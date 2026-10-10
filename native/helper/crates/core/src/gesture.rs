//! The hold key's gestures as a pure state machine (section 6): hold to talk,
//! a quick lone tap cancels, a double tap latches hands-free, and any other
//! key during the press means it was a shortcut.
//!
//! It knows nothing of where key events come from. A backend reports edges
//! with the monotonic time they happened at; the owner calls [`Gesture::on_deadline`]
//! when [`Gesture::deadline`] passes.

use std::time::{Duration, Instant};

pub const HOLD_THRESHOLD: Duration = Duration::from_millis(300);
pub const DOUBLE_TAP_WINDOW: Duration = Duration::from_millis(350);

/// A raw key edge from the OS hook.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyEdge {
    /// The configured hold key went down.
    Down,
    /// The configured hold key came up.
    Up,
    /// Any other (non-modifier) key went down.
    OtherKey,
}

/// What a gesture asks the app to do: a `hotkey` event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Intent {
    Start { latched: bool },
    Stop,
    Cancel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Press {
    /// Sent an unlatched `start`; the release decides between stop and cancel.
    Started,
    /// Turned the latch on or off; the release means nothing.
    Latch,
}

#[derive(Debug)]
pub struct Gesture {
    pub hold_threshold: Duration,
    pub double_tap_window: Duration,
    down: bool,
    latched: bool,
    last_down: Option<Instant>,
    press_started: Option<Instant>,
    press: Press,
    other_key: bool,
    /// When a short tap's wait for a second tap runs out.
    pending: Option<Instant>,
}

impl Default for Gesture {
    fn default() -> Self {
        Self::new()
    }
}

impl Gesture {
    pub fn new() -> Self {
        Self {
            hold_threshold: HOLD_THRESHOLD,
            double_tap_window: DOUBLE_TAP_WINDOW,
            down: false,
            latched: false,
            last_down: None,
            press_started: None,
            press: Press::Latch,
            other_key: false,
            pending: None,
        }
    }

    pub fn is_latched(&self) -> bool {
        self.latched
    }

    /// True while the hold key is down and no other key has been pressed: the
    /// release that follows is a standalone one (the one macOS would turn into
    /// its own fn action).
    pub fn is_standalone_press(&self) -> bool {
        self.down && !self.other_key
    }

    /// Feeds one edge that happened at `at`.
    pub fn edge(&mut self, edge: KeyEdge, at: Instant) -> Option<Intent> {
        match edge {
            KeyEdge::Down if !self.down => {
                self.down = true;
                self.other_key = false;
                self.on_down(at)
            }
            KeyEdge::Up if self.down => {
                self.down = false;
                if self.other_key { None } else { self.on_up(at) }
            }
            KeyEdge::OtherKey if self.down && !self.other_key => {
                self.other_key = true;
                // This press already started a recording that was never a
                // dictation: drop it now instead of transcribing a shortcut.
                if self.press == Press::Started && !self.latched {
                    self.press = Press::Latch;
                    self.pending = None;
                    Some(Intent::Cancel)
                } else {
                    None
                }
            }
            // A repeated edge in the same direction, or another key with the
            // hold key up.
            _ => None,
        }
    }

    fn on_down(&mut self, at: Instant) -> Option<Intent> {
        // Whatever the last release was waiting to decide, this press decides it.
        self.pending = None;
        let double = self.last_down.is_some_and(|last| at.saturating_duration_since(last) < self.double_tap_window);
        self.last_down = Some(at);
        self.press = Press::Latch;
        if double {
            self.latched = true;
            return Some(Intent::Start { latched: true });
        }
        if self.latched {
            self.latched = false;
            return Some(Intent::Stop);
        }
        self.press_started = Some(at);
        self.press = Press::Started;
        Some(Intent::Start { latched: false })
    }

    fn on_up(&mut self, at: Instant) -> Option<Intent> {
        // Hands-free ignores the release, and so does the press that ended it
        // (the reference helper sends a second `stop` there; one is enough).
        if self.latched || self.press != Press::Started {
            return None;
        }
        let held = self.press_started.map_or(Duration::ZERO, |t| at.saturating_duration_since(t));
        if held >= self.hold_threshold {
            return Some(Intent::Stop);
        }
        // Too short to be a hold. It may be the first half of a double tap, so
        // wait out the window before calling it a stray tap.
        self.pending = Some(at + self.double_tap_window);
        None
    }

    /// When [`on_deadline`](Gesture::on_deadline) next has something to decide.
    pub fn deadline(&self) -> Option<Instant> {
        self.pending
    }

    /// Call once `deadline()` has passed.
    pub fn on_deadline(&mut self, now: Instant) -> Option<Intent> {
        match self.pending {
            Some(due) if now >= due => {
                self.pending = None;
                // A lone quick tap was never a dictation.
                (!self.latched).then_some(Intent::Cancel)
            }
            _ => None,
        }
    }

    /// The app ended a latched recording some other way.
    pub fn unlatch(&mut self) {
        self.latched = false;
    }

    /// The hold key was switched off or changed: forget the press in progress.
    pub fn reset(&mut self) {
        let (hold, double) = (self.hold_threshold, self.double_tap_window);
        *self = Self::new();
        self.hold_threshold = hold;
        self.double_tap_window = double;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use Intent::*;
    use KeyEdge::*;

    struct Rig {
        g: Gesture,
        t0: Instant,
    }

    impl Rig {
        fn new() -> Self {
            Self { g: Gesture::new(), t0: Instant::now() }
        }
        fn at(&self, ms: u64) -> Instant {
            self.t0 + Duration::from_millis(ms)
        }
        fn edge(&mut self, edge: KeyEdge, ms: u64) -> Option<Intent> {
            // A timer that came due before this edge fires first, as it would live.
            assert_eq!(self.g.deadline().filter(|d| *d <= self.at(ms)), None, "an unfired deadline before {ms} ms");
            self.g.edge(edge, self.at(ms))
        }
        fn timer(&mut self, ms: u64) -> Option<Intent> {
            self.g.on_deadline(self.at(ms))
        }
    }

    #[test]
    fn hold_starts_and_stops() {
        let mut r = Rig::new();
        assert_eq!(r.edge(Down, 0), Some(Start { latched: false }));
        assert_eq!(r.g.deadline(), None);
        assert_eq!(r.edge(Up, 300), Some(Stop)); // exactly the threshold is a hold
        assert_eq!(r.g.deadline(), None);
    }

    #[test]
    fn a_lone_quick_tap_cancels_after_the_window() {
        let mut r = Rig::new();
        assert_eq!(r.edge(Down, 0), Some(Start { latched: false }));
        assert_eq!(r.edge(Up, 299), None);
        assert_eq!(r.g.deadline(), Some(r.at(299 + 350)));
        assert_eq!(r.timer(648), None); // not yet
        assert_eq!(r.timer(649), Some(Cancel));
        assert_eq!(r.g.deadline(), None);
        assert_eq!(r.timer(2000), None); // once
    }

    #[test]
    fn double_tap_latches_and_a_later_tap_stops_once() {
        let mut r = Rig::new();
        assert_eq!(r.edge(Down, 0), Some(Start { latched: false }));
        assert_eq!(r.edge(Up, 80), None);
        assert_eq!(r.edge(Down, 200), Some(Start { latched: true }));
        assert!(r.g.is_latched());
        assert_eq!(r.g.deadline(), None); // the first tap's wait was dropped
        assert_eq!(r.edge(Up, 280), None); // hands-free ignores the release
        assert_eq!(r.timer(1000), None);
        // Much later, one tap ends it: a stop on the press, nothing on the release.
        assert_eq!(r.edge(Down, 5000), Some(Stop));
        assert!(!r.g.is_latched());
        assert_eq!(r.edge(Up, 5100), None);
        assert_eq!(r.g.deadline(), None);
    }

    #[test]
    fn the_double_tap_window_is_measured_between_downs() {
        let mut r = Rig::new();
        assert_eq!(r.edge(Down, 0), Some(Start { latched: false }));
        assert_eq!(r.edge(Up, 50), None);
        // 350 ms after the first down is no longer a double tap, but it is
        // still inside the first tap's wait, which this press drops.
        assert_eq!(r.edge(Down, 350), Some(Start { latched: false }));
        assert_eq!(r.g.deadline(), None);
        assert_eq!(r.edge(Up, 900), Some(Stop));
    }

    #[test]
    fn a_third_quick_tap_latches_again() {
        let mut r = Rig::new();
        assert_eq!(r.edge(Down, 0), Some(Start { latched: false }));
        r.edge(Up, 50);
        assert_eq!(r.edge(Down, 150), Some(Start { latched: true }));
        r.edge(Up, 200);
        assert_eq!(r.edge(Down, 300), Some(Start { latched: true }));
        assert!(r.g.is_latched());
    }

    #[test]
    fn a_hold_then_an_immediate_press_starts_latched() {
        let mut r = Rig::new();
        assert_eq!(r.edge(Down, 0), Some(Start { latched: false }));
        assert_eq!(r.edge(Up, 320), Some(Stop));
        assert_eq!(r.edge(Down, 340), Some(Start { latched: true }));
    }

    #[test]
    fn another_key_during_the_press_cancels_at_once() {
        let mut r = Rig::new();
        assert_eq!(r.edge(Down, 0), Some(Start { latched: false }));
        assert!(r.g.is_standalone_press());
        assert_eq!(r.edge(OtherKey, 120), Some(Cancel));
        assert!(!r.g.is_standalone_press());
        assert_eq!(r.edge(OtherKey, 160), None); // once per press
        assert_eq!(r.edge(Up, 900), None); // the release of a combination
        assert_eq!(r.g.deadline(), None);
        // The next press is an ordinary one.
        assert_eq!(r.edge(Down, 3000), Some(Start { latched: false }));
    }

    #[test]
    fn another_key_while_latched_does_not_cancel() {
        let mut r = Rig::new();
        r.edge(Down, 0);
        r.edge(Up, 50);
        assert_eq!(r.edge(Down, 150), Some(Start { latched: true }));
        assert_eq!(r.edge(OtherKey, 200), None);
        assert_eq!(r.edge(Up, 260), None);
        assert!(r.g.is_latched());
        // Typing with the hold key up is nobody's business.
        assert_eq!(r.edge(OtherKey, 900), None);
    }

    #[test]
    fn repeated_edges_are_dropped() {
        let mut r = Rig::new();
        assert_eq!(r.edge(Up, 0), None);
        assert_eq!(r.edge(Down, 10), Some(Start { latched: false }));
        assert_eq!(r.edge(Down, 40), None); // key repeat must not look like a double tap
        assert_eq!(r.edge(Down, 70), None);
        assert_eq!(r.edge(Up, 500), Some(Stop));
        assert_eq!(r.edge(Up, 510), None);
    }

    #[test]
    fn unlatch_makes_the_next_press_a_start() {
        let mut r = Rig::new();
        r.edge(Down, 0);
        r.edge(Up, 50);
        r.edge(Down, 150);
        r.edge(Up, 200);
        assert!(r.g.is_latched());
        r.g.unlatch();
        assert!(!r.g.is_latched());
        r.g.unlatch(); // a no-op when not latched
        assert_eq!(r.edge(Down, 4000), Some(Start { latched: false }));
        assert_eq!(r.edge(Up, 4600), Some(Stop));
    }

    #[test]
    fn a_tap_that_became_a_latch_is_not_cancelled_by_its_timer() {
        let mut r = Rig::new();
        r.edge(Down, 0);
        r.edge(Up, 50); // waits until 400
        let stale = r.g.deadline();
        assert_eq!(r.edge(Down, 200), Some(Start { latched: true }));
        assert_eq!(stale, Some(r.at(400)));
        assert_eq!(r.timer(400), None);
    }

    #[test]
    fn thresholds_are_tunable() {
        let mut r = Rig::new();
        r.g.hold_threshold = Duration::from_millis(100);
        r.g.double_tap_window = Duration::from_millis(150);
        assert_eq!(r.edge(Down, 0), Some(Start { latched: false }));
        assert_eq!(r.edge(Up, 120), Some(Stop));
        assert_eq!(r.edge(Down, 1000), Some(Start { latched: false }));
        assert_eq!(r.edge(Up, 1050), None);
        assert_eq!(r.g.deadline(), Some(r.at(1200)));
        assert_eq!(r.edge(Down, 1160), Some(Start { latched: false })); // 160 ms: outside the 150 ms window
        r.g.reset();
        assert_eq!(r.g.hold_threshold, Duration::from_millis(100));
        assert_eq!(r.edge(Up, 1500), None); // the press in progress was forgotten
    }
}

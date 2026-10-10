//! What the event tap decides about one event, with no OS types: which edge to
//! report and whether the event is kept from the rest of the system. The tap
//! callback is a thin shell around this, so it can be tested without a tap.

use quill_core::gesture::KeyEdge;

/// The keys Settings offers: fn, right command, right option, right control,
/// right shift, caps lock. `holdkey` also takes the left-hand modifiers
/// (55, 58, 59, 56); they are not offered because they are in constant use.
pub const HOLD_KEYS: [u32; 6] = [63, 54, 61, 62, 60, 57];

/// The hold key until main says otherwise (fn).
pub const DEFAULT_KEY: u32 = 63;

// CGEventFlags, the device-independent modifier bits.
const ALPHA_SHIFT: u64 = 0x0001_0000;
const SHIFT: u64 = 0x0002_0000;
const CONTROL: u64 = 0x0004_0000;
const ALTERNATE: u64 = 0x0008_0000;
const COMMAND: u64 = 0x0010_0000;
const SECONDARY_FN: u64 = 0x0080_0000;

// The device-dependent bits below them (IOLLEvent.h, NX_DEVICE...KEYMASK):
// which side of the keyboard a modifier is held on.
const LEFT_CONTROL: u64 = 0x0001;
const LEFT_SHIFT: u64 = 0x0002;
const RIGHT_SHIFT: u64 = 0x0004;
const LEFT_COMMAND: u64 = 0x0008;
const RIGHT_COMMAND: u64 = 0x0010;
const LEFT_ALTERNATE: u64 = 0x0020;
const RIGHT_ALTERNATE: u64 = 0x0040;
const RIGHT_CONTROL: u64 = 0x2000;

/// Whether `keycode` is held, judged from the flags of its own `flagsChanged`
/// event. A modifier key raises the same flag as its twin on the other side,
/// so the side bits decide when the keyboard supplies them (releasing right
/// command with left command still held is a release). Events without side
/// bits (some remappers, synthetic events) fall back to the shared flag, which
/// is all the Swift helper looked at. An unknown keycode is read as fn, as the
/// Swift helper does.
pub fn is_down(keycode: u32, flags: u64) -> bool {
    let (shared, this_side, other_side) = match keycode {
        54 => (COMMAND, RIGHT_COMMAND, LEFT_COMMAND),
        55 => (COMMAND, LEFT_COMMAND, RIGHT_COMMAND),
        61 => (ALTERNATE, RIGHT_ALTERNATE, LEFT_ALTERNATE),
        58 => (ALTERNATE, LEFT_ALTERNATE, RIGHT_ALTERNATE),
        62 => (CONTROL, RIGHT_CONTROL, LEFT_CONTROL),
        59 => (CONTROL, LEFT_CONTROL, RIGHT_CONTROL),
        60 => (SHIFT, RIGHT_SHIFT, LEFT_SHIFT),
        56 => (SHIFT, LEFT_SHIFT, RIGHT_SHIFT),
        // Caps lock reports the lock, not the key: on after one press, off
        // after the next. As a hold key it therefore works as press to start,
        // press again to stop, exactly as in the Swift helper.
        57 => return flags & ALPHA_SHIFT != 0,
        _ => return flags & SECONDARY_FN != 0,
    };
    if flags & (this_side | other_side) != 0 {
        flags & this_side != 0
    } else {
        flags & shared != 0
    }
}

/// What the tap does with one event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Verdict {
    /// Reported to the session, stamped with the time of the callback.
    pub edge: Option<KeyEdge>,
    /// Keep the event from the rest of the system.
    pub swallow: bool,
}

impl Verdict {
    const PASS: Verdict = Verdict { edge: None, swallow: false };
}

/// The press in progress, as far as swallowing needs to know it. The gestures
/// themselves (hold, tap, latch) are the session's.
#[derive(Debug, Default)]
pub struct Press {
    down: bool,
    /// Another key went down during this press: it is a combination
    /// (fn+F1, fn+arrow), so its release belongs to the system.
    other_key: bool,
}

impl Press {
    /// A `flagsChanged` event for `keycode` carrying `flags`. `key` is the
    /// configured hold key (`None`: off, everything passes); `swallow` is
    /// whether a standalone release is kept from the system.
    pub fn flags_changed(&mut self, keycode: i64, flags: u64, key: Option<u32>, swallow: bool) -> Verdict {
        // Only the configured key matters; every other modifier passes.
        let Some(key) = key.filter(|key| i64::from(*key) == keycode) else {
            return Verdict::PASS;
        };
        let down = is_down(key, flags);
        if down == self.down {
            return Verdict::PASS;
        }
        self.down = down;
        if down {
            self.other_key = false;
            // The press passes through so fn+F1, fn+arrows and the like work.
            return Verdict { edge: Some(KeyEdge::Down), swallow: false };
        }
        // Only a standalone release is swallowed: that is the one macOS turns
        // into its own fn action (input source switch, emoji picker, dictation).
        Verdict { edge: Some(KeyEdge::Up), swallow: swallow && !self.other_key }
    }

    /// A `keyDown` event. Reported once per press and only while the hold key
    /// is down, so ordinary typing never reaches the session.
    pub fn key_down(&mut self) -> Option<KeyEdge> {
        if !self.down || self.other_key {
            return None;
        }
        self.other_key = true;
        Some(KeyEdge::OtherKey)
    }

    /// The tap was off for a while and may have missed the release. `flags`
    /// is the keyboard's state now.
    pub fn resync(&mut self, flags: u64, key: Option<u32>) -> Option<KeyEdge> {
        let key = key?;
        if !self.down || is_down(key, flags) {
            return None;
        }
        self.down = false;
        Some(KeyEdge::Up)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use KeyEdge::*;

    const FN: Option<u32> = Some(63);
    const NO_FLAGS: u64 = 0x100; // what a bare event carries: "non coalesced"

    fn pass() -> Verdict {
        Verdict { edge: None, swallow: false }
    }

    #[test]
    fn fn_press_passes_and_its_standalone_release_is_swallowed() {
        let mut press = Press::default();
        assert_eq!(press.flags_changed(63, NO_FLAGS | SECONDARY_FN, FN, true), Verdict { edge: Some(Down), swallow: false });
        assert_eq!(press.flags_changed(63, NO_FLAGS, FN, true), Verdict { edge: Some(Up), swallow: true });
    }

    #[test]
    fn nothing_is_swallowed_with_capture_off() {
        let mut press = Press::default();
        press.flags_changed(63, SECONDARY_FN, FN, false);
        assert_eq!(press.flags_changed(63, 0, FN, false), Verdict { edge: Some(Up), swallow: false });
    }

    #[test]
    fn a_combination_reports_once_and_its_release_passes() {
        let mut press = Press::default();
        assert_eq!(press.key_down(), None); // typing with the hold key up
        press.flags_changed(63, SECONDARY_FN, FN, true);
        assert_eq!(press.key_down(), Some(OtherKey));
        assert_eq!(press.key_down(), None); // auto-repeat, a second key
        assert_eq!(press.flags_changed(63, 0, FN, true), Verdict { edge: Some(Up), swallow: false });
        // The next press is a fresh one.
        press.flags_changed(63, SECONDARY_FN, FN, true);
        assert_eq!(press.flags_changed(63, 0, FN, true), Verdict { edge: Some(Up), swallow: true });
        assert_eq!(press.key_down(), None);
    }

    #[test]
    fn other_modifiers_and_repeated_edges_pass_untouched() {
        let mut press = Press::default();
        // Left shift while fn is the hold key.
        assert_eq!(press.flags_changed(56, SHIFT | LEFT_SHIFT, FN, true), pass());
        // A release with nothing held.
        assert_eq!(press.flags_changed(63, 0, FN, true), pass());
        press.flags_changed(63, SECONDARY_FN, FN, true);
        // fn stays down while shift changes: same direction, no edge.
        assert_eq!(press.flags_changed(63, SECONDARY_FN | SHIFT, FN, true), pass());
    }

    #[test]
    fn off_passes_everything() {
        let mut press = Press::default();
        assert_eq!(press.flags_changed(63, SECONDARY_FN, None, true), pass());
        assert_eq!(press.flags_changed(63, 0, None, true), pass());
        assert_eq!(press.key_down(), None);
    }

    #[test]
    fn a_right_modifier_is_told_from_its_left_twin() {
        let key = Some(54); // right command
        let mut press = Press::default();
        // Left command is not the hold key, whatever it does to the flags.
        assert_eq!(press.flags_changed(55, COMMAND | LEFT_COMMAND, key, true), pass());
        // Right command goes down while left is held.
        assert_eq!(
            press.flags_changed(54, COMMAND | LEFT_COMMAND | RIGHT_COMMAND, key, true),
            Verdict { edge: Some(Down), swallow: false }
        );
        // And comes up with left still held: the shared flag stays set.
        assert_eq!(press.flags_changed(54, COMMAND | LEFT_COMMAND, key, true), Verdict { edge: Some(Up), swallow: true });
    }

    #[test]
    fn every_offered_key_reads_its_own_press_and_release() {
        let cases: [(u32, u64); 9] = [
            (54, COMMAND | RIGHT_COMMAND),
            (55, COMMAND | LEFT_COMMAND),
            (61, ALTERNATE | RIGHT_ALTERNATE),
            (58, ALTERNATE | LEFT_ALTERNATE),
            (62, CONTROL | RIGHT_CONTROL),
            (59, CONTROL | LEFT_CONTROL),
            (60, SHIFT | RIGHT_SHIFT),
            (56, SHIFT | LEFT_SHIFT),
            (63, SECONDARY_FN),
        ];
        for (keycode, flags) in cases {
            assert!(is_down(keycode, NO_FLAGS | flags), "{keycode} down");
            assert!(!is_down(keycode, NO_FLAGS), "{keycode} up");
        }
        for keycode in HOLD_KEYS {
            assert!(!is_down(keycode, 0));
        }
    }

    #[test]
    fn flags_without_side_bits_fall_back_to_the_shared_flag() {
        assert!(is_down(54, COMMAND));
        assert!(is_down(60, SHIFT));
        // The other side alone is not this key.
        assert!(!is_down(54, COMMAND | LEFT_COMMAND));
        assert!(!is_down(62, CONTROL | LEFT_CONTROL));
    }

    #[test]
    fn caps_lock_follows_the_lock() {
        let key = Some(57);
        let mut press = Press::default();
        assert_eq!(press.flags_changed(57, ALPHA_SHIFT, key, true).edge, Some(Down));
        // The key's own release leaves the lock on: no edge.
        assert_eq!(press.flags_changed(57, ALPHA_SHIFT, key, true), pass());
        assert_eq!(press.flags_changed(57, 0, key, true).edge, Some(Up));
    }

    #[test]
    fn an_unknown_keycode_is_read_as_fn() {
        assert!(is_down(200, SECONDARY_FN));
        assert!(!is_down(200, COMMAND));
    }

    #[test]
    fn resync_reports_a_release_the_tap_missed() {
        let mut press = Press::default();
        assert_eq!(press.resync(0, FN), None); // nothing was held
        press.flags_changed(63, SECONDARY_FN, FN, true);
        assert_eq!(press.resync(SECONDARY_FN, FN), None); // still held
        assert_eq!(press.resync(0, FN), Some(Up));
        assert_eq!(press.resync(0, FN), None); // once
        // The next press is seen as a press again.
        assert_eq!(press.flags_changed(63, SECONDARY_FN, FN, true).edge, Some(Down));
        assert_eq!(press.resync(0, None), None); // the key was switched off meanwhile
    }
}

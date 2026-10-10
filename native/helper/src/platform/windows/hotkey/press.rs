//! What the keyboard hook decides about one key event, with no OS types: which
//! edge to report and what happens to the event. The hook procedure is a thin
//! shell around this, so it can be tested without a hook.

use quill_core::gesture::KeyEdge;

use super::keys::{is_altgr_phantom, is_modifier, quiet_for, Quiet};

/// One event as the low-level hook sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyEvent {
    /// Virtual key (`KBDLLHOOKSTRUCT.vkCode`); left and right are distinct.
    pub vk: u32,
    pub scan: u32,
    /// Going down (`WM_KEYDOWN`, `WM_SYSKEYDOWN`), else coming up.
    pub down: bool,
    /// Injected by this process (`LLKHF_INJECTED` with our tag).
    pub ours: bool,
}

/// What the hook does with the event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// Hand it on untouched.
    Pass,
    /// Keep it from the rest of the system.
    Swallow,
    /// Send the mask key first, then hand it on: Windows then takes the
    /// release for the end of a combination and opens nothing.
    MaskThenPass,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Verdict {
    /// Reported to the session, stamped with the time of the callback.
    pub edge: Option<KeyEdge>,
    pub action: Action,
}

impl Verdict {
    const PASS: Verdict = Verdict { edge: None, action: Action::Pass };
}

/// The press in progress, as far as the hook needs to know it. The gestures
/// themselves (hold, tap, latch) are the session's.
#[derive(Debug, Default)]
pub struct Press {
    down: bool,
    /// Another key went down during this press: it is a combination
    /// (Alt+Tab, Ctrl+C), so its release is left exactly as it is.
    other_key: bool,
    /// The press was kept from the system, so its release must be too, and
    /// Windows' own idea of the key's state says nothing about it.
    swallowed: bool,
}

impl Press {
    /// `key` is the hold key's virtual key (`None`: off, everything passes);
    /// `quiet` is whether the key's own action is suppressed.
    pub fn on_key(&mut self, event: KeyEvent, key: Option<u32>, quiet: bool) -> Verdict {
        // Our own paste chord and mask key are nobody's key press.
        if event.ours || is_altgr_phantom(event.vk, event.scan) {
            return Verdict::PASS;
        }
        let Some(key) = key else { return Verdict::PASS };
        if event.vk != key {
            if event.down && self.down && !self.other_key && !is_modifier(event.vk) {
                self.other_key = true;
                return Verdict { edge: Some(KeyEdge::OtherKey), action: Action::Pass };
            }
            return Verdict::PASS;
        }
        let quiet = if quiet { quiet_for(key) } else { Quiet::Nothing };
        if event.down {
            if self.down {
                // Auto-repeat while held. A swallowed press stays swallowed.
                let action = if self.swallowed { Action::Swallow } else { Action::Pass };
                return Verdict { edge: None, action };
            }
            self.down = true;
            self.other_key = false;
            self.swallowed = quiet == Quiet::Swallow;
            let action = if self.swallowed { Action::Swallow } else { Action::Pass };
            return Verdict { edge: Some(KeyEdge::Down), action };
        }
        if !self.down {
            // A release of a press that was never seen (the helper started
            // with the key held, or the hook was away).
            return Verdict::PASS;
        }
        self.down = false;
        let action = if std::mem::take(&mut self.swallowed) {
            Action::Swallow
        } else if quiet == Quiet::Mask && !self.other_key {
            Action::MaskThenPass
        } else {
            Action::Pass
        };
        Verdict { edge: Some(KeyEdge::Up), action }
    }

    /// True while a press is in progress that Windows knows about, so its
    /// state can be checked against the keyboard's.
    pub fn can_resync(&self) -> bool {
        self.down && !self.swallowed
    }

    pub fn is_idle(&self) -> bool {
        !self.down
    }

    /// The hook may have missed the release (it was removed, or an elevated
    /// window had the keyboard). `physically_down` is the key's state now.
    pub fn resync(&mut self, physically_down: bool) -> Option<KeyEdge> {
        if !self.can_resync() || physically_down {
            return None;
        }
        self.down = false;
        Some(KeyEdge::Up)
    }
}

#[cfg(test)]
mod tests {
    use super::super::keys::*;
    use super::*;
    use KeyEdge::*;

    const RCTRL: Option<u32> = Some(VK_RCONTROL);
    const KEY_A: u32 = 0x41;

    fn down(vk: u32) -> KeyEvent {
        KeyEvent { vk, scan: 0x1D, down: true, ours: false }
    }

    fn up(vk: u32) -> KeyEvent {
        KeyEvent { vk, scan: 0x1D, down: false, ours: false }
    }

    fn pass() -> Verdict {
        Verdict { edge: None, action: Action::Pass }
    }

    fn edge(edge: KeyEdge, action: Action) -> Verdict {
        Verdict { edge: Some(edge), action }
    }

    #[test]
    fn right_ctrl_reports_both_edges_and_passes_them() {
        let mut press = Press::default();
        assert_eq!(press.on_key(down(VK_RCONTROL), RCTRL, true), edge(Down, Action::Pass));
        assert_eq!(press.on_key(up(VK_RCONTROL), RCTRL, true), edge(Up, Action::Pass));
    }

    #[test]
    fn auto_repeat_is_one_press() {
        let mut press = Press::default();
        assert_eq!(press.on_key(down(VK_RCONTROL), RCTRL, true).edge, Some(Down));
        for _ in 0..20 {
            assert_eq!(press.on_key(down(VK_RCONTROL), RCTRL, true), pass());
        }
        assert_eq!(press.on_key(up(VK_RCONTROL), RCTRL, true).edge, Some(Up));
        assert_eq!(press.on_key(up(VK_RCONTROL), RCTRL, true), pass());
    }

    #[test]
    fn the_left_twin_is_another_key_entirely() {
        let mut press = Press::default();
        assert_eq!(press.on_key(down(VK_LCONTROL), RCTRL, true), pass());
        assert_eq!(press.on_key(up(VK_LCONTROL), RCTRL, true), pass());
        assert!(press.is_idle());
    }

    #[test]
    fn a_combination_reports_once_per_press() {
        let mut press = Press::default();
        assert_eq!(press.on_key(down(KEY_A), RCTRL, true), pass()); // typing with the hold key up
        press.on_key(down(VK_RCONTROL), RCTRL, true);
        assert_eq!(press.on_key(down(VK_LSHIFT), RCTRL, true), pass()); // a modifier is not a combination yet
        assert_eq!(press.on_key(down(KEY_A), RCTRL, true), edge(OtherKey, Action::Pass));
        assert_eq!(press.on_key(up(KEY_A), RCTRL, true), pass());
        assert_eq!(press.on_key(down(KEY_A), RCTRL, true), pass());
        assert_eq!(press.on_key(up(VK_RCONTROL), RCTRL, true), edge(Up, Action::Pass));
        // The next press starts clean.
        press.on_key(down(VK_RCONTROL), RCTRL, true);
        assert_eq!(press.on_key(down(KEY_A), RCTRL, true).edge, Some(OtherKey));
    }

    #[test]
    fn our_own_injected_keys_are_invisible() {
        let mut press = Press::default();
        press.on_key(down(VK_RCONTROL), RCTRL, true);
        // The paste chord while the user still holds the key.
        let ours = KeyEvent { vk: 0x56, scan: 0, down: true, ours: true };
        assert_eq!(press.on_key(ours, RCTRL, true), pass());
        // Even an injected event for the hold key itself.
        let ours = KeyEvent { vk: VK_RCONTROL, scan: 0, down: false, ours: true };
        assert_eq!(press.on_key(ours, RCTRL, true), pass());
        assert_eq!(press.on_key(up(VK_RCONTROL), RCTRL, true), edge(Up, Action::Pass));
    }

    #[test]
    fn off_passes_everything() {
        let mut press = Press::default();
        assert_eq!(press.on_key(down(VK_RCONTROL), None, true), pass());
        assert_eq!(press.on_key(down(KEY_A), None, true), pass());
        assert_eq!(press.on_key(up(VK_RCONTROL), None, true), pass());
    }

    #[test]
    fn a_lone_right_alt_release_is_masked() {
        let key = Some(VK_RMENU);
        let mut press = Press::default();
        assert_eq!(press.on_key(down(VK_RMENU), key, true), edge(Down, Action::Pass));
        assert_eq!(press.on_key(up(VK_RMENU), key, true), edge(Up, Action::MaskThenPass));
    }

    #[test]
    fn an_alt_combination_is_left_alone() {
        let key = Some(VK_RMENU);
        let mut press = Press::default();
        press.on_key(down(VK_RMENU), key, true);
        press.on_key(down(0x09), key, true); // Tab
        assert_eq!(press.on_key(up(VK_RMENU), key, true), edge(Up, Action::Pass));
    }

    #[test]
    fn the_altgr_phantom_neither_presses_nor_combines() {
        // Left Ctrl as the hold key on a layout with AltGr.
        let key = Some(VK_LCONTROL);
        let phantom_down = KeyEvent { vk: VK_LCONTROL, scan: 0x21D, down: true, ours: false };
        let phantom_up = KeyEvent { vk: VK_LCONTROL, scan: 0x21D, down: false, ours: false };
        let mut press = Press::default();
        assert_eq!(press.on_key(phantom_down, key, true), pass());
        assert_eq!(press.on_key(phantom_up, key, true), pass());
        assert!(press.is_idle());
        // The real key still works.
        assert_eq!(press.on_key(down(VK_LCONTROL), key, true).edge, Some(Down));
    }

    #[test]
    fn caps_lock_is_swallowed_whole() {
        let key = Some(VK_CAPITAL);
        let mut press = Press::default();
        assert_eq!(press.on_key(down(VK_CAPITAL), key, true), edge(Down, Action::Swallow));
        assert_eq!(press.on_key(down(VK_CAPITAL), key, true), Verdict { edge: None, action: Action::Swallow });
        assert!(!press.can_resync(), "Windows never saw this press");
        assert_eq!(press.on_key(up(VK_CAPITAL), key, true), edge(Up, Action::Swallow));
        // A release nobody saw go down passes, so the key cannot get stuck.
        assert_eq!(press.on_key(up(VK_CAPITAL), key, true), pass());
    }

    #[test]
    fn nothing_is_suppressed_with_capture_off() {
        let mut press = Press::default();
        assert_eq!(press.on_key(down(VK_CAPITAL), Some(VK_CAPITAL), false), edge(Down, Action::Pass));
        assert_eq!(press.on_key(up(VK_CAPITAL), Some(VK_CAPITAL), false), edge(Up, Action::Pass));
        assert_eq!(press.on_key(down(VK_RMENU), Some(VK_RMENU), false), edge(Down, Action::Pass));
        assert_eq!(press.on_key(up(VK_RMENU), Some(VK_RMENU), false), edge(Up, Action::Pass));
    }

    #[test]
    fn a_press_swallowed_before_capture_went_off_is_released_swallowed() {
        let key = Some(VK_CAPITAL);
        let mut press = Press::default();
        press.on_key(down(VK_CAPITAL), key, true);
        // Windows never saw the press, so it must not see a lone release.
        assert_eq!(press.on_key(up(VK_CAPITAL), key, false), edge(Up, Action::Swallow));
    }

    #[test]
    fn resync_reports_a_release_the_hook_missed() {
        let mut press = Press::default();
        assert_eq!(press.resync(false), None); // nothing was held
        press.on_key(down(VK_RCONTROL), RCTRL, true);
        assert!(press.can_resync());
        assert_eq!(press.resync(true), None); // still held
        assert_eq!(press.resync(false), Some(Up));
        assert_eq!(press.resync(false), None); // once
        assert!(press.is_idle());
        // The next press is seen as a press again.
        assert_eq!(press.on_key(down(VK_RCONTROL), RCTRL, true).edge, Some(Down));
    }
}

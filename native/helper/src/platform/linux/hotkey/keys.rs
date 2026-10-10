//! Which key the hold key is on this keyboard, and what one raw key event
//! means for it. No X types: the listener in `hotkey.rs` is a thin shell
//! around this, so it is tested without a server.
//!
//! `holdkey` carries a macOS virtual keycode on every platform (section 2.3),
//! so this is also where those are turned into X keys.

use quill_core::gesture::KeyEdge;

use super::super::keymap::{
    KeyClass, Keymap, XK_ALT_L, XK_ALT_R, XK_CONTROL_L, XK_CONTROL_R, XK_ISO_LEVEL3_SHIFT, XK_META_L, XK_META_R, XK_SHIFT_L,
    XK_SHIFT_R, XK_SUPER_L, XK_SUPER_R,
};

/// The keys Settings offers, as macOS keycodes: right control, right alt,
/// right shift, right super. `holdkey` also takes the left-hand ones (59, 58,
/// 56, 55); they are not offered because they are in constant use. There is
/// no fn key (the keyboard handles it itself and sends nothing), and caps
/// lock is left out because nothing here can stop it toggling.
pub const HOLD_KEYS: [u32; 4] = [62, 61, 60, 54];

/// The hold key until main says otherwise, and the one a keycode with no key
/// here is read as: right control. Main's own default is fn (63), which no PC
/// keyboard reports, so a fresh install lands here. The macOS helper reads an
/// unknown keycode as its default in the same way.
pub const DEFAULT_KEY: u32 = 62;

/// One hold key in X terms.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HoldKey {
    /// The keysyms the key carries, the usual one first.
    pub keysyms: &'static [u32],
    /// Its keycode on every evdev keyboard (the kernel's code plus 8).
    pub physical: u8,
}

/// The X key for a macOS keycode. Anything without a counterpart is the
/// default key.
pub fn hold_key(mac_keycode: u32) -> HoldKey {
    match mac_keycode {
        59 => HoldKey { keysyms: &[XK_CONTROL_L], physical: 37 },
        60 => HoldKey { keysyms: &[XK_SHIFT_R], physical: 62 },
        56 => HoldKey { keysyms: &[XK_SHIFT_L], physical: 50 },
        // Right alt is AltGr on most non-US layouts.
        61 => HoldKey { keysyms: &[XK_ALT_R, XK_ISO_LEVEL3_SHIFT, XK_META_R], physical: 108 },
        58 => HoldKey { keysyms: &[XK_ALT_L, XK_META_L], physical: 64 },
        54 => HoldKey { keysyms: &[XK_SUPER_R], physical: 134 },
        55 => HoldKey { keysyms: &[XK_SUPER_L], physical: 133 },
        _ => HoldKey { keysyms: &[XK_CONTROL_R], physical: 105 },
    }
}

/// The keycode to watch for `mac_keycode` under this mapping.
///
/// The usual physical key when it carries one of the key's keysyms, which is
/// nearly always. Otherwise the key that does carry it (the user swapped keys
/// with an xkb option), and failing that the physical key again (its keysym
/// was given to something else, a compose key say, but it is still the key
/// the user means). The physical key goes first because layouts also hang
/// these keysyms on keycodes no keyboard sends (`ISO_Level3_Shift` on 92,
/// `Super_L` on 206), and a search would find those.
pub fn resolve(mac_keycode: u32, keymap: Option<&Keymap>) -> u8 {
    let key = hold_key(mac_keycode);
    let Some(keymap) = keymap.filter(|keymap| !keymap.is_empty()) else { return key.physical };
    if keymap.syms(u32::from(key.physical)).iter().any(|sym| key.keysyms.contains(sym)) {
        return key.physical;
    }
    key.keysyms.iter().find_map(|&sym| keymap.with_plain(sym)).unwrap_or(key.physical)
}

/// The press in progress, as far as the listener needs to know it. The
/// gestures themselves (hold, tap, latch) are the session's.
#[derive(Debug, Default)]
pub struct Press {
    down: bool,
    /// Another key went down during this press; it is reported once.
    other_key: bool,
}

impl Press {
    /// One raw key event. `hold` is the keycode being watched (`None`: the
    /// hold key is off, nothing is reported) and `class` what kind of key
    /// `keycode` is.
    ///
    /// A repeated edge in the same direction is dropped (auto-repeat sends
    /// presses without releases). Another key counts only while the hold key
    /// is down, only once per press, and only if it is a real key: a second
    /// modifier does not turn a dictation into a shortcut.
    pub fn key(&mut self, keycode: u32, pressed: bool, hold: Option<u8>, class: KeyClass) -> Option<KeyEdge> {
        let hold = hold?;
        if keycode == u32::from(hold) {
            if pressed == self.down {
                return None;
            }
            self.down = pressed;
            if pressed {
                self.other_key = false;
                return Some(KeyEdge::Down);
            }
            return Some(KeyEdge::Up);
        }
        if pressed && self.down && !self.other_key && class == KeyClass::Ordinary {
            self.other_key = true;
            return Some(KeyEdge::OtherKey);
        }
        None
    }

    /// The listener lost its connection: a key that is down will never be
    /// seen coming up, so the press is ended here.
    pub fn abandon(&mut self) -> Option<KeyEdge> {
        let was_down = std::mem::take(self).down;
        was_down.then_some(KeyEdge::Up)
    }
}

#[cfg(test)]
mod tests {
    use super::super::super::keymap::testing::{keymap, us};
    use super::super::super::keymap::{XK_MODE_SWITCH, XK_V};
    use super::*;

    const RIGHT_CTRL: Option<u8> = Some(105);

    #[test]
    fn every_offered_key_exists_on_a_us_keyboard() {
        let map = us();
        let keycodes: Vec<u8> = HOLD_KEYS.iter().map(|&key| resolve(key, Some(&map))).collect();
        assert_eq!(keycodes, vec![105, 108, 62, 134]);
        assert_eq!(HOLD_KEYS[0], DEFAULT_KEY);
    }

    #[test]
    fn the_left_hand_keys_are_taken_too() {
        let map = us();
        assert_eq!(resolve(59, Some(&map)), 37);
        assert_eq!(resolve(58, Some(&map)), 64);
        assert_eq!(resolve(56, Some(&map)), 50);
        // Super_L is also on the fake keycode 206; the real key wins.
        assert_eq!(resolve(55, Some(&map)), 133);
    }

    #[test]
    fn keys_a_pc_keyboard_does_not_have_fall_back_to_right_control() {
        let map = us();
        for mac in [63, 57, 0, 999] {
            assert_eq!(hold_key(mac), hold_key(DEFAULT_KEY), "{mac}");
            assert_eq!(resolve(mac, Some(&map)), 105, "{mac}");
        }
    }

    #[test]
    fn altgr_layouts_use_the_physical_right_alt() {
        // German: keycode 108 is ISO_Level3_Shift, and so is the fake keycode 92.
        let map = keymap(&[(92, &[XK_ISO_LEVEL3_SHIFT]), (108, &[XK_ISO_LEVEL3_SHIFT]), (105, &[XK_CONTROL_R])]);
        assert_eq!(resolve(61, Some(&map)), 108);
    }

    #[test]
    fn a_swapped_key_is_followed_to_where_its_keysym_went() {
        // ctrl:swap_rwin_rctl: right control now lives on the right super key.
        let map = keymap(&[(105, &[XK_SUPER_R]), (134, &[XK_CONTROL_R])]);
        assert_eq!(resolve(62, Some(&map)), 134);
        assert_eq!(resolve(54, Some(&map)), 105);
    }

    #[test]
    fn a_key_given_another_job_is_still_the_physical_key() {
        // compose:rctrl: no key carries Control_R any more.
        let map = keymap(&[(105, &[0xff20]), (55, &[XK_V])]);
        assert_eq!(resolve(62, Some(&map)), 105);
    }

    #[test]
    fn without_a_mapping_the_physical_key_is_used() {
        assert_eq!(resolve(62, None), 105);
        assert_eq!(resolve(60, Some(&Keymap::default())), 62);
    }

    #[test]
    fn a_press_and_release_are_one_edge_each() {
        let mut press = Press::default();
        assert_eq!(press.key(105, true, RIGHT_CTRL, KeyClass::Modifier), Some(KeyEdge::Down));
        // Auto-repeat, or the same event seen through two devices.
        assert_eq!(press.key(105, true, RIGHT_CTRL, KeyClass::Modifier), None);
        assert_eq!(press.key(105, false, RIGHT_CTRL, KeyClass::Modifier), Some(KeyEdge::Up));
        assert_eq!(press.key(105, false, RIGHT_CTRL, KeyClass::Modifier), None);
    }

    #[test]
    fn typing_without_the_hold_key_is_not_reported() {
        let mut press = Press::default();
        assert_eq!(press.key(38, true, RIGHT_CTRL, KeyClass::Ordinary), None);
        assert_eq!(press.key(38, false, RIGHT_CTRL, KeyClass::Ordinary), None);
        assert_eq!(press.key(37, true, RIGHT_CTRL, KeyClass::Modifier), None);
    }

    #[test]
    fn another_key_during_the_press_is_reported_once() {
        let mut press = Press::default();
        press.key(105, true, RIGHT_CTRL, KeyClass::Modifier);
        assert_eq!(press.key(38, true, RIGHT_CTRL, KeyClass::Ordinary), Some(KeyEdge::OtherKey));
        assert_eq!(press.key(38, false, RIGHT_CTRL, KeyClass::Ordinary), None);
        assert_eq!(press.key(39, true, RIGHT_CTRL, KeyClass::Ordinary), None);
        assert_eq!(press.key(105, false, RIGHT_CTRL, KeyClass::Modifier), Some(KeyEdge::Up));
        // The next press starts clean.
        press.key(105, true, RIGHT_CTRL, KeyClass::Modifier);
        assert_eq!(press.key(38, true, RIGHT_CTRL, KeyClass::Ordinary), Some(KeyEdge::OtherKey));
    }

    #[test]
    fn modifiers_and_dead_keycodes_are_not_another_key() {
        let mut press = Press::default();
        press.key(105, true, RIGHT_CTRL, KeyClass::Modifier);
        assert_eq!(press.key(50, true, RIGHT_CTRL, KeyClass::Modifier), None);
        assert_eq!(press.key(250, true, RIGHT_CTRL, KeyClass::Unmapped), None);
        // A release of a key that was down before the press is nothing either.
        assert_eq!(press.key(38, false, RIGHT_CTRL, KeyClass::Ordinary), None);
        assert_eq!(press.key(38, true, RIGHT_CTRL, KeyClass::Ordinary), Some(KeyEdge::OtherKey));
    }

    #[test]
    fn with_the_hold_key_off_nothing_is_reported() {
        let mut press = Press::default();
        assert_eq!(press.key(105, true, None, KeyClass::Modifier), None);
        assert_eq!(press.key(38, true, None, KeyClass::Ordinary), None);
        assert_eq!(press.key(105, false, None, KeyClass::Modifier), None);
    }

    #[test]
    fn a_lost_connection_ends_the_press_in_progress() {
        let mut press = Press::default();
        assert_eq!(press.abandon(), None);
        press.key(105, true, RIGHT_CTRL, KeyClass::Modifier);
        assert_eq!(press.abandon(), Some(KeyEdge::Up));
        assert_eq!(press.abandon(), None);
        // And the key can be pressed again afterwards.
        assert_eq!(press.key(105, true, RIGHT_CTRL, KeyClass::Modifier), Some(KeyEdge::Down));
    }

    #[test]
    fn the_classes_come_from_the_mapping() {
        let map = us();
        let mut press = Press::default();
        press.key(105, true, RIGHT_CTRL, map.class(105));
        assert_eq!(press.key(203, true, RIGHT_CTRL, map.class(203)), None, "Mode_switch is a modifier");
        assert_eq!(map.base(203), XK_MODE_SWITCH);
        assert_eq!(press.key(55, true, RIGHT_CTRL, map.class(55)), Some(KeyEdge::OtherKey));
    }
}

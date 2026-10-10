//! Which key is the hold key on Windows, with no OS types.
//!
//! On the wire a key is named by its macOS virtual keycode (`holdkey <n>`,
//! section 4 of the contract): the number names the physical key, and each
//! helper maps it to what its own OS calls that key. This file is the Windows
//! side of that table.
//!
//! | `holdkey` | Key          | Windows virtual key | Offered in `holdKeys` |
//! |-----------|--------------|---------------------|-----------------------|
//! | 62        | Right Ctrl   | VK_RCONTROL 0xA3    | yes (the default)     |
//! | 61        | Right Alt    | VK_RMENU 0xA5       | yes                   |
//! | 60        | Right Shift  | VK_RSHIFT 0xA1      | yes                   |
//! | 57        | Caps Lock    | VK_CAPITAL 0x14     | yes                   |
//! | 54        | Right Win    | VK_RWIN 0x5C        | accepted              |
//! | 59        | Left Ctrl    | VK_LCONTROL 0xA2    | accepted              |
//! | 58        | Left Alt     | VK_LMENU 0xA4       | accepted              |
//! | 56        | Left Shift   | VK_LSHIFT 0xA0      | accepted              |
//! | 55        | Left Win     | VK_LWIN 0x5B        | accepted              |
//! | 105, 107, 113, 106, 64, 79, 80, 90 | F13 to F20 | VK_F13 0x7C to VK_F20 0x83 | accepted |
//! | 63 (fn) and anything else | (no such key) | read as the default, Right Ctrl | |
//!
//! There is no fn key: keyboards resolve it in firmware and Windows never
//! sees it. Main's stored default is 63, so 63 means "the default key" here,
//! the same way the macOS helpers read an unknown keycode as fn.

// winuser.h virtual-key codes.
pub const VK_CAPITAL: u32 = 0x14;
pub const VK_LWIN: u32 = 0x5B;
pub const VK_RWIN: u32 = 0x5C;
pub const VK_F13: u32 = 0x7C;
pub const VK_SHIFT: u32 = 0x10;
pub const VK_CONTROL: u32 = 0x11;
pub const VK_MENU: u32 = 0x12;
pub const VK_LSHIFT: u32 = 0xA0;
pub const VK_RSHIFT: u32 = 0xA1;
pub const VK_LCONTROL: u32 = 0xA2;
pub const VK_RCONTROL: u32 = 0xA3;
pub const VK_LMENU: u32 = 0xA4;
pub const VK_RMENU: u32 = 0xA5;
/// A key with no meaning at all, sent to make a lone Alt or Win release look
/// like the end of a combination (AutoHotkey's default "menu mask key").
pub const VK_MASK: u32 = 0xE8;

/// `dwExtraInfo` on every key event this process injects (the paste chord,
/// typed text, the mask key), so the hook can tell them from the user's.
/// Events injected by other programs (key remappers) carry something else and
/// are treated as real keys.
pub const INJECTED_TAG: usize = 0x5155_494C; // "QUIL"

/// The keys Settings offers, as wire keycodes: Right Ctrl, Right Alt, Right
/// Shift, Caps Lock.
pub const HOLD_KEYS: [u32; 4] = [62, 61, 60, 57];

/// The hold key until main says otherwise, and for a keycode with no key here.
pub const DEFAULT_KEY: u32 = 62;

/// macOS keycodes of F13 to F20, in that order.
const F_KEYS: [u32; 8] = [105, 107, 113, 106, 64, 79, 80, 90];

/// The Windows virtual key for a wire keycode.
pub fn vk_for(keycode: u32) -> u32 {
    match keycode {
        62 => VK_RCONTROL,
        59 => VK_LCONTROL,
        61 => VK_RMENU,
        58 => VK_LMENU,
        60 => VK_RSHIFT,
        56 => VK_LSHIFT,
        54 => VK_RWIN,
        55 => VK_LWIN,
        57 => VK_CAPITAL,
        other => match F_KEYS.iter().position(|&f| f == other) {
            Some(index) => VK_F13 + index as u32,
            None => VK_RCONTROL,
        },
    }
}

/// What Windows itself does with a lone press of the key, and so what has to
/// be kept from it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Quiet {
    /// Nothing happens on a lone press (Ctrl, Shift, F13 and up): every event
    /// passes untouched.
    Nothing,
    /// A lone release opens something (Alt: the menu bar; Win: Start). The
    /// press and release still pass, so combinations keep working, but a
    /// standalone release is preceded by the mask key.
    Mask,
    /// The press itself acts (Caps Lock toggles): both edges are swallowed.
    Swallow,
}

pub fn quiet_for(vk: u32) -> Quiet {
    match vk {
        VK_LMENU | VK_RMENU | VK_LWIN | VK_RWIN => Quiet::Mask,
        VK_CAPITAL => Quiet::Swallow,
        _ => Quiet::Nothing,
    }
}

/// Modifier keys never make a press "a combination" by themselves: Right Ctrl
/// then Shift is still waiting for the key that matters.
pub fn is_modifier(vk: u32) -> bool {
    matches!(
        vk,
        VK_SHIFT | VK_CONTROL | VK_MENU | VK_LSHIFT | VK_RSHIFT | VK_LCONTROL | VK_RCONTROL | VK_LMENU | VK_RMENU | VK_LWIN
            | VK_RWIN | VK_CAPITAL | VK_MASK
    )
}

/// On layouts with AltGr, Windows announces a Right Alt press with a made-up
/// Left Ctrl event carrying this scan code. It is not a key anyone pressed.
pub fn is_altgr_phantom(vk: u32, scan: u32) -> bool {
    vk == VK_LCONTROL && scan == 0x21D
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_offered_key_has_its_own_virtual_key() {
        assert_eq!(HOLD_KEYS.map(vk_for), [VK_RCONTROL, VK_RMENU, VK_RSHIFT, VK_CAPITAL]);
        assert!(HOLD_KEYS.contains(&DEFAULT_KEY));
        assert_eq!(vk_for(DEFAULT_KEY), VK_RCONTROL);
    }

    #[test]
    fn left_and_right_are_told_apart() {
        assert_eq!((vk_for(62), vk_for(59)), (0xA3, 0xA2));
        assert_eq!((vk_for(61), vk_for(58)), (0xA5, 0xA4));
        assert_eq!((vk_for(60), vk_for(56)), (0xA1, 0xA0));
        assert_eq!((vk_for(54), vk_for(55)), (0x5C, 0x5B));
    }

    #[test]
    fn fn_and_unknown_keycodes_read_as_the_default() {
        // 63 is what main has stored until the user picks a key.
        for keycode in [63, 0, 1, 200, 9999] {
            assert_eq!(vk_for(keycode), VK_RCONTROL, "{keycode}");
        }
    }

    #[test]
    fn function_keys_thirteen_to_twenty() {
        assert_eq!(vk_for(105), 0x7C); // F13
        assert_eq!(vk_for(107), 0x7D); // F14
        assert_eq!(vk_for(113), 0x7E); // F15
        assert_eq!(vk_for(106), 0x7F); // F16
        assert_eq!(vk_for(64), 0x80); // F17
        assert_eq!(vk_for(79), 0x81); // F18
        assert_eq!(vk_for(80), 0x82); // F19
        assert_eq!(vk_for(90), 0x83); // F20
    }

    #[test]
    fn only_keys_with_an_action_of_their_own_are_kept_quiet() {
        assert_eq!(quiet_for(VK_RCONTROL), Quiet::Nothing);
        assert_eq!(quiet_for(VK_RSHIFT), Quiet::Nothing);
        assert_eq!(quiet_for(VK_F13), Quiet::Nothing);
        assert_eq!(quiet_for(VK_RMENU), Quiet::Mask);
        assert_eq!(quiet_for(VK_LMENU), Quiet::Mask);
        assert_eq!(quiet_for(VK_RWIN), Quiet::Mask);
        assert_eq!(quiet_for(VK_CAPITAL), Quiet::Swallow);
    }

    #[test]
    fn modifiers_and_the_mask_key_are_not_other_keys() {
        for vk in [VK_LSHIFT, VK_RSHIFT, VK_LCONTROL, VK_RCONTROL, VK_LMENU, VK_RMENU, VK_LWIN, VK_RWIN, VK_CAPITAL, VK_MASK] {
            assert!(is_modifier(vk), "{vk:#x}");
        }
        for vk in [0x41, 0x56, 0x0D, 0x20, 0x70, VK_F13] {
            assert!(!is_modifier(vk), "{vk:#x}");
        }
    }

    #[test]
    fn the_altgr_phantom_is_recognised_by_its_scan_code() {
        assert!(is_altgr_phantom(VK_LCONTROL, 0x21D));
        assert!(!is_altgr_phantom(VK_LCONTROL, 0x1D)); // a real Left Ctrl
        assert!(!is_altgr_phantom(VK_RCONTROL, 0x21D));
    }
}

//! The X server's keyboard mapping as plain data: which keysyms each keycode
//! carries. No X types, so the lookups the hold key and the paste chord rest
//! on can be tested without a server.
//!
//! X11 has two numbers for a key. A keycode (8 to 255) names the physical
//! key; with the evdev driver every Linux desktop uses it is the kernel's
//! code plus 8, whatever the layout. A keysym names what the key means
//! (`Control_R`, `v`) and depends on the layout.

/// The empty slot in a mapping.
pub const NO_SYMBOL: u32 = 0;

pub const XK_RETURN: u32 = 0xff0d;
pub const XK_TAB: u32 = 0xff09;
pub const XK_INSERT: u32 = 0xff63;
pub const XK_SHIFT_L: u32 = 0xffe1;
pub const XK_SHIFT_R: u32 = 0xffe2;
pub const XK_CONTROL_L: u32 = 0xffe3;
pub const XK_CONTROL_R: u32 = 0xffe4;
pub const XK_META_L: u32 = 0xffe7;
pub const XK_META_R: u32 = 0xffe8;
pub const XK_ALT_L: u32 = 0xffe9;
pub const XK_ALT_R: u32 = 0xffea;
pub const XK_SUPER_L: u32 = 0xffeb;
pub const XK_SUPER_R: u32 = 0xffec;
pub const XK_ISO_LEVEL3_SHIFT: u32 = 0xfe03;
pub const XK_MODE_SWITCH: u32 = 0xff7e;
pub const XK_NUM_LOCK: u32 = 0xff7f;
pub const XK_V: u32 = 0x0076;

/// True for the keysyms of keys that only change what other keys do: both
/// shifts, controls, alts, metas, supers and hypers, the locks, AltGr and the
/// group switches. Pressing one of these while the hold key is down does not
/// make the press a shortcut.
pub fn is_modifier_keysym(keysym: u32) -> bool {
    matches!(keysym,
        // Shift_L to Hyper_R, with Caps_Lock and Shift_Lock among them.
        0xffe1..=0xffee
        // ISO_Lock to ISO_Last_Group_Lock: level 3 and 5 shifts, group switches.
        | 0xfe01..=0xfe13
        | XK_MODE_SWITCH
        | XK_NUM_LOCK)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyClass {
    /// Carries no keysym at all: pressing it does nothing anywhere.
    Unmapped,
    Modifier,
    /// Anything that types or acts: a letter, a function key, an arrow.
    Ordinary,
}

/// One snapshot of the mapping, as `GetKeyboardMapping` returns it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Keymap {
    first: u8,
    per: usize,
    syms: Vec<u32>,
}

impl Keymap {
    /// `syms` holds `per_keycode` keysyms for each keycode from `first_keycode`
    /// on. A trailing partial row is ignored.
    pub fn new(first_keycode: u8, per_keycode: u8, syms: Vec<u32>) -> Self {
        Self { first: first_keycode, per: usize::from(per_keycode), syms }
    }

    fn rows(&self) -> usize {
        if self.per == 0 {
            0
        } else {
            (self.syms.len() / self.per).min(256 - usize::from(self.first))
        }
    }

    pub fn is_empty(&self) -> bool {
        self.rows() == 0
    }

    /// Every keycode the mapping covers, lowest first.
    pub fn keycodes(&self) -> impl Iterator<Item = u8> + '_ {
        (0..self.rows()).map(|row| self.first + row as u8)
    }

    /// The keysyms of one keycode, in column order (plain, shifted, then the
    /// second group). Empty for a keycode outside the mapping.
    pub fn syms(&self, keycode: u32) -> &[u32] {
        let Some(row) = keycode.checked_sub(u32::from(self.first)).map(|row| row as usize) else { return &[] };
        if row >= self.rows() {
            return &[];
        }
        &self.syms[row * self.per..(row + 1) * self.per]
    }

    /// What the key means with nothing held: its first keysym that is set.
    pub fn base(&self, keycode: u32) -> u32 {
        self.syms(keycode).iter().copied().find(|&sym| sym != NO_SYMBOL).unwrap_or(NO_SYMBOL)
    }

    pub fn class(&self, keycode: u32) -> KeyClass {
        match self.base(keycode) {
            NO_SYMBOL => KeyClass::Unmapped,
            sym if is_modifier_keysym(sym) => KeyClass::Modifier,
            _ => KeyClass::Ordinary,
        }
    }

    /// The lowest keycode whose plain (first column) keysym is `keysym`.
    pub fn with_plain(&self, keysym: u32) -> Option<u8> {
        self.keycodes().find(|&keycode| self.syms(u32::from(keycode)).first() == Some(&keysym))
    }

    /// The lowest keycode that carries `keysym` in any column: on a layout
    /// with two groups (Russian with Latin second) `v` is only in the second.
    pub fn with_any(&self, keysym: u32) -> Option<u8> {
        self.keycodes().find(|&keycode| self.syms(u32::from(keycode)).contains(&keysym))
    }

    /// The highest keycode that carries nothing, for typing through a
    /// temporary mapping. Highest, because the low unused codes are the ones
    /// a hardware key is most likely to send after all.
    pub fn spare(&self) -> Option<u8> {
        let mut spare = None;
        for keycode in self.keycodes() {
            if self.class(u32::from(keycode)) == KeyClass::Unmapped {
                spare = Some(keycode);
            }
        }
        spare
    }
}

#[cfg(test)]
pub mod testing {
    use super::*;

    /// A cut-down US layout with evdev keycodes, four columns per key, built
    /// from `(keycode, [keysyms])` rows; keycodes not listed carry nothing.
    pub fn keymap(rows: &[(u8, &[u32])]) -> Keymap {
        const FIRST: u8 = 8;
        const PER: usize = 4;
        let mut syms = vec![NO_SYMBOL; (256 - FIRST as usize) * PER];
        for (keycode, row) in rows {
            let at = usize::from(*keycode - FIRST) * PER;
            syms[at..at + row.len()].copy_from_slice(row);
        }
        Keymap::new(FIRST, PER as u8, syms)
    }

    /// What `xmodmap -pke` shows on a US keyboard, the rows that matter here.
    pub fn us() -> Keymap {
        keymap(&[
            (36, &[XK_RETURN]),
            (37, &[XK_CONTROL_L]),
            (38, &[0x61, 0x41]),
            (50, &[XK_SHIFT_L]),
            (55, &[XK_V, 0x56]),
            (62, &[XK_SHIFT_R]),
            (64, &[XK_ALT_L, XK_META_L]),
            (66, &[0xffe5]),
            (67, &[0xffbe]),
            (77, &[XK_NUM_LOCK]),
            (92, &[XK_ISO_LEVEL3_SHIFT]),
            (105, &[XK_CONTROL_R]),
            (108, &[XK_ALT_R, XK_META_R]),
            (118, &[XK_INSERT]),
            (133, &[XK_SUPER_L]),
            (134, &[XK_SUPER_R]),
            (203, &[XK_MODE_SWITCH]),
            (204, &[NO_SYMBOL, XK_ALT_L]),
            (206, &[NO_SYMBOL, XK_SUPER_L]),
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::testing::{keymap, us};
    use super::*;

    #[test]
    fn modifier_keysyms_are_told_from_the_rest() {
        for sym in [XK_SHIFT_L, XK_SHIFT_R, XK_CONTROL_L, XK_CONTROL_R, XK_ALT_L, XK_ALT_R, XK_SUPER_L, XK_SUPER_R] {
            assert!(is_modifier_keysym(sym), "{sym:#x}");
        }
        // Caps Lock, AltGr, Mode_switch, Num Lock, ISO_Next_Group, Hyper_R.
        for sym in [0xffe5, XK_ISO_LEVEL3_SHIFT, XK_MODE_SWITCH, XK_NUM_LOCK, 0xfe08, 0xffee] {
            assert!(is_modifier_keysym(sym), "{sym:#x}");
        }
        // a, V, Return, Escape, F1, Left, space, Insert, Multi_key (compose).
        for sym in [0x61, 0x56, XK_RETURN, 0xff1b, 0xffbe, 0xff51, 0x20, XK_INSERT, 0xff20, NO_SYMBOL] {
            assert!(!is_modifier_keysym(sym), "{sym:#x}");
        }
    }

    #[test]
    fn a_keycode_is_read_by_its_columns() {
        let map = us();
        assert_eq!(map.syms(38), &[0x61, 0x41, 0, 0]);
        assert_eq!(map.base(38), 0x61);
        // Column 0 empty: the first keysym that is set speaks for the key.
        assert_eq!(map.base(206), XK_SUPER_L);
        assert_eq!(map.base(200), NO_SYMBOL);
    }

    #[test]
    fn keycodes_outside_the_mapping_are_empty_not_a_panic() {
        let map = us();
        assert!(map.syms(7).is_empty());
        assert!(map.syms(0).is_empty());
        assert!(map.syms(256).is_empty());
        assert!(map.syms(u32::MAX).is_empty());
        assert_eq!(map.syms(8).len(), 4);
        assert_eq!(map.syms(255).len(), 4);
        assert_eq!(map.class(4000), KeyClass::Unmapped);
    }

    #[test]
    fn keys_are_classed_for_the_other_key_rule() {
        let map = us();
        assert_eq!(map.class(105), KeyClass::Modifier);
        assert_eq!(map.class(66), KeyClass::Modifier);
        assert_eq!(map.class(206), KeyClass::Modifier);
        assert_eq!(map.class(38), KeyClass::Ordinary);
        assert_eq!(map.class(67), KeyClass::Ordinary);
        assert_eq!(map.class(36), KeyClass::Ordinary);
        assert_eq!(map.class(250), KeyClass::Unmapped);
    }

    #[test]
    fn a_keysym_is_found_by_its_plain_column_first() {
        let map = us();
        assert_eq!(map.with_plain(XK_V), Some(55));
        assert_eq!(map.with_plain(XK_CONTROL_R), Some(105));
        // Alt_L is plain on 64 and shifted on the fake keycode 204.
        assert_eq!(map.with_plain(XK_ALT_L), Some(64));
        assert_eq!(map.with_plain(XK_META_L), None);
        assert_eq!(map.with_any(XK_META_L), Some(64));
        assert_eq!(map.with_any(0x1234), None);
    }

    #[test]
    fn a_latin_letter_in_the_second_group_is_still_found() {
        // Russian first, Latin second: keycode 55 is Cyrillic em, then v.
        let map = keymap(&[(55, &[0x6cd, 0x6ed, XK_V, 0x56])]);
        assert_eq!(map.with_plain(XK_V), None);
        assert_eq!(map.with_any(XK_V), Some(55));
    }

    #[test]
    fn the_spare_keycode_is_the_highest_unused_one() {
        assert_eq!(us().spare(), Some(255));
        let full = Keymap::new(8, 1, vec![0x61; 248]);
        assert_eq!(full.spare(), None);
        let mut syms = vec![0x61; 248];
        syms[10] = NO_SYMBOL;
        assert_eq!(Keymap::new(8, 1, syms).spare(), Some(18));
    }

    #[test]
    fn odd_shapes_do_not_panic() {
        let empty = Keymap::default();
        assert!(empty.is_empty());
        assert_eq!(empty.keycodes().count(), 0);
        assert_eq!(empty.spare(), None);
        assert!(empty.syms(40).is_empty());
        // A reply cut short: the partial last row is ignored.
        let short = Keymap::new(8, 4, vec![0x61, 0x41, 0, 0, 0x62]);
        assert_eq!(short.keycodes().collect::<Vec<_>>(), vec![8]);
        // More rows than keycodes exist: nothing wraps past 255.
        let long = Keymap::new(250, 1, vec![0x61; 40]);
        assert_eq!(long.keycodes().last(), Some(255));
        assert_eq!(long.keycodes().count(), 6);
    }
}

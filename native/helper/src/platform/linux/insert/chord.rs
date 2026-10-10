//! Which keys paste into the focused window, and in what order they are
//! posted. No X types: `insert.rs` reads the window's class, the keyboard
//! mapping and the keys held down, and this decides what to do with them.

use super::super::keymap::{
    Keymap, XK_ALT_L, XK_ALT_R, XK_CONTROL_L, XK_CONTROL_R, XK_INSERT, XK_ISO_LEVEL3_SHIFT, XK_META_L, XK_META_R,
    XK_MODE_SWITCH, XK_SHIFT_L, XK_SHIFT_R, XK_SUPER_L, XK_SUPER_R, XK_V,
};

const XK_HYPER_L: u32 = 0xffed;
const XK_HYPER_R: u32 = 0xffee;
const XK_ISO_LEVEL5_SHIFT: u32 = 0xfe11;

/// The keycodes these keys have on an evdev keyboard, for a mapping that
/// (against all odds) does not carry their keysyms.
const PHYSICAL_CONTROL_L: u8 = 37;
const PHYSICAL_SHIFT_L: u8 = 50;
const PHYSICAL_V: u8 = 55;
const PHYSICAL_INSERT: u8 = 118;

/// The paste shortcut of the app in front.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Chord {
    /// Nearly everything.
    CtrlV,
    /// Terminal emulators, where Ctrl+V means "take the next key literally".
    CtrlShiftV,
    /// The old X way, for the apps that know neither of the above: xterm and
    /// urxvt (which paste the PRIMARY selection with it), Emacs and gVim
    /// (where Ctrl+V scrolls or starts a block selection).
    ShiftInsert,
}

impl Chord {
    /// True when the app pastes the PRIMARY selection with this chord, so
    /// the text has to be staged there as well as on the clipboard.
    pub fn reads_primary(self) -> bool {
        self == Chord::ShiftInsert
    }
}

/// Terminals that paste the clipboard with Ctrl+Shift+V. Matched against the
/// window's class and instance name, lower-cased.
const CTRL_SHIFT_V: &[&str] = &[
    "alacritty",
    "blackbox",
    "contour",
    "cool-retro-term",
    "cosmic-term",
    "deepin-terminal",
    "foot",
    "footclient",
    "ghostty",
    "gnome-terminal",
    "gnome-terminal-server",
    "guake",
    "hyper",
    "kgx",
    "kitty",
    "konsole",
    "lxterminal",
    "mate-terminal",
    "ptyxis",
    "qterminal",
    "rio",
    "roxterm",
    "sakura",
    "st",
    "st-256color",
    "tabby",
    "terminator",
    "terminology",
    "termite",
    "tilda",
    "tilix",
    "warp",
    "wezterm",
    "wezterm-gui",
    "xfce4-terminal",
    "yakuake",
    // Reverse-DNS names whose last part is too plain to match on by itself.
    "org.gnome.console",
    "io.elementary.terminal",
];

/// Apps that only take Shift+Insert.
const SHIFT_INSERT: &[&str] = &["xterm", "uxterm", "urxvt", "rxvt", "emacs", "gvim"];

/// The two strings of a `WM_CLASS` property: the instance name, then the
/// class, each ended by a NUL. Missing parts come back empty.
pub fn parse_wm_class(value: &[u8]) -> (String, String) {
    let mut parts = value.split(|&byte| byte == 0).map(|part| String::from_utf8_lossy(part).into_owned());
    let instance = parts.next().unwrap_or_default();
    let class = parts.next().unwrap_or_default();
    (instance, class)
}

/// A name as the lists spell it: lower case, and for a reverse-DNS app id
/// (`org.wezfurlong.wezterm`, `com.mitchellh.ghostty`) its last part too.
fn spellings(name: &str) -> Vec<String> {
    let whole = name.trim().to_lowercase();
    let last = whole.rsplit('.').next().unwrap_or_default().to_string();
    if last.is_empty() || last == whole {
        vec![whole]
    } else {
        vec![whole, last]
    }
}

/// The chord for a window with this `WM_CLASS`. A window that names no class
/// is treated like any other app.
pub fn chord_for(instance: &str, class: &str) -> Chord {
    let names: Vec<String> = spellings(class).into_iter().chain(spellings(instance)).filter(|name| !name.is_empty()).collect();
    let listed = |list: &[&str]| names.iter().any(|name| list.contains(&name.as_str()));
    if listed(SHIFT_INSERT) {
        Chord::ShiftInsert
    } else if listed(CTRL_SHIFT_V) {
        Chord::CtrlShiftV
    } else {
        Chord::CtrlV
    }
}

/// The keys of one paste, as keycodes of the current mapping.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    /// Modifiers the user is still holding that would change the chord's
    /// meaning (Alt held while Ctrl+V goes out). Released first, not pressed
    /// again: the key is physically down, and its real release ends it.
    pub release_first: Vec<u8>,
    /// Held around the key, pressed in this order.
    pub modifiers: Vec<u8>,
    pub key: u8,
}

fn keycode(keymap: &Keymap, keysym: u32, physical: u8) -> u8 {
    keymap.with_plain(keysym).or_else(|| keymap.with_any(keysym)).unwrap_or(physical)
}

/// True when bit `keycode` is set in a `QueryKeymap` reply.
pub fn is_held(held: &[u8; 32], keycode: u8) -> bool {
    held[usize::from(keycode / 8)] & (1 << (keycode % 8)) != 0
}

/// The held keys that are shift-like modifiers (never the locks: "releasing"
/// caps lock would be pressing it), leaving out those the chord itself uses.
fn stray_modifiers(keymap: &Keymap, held: &[u8; 32], keep: &[u32]) -> Vec<u8> {
    const RELEASABLE: [u32; 15] = [
        XK_SHIFT_L,
        XK_SHIFT_R,
        XK_CONTROL_L,
        XK_CONTROL_R,
        XK_META_L,
        XK_META_R,
        XK_ALT_L,
        XK_ALT_R,
        XK_SUPER_L,
        XK_SUPER_R,
        XK_HYPER_L,
        XK_HYPER_R,
        XK_ISO_LEVEL3_SHIFT,
        XK_ISO_LEVEL5_SHIFT,
        XK_MODE_SWITCH,
    ];
    keymap
        .keycodes()
        .filter(|&keycode| is_held(held, keycode))
        .filter(|&keycode| {
            let sym = keymap.base(u32::from(keycode));
            RELEASABLE.contains(&sym) && !keep.contains(&sym)
        })
        .collect()
}

/// Works out the keys for `chord`. `held` is the server's view of which keys
/// are down (`QueryKeymap`).
pub fn plan(chord: Chord, keymap: &Keymap, held: &[u8; 32]) -> Plan {
    let control = keycode(keymap, XK_CONTROL_L, PHYSICAL_CONTROL_L);
    let shift = keycode(keymap, XK_SHIFT_L, PHYSICAL_SHIFT_L);
    // The key that types `v` in this layout, wherever it sits (Dvorak has it
    // elsewhere; a Cyrillic layout has it in the second group of the same key).
    let v = keycode(keymap, XK_V, PHYSICAL_V);
    let insert = keycode(keymap, XK_INSERT, PHYSICAL_INSERT);
    const CONTROLS: [u32; 2] = [XK_CONTROL_L, XK_CONTROL_R];
    const SHIFTS: [u32; 2] = [XK_SHIFT_L, XK_SHIFT_R];
    let (modifiers, key, keep): (Vec<u8>, u8, Vec<u32>) = match chord {
        Chord::CtrlV => (vec![control], v, CONTROLS.to_vec()),
        Chord::CtrlShiftV => (vec![control, shift], v, [CONTROLS, SHIFTS].concat()),
        Chord::ShiftInsert => (vec![shift], insert, SHIFTS.to_vec()),
    };
    Plan { release_first: stray_modifiers(keymap, held, &keep), modifiers, key }
}

/// The modifiers to let go of before typing text key by key: all of them.
pub fn release_for_typing(keymap: &Keymap, held: &[u8; 32]) -> Vec<u8> {
    stray_modifiers(keymap, held, &[])
}

impl Plan {
    /// Every key event of the chord in order: `(keycode, pressed)`.
    pub fn steps(&self) -> Vec<(u8, bool)> {
        let mut steps: Vec<(u8, bool)> = self.release_first.iter().map(|&keycode| (keycode, false)).collect();
        steps.extend(self.modifiers.iter().map(|&keycode| (keycode, true)));
        steps.push((self.key, true));
        steps.push((self.key, false));
        steps.extend(self.modifiers.iter().rev().map(|&keycode| (keycode, false)));
        steps
    }
}

#[cfg(test)]
mod tests {
    use super::super::super::keymap::testing::{keymap, us};
    use super::*;

    fn holding(keycodes: &[u8]) -> [u8; 32] {
        let mut held = [0u8; 32];
        for &keycode in keycodes {
            held[usize::from(keycode / 8)] |= 1 << (keycode % 8);
        }
        held
    }

    #[test]
    fn wm_class_is_two_nul_ended_strings() {
        assert_eq!(parse_wm_class(b"gnome-terminal-server\0Gnome-terminal\0"), ("gnome-terminal-server".into(), "Gnome-terminal".into()));
        assert_eq!(parse_wm_class(b"Navigator\0firefox\0"), ("Navigator".into(), "firefox".into()));
        assert_eq!(parse_wm_class(b"xterm"), ("xterm".into(), String::new()));
        assert_eq!(parse_wm_class(b""), (String::new(), String::new()));
        assert_eq!(parse_wm_class(b"\0\0"), (String::new(), String::new()));
        // Not UTF-8: read as far as it goes, never a panic.
        assert_eq!(parse_wm_class(b"caf\xe9\0Caf\xe9\0").1, "Caf\u{fffd}");
    }

    #[test]
    fn ordinary_apps_paste_with_ctrl_v() {
        for (instance, class) in [
            ("Navigator", "firefox"),
            ("google-chrome", "Google-chrome"),
            ("code", "Code"),
            ("slack", "Slack"),
            ("gedit", "Gedit"),
            ("libreoffice", "libreoffice-writer"),
            ("", ""),
        ] {
            assert_eq!(chord_for(instance, class), Chord::CtrlV, "{instance} / {class}");
        }
    }

    #[test]
    fn terminals_paste_with_ctrl_shift_v() {
        for (instance, class) in [
            ("gnome-terminal-server", "Gnome-terminal"),
            ("konsole", "konsole"),
            ("Alacritty", "Alacritty"),
            ("kitty", "kitty"),
            ("org.wezfurlong.wezterm", "org.wezfurlong.wezterm"),
            ("com.mitchellh.ghostty", "com.mitchellh.ghostty"),
            ("xfce4-terminal", "Xfce4-terminal"),
            ("tilix", "Tilix"),
            ("terminator", "Terminator"),
            ("foot", "foot"),
            ("st-256color", "st-256color"),
            ("kgx", "org.gnome.Console"),
            ("org.gnome.Ptyxis", "org.gnome.Ptyxis"),
            ("io.elementary.terminal", "Io.elementary.terminal"),
        ] {
            assert_eq!(chord_for(instance, class), Chord::CtrlShiftV, "{instance} / {class}");
        }
    }

    #[test]
    fn the_old_guard_pastes_with_shift_insert() {
        for (instance, class) in [("xterm", "XTerm"), ("xterm", "UXTerm"), ("urxvt", "URxvt"), ("emacs", "Emacs"), ("gvim", "Gvim")] {
            let chord = chord_for(instance, class);
            assert_eq!(chord, Chord::ShiftInsert, "{instance} / {class}");
            assert!(chord.reads_primary());
        }
        assert!(!Chord::CtrlV.reads_primary());
        assert!(!Chord::CtrlShiftV.reads_primary());
    }

    #[test]
    fn a_name_that_only_contains_a_terminals_name_is_not_one() {
        // "st" must not catch Steam or Postman; "rio" must not catch a radio app.
        for (instance, class) in [("steam", "Steam"), ("postman", "Postman"), ("radio", "Radio"), ("org.example.Listen", "Listen")] {
            assert_eq!(chord_for(instance, class), Chord::CtrlV, "{instance} / {class}");
        }
    }

    #[test]
    fn ctrl_v_is_four_events_in_order() {
        let plan = plan(Chord::CtrlV, &us(), &holding(&[]));
        assert_eq!(plan, Plan { release_first: vec![], modifiers: vec![37], key: 55 });
        assert_eq!(plan.steps(), vec![(37, true), (55, true), (55, false), (37, false)]);
    }

    #[test]
    fn the_terminal_chord_wraps_shift_inside_control() {
        let plan = plan(Chord::CtrlShiftV, &us(), &holding(&[]));
        assert_eq!(plan.steps(), vec![(37, true), (50, true), (55, true), (55, false), (50, false), (37, false)]);
    }

    #[test]
    fn shift_insert_uses_the_insert_key() {
        let plan = plan(Chord::ShiftInsert, &us(), &holding(&[]));
        assert_eq!(plan.steps(), vec![(50, true), (118, true), (118, false), (50, false)]);
    }

    #[test]
    fn modifiers_the_user_still_holds_are_let_go_first() {
        // Right alt (the hold key, say) and left shift are down.
        let plan = plan(Chord::CtrlV, &us(), &holding(&[108, 50]));
        assert_eq!(plan.release_first, vec![50, 108]);
        assert_eq!(plan.steps()[..3], [(50, false), (108, false), (37, true)]);
    }

    #[test]
    fn modifiers_the_chord_uses_are_left_alone() {
        // Right control held: Ctrl+V is still Ctrl+V.
        assert!(plan(Chord::CtrlV, &us(), &holding(&[105])).release_first.is_empty());
        // Shift held is part of the terminal chord, and of Shift+Insert.
        assert!(plan(Chord::CtrlShiftV, &us(), &holding(&[62, 105])).release_first.is_empty());
        assert_eq!(plan(Chord::ShiftInsert, &us(), &holding(&[62, 105])).release_first, vec![105]);
    }

    #[test]
    fn locks_and_ordinary_keys_are_never_released() {
        // Caps lock, num lock and the letter a are down.
        let plan = plan(Chord::CtrlV, &us(), &holding(&[66, 77, 38]));
        assert!(plan.release_first.is_empty());
    }

    #[test]
    fn typing_lets_go_of_every_modifier() {
        assert_eq!(release_for_typing(&us(), &holding(&[37, 50, 108, 133, 38, 66])), vec![37, 50, 108, 133]);
    }

    #[test]
    fn the_v_key_is_found_where_the_layout_puts_it() {
        // Dvorak: v is on the key QWERTY calls period (keycode 60).
        let dvorak = keymap(&[(37, &[XK_CONTROL_L]), (60, &[XK_V, 0x56]), (55, &[0x6b, 0x4b])]);
        assert_eq!(plan(Chord::CtrlV, &dvorak, &holding(&[])).key, 60);
        // Russian with Latin in the second group: same key as QWERTY.
        let russian = keymap(&[(37, &[XK_CONTROL_L]), (55, &[0x6cd, 0x6ed, XK_V, 0x56])]);
        assert_eq!(plan(Chord::CtrlV, &russian, &holding(&[])).key, 55);
    }

    #[test]
    fn a_mapping_without_the_keys_falls_back_to_the_usual_keycodes() {
        let bare = Keymap::default();
        assert_eq!(plan(Chord::CtrlShiftV, &bare, &holding(&[])), Plan { release_first: vec![], modifiers: vec![37, 50], key: 55 });
        assert_eq!(plan(Chord::ShiftInsert, &bare, &holding(&[])).key, 118);
    }

    #[test]
    fn held_keys_are_read_bit_by_bit() {
        let held = holding(&[8, 105, 255]);
        assert!(is_held(&held, 8) && is_held(&held, 105) && is_held(&held, 255));
        assert!(!is_held(&held, 9) && !is_held(&held, 104));
    }
}

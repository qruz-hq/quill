//! Everything about typing into another app that can be decided without
//! Windows: which chord pastes in the window in front, which keys to send for
//! it, how a text is typed key by key when it cannot be pasted, and when not
//! to try at all. No OS types, so it can be tested as is.

// winuser.h virtual-key codes.
pub const VK_SHIFT: u16 = 0x10;
pub const VK_CONTROL: u16 = 0x11;
pub const VK_MENU: u16 = 0x12;
pub const VK_RETURN: u16 = 0x0D;
pub const VK_INSERT: u16 = 0x2D;
pub const VK_V: u16 = 0x56;
pub const VK_LWIN: u16 = 0x5B;
pub const VK_RWIN: u16 = 0x5C;

// ------------------------------------------------------------- the chord

/// The key combination that pastes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Chord {
    /// Ctrl+V: everything except the terminals below.
    CtrlV,
    /// Shift+Insert: terminals where Ctrl+V is a key for the shell (it means
    /// "quote the next character") and pasting is on Shift+Insert.
    ShiftInsert,
}

/// Programs that paste on Shift+Insert and not on Ctrl+V, by executable name
/// without `.exe`, lower case.
const SHIFT_INSERT_PROGRAMS: [&str; 9] =
    ["mintty", "putty", "kitty", "alacritty", "wezterm-gui", "rxvt", "xterm", "gvim", "emacs"];

/// The same programs by window class, for when the process cannot be read.
const SHIFT_INSERT_CLASSES: [&str; 5] = ["mintty", "PuTTY", "KiTTY", "org.wezfurlong.wezterm", "Vim"];

/// `C:\Program Files\Git\usr\bin\mintty.exe` -> `mintty`.
fn program_name(exe_path: &str) -> String {
    let file = exe_path.rsplit(['\\', '/']).next().unwrap_or(exe_path);
    let lower = file.trim().to_lowercase();
    lower.strip_suffix(".exe").unwrap_or(&lower).to_string()
}

/// Which chord pastes into the window in front, from its window class and
/// the path of the program that owns it (either may be empty: unknown).
///
/// Windows Terminal, the classic console (with its default "Ctrl key
/// shortcuts"), PowerShell and the terminal inside VS Code all paste on
/// Ctrl+V, so they are not listed.
pub fn chord_for(window_class: &str, exe_path: &str) -> Chord {
    let program = program_name(exe_path);
    if SHIFT_INSERT_PROGRAMS.contains(&program.as_str()) || SHIFT_INSERT_CLASSES.contains(&window_class.trim()) {
        Chord::ShiftInsert
    } else {
        Chord::CtrlV
    }
}

/// One key edge to inject.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stroke {
    pub vk: u16,
    pub up: bool,
    /// A key of the navigation cluster (Insert).
    pub extended: bool,
}

const fn down(vk: u16) -> Stroke {
    Stroke { vk, up: false, extended: false }
}

const fn up(vk: u16) -> Stroke {
    Stroke { vk, up: true, extended: false }
}

/// The modifier keys that can be held when the paste is due (the hold key
/// itself may be one of them, still down after a tap that ended a latch).
pub const WATCHED_MODIFIERS: [u16; 8] = [
    0xA0, // left shift
    0xA1, // right shift
    0xA2, // left ctrl
    0xA3, // right ctrl
    0xA4, // left alt
    0xA5, // right alt
    VK_LWIN, VK_RWIN,
];

/// Whether a held `vk` would change what the chord means, so it has to be
/// released first. A held Ctrl is part of Ctrl+V; anything else turns it into
/// another shortcut (Win+Ctrl+V opens the sound output list on Windows 11).
fn interferes(chord: Chord, vk: u16) -> bool {
    let is_ctrl = matches!(vk, 0xA2 | 0xA3 | VK_CONTROL);
    let is_shift = matches!(vk, 0xA0 | 0xA1 | VK_SHIFT);
    match chord {
        Chord::CtrlV => !is_ctrl,
        Chord::ShiftInsert => !is_shift,
    }
}

/// The key events that paste with `chord` when the modifiers in `held` are
/// physically down. `SendInput` does not reset the keyboard's state, so the
/// ones in the way are released first. They are not pressed again: the user's
/// own release of the key then simply finds it up already.
pub fn chord_strokes(chord: Chord, held: &[u16]) -> Vec<Stroke> {
    let mut strokes: Vec<Stroke> = Vec::with_capacity(held.len() + 4);
    for &vk in held {
        // The generic codes mirror the left and right ones; releasing the
        // specific keys is enough.
        if vk != VK_SHIFT && vk != VK_CONTROL && vk != VK_MENU && interferes(chord, vk) {
            strokes.push(up(vk));
        }
    }
    match chord {
        Chord::CtrlV => strokes.extend([down(VK_CONTROL), down(VK_V), up(VK_V), up(VK_CONTROL)]),
        Chord::ShiftInsert => strokes.extend([
            down(VK_SHIFT),
            Stroke { vk: VK_INSERT, up: false, extended: true },
            Stroke { vk: VK_INSERT, up: true, extended: true },
            up(VK_SHIFT),
        ]),
    }
    strokes
}

/// Releases for every held modifier, for typing text: a held Ctrl would turn
/// each letter into a shortcut.
pub fn release_strokes(held: &[u16]) -> Vec<Stroke> {
    held.iter().filter(|&&vk| vk != VK_SHIFT && vk != VK_CONTROL && vk != VK_MENU).map(|&vk| up(vk)).collect()
}

// ----------------------------------------------------- elevated windows

/// Whether typing into the window in front is known to be impossible: it runs
/// as administrator and this helper does not (UIPI drops the keys without an
/// error). `None` is "could not find out", which is not a reason to give up.
pub fn blocked_by_elevation(ours: Option<bool>, theirs: Option<bool>) -> bool {
    theirs == Some(true) && ours != Some(true)
}

// -------------------------------------------------- restoring the clipboard

/// Whether the user's clipboard is put back after the paste. `staged` is the
/// clipboard's sequence number right after the dictation was put on it, `now`
/// the number when the restore is due. If they differ, something else was
/// copied in between (by the user or another program) and that is newer than
/// what was saved.
pub fn should_restore(staged: u32, now: u32) -> bool {
    // 0 means the number could not be read: restore, as the macOS helper does.
    staged == 0 || now == 0 || staged == now
}

// ----------------------------------------------------------------- typing

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// Keys that type these UTF-16 units, one key press per unit.
    Text(Vec<u16>),
    /// The Enter key: a line break typed as a character is ignored by many apps.
    Return,
}

/// One `SendInput` call carries at most this many units (two events each), so
/// a slow app is never handed thousands of events at once.
pub const MAX_UNITS: usize = 32;

/// `text` as key presses, in order. A surrogate pair stays in one run: split
/// in two calls, another program's input could land between its halves.
/// `\r\n` and `\r` count as one line break.
pub fn typing_plan(text: &str) -> Vec<Step> {
    let mut steps = Vec::new();
    let mut chunk: Vec<u16> = Vec::with_capacity(MAX_UNITS);
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\n' || c == '\r' {
            if c == '\r' && chars.peek() == Some(&'\n') {
                chars.next();
            }
            if !chunk.is_empty() {
                steps.push(Step::Text(std::mem::take(&mut chunk)));
            }
            steps.push(Step::Return);
            continue;
        }
        if chunk.len() + c.len_utf16() > MAX_UNITS {
            steps.push(Step::Text(std::mem::take(&mut chunk)));
        }
        let mut units = [0u16; 2];
        chunk.extend_from_slice(c.encode_utf16(&mut units));
    }
    if !chunk.is_empty() {
        steps.push(Step::Text(chunk));
    }
    steps
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- terminal detection

    #[test]
    fn ordinary_apps_paste_with_ctrl_v() {
        for (class, exe) in [
            ("Notepad", r"C:\Windows\System32\notepad.exe"),
            ("Chrome_WidgetWin_1", r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
            ("Chrome_WidgetWin_1", r"C:\Users\me\AppData\Local\Programs\Microsoft VS Code\Code.exe"),
            ("OpusApp", r"C:\Program Files\Microsoft Office\root\Office16\WINWORD.EXE"),
            ("", ""),
        ] {
            assert_eq!(chord_for(class, exe), Chord::CtrlV, "{class} {exe}");
        }
    }

    #[test]
    fn windows_own_terminals_paste_with_ctrl_v() {
        assert_eq!(chord_for("CASCADIA_HOSTING_WINDOW_CLASS", r"C:\Program Files\WindowsApps\Terminal\WindowsTerminal.exe"), Chord::CtrlV);
        assert_eq!(chord_for("ConsoleWindowClass", r"C:\Windows\System32\conhost.exe"), Chord::CtrlV);
        assert_eq!(chord_for("ConsoleWindowClass", r"C:\Windows\System32\cmd.exe"), Chord::CtrlV);
        assert_eq!(chord_for("ConsoleWindowClass", r"C:\Program Files\PowerShell\7\pwsh.exe"), Chord::CtrlV);
    }

    #[test]
    fn unix_style_terminals_paste_with_shift_insert() {
        for exe in [
            r"C:\Program Files\Git\usr\bin\mintty.exe",
            r"C:\Program Files\PuTTY\putty.exe",
            r"C:\Program Files\Alacritty\alacritty.exe",
            r"C:\Program Files\WezTerm\wezterm-gui.exe",
            r"C:\tools\KiTTY\kitty.exe",
            "C:/msys64/usr/bin/mintty.exe",
            r"D:\Apps\MINTTY.EXE",
        ] {
            assert_eq!(chord_for("", exe), Chord::ShiftInsert, "{exe}");
        }
    }

    #[test]
    fn the_window_class_is_enough_when_the_process_cannot_be_read() {
        assert_eq!(chord_for("mintty", ""), Chord::ShiftInsert);
        assert_eq!(chord_for("PuTTY", ""), Chord::ShiftInsert);
        assert_eq!(chord_for("org.wezfurlong.wezterm", ""), Chord::ShiftInsert);
    }

    #[test]
    fn a_name_that_only_contains_a_terminal_is_not_one() {
        assert_eq!(chord_for("", r"C:\Tools\puttygen.exe"), Chord::CtrlV);
        assert_eq!(chord_for("", r"C:\mintty\notes.exe"), Chord::CtrlV);
        assert_eq!(chord_for("PuTTYConfigBox2", ""), Chord::CtrlV);
    }

    #[test]
    fn program_names_lose_their_folder_and_extension() {
        assert_eq!(program_name(r"C:\a\b\Code.exe"), "code");
        assert_eq!(program_name("mintty"), "mintty");
        assert_eq!(program_name(""), "");
    }

    // ---- the chord

    #[test]
    fn ctrl_v_with_nothing_held() {
        assert_eq!(chord_strokes(Chord::CtrlV, &[]), vec![down(VK_CONTROL), down(VK_V), up(VK_V), up(VK_CONTROL)]);
    }

    #[test]
    fn shift_insert_marks_insert_as_extended() {
        let strokes = chord_strokes(Chord::ShiftInsert, &[]);
        assert_eq!(strokes.len(), 4);
        assert_eq!(strokes[0], down(VK_SHIFT));
        assert_eq!(strokes[1], Stroke { vk: VK_INSERT, up: false, extended: true });
        assert_eq!(strokes[2], Stroke { vk: VK_INSERT, up: true, extended: true });
        assert_eq!(strokes[3], up(VK_SHIFT));
    }

    #[test]
    fn modifiers_in_the_way_are_released_first() {
        // Right Shift (the hold key, still down) and Left Win.
        let strokes = chord_strokes(Chord::CtrlV, &[0xA1, VK_SHIFT, VK_LWIN]);
        assert_eq!(strokes[..2], [up(0xA1), up(VK_LWIN)]);
        assert_eq!(strokes[2..], [down(VK_CONTROL), down(VK_V), up(VK_V), up(VK_CONTROL)]);
    }

    #[test]
    fn a_held_ctrl_is_left_alone_for_ctrl_v_and_released_for_shift_insert() {
        // Right Ctrl, the default hold key.
        assert_eq!(chord_strokes(Chord::CtrlV, &[0xA3, VK_CONTROL]).len(), 4);
        let strokes = chord_strokes(Chord::ShiftInsert, &[0xA3, VK_CONTROL]);
        assert_eq!(strokes[0], up(0xA3));
        assert_eq!(strokes.len(), 5);
        // And a held Shift the other way round.
        assert_eq!(chord_strokes(Chord::ShiftInsert, &[0xA0, VK_SHIFT]).len(), 4);
    }

    #[test]
    fn every_chord_leaves_no_key_of_its_own_down() {
        for chord in [Chord::CtrlV, Chord::ShiftInsert] {
            let strokes = chord_strokes(chord, &[0xA4, 0xA1]);
            for stroke in strokes.iter().filter(|s| !s.up) {
                assert!(strokes.iter().any(|s| s.up && s.vk == stroke.vk), "{chord:?} leaves {:#x} down", stroke.vk);
            }
        }
    }

    #[test]
    fn typing_releases_every_held_modifier() {
        assert_eq!(release_strokes(&[0xA3, VK_CONTROL, 0xA0, VK_SHIFT]), vec![up(0xA3), up(0xA0)]);
        assert_eq!(release_strokes(&[]), vec![]);
    }

    // ---- elevation

    #[test]
    fn only_a_known_elevated_window_stops_a_plain_helper() {
        assert!(blocked_by_elevation(Some(false), Some(true)));
        assert!(blocked_by_elevation(None, Some(true)));
        assert!(!blocked_by_elevation(Some(true), Some(true))); // both elevated
        assert!(!blocked_by_elevation(Some(false), Some(false)));
        assert!(!blocked_by_elevation(Some(false), None)); // unknown: try
        assert!(!blocked_by_elevation(None, None));
    }

    // ---- restore

    #[test]
    fn the_clipboard_is_put_back_only_if_nothing_newer_is_on_it() {
        assert!(should_restore(41, 41));
        assert!(!should_restore(41, 42)); // the user copied something meanwhile
        assert!(should_restore(0, 42)); // the number could not be read
        assert!(should_restore(41, 0));
    }

    // ---- typing

    fn text(s: &str) -> Step {
        Step::Text(s.encode_utf16().collect())
    }

    fn typed(steps: &[Step]) -> String {
        steps
            .iter()
            .map(|step| match step {
                Step::Text(units) => String::from_utf16(units).expect("a run is whole characters"),
                Step::Return => "\n".to_string(),
            })
            .collect()
    }

    #[test]
    fn short_text_is_one_run() {
        assert_eq!(typing_plan("hello world"), vec![text("hello world")]);
        assert_eq!(typing_plan(""), vec![]);
    }

    #[test]
    fn long_text_is_cut_into_runs() {
        let input = "a".repeat(MAX_UNITS + 5);
        assert_eq!(typing_plan(&input), vec![text(&"a".repeat(MAX_UNITS)), text("aaaaa")]);
    }

    #[test]
    fn a_surrogate_pair_is_never_split() {
        let input = format!("{}\u{1F600}!", "a".repeat(MAX_UNITS - 1));
        let steps = typing_plan(&input);
        assert_eq!(steps, vec![text(&"a".repeat(MAX_UNITS - 1)), text("\u{1F600}!")]);
        assert_eq!(typed(&steps), input);
    }

    #[test]
    fn line_breaks_become_the_enter_key() {
        assert_eq!(typing_plan("one\ntwo"), vec![text("one"), Step::Return, text("two")]);
        assert_eq!(typing_plan("one\r\ntwo\r"), vec![text("one"), Step::Return, text("two"), Step::Return]);
        assert_eq!(typing_plan("\n\n"), vec![Step::Return, Step::Return]);
    }

    #[test]
    fn everything_typed_adds_up_to_the_text() {
        let input = "Ol\u{e1}, tudo bem? \u{1F44B}\u{1F3FD} Uma frase longa o bastante para v\u{e1}rias teclas e mais algumas.\nSegunda linha.";
        let steps = typing_plan(input);
        assert_eq!(typed(&steps), input);
        for step in &steps {
            if let Step::Text(units) = step {
                assert!(!units.is_empty() && units.len() <= MAX_UNITS);
            }
        }
    }
}

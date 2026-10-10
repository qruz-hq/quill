//! Capability `insert`: type text into the focused app by pasting it.
//!
//! X11, the same steps as on macOS: remember the clipboard's text, put the
//! dictation there, post the paste shortcut 60 ms later through XTEST, and
//! hand back a closure that restores the text (the session runs it 350 ms
//! after the chord). A clipboard that held no text is not restored, so the
//! dictation stays on it.
//!
//! What differs from macOS:
//!
//! - The shortcut depends on the app. Terminals take Ctrl+Shift+V, and a few
//!   old-timers only Shift+Insert, so the focused window's `WM_CLASS` is read
//!   first (`insert/chord.rs` has the lists).
//! - An X11 clipboard is not a store: the owner hands the text over when an
//!   app asks. So one `arboard::Clipboard` lives as long as the helper, and
//!   its thread answers those requests.
//! - When the clipboard cannot be set at all, the text is typed through a
//!   spare keycode that is remapped for each character (what `xdotool type`
//!   does). Slower, and an app that reads the mapping lazily can drop a key.
//!
//! Wayland: no client may post keys to another, and there is no way to ask
//! which window has the focus. The capability is left out of the handshake.
//! An `insert` that arrives anyway copies the text to the clipboard and
//! answers with an `error` that tells the user to paste it themselves.

use std::sync::{Arc, Mutex};
use std::thread::sleep;
use std::time::Duration;

use arboard::{Clipboard, GetExtLinux, LinuxClipboardKind, SetExtLinux};
use quill_core::bus::Bus;
use quill_core::caps::{ClipboardRestore, InsertError, TextInserter, PASTE_DELAY};
use quill_core::logln;
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{AtomEnum, ConnectionExt as _, Window, KEY_PRESS_EVENT, KEY_RELEASE_EVENT};
use x11rb::protocol::xtest::ConnectionExt as _;

use super::desktop::{self, Desktop};
use super::keymap::NO_SYMBOL;
use super::x11::{self, Display};

mod chord;
mod typing;

use chord::Chord;

/// The chord could not be posted; the text is still on the clipboard.
const CHORD_FAILED: &str = "Quill could not type the text. It is on the clipboard: press Ctrl+V to paste it.";
const TYPING_FAILED: &str = "Quill could not type the text into this app.";
/// Wayland, every time: the reduced mode, worded as an instruction.
const WAYLAND_COPIED: &str = "Quill cannot type into other apps on Wayland. The text is on the clipboard: press Ctrl+V to paste it.";
const COPY_FAILED: &str = "Quill could not copy the text to the clipboard.";

const NOTE_WAYLAND: &str = "wayland: apps cannot send keys to other windows; the text is copied to the clipboard instead";
const NOTE_HEADLESS: &str = "no display: there is no app to type into";
const NOTE_NO_XTEST: &str = "x11: the display has no XTEST, which the paste shortcut needs";

/// Between two key events of the chord, so that a toolkit which reads the
/// modifier state a moment late still sees the modifier down.
const KEY_GAP: Duration = Duration::from_millis(4);
/// How long the server and the focused app get to take in a changed mapping
/// before the remapped key is pressed.
const REMAP_SETTLE: Duration = Duration::from_millis(4);
/// Between two typed characters.
const TYPING_GAP: Duration = Duration::from_millis(6);
/// How long after a synthetic key the hold key's listener may still read it.
const ECHO: Duration = Duration::from_millis(300);
/// How far up from the focused window a `WM_CLASS` is looked for.
const MAX_PARENTS: usize = 8;

pub fn create(_bus: &Bus) -> Arc<dyn TextInserter> {
    let board = Arc::new(Board::default());
    match desktop::current() {
        Desktop::X11 => {
            let probe = x11::probe();
            if probe.xtest {
                Arc::new(Paste { board })
            } else {
                let note = probe.error.as_ref().map_or_else(|| NOTE_NO_XTEST.to_string(), |error| format!("x11: {error}"));
                Arc::new(ClipboardOnly { board, note, told: CHORD_FAILED })
            }
        }
        Desktop::Wayland => Arc::new(ClipboardOnly { board, note: NOTE_WAYLAND.to_string(), told: WAYLAND_COPIED }),
        Desktop::Headless => Arc::new(ClipboardOnly { board, note: NOTE_HEADLESS.to_string(), told: CHORD_FAILED }),
    }
}

// -------------------------------------------------------------- clipboard

/// The helper's one clipboard handle, opened on first use and kept: on X11
/// its thread is what serves the text to the app that pastes.
#[derive(Default)]
struct Board(Mutex<Option<Clipboard>>);

impl Board {
    fn with<T>(&self, run: impl FnOnce(&mut Clipboard) -> Result<T, arboard::Error>) -> Result<T, arboard::Error> {
        let mut slot = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if slot.is_none() {
            *slot = Some(Clipboard::new()?);
        }
        let Some(clipboard) = slot.as_mut() else { return Err(arboard::Error::ClipboardNotSupported) };
        let result = run(clipboard);
        // A handle whose connection died is of no use: the next call opens a
        // new one. "Nothing on the clipboard" is an answer, not a failure.
        if matches!(result, Err(arboard::Error::Unknown { .. } | arboard::Error::ClipboardNotSupported)) {
            *slot = None;
        }
        result
    }

    /// The text on `kind`, if it holds text.
    fn text(&self, kind: LinuxClipboardKind) -> Option<String> {
        self.with(|clipboard| clipboard.get().clipboard(kind).text()).ok()
    }

    fn set(&self, kind: LinuxClipboardKind, text: &str) -> Result<(), arboard::Error> {
        self.with(|clipboard| clipboard.set().clipboard(kind).text(text.to_string()))
    }
}

/// Puts `previous` back on `kind` when the session says the paste is done.
fn restore_of(board: &Arc<Board>, saved: Vec<(LinuxClipboardKind, String)>) -> Option<ClipboardRestore> {
    if saved.is_empty() {
        return None;
    }
    let board = board.clone();
    Some(Box::new(move || {
        for (kind, text) in saved {
            if let Err(error) = board.set(kind, &text) {
                logln!("insert: could not restore the clipboard ({error})");
            }
        }
    }))
}

// ----------------------------------------------------------------- X11

/// The `WM_CLASS` of `window`, raw.
fn wm_class(display: &Display, window: Window) -> Option<Vec<u8>> {
    let reply = display.conn.get_property(false, window, AtomEnum::WM_CLASS, AtomEnum::STRING, 0, 256).ok()?.reply().ok()?;
    (!reply.value.is_empty()).then_some(reply.value)
}

/// The window the user is typing into, as the window manager names it
/// (`_NET_ACTIVE_WINDOW`), which is the one that carries the app's class.
fn active_window(display: &Display) -> Option<Window> {
    let atom = display.conn.intern_atom(true, b"_NET_ACTIVE_WINDOW").ok()?.reply().ok()?.atom;
    if atom == x11rb::NONE {
        return None;
    }
    let reply = display.conn.get_property(false, display.root, atom, AtomEnum::WINDOW, 0, 1).ok()?.reply().ok()?;
    let window = reply.value32()?.next();
    window.filter(|&window| window != x11rb::NONE)
}

/// The paste shortcut of the app in front. Anything that cannot be read
/// (no window manager, a window without a class) gets the common one.
fn chord_of_focused_app(display: &Display) -> Chord {
    let named = active_window(display).and_then(|window| wm_class(display, window));
    let class = named.or_else(|| {
        // No window manager that says: start at the window with the keyboard
        // focus, which is often a child, and walk up to one with a class.
        let mut window = display.conn.get_input_focus().ok()?.reply().ok()?.focus;
        for _ in 0..MAX_PARENTS {
            // 0 is None and 1 is PointerRoot: neither is a window.
            if window <= 1 || window == display.root {
                return None;
            }
            if let Some(class) = wm_class(display, window) {
                return Some(class);
            }
            window = display.conn.query_tree(window).ok()?.reply().ok()?.parent;
        }
        None
    });
    let Some(class) = class else { return Chord::CtrlV };
    let (instance, class) = chord::parse_wm_class(&class);
    chord::chord_for(&instance, &class)
}

/// The server's view of which keys are down.
fn held_keys(display: &Display) -> [u8; 32] {
    display.conn.query_keymap().ok().and_then(|cookie| cookie.reply().ok()).map_or([0; 32], |reply| reply.keys)
}

/// Posts one synthetic key event. Sent, not yet flushed.
fn fake_key(display: &Display, keycode: u8, pressed: bool) -> bool {
    let kind = if pressed { KEY_PRESS_EVENT } else { KEY_RELEASE_EVENT };
    display.conn.xtest_fake_input(kind, keycode, x11rb::CURRENT_TIME, display.root, 0, 0, 0).is_ok()
}

/// Posts `steps` one after the other. True when the server took them all.
fn post(display: &Display, steps: &[(u8, bool)]) -> bool {
    x11::injecting_for(KEY_GAP * steps.len() as u32 + ECHO);
    for &(keycode, pressed) in steps {
        if !fake_key(display, keycode, pressed) || display.conn.flush().is_err() {
            return false;
        }
        sleep(KEY_GAP);
    }
    display.sync()
}

fn post_chord(display: &Display, chord: Chord) -> bool {
    let keymap = display.keymap().unwrap_or_default();
    let plan = chord::plan(chord, &keymap, &held_keys(display));
    post(display, &plan.steps())
}

/// Types `text` through a spare keycode, remapped for every character and
/// emptied again afterwards.
fn type_text(display: &Display, text: &str) -> bool {
    let Some(keymap) = display.keymap() else { return false };
    let Some(spare) = keymap.spare() else {
        logln!("insert: no unused keycode to type through");
        return false;
    };
    let release: Vec<(u8, bool)> = chord::release_for_typing(&keymap, &held_keys(display)).into_iter().map(|key| (key, false)).collect();
    if !release.is_empty() && !post(display, &release) {
        return false;
    }
    let remap = |keysym: u32| display.conn.change_keyboard_mapping(1, spare, 1, &[keysym]).is_ok() && display.sync();
    let mut typed = true;
    let mut mapped = NO_SYMBOL;
    for keysym in typing::plan(text) {
        x11::injecting_for(REMAP_SETTLE + TYPING_GAP + ECHO);
        // A doubled letter needs no second remap.
        if keysym != mapped {
            if !remap(keysym) {
                typed = false;
                break;
            }
            mapped = keysym;
            sleep(REMAP_SETTLE);
        }
        if !(fake_key(display, spare, true) && fake_key(display, spare, false) && display.conn.flush().is_ok()) {
            typed = false;
            break;
        }
        sleep(TYPING_GAP);
    }
    // Leave the keyboard as it was found, whatever happened.
    let cleared = remap(NO_SYMBOL);
    typed && cleared
}

/// X11 with XTEST: the full capability.
struct Paste {
    board: Arc<Board>,
}

impl TextInserter for Paste {
    fn supported(&self) -> bool {
        true
    }

    fn paste(&self, text: &str) -> Result<Option<ClipboardRestore>, InsertError> {
        // A connection per insert: it costs a millisecond, and one kept open
        // for hours would have to be watched for the server going away.
        let display = Display::open();
        if let Err(error) = &display {
            logln!("insert: {error}");
        }
        let chord = display.as_ref().map_or(Chord::CtrlV, chord_of_focused_app);
        let mut kinds = vec![LinuxClipboardKind::Clipboard];
        if chord.reads_primary() {
            kinds.push(LinuxClipboardKind::Primary);
        }

        let saved: Vec<(LinuxClipboardKind, String)> =
            kinds.iter().filter_map(|&kind| Some((kind, self.board.text(kind)?))).collect();
        let restore = restore_of(&self.board, saved);

        let staged = kinds.iter().try_for_each(|&kind| self.board.set(kind, text));
        if let Err(error) = staged {
            // Pasting now would paste the wrong thing, or nothing.
            logln!("insert: clipboard unavailable ({error}), typing instead");
            let typed = display.as_ref().is_ok_and(|display| type_text(display, text));
            if !typed {
                return Err(InsertError { message: TYPING_FAILED.to_string() });
            }
            // Staging may have replaced one selection before it failed.
            return Ok(restore);
        }

        sleep(PASTE_DELAY);
        let posted = display.as_ref().is_ok_and(|display| post_chord(display, chord));
        if !posted {
            // Leave the dictation on the clipboard: it is the only copy.
            logln!("insert: could not post the paste chord");
            return Err(InsertError { message: CHORD_FAILED.to_string() });
        }
        Ok(restore)
    }

    fn note(&self) -> Option<String> {
        None
    }
}

// ------------------------------------------------- Wayland and the rest

/// A session where keys cannot be posted. Not listed in the handshake; an
/// `insert` still leaves the text where the user can paste it from.
struct ClipboardOnly {
    board: Arc<Board>,
    note: String,
    /// What the user is told once the text is on the clipboard.
    told: &'static str,
}

impl TextInserter for ClipboardOnly {
    fn supported(&self) -> bool {
        false
    }

    fn paste(&self, text: &str) -> Result<Option<ClipboardRestore>, InsertError> {
        // Nothing is restored: the clipboard is where the dictation now lives.
        let message = match self.board.set(LinuxClipboardKind::Clipboard, text) {
            Ok(()) => self.told,
            Err(error) => {
                logln!("insert: could not copy to the clipboard ({error})");
                COPY_FAILED
            }
        };
        Err(InsertError { message: message.to_string() })
    }

    fn note(&self) -> Option<String> {
        Some(self.note.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Nothing here touches a clipboard or posts a key: both belong to whoever
    // runs the tests. What is decided without a display is tested in
    // `insert/chord.rs` and `insert/typing.rs`; the live path is in
    // docs/HELPER-MANUAL-TESTS.md.

    #[test]
    fn the_reduced_mode_is_not_offered_but_explains_itself() {
        let wayland = ClipboardOnly { board: Arc::new(Board::default()), note: NOTE_WAYLAND.to_string(), told: WAYLAND_COPIED };
        assert!(!wayland.supported());
        assert!(wayland.note().unwrap().starts_with("wayland:"));
    }

    #[test]
    fn the_full_mode_is_offered() {
        let paste = Paste { board: Arc::new(Board::default()) };
        assert!(paste.supported());
        assert!(paste.note().is_none());
    }

    #[test]
    fn every_message_says_where_the_text_is_or_that_it_is_lost() {
        for message in [CHORD_FAILED, WAYLAND_COPIED] {
            assert!(message.contains("on the clipboard") && message.contains("Ctrl+V"), "{message}");
        }
        // Main shows at most the first line and 160 characters.
        for message in [CHORD_FAILED, TYPING_FAILED, WAYLAND_COPIED, COPY_FAILED] {
            assert!(message.len() <= 160 && !message.contains('\n'), "{message}");
        }
    }

    #[test]
    fn nothing_saved_means_nothing_to_restore() {
        let board = Arc::new(Board::default());
        assert!(restore_of(&board, Vec::new()).is_none());
        assert!(restore_of(&board, vec![(LinuxClipboardKind::Clipboard, "before".to_string())]).is_some());
    }
}

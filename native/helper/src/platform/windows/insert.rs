//! Capability `insert`: type text into the focused app by pasting it.
//!
//! The same steps as the macOS helper: remember the clipboard's text, put the
//! dictation there, send the paste chord 60 ms later with `SendInput`, and
//! hand back a closure that restores the text (the session runs it 350 ms
//! after the chord). A clipboard that held no text is not restored, so the
//! dictation stays on it.
//!
//! What is particular to Windows:
//!
//! - the chord is Ctrl+V, or Shift+Insert in terminals where Ctrl+V belongs to
//!   the shell (`insert/plan.rs` has the list);
//! - `SendInput` does not reset the keyboard, so modifiers the user still
//!   holds are released first;
//! - the dictation is kept out of the clipboard history (Win+V) and cloud
//!   sync, and the old text is only put back if nothing newer was copied in
//!   the meantime (the clipboard's sequence number tells);
//! - a window running as administrator takes no input from a plain process
//!   (UIPI) and gives no error. That case is detected up front and answered
//!   with a message; the text is left on the clipboard for the user to paste;
//! - when the clipboard cannot be written at all, the text is typed as
//!   Unicode key events instead.
//!
//! Compiles, but has not been run on Windows yet.

use std::sync::Arc;
use std::thread::sleep;
use std::time::Duration;

use arboard::SetExtWindows;
use quill_core::bus::Bus;
use quill_core::caps::{ClipboardRestore, InsertError, TextInserter, PASTE_DELAY};
use quill_core::logln;
use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND};
use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
use windows::Win32::System::DataExchange::GetClipboardSequenceNumber;
use windows::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::INPUT;
use windows::Win32::UI::WindowsAndMessaging::{GetClassNameW, GetForegroundWindow, GetWindowThreadProcessId};

use super::input;

mod plan;

use plan::{Chord, Step, Stroke};

/// Shown to the user as is. The text stays on the clipboard in both cases.
const ELEVATED: &str =
    "Quill cannot type into a window that runs as administrator. The text is on the clipboard: press Ctrl+V to paste it.";
const CHORD_FAILED: &str = "Quill could not type the text. It is on the clipboard: press Ctrl+V to paste it.";
const TYPING_FAILED: &str = "Quill could not type the text into this app.";

/// Between two runs of typed keys, so a slow app does not drop or reorder them.
const TYPING_GAP: Duration = Duration::from_millis(4);
/// Another program can have the clipboard open for a moment.
const CLIPBOARD_TRIES: u32 = 4;
const CLIPBOARD_RETRY: Duration = Duration::from_millis(15);

// -------------------------------------------------------------- clipboard

fn with_clipboard<T>(action: impl Fn(&mut arboard::Clipboard) -> Result<T, arboard::Error>) -> Result<T, arboard::Error> {
    let mut tries = 0;
    loop {
        tries += 1;
        match arboard::Clipboard::new().and_then(|mut clipboard| action(&mut clipboard)) {
            Err(arboard::Error::ClipboardOccupied) if tries < CLIPBOARD_TRIES => sleep(CLIPBOARD_RETRY),
            result => return result,
        }
    }
}

/// The clipboard's text, if it holds any.
fn clipboard_text() -> Option<String> {
    with_clipboard(|clipboard| clipboard.get_text()).ok()
}

/// Replaces the clipboard's contents with `text`, marked so that the clipboard
/// history and cloud sync leave it out.
fn set_clipboard_text(text: &str) -> Result<(), arboard::Error> {
    with_clipboard(|clipboard| clipboard.set().exclude_from_history().exclude_from_cloud().text(text))
}

/// Changes every time the clipboard's contents do. 0 when it cannot be read.
fn clipboard_sequence() -> u32 {
    // SAFETY: no arguments, reads a counter.
    unsafe { GetClipboardSequenceNumber() }
}

// ------------------------------------------------------ the window in front

/// A process or token handle, closed when dropped.
struct Owned(HANDLE);

impl Drop for Owned {
    fn drop(&mut self) {
        // SAFETY: the handle came from an Open call, is owned by this value
        // alone and is closed once.
        let _ = unsafe { CloseHandle(self.0) };
    }
}

/// Whether the process behind `process` runs elevated. `None`: no answer.
fn is_elevated(process: HANDLE) -> Option<bool> {
    let mut token = HANDLE::default();
    // SAFETY: `process` is a live process handle (or the pseudo handle of
    // this process) and `token` is a live local that receives the new handle.
    unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) }.ok()?;
    let token = Owned(token);
    let mut elevation = TOKEN_ELEVATION::default();
    let mut size = 0u32;
    // SAFETY: the buffer is one TOKEN_ELEVATION and its size is passed with it.
    unsafe {
        GetTokenInformation(
            token.0,
            TokenElevation,
            Some((&raw mut elevation).cast()),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut size,
        )
    }
    .ok()?;
    Some(elevation.TokenIsElevated != 0)
}

/// What is known about the window that has the keyboard.
#[derive(Default)]
struct Front {
    class: String,
    exe: String,
    elevated: Option<bool>,
}

fn window_class(window: HWND) -> String {
    let mut buffer = [0u16; 256];
    // SAFETY: `buffer` is a live array; the call writes at most its length
    // and returns how many units it wrote (0 on failure).
    let written = unsafe { GetClassNameW(window, &mut buffer) };
    String::from_utf16_lossy(&buffer[..usize::try_from(written).unwrap_or(0).min(buffer.len())])
}

fn front() -> Front {
    // SAFETY: no arguments; may return a null window (nothing has focus).
    let window = unsafe { GetForegroundWindow() };
    if window.is_invalid() {
        return Front::default();
    }
    let mut front = Front { class: window_class(window), ..Front::default() };
    let mut pid = 0u32;
    // SAFETY: `pid` is a live local that receives the process id.
    unsafe { GetWindowThreadProcessId(window, Some(&mut pid)) };
    if pid == 0 {
        return front;
    }
    // SAFETY: asks for the least access there is; the handle is owned below.
    let Ok(process) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }) else {
        return front;
    };
    let process = Owned(process);
    let mut path = [0u16; 1024];
    let mut length = path.len() as u32;
    // SAFETY: `path` holds `length` units; the call sets `length` to what it wrote.
    if unsafe { QueryFullProcessImageNameW(process.0, PROCESS_NAME_WIN32, PWSTR(path.as_mut_ptr()), &mut length) }.is_ok() {
        front.exe = String::from_utf16_lossy(&path[..(length as usize).min(path.len())]);
    }
    front.elevated = is_elevated(process.0);
    front
}

fn helper_is_elevated() -> Option<bool> {
    // SAFETY: returns a pseudo handle that needs no closing.
    is_elevated(unsafe { GetCurrentProcess() })
}

// ------------------------------------------------------------------- keys

fn held_modifiers() -> Vec<u16> {
    plan::WATCHED_MODIFIERS.into_iter().filter(|&vk| input::is_down(u32::from(vk))).collect()
}

fn inputs(strokes: &[Stroke]) -> Vec<INPUT> {
    strokes.iter().map(|stroke| input::key(stroke.vk, stroke.up, stroke.extended)).collect()
}

fn post_paste_chord(chord: Chord) -> bool {
    input::send(&inputs(&plan::chord_strokes(chord, &held_modifiers())))
}

/// Types `text` as Unicode key events, whatever the keyboard layout.
fn type_text(text: &str) -> bool {
    // A modifier the user still holds would turn the text into shortcuts.
    if !input::send(&inputs(&plan::release_strokes(&held_modifiers()))) {
        return false;
    }
    for step in plan::typing_plan(text) {
        let events: Vec<INPUT> = match &step {
            Step::Text(units) => units.iter().flat_map(|&unit| [input::unicode(unit, false), input::unicode(unit, true)]).collect(),
            Step::Return => vec![input::key(plan::VK_RETURN, false, false), input::key(plan::VK_RETURN, true, false)],
        };
        if !input::send(&events) {
            return false;
        }
        sleep(TYPING_GAP);
    }
    true
}

/// Puts `previous` back, unless something newer than the dictation is on the
/// clipboard by then. `staged` is the sequence number after staging (0: not
/// known, restore regardless). Nothing to put back when there was no text.
fn restore_of(previous: Option<String>, staged: u32) -> Option<ClipboardRestore> {
    previous.map(|previous| -> ClipboardRestore {
        Box::new(move || {
            if !plan::should_restore(staged, clipboard_sequence()) {
                logln!("insert: something newer is on the clipboard, leaving it");
                return;
            }
            if let Err(error) = set_clipboard_text(&previous) {
                logln!("insert: could not restore the clipboard ({error})");
            }
        })
    })
}

struct Paste;

impl TextInserter for Paste {
    fn supported(&self) -> bool {
        true
    }

    fn paste(&self, text: &str) -> Result<Option<ClipboardRestore>, InsertError> {
        let front = front();
        let blocked = plan::blocked_by_elevation(helper_is_elevated(), front.elevated);

        let previous = clipboard_text();
        if let Err(error) = set_clipboard_text(text) {
            // Pasting now would paste the wrong thing, or nothing.
            logln!("insert: clipboard unavailable ({error}), typing instead");
            if blocked || !type_text(text) {
                return Err(InsertError { message: TYPING_FAILED.to_string() });
            }
            // Staging may have emptied the clipboard before it failed.
            return Ok(restore_of(previous, 0));
        }
        if blocked {
            // The keys would vanish without an error. The dictation stays on
            // the clipboard: it is the only copy.
            logln!("insert: the window in front runs as administrator");
            return Err(InsertError { message: ELEVATED.to_string() });
        }
        let staged = clipboard_sequence();

        sleep(PASTE_DELAY);
        let chord = plan::chord_for(&front.class, &front.exe);
        if !post_paste_chord(chord) {
            logln!("insert: SendInput refused the paste chord");
            return Err(InsertError { message: CHORD_FAILED.to_string() });
        }

        Ok(restore_of(previous, staged))
    }

    fn note(&self) -> Option<String> {
        Some("cannot type into windows that run as administrator".to_string())
    }
}

/// `bus` is unused: the session reports `inserted` when `paste` returns.
pub fn create(_bus: &Bus) -> Arc<dyn TextInserter> {
    Arc::new(Paste)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Nothing here touches the clipboard or sends a key: both belong to
    // whoever runs the tests. The live path is in docs/HELPER-MANUAL-TESTS.md.

    #[test]
    fn the_backend_is_offered() {
        let (bus, _rx) = Bus::new();
        assert!(create(&bus).supported());
    }

    #[test]
    fn the_messages_say_where_the_text_is() {
        assert!(ELEVATED.contains("clipboard") && ELEVATED.contains("administrator"));
        assert!(CHORD_FAILED.contains("clipboard"));
    }
}

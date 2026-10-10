//! Capability `insert`: type text into the focused app by pasting it.
//!
//! As the Swift helper does it: remember the pasteboard's string, put the
//! text there, post a synthetic Cmd+V 60 ms later, and hand back a closure
//! that restores the string (the session runs it 350 ms after the chord). A
//! pasteboard that held no text is not restored, so the dictation stays on it.
//!
//! One addition: when the text cannot be put on the pasteboard at all, it is
//! typed as Unicode key events instead of pasting whatever was there before.
//!
//! No unsafe code here: the pasteboard goes through `arboard` and the key
//! events through `core-graphics`, both of which release what they create.

use std::sync::Arc;
use std::thread::sleep;
use std::time::Duration;

use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation, CGKeyCode, KeyCode};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use objc2::rc::autoreleasepool;
use quill_core::bus::Bus;
use quill_core::caps::{ClipboardRestore, InsertError, TextInserter, PASTE_DELAY};
use quill_core::logln;

use super::permissions::accessibility_trusted;

mod typing;

use typing::Step;

/// Section 9: shown to the user as is.
const NEEDS_ACCESSIBILITY: &str = "Quill needs Accessibility to type for you. Allow it from the Quill window; no relaunch needed.";
/// The chord could not be posted; the text is still on the pasteboard.
const CHORD_FAILED: &str = "Quill could not type the text. It is on the clipboard: press Command+V to paste it.";
const TYPING_FAILED: &str = "Quill could not type the text into this app.";

/// Between two typed key presses, so a slow app does not drop or reorder them.
const TYPING_GAP: Duration = Duration::from_millis(4);

/// The pasteboard's string, if it holds one.
fn clipboard_text() -> Option<String> {
    // The pool takes the temporaries AppKit autoreleases: this runs on a
    // worker thread that has no pool of its own, where they would pile up.
    autoreleasepool(|_| arboard::Clipboard::new().ok()?.get_text().ok())
}

/// Replaces the pasteboard's contents with `text`.
fn set_clipboard_text(text: &str) -> Result<(), arboard::Error> {
    autoreleasepool(|_| arboard::Clipboard::new()?.set_text(text))
}

/// A key event source tied to the session's combined state, as the Swift
/// helper uses.
fn event_source() -> Option<CGEventSource> {
    CGEventSource::new(CGEventSourceStateID::CombinedSessionState).ok()
}

/// Posts one key going down and up with exactly `flags`, after `prepare` has
/// had its say on both events. False when the events could not be created.
fn post_key(keycode: CGKeyCode, flags: CGEventFlags, prepare: impl Fn(&CGEvent)) -> bool {
    for down in [true, false] {
        // Each event takes its own source; both are released when dropped.
        let Some(event) = event_source().and_then(|source| CGEvent::new_keyboard_event(source, keycode, down).ok()) else {
            return false;
        };
        event.set_flags(flags);
        prepare(&event);
        event.post(CGEventTapLocation::HID);
    }
    true
}

/// Cmd+V by keycode (ANSI V, 0x09), as the Swift helper posts it.
fn post_paste_chord() -> bool {
    post_key(KeyCode::ANSI_V, CGEventFlags::CGEventFlagCommand, |_| {})
}

/// Types `text` as Unicode key events. The flags are cleared so a modifier
/// the user still holds does not turn the text into shortcuts.
fn type_text(text: &str) -> bool {
    for step in typing::plan(text) {
        let posted = match &step {
            Step::Text(units) => post_key(0, CGEventFlags::CGEventFlagNull, |event| event.set_string_from_utf16_unchecked(units)),
            Step::Return => post_key(KeyCode::RETURN, CGEventFlags::CGEventFlagNull, |_| {}),
        };
        if !posted {
            return false;
        }
        sleep(TYPING_GAP);
    }
    true
}

struct Paste;

impl TextInserter for Paste {
    fn supported(&self) -> bool {
        true
    }

    fn paste(&self, text: &str) -> Result<Option<ClipboardRestore>, InsertError> {
        // Posting key events without the grant does nothing at all, silently.
        if !accessibility_trusted() {
            return Err(InsertError { message: NEEDS_ACCESSIBILITY.to_string() });
        }

        let previous = clipboard_text();
        let restore = previous.map(|previous| -> ClipboardRestore {
            Box::new(move || {
                if let Err(error) = set_clipboard_text(&previous) {
                    logln!("insert: could not restore the clipboard ({error})");
                }
            })
        });

        if let Err(error) = set_clipboard_text(text) {
            // Pasting now would paste the wrong thing, or nothing.
            logln!("insert: clipboard unavailable ({error}), typing instead");
            if !type_text(text) {
                return Err(InsertError { message: TYPING_FAILED.to_string() });
            }
            // Staging may have cleared the pasteboard before it failed.
            return Ok(restore);
        }

        sleep(PASTE_DELAY);
        if !post_paste_chord() {
            // Leave the dictation on the clipboard: it is the only copy.
            logln!("insert: could not create the paste chord");
            return Err(InsertError { message: CHORD_FAILED.to_string() });
        }
        Ok(restore)
    }
}

/// `bus` is unused: the session reports `inserted` when `paste` returns.
pub fn create(_bus: &Bus) -> Arc<dyn TextInserter> {
    Arc::new(Paste)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Nothing here touches the pasteboard or posts a key: both belong to
    // whoever runs the tests. The live path is in docs/HELPER-MANUAL-TESTS.md.

    #[test]
    fn the_backend_is_offered() {
        let (bus, _rx) = Bus::new();
        assert!(create(&bus).supported());
    }

    #[test]
    fn the_accessibility_wording_is_the_one_main_expects() {
        // Section 9: main shows this as a dictation error and the conformance
        // suite matches on "Accessibility".
        assert!(NEEDS_ACCESSIBILITY.contains("Accessibility"));
        assert_eq!(NEEDS_ACCESSIBILITY, "Quill needs Accessibility to type for you. Allow it from the Quill window; no relaunch needed.");
    }
}

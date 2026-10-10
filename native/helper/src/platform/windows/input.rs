//! Injecting key events with `SendInput`, for the paste chord, typed text and
//! the hook's mask key. Every event carries [`INJECTED_TAG`], which is how the
//! keyboard hook knows not to treat it as the user's.

use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY,
    KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, VIRTUAL_KEY,
};

use super::hotkey::keys::INJECTED_TAG;

fn keyboard(vk: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: INJECTED_TAG },
        },
    }
}

/// One edge of a virtual key. `extended` for the keys of the navigation
/// cluster (Insert), which otherwise read as their numeric keypad twins.
pub fn key(vk: u16, up: bool, extended: bool) -> INPUT {
    let mut flags = KEYBD_EVENT_FLAGS(0);
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    if extended {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    keyboard(vk, 0, flags)
}

/// One edge of a key that types the UTF-16 unit `unit`, whatever the layout.
pub fn unicode(unit: u16, up: bool) -> INPUT {
    let flags = if up { KEYEVENTF_UNICODE | KEYEVENTF_KEYUP } else { KEYEVENTF_UNICODE };
    keyboard(0, unit, flags)
}

/// Inserts the events into the input stream as one uninterrupted run. False
/// when Windows took fewer than all of them. An elevated window in front
/// refuses them without saying so (UIPI), so true is not proof of delivery.
pub fn send(inputs: &[INPUT]) -> bool {
    if inputs.is_empty() {
        return true;
    }
    // SAFETY: `inputs` is a live slice of fully initialised INPUT structures
    // and the size passed is that of one of them.
    let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    sent as usize == inputs.len()
}

/// Whether the key is held right now, as Windows sees it.
pub fn is_down(vk: u32) -> bool {
    // SAFETY: takes a virtual-key code and returns its state; nothing of ours.
    let state = unsafe { GetAsyncKeyState(vk as i32) };
    state < 0
}

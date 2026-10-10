//! Capability `hotkey`: the global hold key, reported as raw edges.
//!
//! X11: XInput 2 raw key events, selected on the root window. The server
//! sends them to every client that asks, whichever window has the focus, with
//! no grab and no permission. A thread of its own waits on a connection of
//! its own and posts edges to the session, where the gestures live
//! (`quill_core::gesture`). What one event means is the pure code in
//! `hotkey/keys.rs`; this file is the X shell around it.
//!
//! Nothing is swallowed: the only way to keep a key from other X clients is
//! to grab it, which takes it away in combinations too. So the keys offered
//! are ones that do nothing when pressed alone (right control, right alt,
//! right shift, right super), and `hotkey-swallow` is not listed.
//!
//! Wayland: a client gets no key events unless one of its windows has the
//! focus, by design, and an X client under XWayland only sees keys typed into
//! X11 windows. There is no honest hold key to offer, so the capability is
//! left out of the handshake with a note saying why, and the app falls back
//! to its own toggle shortcut. (Reading `/dev/input` would work, but needs
//! the user in the `input` group, which lets every program they run read
//! every key. Not done.)

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

use quill_core::bus::Bus;
use quill_core::caps::{Hotkey, HotkeyError};
use quill_core::logln;
use quill_core::unsupported::UNSUPPORTED;
use x11rb::connection::Connection;
use x11rb::protocol::xinput::{self, ConnectionExt as _, XIEventMask};
use x11rb::protocol::Event;

use super::desktop::{self, Desktop};
use super::keymap::{KeyClass, Keymap};
use super::x11::{self, Display};

mod keys;

use keys::Press;

/// `key` when the hold key is off.
const KEY_OFF: i64 = -1;

const NOTE_WAYLAND: &str = "wayland: apps cannot see keys typed into other windows, so there is no hold key; use the app shortcut";
const NOTE_HEADLESS: &str = "no display: there is no keyboard to watch";
const NOTE_NO_XINPUT: &str = "x11: the display has no XInput 2, which the hold key needs";
const NOTE_X11: &str = "x11: the hold key is watched, not taken; it still reaches the focused app";

/// Builds the backend for the session the helper was started in.
pub fn create(bus: &Bus) -> Box<dyn Hotkey> {
    match desktop::current() {
        Desktop::X11 => {
            let probe = x11::probe();
            if probe.xinput2 {
                Box::new(RawKeys::new(bus))
            } else {
                let note = probe.error.as_ref().map_or_else(|| NOTE_NO_XINPUT.to_string(), |error| format!("x11: {error}"));
                Box::new(Unavailable { note })
            }
        }
        Desktop::Wayland => Box::new(Unavailable { note: NOTE_WAYLAND.to_string() }),
        Desktop::Headless => Box::new(Unavailable { note: NOTE_HEADLESS.to_string() }),
    }
}

/// No hold key in this session. Stays out of the handshake; the note says why.
struct Unavailable {
    note: String,
}

impl Hotkey for Unavailable {
    fn supported(&self) -> bool {
        false
    }

    fn hold_keys(&self) -> Vec<u32> {
        Vec::new()
    }

    fn install(&mut self) -> Result<(), HotkeyError> {
        Err(HotkeyError { reason: UNSUPPORTED.to_string(), retry: false })
    }

    fn installed(&self) -> bool {
        false
    }

    fn set_key(&mut self, _key: Option<u32>) {}

    fn note(&self) -> Option<String> {
        Some(self.note.clone())
    }
}

#[derive(Default)]
struct State {
    /// The server's keyboard mapping, once a listener has read it.
    keymap: Option<Keymap>,
    /// The keycode being watched, `None` with the hold key off.
    hold: Option<u8>,
    press: Press,
}

/// What the controller thread and the listener thread share.
struct Shared {
    bus: Bus,
    /// The hold key as main names it (a macOS keycode), or [`KEY_OFF`].
    key: AtomicI64,
    /// A listener thread is alive and connected.
    listening: AtomicBool,
    state: Mutex<State>,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        // Nothing in here can be left half done by a panic.
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn key(&self) -> Option<u32> {
        u32::try_from(self.key.load(Ordering::Relaxed)).ok()
    }

    /// A new mapping (at install, and whenever the server says it changed):
    /// the hold key may have moved to another keycode.
    fn remap(&self, keymap: Option<Keymap>) {
        let key = self.key();
        let mut state = self.lock();
        if keymap.is_some() {
            state.keymap = keymap;
        }
        state.hold = key.map(|key| keys::resolve(key, state.keymap.as_ref()));
    }

    /// One raw key event: `keycode` went down or up on device `source`.
    /// `ours` is the device the helper's own synthetic keys come from, and
    /// `injecting` whether it is posting some right now.
    fn raw_key(&self, keycode: u32, pressed: bool, source: u16, ours: Option<u16>, injecting: bool, at: Instant) {
        let edge = {
            let mut state = self.lock();
            if injecting {
                // The paste chord, seen from this side. With the device known
                // only its events are dropped, so a real key is never lost.
                // With it unknown everything but the hold key itself is.
                let synthetic = match ours {
                    Some(ours) => source == ours,
                    None => Some(keycode) != state.hold.map(u32::from),
                };
                if synthetic {
                    return;
                }
            }
            let class = state.keymap.as_ref().map_or(KeyClass::Ordinary, |keymap| keymap.class(keycode));
            let hold = state.hold;
            state.press.key(keycode, pressed, hold, class)
        };
        if let Some(edge) = edge {
            self.bus.key(edge, at);
        }
    }

    /// The listener's connection ended. A key that is down will never be seen
    /// coming up, so the press ends here, and the session is told so that its
    /// poll installs a new listener.
    fn lost(&self, why: &str) {
        let ended = self.lock().press.abandon();
        if let Some(edge) = ended {
            self.bus.key(edge, Instant::now());
        }
        self.listening.store(false, Ordering::Relaxed);
        logln!("hotkey: the X11 listener stopped ({why})");
        self.bus.hotkey_status(false, Some("x11 connection lost"));
    }
}

/// The device id of the keyboard XTEST events are sent from.
fn xtest_keyboard(display: &Display) -> Option<u16> {
    let reply = display.conn.xinput_xi_query_device(xinput::Device::ALL).ok()?.reply().ok()?;
    reply.infos.iter().find(|info| String::from_utf8_lossy(&info.name).contains("XTEST keyboard")).map(|info| info.deviceid)
}

/// Opens a connection and asks for every key press and release on it.
fn open_listener() -> Result<Display, String> {
    let display = Display::open()?;
    match display.xinput_version() {
        Some((major, _)) if major >= 2 => {}
        _ => return Err("the display has no XInput 2".to_string()),
    }
    let mask = xinput::EventMask {
        deviceid: xinput::Device::ALL_MASTER.into(),
        mask: vec![XIEventMask::RAW_KEY_PRESS | XIEventMask::RAW_KEY_RELEASE],
    };
    let selected = display
        .conn
        .xinput_xi_select_events(display.root, &[mask])
        .map_err(|error| error.to_string())
        .and_then(|cookie| cookie.check().map_err(|error| error.to_string()));
    selected.map_err(|error| format!("could not select raw key events ({error})"))?;
    Ok(display)
}

/// The listener thread: blocks on the connection until it ends.
fn listen(shared: Arc<Shared>, display: Display, ours: Option<u16>) {
    let why = loop {
        let event = match display.conn.wait_for_event() {
            Ok(event) => event,
            Err(error) => break error.to_string(),
        };
        let at = Instant::now();
        match event {
            Event::XinputRawKeyPress(key) => shared.raw_key(key.detail, true, key.sourceid, ours, x11::is_injecting(), at),
            Event::XinputRawKeyRelease(key) => shared.raw_key(key.detail, false, key.sourceid, ours, x11::is_injecting(), at),
            // Sent to every client when the layout or an xkb option changes.
            Event::MappingNotify(_) => shared.remap(display.keymap()),
            _ => {}
        }
    };
    shared.lost(&why);
}

struct RawKeys {
    shared: Arc<Shared>,
}

impl RawKeys {
    fn new(bus: &Bus) -> Self {
        let shared = Shared {
            bus: bus.clone(),
            key: AtomicI64::new(i64::from(keys::DEFAULT_KEY)),
            listening: AtomicBool::new(false),
            state: Mutex::new(State::default()),
        };
        shared.remap(None);
        Self { shared: Arc::new(shared) }
    }
}

impl Hotkey for RawKeys {
    fn supported(&self) -> bool {
        true
    }

    fn hold_keys(&self) -> Vec<u32> {
        keys::HOLD_KEYS.to_vec()
    }

    fn install(&mut self) -> Result<(), HotkeyError> {
        if self.installed() {
            return Ok(());
        }
        // The server can be gone for a moment (a display manager restarting
        // it), so every failure here is worth another try on the poll.
        let failed = |reason: String| HotkeyError { reason: format!("x11: {reason}"), retry: true };
        let display = open_listener().map_err(failed)?;
        let ours = xtest_keyboard(&display);
        {
            let mut state = self.shared.lock();
            state.press = Press::default();
        }
        self.shared.remap(display.keymap());
        self.shared.listening.store(true, Ordering::Relaxed);
        let shared = self.shared.clone();
        let spawned = std::thread::Builder::new().name("hotkey-x11".to_string()).spawn(move || listen(shared, display, ours));
        if let Err(error) = spawned {
            self.shared.listening.store(false, Ordering::Relaxed);
            return Err(failed(format!("could not start the listener thread ({error})")));
        }
        Ok(())
    }

    fn installed(&self) -> bool {
        self.shared.listening.load(Ordering::Relaxed)
    }

    fn set_key(&mut self, key: Option<u32>) {
        self.shared.key.store(key.map_or(KEY_OFF, i64::from), Ordering::Relaxed);
        self.shared.remap(None);
        // A press of the old key is not a press of the new one.
        self.shared.lock().press = Press::default();
    }

    fn note(&self) -> Option<String> {
        Some(NOTE_X11.to_string())
    }
}

#[cfg(test)]
mod tests {
    use quill_core::bus::Msg;
    use quill_core::gesture::KeyEdge;

    use super::super::keymap::testing::us;
    use super::*;

    // No test opens a display: what a raw event means is decided in `Shared`
    // and in `keys.rs`, which need none. The listener itself is in
    // docs/HELPER-MANUAL-TESTS.md.

    fn edges(rx: &crossbeam_channel::Receiver<Msg>) -> Vec<KeyEdge> {
        let mut seen = Vec::new();
        while let Ok(msg) = rx.try_recv() {
            match msg {
                Msg::Key { edge, .. } => seen.push(edge),
                other => panic!("unexpected {other:?}"),
            }
        }
        seen
    }

    const KEYBOARD: u16 = 3;
    const XTEST: u16 = 5;

    #[test]
    fn a_session_without_a_hold_key_says_so() {
        let mut none = Unavailable { note: NOTE_WAYLAND.to_string() };
        assert!(!none.supported());
        assert!(!none.swallows());
        assert!(none.hold_keys().is_empty());
        assert!(!none.installed());
        let error = none.install().unwrap_err();
        assert_eq!((error.reason.as_str(), error.retry), ("unsupported", false));
        none.set_key(Some(62));
        assert!(none.note().unwrap().starts_with("wayland:"));
    }

    #[test]
    fn the_backend_reports_what_it_offers_before_any_connection() {
        let (bus, _rx) = Bus::new();
        let mut hotkey = RawKeys::new(&bus);
        assert!(hotkey.supported());
        assert!(!hotkey.swallows(), "nothing is kept from other apps on X11");
        assert_eq!(hotkey.hold_keys(), vec![62, 61, 60, 54]);
        assert!(!hotkey.installed());
        assert!(hotkey.note().unwrap().starts_with("x11:"));

        // Right control until main says otherwise, by its usual keycode.
        assert_eq!(hotkey.shared.lock().hold, Some(105));
        hotkey.set_key(Some(60));
        assert_eq!(hotkey.shared.lock().hold, Some(62));
        hotkey.set_key(None);
        assert_eq!(hotkey.shared.lock().hold, None);
        // Main's default, fn, does not exist here.
        hotkey.set_key(Some(63));
        assert_eq!(hotkey.shared.lock().hold, Some(105));
    }

    #[test]
    fn raw_events_become_edges() {
        let (bus, rx) = Bus::new();
        let hotkey = RawKeys::new(&bus);
        let shared = &hotkey.shared;
        shared.remap(Some(us()));
        let now = Instant::now();
        shared.raw_key(105, true, KEYBOARD, Some(XTEST), false, now);
        shared.raw_key(105, true, KEYBOARD, Some(XTEST), false, now);
        shared.raw_key(50, true, KEYBOARD, Some(XTEST), false, now);
        shared.raw_key(38, true, KEYBOARD, Some(XTEST), false, now);
        shared.raw_key(38, false, KEYBOARD, Some(XTEST), false, now);
        shared.raw_key(105, false, KEYBOARD, Some(XTEST), false, now);
        assert_eq!(edges(&rx), vec![KeyEdge::Down, KeyEdge::OtherKey, KeyEdge::Up]);
    }

    #[test]
    fn the_helpers_own_paste_chord_is_not_another_key() {
        let (bus, rx) = Bus::new();
        let hotkey = RawKeys::new(&bus);
        let shared = &hotkey.shared;
        shared.remap(Some(us()));
        let now = Instant::now();
        shared.raw_key(105, true, KEYBOARD, Some(XTEST), false, now);
        // Control_L, v, v, Control_L from the XTEST keyboard while pasting.
        for (keycode, pressed) in [(37, true), (55, true), (55, false), (37, false)] {
            shared.raw_key(keycode, pressed, XTEST, Some(XTEST), true, now);
        }
        assert_eq!(edges(&rx), vec![KeyEdge::Down]);
        // The user's own keyboard still counts while the chord is going out.
        shared.raw_key(38, true, KEYBOARD, Some(XTEST), true, now);
        assert_eq!(edges(&rx), vec![KeyEdge::OtherKey]);
        // And another program's synthetic keys count when the helper posts none.
        shared.raw_key(105, false, XTEST, Some(XTEST), false, now);
        assert_eq!(edges(&rx), vec![KeyEdge::Up]);
    }

    #[test]
    fn with_the_synthetic_device_unknown_the_hold_key_is_still_followed() {
        let (bus, rx) = Bus::new();
        let hotkey = RawKeys::new(&bus);
        let shared = &hotkey.shared;
        shared.remap(Some(us()));
        let now = Instant::now();
        shared.raw_key(105, true, KEYBOARD, None, true, now);
        shared.raw_key(55, true, KEYBOARD, None, true, now);
        shared.raw_key(105, false, KEYBOARD, None, true, now);
        assert_eq!(edges(&rx), vec![KeyEdge::Down, KeyEdge::Up]);
    }

    #[test]
    fn a_layout_change_moves_the_hold_key() {
        use super::super::keymap::testing::keymap;
        use super::super::keymap::{XK_CONTROL_R, XK_SUPER_R};
        let (bus, rx) = Bus::new();
        let hotkey = RawKeys::new(&bus);
        let shared = &hotkey.shared;
        shared.remap(Some(us()));
        assert_eq!(shared.lock().hold, Some(105));
        // The user swaps right control and right super.
        shared.remap(Some(keymap(&[(105, &[XK_SUPER_R]), (134, &[XK_CONTROL_R])])));
        assert_eq!(shared.lock().hold, Some(134));
        let now = Instant::now();
        shared.raw_key(105, true, KEYBOARD, Some(XTEST), false, now);
        shared.raw_key(134, true, KEYBOARD, Some(XTEST), false, now);
        assert_eq!(edges(&rx), vec![KeyEdge::Down]);
    }

    #[test]
    fn a_lost_connection_ends_the_press_and_asks_for_a_new_listener() {
        let (bus, rx) = Bus::new();
        let hotkey = RawKeys::new(&bus);
        let shared = &hotkey.shared;
        shared.listening.store(true, Ordering::Relaxed);
        shared.raw_key(105, true, KEYBOARD, Some(XTEST), false, Instant::now());
        shared.lost("test");
        assert!(!hotkey.installed());
        let mut seen = Vec::new();
        while let Ok(msg) = rx.try_recv() {
            seen.push(msg);
        }
        assert!(matches!(seen[0], Msg::Key { edge: KeyEdge::Down, .. }));
        assert!(matches!(seen[1], Msg::Key { edge: KeyEdge::Up, .. }));
        assert!(matches!(&seen[2], Msg::HotkeyStatus { installed: false, reason: Some(reason) } if reason == "x11 connection lost"));
    }
}

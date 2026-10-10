//! The X11 calls the hold key and the paste chord share: opening the display,
//! reading the keyboard mapping, and asking once what the server offers.
//!
//! `x11rb` speaks the X protocol itself, in Rust, over the display's socket:
//! no libX11 or libxcb is linked, so the helper starts on a machine that has
//! neither (a Wayland-only install) and simply reports what is missing.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use x11rb::connection::{Connection, RequestConnection};
use x11rb::protocol::xinput::{self, ConnectionExt as _};
use x11rb::protocol::xproto::{ConnectionExt as _, Window};
use x11rb::protocol::xtest;
use x11rb::rust_connection::RustConnection;

use super::keymap::Keymap;

/// One connection to the display named by `DISPLAY`.
pub struct Display {
    pub conn: RustConnection,
    pub root: Window,
}

impl Display {
    pub fn open() -> Result<Self, String> {
        let (conn, screen) = x11rb::connect(None).map_err(|error| format!("cannot connect to the display ({error})"))?;
        let root = conn.setup().roots.get(screen).map(|screen| screen.root).ok_or("the display has no screen")?;
        Ok(Self { conn, root })
    }

    /// The whole keyboard mapping as it is now.
    pub fn keymap(&self) -> Option<Keymap> {
        let setup = self.conn.setup();
        let (first, last) = (setup.min_keycode, setup.max_keycode);
        let count = last.checked_sub(first)?.checked_add(1)?;
        let reply = self.conn.get_keyboard_mapping(first, count).ok()?.reply().ok()?;
        Some(Keymap::new(first, reply.keysyms_per_keycode, reply.keysyms))
    }

    /// True when the server has the extension called `name`.
    pub fn has_extension(&self, name: &'static str) -> bool {
        matches!(self.conn.extension_information(name), Ok(Some(_)))
    }

    /// Announces XInput 2.2 on this connection and returns the version the
    /// server speaks. It has to be the first XInput request of a connection:
    /// it is what makes raw events carry the device they came from.
    pub fn xinput_version(&self) -> Option<(u16, u16)> {
        if !self.has_extension(xinput::X11_EXTENSION_NAME) {
            return None;
        }
        let reply = self.conn.xinput_xi_query_version(2, 2).ok()?.reply().ok()?;
        Some((reply.major_version, reply.minor_version))
    }

    /// Waits until the server has handled everything sent so far. False when
    /// the connection is gone.
    pub fn sync(&self) -> bool {
        self.conn.get_input_focus().ok().and_then(|cookie| cookie.reply().ok()).is_some()
    }
}

/// What the display offers, asked once at boot.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Probe {
    /// XInput 2: raw key events, for the hold key.
    pub xinput2: bool,
    /// XTEST: synthetic key events, for the paste chord.
    pub xtest: bool,
    /// Why nothing is offered, when the display could not be opened.
    pub error: Option<String>,
}

pub fn probe() -> &'static Probe {
    static PROBE: OnceLock<Probe> = OnceLock::new();
    PROBE.get_or_init(|| match Display::open() {
        Ok(display) => Probe {
            xinput2: display.xinput_version().is_some_and(|(major, _)| major >= 2),
            xtest: display.has_extension(xtest::X11_EXTENSION_NAME),
            error: None,
        },
        Err(error) => Probe { xinput2: false, xtest: false, error: Some(error) },
    })
}

// ------------------------------------------------- our own synthetic keys

/// Until when (milliseconds on [`clock_ms`]) the helper's own synthetic keys
/// may still be arriving at the hold key's listener.
static INJECTING_UNTIL: AtomicU64 = AtomicU64::new(0);

fn clock_ms() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// The paste chord is about to post keys for at most `span`. The hold key's
/// listener sees them too (X11 shows every client every key) and must not
/// take the `v` of a paste for the user pressing another key.
pub fn injecting_for(span: Duration) {
    INJECTING_UNTIL.fetch_max(clock_ms() + span.as_millis() as u64, Ordering::Relaxed);
}

pub fn is_injecting() -> bool {
    clock_ms() < INJECTING_UNTIL.load(Ordering::Relaxed)
}

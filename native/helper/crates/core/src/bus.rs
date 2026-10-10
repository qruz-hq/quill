//! The one channel into the controller thread. Everything that happens
//! outside it (a line on stdin, a buffer of audio, a key edge, a finished
//! transcription) becomes a [`Msg`], so all state has a single owner.

use std::time::Instant;

use crossbeam_channel::{unbounded, Receiver, Sender};

use crate::command::Command;
use crate::event::Event;
use crate::gesture::KeyEdge;

/// Identifies one opened capture, so buffers from a capture that has since
/// been closed are recognised and dropped.
pub type CaptureId = u64;

#[derive(Debug)]
pub enum Msg {
    Command(Command),
    /// stdin closed: main is gone.
    Eof,
    /// 16 kHz mono floats from the capture `capture`.
    Samples { capture: CaptureId, samples: Vec<f32> },
    /// That capture died (unplugged, runtime error). Its stream is still to be dropped.
    CaptureLost { capture: CaptureId, reason: String },
    /// The device list or the default input changed. Debounced by the session.
    DevicesChanged,
    Key { edge: KeyEdge, at: Instant },
    /// A hook that reports by itself (the OS removed it, it came back).
    HotkeyStatus { installed: bool, reason: Option<String> },
    /// What the helper can do changed while running: the handshake is sent again.
    CapabilitiesChanged,
    /// A partial decode of recording `recording` finished.
    PartialDone { recording: u64, text: String },
    /// A worker thread's answer (`final`, `inserted`, `cal`, `error`), written
    /// by the controller so it is ordered with everything else.
    Emit(Event),
}

/// Cloneable handle to the controller. Backends are given one when they are
/// built and keep it for their callbacks.
#[derive(Clone)]
pub struct Bus {
    tx: Sender<Msg>,
}

impl Bus {
    pub fn new() -> (Bus, Receiver<Msg>) {
        let (tx, rx) = unbounded();
        (Bus { tx }, rx)
    }

    /// Never blocks. A message sent while the helper is exiting is dropped.
    pub fn send(&self, msg: Msg) {
        let _ = self.tx.send(msg);
    }

    /// Device watcher: something was plugged in, removed, or the default moved.
    pub fn devices_changed(&self) {
        self.send(Msg::DevicesChanged);
    }

    /// Hotkey backend: a raw edge, stamped where it was observed (in the hook
    /// callback), not where it is handled.
    pub fn key(&self, edge: KeyEdge, at: Instant) {
        self.send(Msg::Key { edge, at });
    }

    /// Hotkey backend: the hook's state changed without an `install` call.
    pub fn hotkey_status(&self, installed: bool, reason: Option<&str>) {
        self.send(Msg::HotkeyStatus { installed, reason: reason.map(str::to_string) });
    }

    /// Any backend: what [`supported`](crate::caps) reports has changed.
    pub fn capabilities_changed(&self) {
        self.send(Msg::CapabilitiesChanged);
    }

    /// A worker thread's event.
    pub fn emit(&self, event: Event) {
        self.send(Msg::Emit(event));
    }
}

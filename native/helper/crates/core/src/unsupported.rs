//! A stand-in for every capability: compiles everywhere, does nothing, and
//! says so. A platform file that has no real backend yet returns one of
//! these, and the capability stays out of the handshake.

use std::path::Path;

use serde_json::{json, Map, Value};

use crate::caps::*;

pub const UNSUPPORTED: &str = "unsupported";

pub struct NoAudio;

impl AudioCapture for NoAudio {
    fn supported(&self) -> bool {
        false
    }
    fn devices(&self) -> Vec<DeviceInfo> {
        Vec::new()
    }
    fn open(&mut self, _uid: Option<&str>, _sink: CaptureSink) -> Result<Box<dyn CaptureStream>, CaptureError> {
        Err(CaptureError::new("Microphone capture is not available in this build."))
    }
}

pub struct NoDeviceWatcher;

impl DeviceWatcher for NoDeviceWatcher {
    fn start(&mut self) {}
}

pub struct NoTranscriber;

impl Transcriber for NoTranscriber {
    fn supported(&self) -> bool {
        false
    }
    fn transcribe(&self, _job: &TranscribeJob<'_>) -> Result<String, TranscribeError> {
        Err(TranscribeError(UNSUPPORTED.to_string()))
    }
    fn detect_language(&self, _model: &Path, _samples: &[f32]) -> Option<String> {
        None
    }
}

pub struct NoHotkey;

impl Hotkey for NoHotkey {
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
}

pub struct NoInserter;

impl TextInserter for NoInserter {
    fn supported(&self) -> bool {
        false
    }
    fn paste(&self, _text: &str) -> Result<Option<ClipboardRestore>, InsertError> {
        Err(InsertError { message: "Quill cannot type into other apps in this build.".to_string() })
    }
}

pub struct NoDucker;

impl Ducker for NoDucker {
    fn supported(&self) -> bool {
        false
    }
    fn recover(&self) {}
    fn duck(&self, _level: f32) {}
    fn restore(&self) {}
    fn retry_orphans(&self) {}
}

/// No permission gate: everything is "trusted" (Windows, Linux).
pub struct NoGate;

impl Permissions for NoGate {
    fn has_accessibility_gate(&self) -> bool {
        false
    }
    fn accessibility_trusted(&self) -> bool {
        true
    }
}

pub struct NoCalendar;

impl Calendar for NoCalendar {
    fn supported(&self) -> bool {
        false
    }
    fn call(&self, _op: &str, _args: &Map<String, Value>, reply: CalReply) {
        let mut result = Map::new();
        result.insert("error".to_string(), json!(UNSUPPORTED));
        reply(result);
    }
}

/// A full set of stand-ins.
pub fn backends() -> Backends {
    use std::sync::Arc;
    Backends {
        audio: Box::new(NoAudio),
        watcher: Box::new(NoDeviceWatcher),
        transcriber: Arc::new(NoTranscriber),
        hotkey: Box::new(NoHotkey),
        inserter: Arc::new(NoInserter),
        ducker: Arc::new(NoDucker),
        permissions: Arc::new(NoGate),
        calendar: Arc::new(NoCalendar),
    }
}

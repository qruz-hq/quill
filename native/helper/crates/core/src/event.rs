//! The stdout half of the protocol: typed events, one JSON object per line
//! (section 4), and the sink that writes them whole.

use std::io::Write;
use std::sync::Mutex;

use serde::Serialize;
use serde_json::{Map, Value};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DeviceInfo {
    /// Not stable and not read by main: a list index is fine.
    pub id: u32,
    /// Stable across reconnects, unique in the list.
    pub uid: String,
    pub name: String,
    #[serde(rename = "isDefault")]
    pub is_default: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Macos,
    Windows,
    Linux,
}

impl Platform {
    /// What this build targets.
    pub const fn current() -> Self {
        if cfg!(target_os = "macos") {
            Platform::Macos
        } else if cfg!(windows) {
            Platform::Windows
        } else {
            Platform::Linux
        }
    }
}

/// The handshake of section 11.2.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Capabilities {
    pub protocol: u32,
    pub platform: Platform,
    pub helper: String,
    pub capabilities: Vec<String>,
    #[serde(rename = "holdKeys")]
    pub hold_keys: Vec<u32>,
    pub notes: Map<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MicTestState {
    Started,
    Ended,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HotkeyIntent {
    Start,
    Stop,
    Cancel,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Event {
    Boot {
        pid: u32,
    },
    Capabilities(Capabilities),
    HotkeyStatus {
        installed: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    Devices {
        devices: Vec<DeviceInfo>,
        pinned: String,
    },
    Started,
    Level {
        value: f32,
    },
    Spectrum {
        bands: Vec<f32>,
    },
    Partial {
        text: String,
    },
    Chunk {
        b64: String,
    },
    Transcribing,
    Audio {
        id: String,
        path: String,
        seconds: f64,
    },
    Final {
        id: String,
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Cancelled,
    StartFailed {
        message: String,
    },
    Interrupted,
    MicTest {
        state: MicTestState,
        #[serde(skip_serializing_if = "Option::is_none")]
        device: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    MicTestLevel {
        value: f32,
    },
    Inserted {
        chars: usize,
    },
    Ax {
        trusted: bool,
    },
    Hotkey {
        intent: HotkeyIntent,
        #[serde(skip_serializing_if = "Option::is_none")]
        latched: Option<bool>,
    },
    Cal {
        id: String,
        #[serde(flatten)]
        result: Map<String, Value>,
    },
    Error {
        message: String,
    },
}

impl Event {
    pub fn final_text(id: impl Into<String>, text: impl Into<String>) -> Self {
        Event::Final { id: id.into(), text: text.into(), error: None }
    }

    /// A `final` with no text and the helper's own reason, written for the user.
    pub fn final_error(id: impl Into<String>, error: impl Into<String>) -> Self {
        Event::Final { id: id.into(), text: String::new(), error: Some(error.into()) }
    }

    pub fn mic_test_started(device: impl Into<String>) -> Self {
        Event::MicTest { state: MicTestState::Started, device: Some(device.into()), error: None }
    }

    pub fn mic_test_ended(error: Option<String>) -> Self {
        Event::MicTest { state: MicTestState::Ended, device: None, error }
    }

    /// A `cal` answer. `id` and `type` in `result` would collide with the
    /// envelope, so they are dropped.
    pub fn cal(id: impl Into<String>, mut result: Map<String, Value>) -> Self {
        result.remove("id");
        result.remove("type");
        Event::Cal { id: id.into(), result }
    }

    /// The line as written: one JSON object, no raw line break, `\n` terminated.
    pub fn to_line(&self) -> Vec<u8> {
        // Serialising these types cannot fail (string keys, no foreign Serialize
        // impls); a non-finite float is written as null by serde_json.
        let mut line = serde_json::to_vec(self).unwrap_or_else(|_| br#"{"type":"error","message":"unserialisable event"}"#.to_vec());
        line.push(b'\n');
        line
    }
}

/// Where events go. The session only ever talks to this.
pub trait EventSink: Send + Sync {
    fn emit(&self, event: &Event);
}

static STDOUT_LOCK: Mutex<()> = Mutex::new(());

/// Writes each event to stdout as one whole line and flushes it: main reads a
/// pipe, and a block-buffered line would never arrive. A failed write (main is
/// gone) is swallowed; the reader thread sees the closed stdin and quits.
pub struct StdoutSink;

impl EventSink for StdoutSink {
    fn emit(&self, event: &Event) {
        let line = event.to_line();
        let _guard = STDOUT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(&line);
        let _ = out.flush();
    }
}

/// Blocks further events for good. Taken on the way out, so the process never
/// exits half way through a line.
pub fn seal_stdout() {
    std::mem::forget(STDOUT_LOCK.lock().unwrap_or_else(|e| e.into_inner()));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn value(event: &Event) -> Value {
        let line = event.to_line();
        assert_eq!(line.last(), Some(&b'\n'));
        assert_eq!(line.iter().filter(|b| **b == b'\n').count(), 1, "one line per event");
        serde_json::from_slice(&line).unwrap()
    }

    #[test]
    fn unit_events_carry_only_their_type() {
        assert_eq!(value(&Event::Started), json!({"type": "started"}));
        assert_eq!(value(&Event::Transcribing), json!({"type": "transcribing"}));
        assert_eq!(value(&Event::Cancelled), json!({"type": "cancelled"}));
        assert_eq!(value(&Event::Interrupted), json!({"type": "interrupted"}));
    }

    #[test]
    fn type_names_match_the_contract() {
        assert_eq!(value(&Event::Boot { pid: 7 }), json!({"type": "boot", "pid": 7}));
        assert_eq!(value(&Event::StartFailed { message: "m".into() }), json!({"type": "start-failed", "message": "m"}));
        assert_eq!(value(&Event::MicTestLevel { value: 0.5 }), json!({"type": "mic-test-level", "value": 0.5}));
        assert_eq!(value(&Event::Level { value: 0.25 }), json!({"type": "level", "value": 0.25}));
        assert_eq!(value(&Event::Ax { trusted: true }), json!({"type": "ax", "trusted": true}));
        assert_eq!(value(&Event::Inserted { chars: 12 }), json!({"type": "inserted", "chars": 12}));
        assert_eq!(value(&Event::Chunk { b64: "AAA=".into() }), json!({"type": "chunk", "b64": "AAA="}));
        assert_eq!(value(&Event::Partial { text: "hi".into() }), json!({"type": "partial", "text": "hi"}));
        assert_eq!(value(&Event::Error { message: "x".into() }), json!({"type": "error", "message": "x"}));
        assert_eq!(value(&Event::Spectrum { bands: vec![0.0, 1.0] }), json!({"type": "spectrum", "bands": [0.0, 1.0]}));
    }

    #[test]
    fn optional_fields_are_left_out() {
        assert_eq!(value(&Event::final_text("9", "hello")), json!({"type": "final", "id": "9", "text": "hello"}));
        assert_eq!(
            value(&Event::final_error("", "No speech model installed.")),
            json!({"type": "final", "id": "", "text": "", "error": "No speech model installed."})
        );
        assert_eq!(value(&Event::HotkeyStatus { installed: true, reason: None }), json!({"type": "hotkey-status", "installed": true}));
        assert_eq!(
            value(&Event::HotkeyStatus { installed: false, reason: Some("accessibility".into()) }),
            json!({"type": "hotkey-status", "installed": false, "reason": "accessibility"})
        );
        assert_eq!(value(&Event::mic_test_started("MacBook Pro Microphone")), json!({"type": "mic-test", "state": "started", "device": "MacBook Pro Microphone"}));
        assert_eq!(value(&Event::mic_test_ended(None)), json!({"type": "mic-test", "state": "ended"}));
        assert_eq!(value(&Event::mic_test_ended(Some("nope".into()))), json!({"type": "mic-test", "state": "ended", "error": "nope"}));
        assert_eq!(
            value(&Event::Hotkey { intent: HotkeyIntent::Start, latched: Some(false) }),
            json!({"type": "hotkey", "intent": "start", "latched": false})
        );
        assert_eq!(value(&Event::Hotkey { intent: HotkeyIntent::Cancel, latched: None }), json!({"type": "hotkey", "intent": "cancel"}));
    }

    #[test]
    fn ids_stay_strings() {
        assert_eq!(value(&Event::final_text("0007", ""))["id"], json!("0007"));
        let audio = Event::Audio { id: "12".into(), path: "/tmp/quill-x.wav".into(), seconds: 1.25 };
        assert_eq!(value(&audio), json!({"type": "audio", "id": "12", "path": "/tmp/quill-x.wav", "seconds": 1.25}));
    }

    #[test]
    fn line_breaks_in_text_are_escaped() {
        let line = Event::final_text("1", "two\nlines\r\nhere").to_line();
        assert_eq!(line.iter().filter(|b| **b == b'\n' || **b == b'\r').count(), 1);
        assert_eq!(value(&Event::final_text("1", "two\nlines"))["text"], json!("two\nlines"));
    }

    #[test]
    fn devices_use_the_wire_field_names() {
        let event = Event::Devices {
            devices: vec![DeviceInfo { id: 0, uid: "BuiltInMicrophoneDevice".into(), name: "MacBook Pro Microphone".into(), is_default: true }],
            pinned: String::new(),
        };
        assert_eq!(
            value(&event),
            json!({"type": "devices", "pinned": "", "devices": [
                {"id": 0, "uid": "BuiltInMicrophoneDevice", "name": "MacBook Pro Microphone", "isDefault": true}]})
        );
    }

    #[test]
    fn cal_answers_are_flat() {
        let mut result = Map::new();
        result.insert("status".into(), json!("granted"));
        result.insert("id".into(), json!("spoofed"));
        result.insert("type".into(), json!("spoofed"));
        assert_eq!(value(&Event::cal("c7", result)), json!({"type": "cal", "id": "c7", "status": "granted"}));
    }

    #[test]
    fn capabilities_handshake_shape() {
        let event = Event::Capabilities(Capabilities {
            protocol: 1,
            platform: Platform::Macos,
            helper: "flow-stt 0.2.0".into(),
            capabilities: vec!["audio".into(), "duck".into()],
            hold_keys: vec![63, 54],
            notes: Map::new(),
        });
        assert_eq!(
            value(&event),
            json!({"type": "capabilities", "protocol": 1, "platform": "macos", "helper": "flow-stt 0.2.0",
                   "capabilities": ["audio", "duck"], "holdKeys": [63, 54], "notes": {}})
        );
    }

    #[test]
    fn a_non_finite_number_never_breaks_the_line() {
        let line = Event::Level { value: f32::NAN }.to_line();
        assert!(serde_json::from_slice::<Value>(&line).is_ok());
    }
}

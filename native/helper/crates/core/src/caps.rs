//! One trait per capability. The session is written against these and nothing
//! else; `flow-stt` picks an implementation per OS at compile time.
//!
//! Threading. `AudioCapture`, `CaptureStream`, `DeviceWatcher` and `Hotkey`
//! are created and called on the controller thread only, so they need not be
//! `Send` (a `cpal::Stream` is not). The others are shared with worker threads
//! and with the shutdown path, and must be `Send + Sync`. No method may block
//! the controller for long except `AudioCapture::open` (opening a Bluetooth
//! microphone can take a second) and dropping a `CaptureStream`.
//!
//! Backends talk back through the [`Bus`] they were built with, never by
//! writing to stdout.

use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use serde_json::{Map, Value};

use crate::bus::{Bus, CaptureId, Msg};
pub use crate::event::DeviceInfo;
use crate::resample::{downmix, Resampler};

// ------------------------------------------------------------------ audio

/// Why a microphone could not be opened. `message` is written for the user: it
/// is shown as a mic test's `error` (section 9 has the reference wording).
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("{message}")]
pub struct CaptureError {
    pub message: String,
}

impl CaptureError {
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into() }
    }

    pub fn no_device() -> Self {
        Self::new("No microphone found. Connect one or pick another input in Settings.")
    }

    pub fn open_failed(device: &str) -> Self {
        Self::new(format!("Could not open {device}. Pick another input in Settings."))
    }

    pub fn read_failed(device: &str) -> Self {
        Self::new(format!("Could not read audio from {device}."))
    }
}

/// Where a capture delivers its audio. Owned by the capture's callback.
pub struct CaptureSink {
    bus: Bus,
    capture: CaptureId,
    resampler: Option<(u32, Resampler)>,
    /// Samples the device sent that were NaN or infinite, replaced by silence.
    /// One of them reaching whisper turns every logit into NaN, and the text
    /// into a line of "!".
    non_finite: u64,
}

impl CaptureSink {
    pub fn new(bus: Bus, capture: CaptureId) -> Self {
        Self { bus, capture, resampler: None, non_finite: 0 }
    }

    /// Replaces NaN and infinite samples with silence, and says so once per
    /// capture (the total is logged when the capture ends).
    fn sanitize<'a>(&mut self, samples: &'a [f32]) -> std::borrow::Cow<'a, [f32]> {
        let bad = samples.iter().filter(|s| !s.is_finite()).count();
        if bad == 0 {
            return std::borrow::Cow::Borrowed(samples);
        }
        if self.non_finite == 0 {
            crate::logln!("mic: the device sent NaN or infinite samples, replacing them with silence");
        }
        self.non_finite += bad as u64;
        std::borrow::Cow::Owned(samples.iter().map(|&s| if s.is_finite() { s } else { 0.0 }).collect())
    }

    /// Audio that already is 16 kHz mono.
    pub fn push_mono_16k(&self, samples: &[f32]) {
        if !samples.is_empty() {
            self.bus.send(Msg::Samples { capture: self.capture, samples: samples.to_vec() });
        }
    }

    /// Interleaved float frames in the device's own format: downmixed and
    /// resampled to 16 kHz here.
    pub fn push(&mut self, interleaved: &[f32], channels: u16, rate: u32) {
        let interleaved = self.sanitize(interleaved);
        let mono = downmix(&interleaved, channels);
        if rate == crate::SAMPLE_RATE {
            return self.push_mono_16k(&mono);
        }
        // A device that changes rate mid-stream gets a fresh resampler.
        if self.resampler.as_ref().map(|(r, _)| *r) != Some(rate) {
            self.resampler = Some((rate, Resampler::to_16k(rate)));
        }
        let mut out = Vec::with_capacity(mono.len() * crate::SAMPLE_RATE as usize / rate.max(1) as usize + 8);
        if let Some((_, resampler)) = self.resampler.as_mut() {
            resampler.process(&mono, &mut out);
        }
        self.push_mono_16k(&out);
    }

    /// For the capture's error callback, which usually lives apart from the
    /// data callback.
    pub fn lost_handle(&self) -> LostHandle {
        LostHandle { bus: self.bus.clone(), capture: self.capture }
    }
}

impl Drop for CaptureSink {
    fn drop(&mut self) {
        if self.non_finite > 0 {
            crate::logln!("mic: {} NaN or infinite samples replaced with silence in this capture", self.non_finite);
        }
    }
}

/// Reports that a capture died by itself.
#[derive(Clone)]
pub struct LostHandle {
    bus: Bus,
    capture: CaptureId,
}

impl LostHandle {
    /// The device was unplugged or the stream fell over. The session drops the
    /// stream and retries on whatever device is there now (section 5.2).
    pub fn lost(&self, reason: &str) {
        self.bus.send(Msg::CaptureLost { capture: self.capture, reason: reason.to_string() });
    }
}

/// An open microphone. Dropping it must release the device before returning:
/// a Bluetooth headset only leaves its call profile once nothing holds its mic.
pub trait CaptureStream {
    /// The device's display name (`mic-test` `started` carries it).
    fn name(&self) -> &str;
}

/// Capability ids `audio`, `devices`, `level`, `spectrum`, `mic-test`,
/// `cloud-audio`, `stream`.
pub trait AudioCapture {
    fn supported(&self) -> bool;

    /// Input devices. `uid` must be stable across reconnects.
    fn devices(&self) -> Vec<DeviceInfo>;

    /// Opens `uid`, or the system default input for `None`. A `uid` that is
    /// not connected falls back to the default (the pin is the session's to
    /// keep). No device at all: [`CaptureError::no_device`].
    ///
    /// Audio goes to `sink` from the moment this returns `Ok` until the stream
    /// is dropped; a stream that dies reports through `sink.lost_handle()`.
    fn open(&mut self, uid: Option<&str>, sink: CaptureSink) -> Result<Box<dyn CaptureStream>, CaptureError>;
}

/// Hot-plug and default-input changes: call `bus.devices_changed()` for each,
/// from any thread. The session debounces (250 ms) and re-lists.
pub trait DeviceWatcher {
    /// Starts watching. Called once, at boot.
    fn start(&mut self);
}

// ---------------------------------------------------------- transcription

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecodeMode {
    /// Beam search: `stop`, `retry`, `transcribe-file`.
    Final,
    /// Greedy, for interim text while the user is still speaking.
    Partial,
}

pub struct TranscribeJob<'a> {
    pub model: &'a Path,
    /// 16 kHz mono.
    pub samples: &'a [f32],
    /// An ISO 639-1 code, or `auto`.
    pub language: &'a str,
    pub mode: DecodeMode,
    /// Set when the answer is no longer wanted (a partial whose recording
    /// ended). Checking it is optional but keeps `stop` from waiting.
    pub abort: &'a AtomicBool,
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("{0}")]
pub struct TranscribeError(pub String);

/// Capability ids `transcribe`, `partials`, `language-detect`,
/// `transcribe-file`. Called from worker threads, several at once: a `final`
/// and a `transcribe-file` can overlap, and a partial can still be decoding
/// when a `stop` arrives. Serialise inside if the engine needs it.
pub trait Transcriber: Send + Sync {
    fn supported(&self) -> bool;

    /// Whisper's raw text, one segment per line. The session applies the text
    /// rules of section 5.3 (`text::clean_transcript`). An error is logged and
    /// becomes an empty `final`, never an `error` event.
    fn transcribe(&self, job: &TranscribeJob<'_>) -> Result<String, TranscribeError>;

    /// The spoken language as an ISO 639-1 code, or `None` when detection
    /// failed. Only called with several languages configured.
    fn detect_language(&self, model: &Path, samples: &[f32]) -> Option<String>;

    /// Whether interim passes are worth running while the user speaks. Each one
    /// re-decodes the whole recording, which a GPU does in a blink and a CPU
    /// does at full load on every core for as long as the key is held.
    fn partials(&self) -> bool {
        self.supported()
    }

    /// A word for the capabilities handshake's `notes` (`"metal"`, `"cpu"`).
    fn note(&self) -> Option<String> {
        None
    }
}

// ----------------------------------------------------------------- hotkey

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("{reason}")]
pub struct HotkeyError {
    /// `hotkey-status.reason`. Exactly `"accessibility"` means the permission
    /// is missing (main branches on it, section 9).
    pub reason: String,
    /// Try again on the 2 s poll.
    pub retry: bool,
}

/// Capability ids `hotkey` and `hotkey-swallow`. The backend owns the OS key
/// hook and reports raw edges with `bus.key(edge, Instant::now())` from its
/// callback: `Down` and `Up` for the configured key only, `OtherKey` for any
/// non-modifier key going down. The gesture logic is the session's
/// (`gesture::Gesture`). Whether to swallow an event has to be decided inside
/// the callback, so that stays with the backend.
pub trait Hotkey {
    fn supported(&self) -> bool;

    /// True when a standalone release of the hold key is kept from the OS.
    fn swallows(&self) -> bool {
        false
    }

    /// Keycodes `holdkey` accepts on this platform (the handshake's `holdKeys`).
    fn hold_keys(&self) -> Vec<u32>;

    /// Installs the hook. A no-op returning `Ok` when it is installed already.
    fn install(&mut self) -> Result<(), HotkeyError>;

    fn installed(&self) -> bool;

    /// Chooses the hold key; `None` leaves every key to the OS (the hook may
    /// stay installed). Takes effect at once.
    fn set_key(&mut self, key: Option<u32>);

    /// Legacy `fn-capture-on|off`.
    fn set_swallow(&mut self, _on: bool) {}

    fn note(&self) -> Option<String> {
        None
    }
}

// ----------------------------------------------------------------- typing

/// Between staging the text on the clipboard and posting the paste chord.
pub const PASTE_DELAY: Duration = Duration::from_millis(60);
/// Between the paste chord and putting the user's clipboard back.
pub const CLIPBOARD_RESTORE_DELAY: Duration = Duration::from_millis(350);

/// `message` goes to the user in an `error` event.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("{message}")]
pub struct InsertError {
    pub message: String,
}

/// Puts the user's clipboard back. Run by the session
/// [`CLIPBOARD_RESTORE_DELAY`] after the paste.
pub type ClipboardRestore = Box<dyn FnOnce() + Send>;

/// Capability id `insert`. Called on a dedicated thread, one insert at a time.
pub trait TextInserter: Send + Sync {
    fn supported(&self) -> bool;

    /// Saves the clipboard, stages `text` on it, waits [`PASTE_DELAY`] and
    /// posts the paste chord. Returns once the chord is posted (`inserted` is
    /// sent then), with the restore to run afterwards, or `None` when there is
    /// nothing to put back (the clipboard held no text).
    fn paste(&self, text: &str) -> Result<Option<ClipboardRestore>, InsertError>;

    fn note(&self) -> Option<String> {
        None
    }
}

// ---------------------------------------------------------------- ducking

/// Capability id `duck` (section 7). Shared with the shutdown path: every way
/// out of the process calls `restore`, possibly from another thread while the
/// controller is in `duck`, so implementations lock their own state.
pub trait Ducker: Send + Sync {
    fn supported(&self) -> bool;

    /// At boot, before `boot` is written: undo a duck that a previous run left
    /// behind (the duck state file, `paths::duck_state_file`).
    fn recover(&self);

    /// Lowers the default output to `level` (0 to 1) times its current volume
    /// and remembers what it was. A no-op when already ducked. Only called
    /// with ducking on.
    fn duck(&self, level: f32);

    /// Puts back what `duck` changed. A no-op when nothing is ducked: with
    /// `duck off` this must not read or write any volume.
    fn restore(&self);

    /// A device that was gone at restore time may be back: called when the
    /// device list changes and before each `duck`. A no-op with no orphans.
    fn retry_orphans(&self);

    fn note(&self) -> Option<String> {
        None
    }
}

// ------------------------------------------------------------ permissions

/// Capability id `accessibility`, and the platform's wording.
pub trait Permissions: Send + Sync {
    /// True where typing and the hold key sit behind a user grant (macOS).
    fn has_accessibility_gate(&self) -> bool;

    /// The grant as it is now, without prompting. `true` where there is no gate.
    fn accessibility_trusted(&self) -> bool;

    /// `final.error` for a recording of digital silence (section 5.3 step 2).
    /// Must contain the word "microphone".
    fn silent_microphone_message(&self) -> String {
        "No audio from the microphone. Check the input device and its permissions.".to_string()
    }
}

// --------------------------------------------------------------- calendar

/// Answers one `cal` op; the session adds `type` and `id`.
pub type CalReply = Box<dyn FnOnce(Map<String, Value>) + Send>;

/// The ops of section 8. Anything else is answered `unknown op` by the session.
pub const CALENDAR_OPS: [&str; 5] = ["status", "request", "calendars", "upsert", "delete"];

/// Capability id `calendar`. Called on a dedicated thread, one op at a time,
/// in the order the ops arrived.
pub trait Calendar: Send + Sync {
    fn supported(&self) -> bool;

    /// Runs `op` (one of [`CALENDAR_OPS`]) and calls `reply` exactly once, now
    /// or later from any thread (`request` waits for the user).
    fn call(&self, op: &str, args: &Map<String, Value>, reply: CalReply);
}

/// Everything a session needs, one implementation per capability.
pub struct Backends {
    pub audio: Box<dyn AudioCapture>,
    pub watcher: Box<dyn DeviceWatcher>,
    pub transcriber: std::sync::Arc<dyn Transcriber>,
    pub hotkey: Box<dyn Hotkey>,
    pub inserter: std::sync::Arc<dyn TextInserter>,
    pub ducker: std::sync::Arc<dyn Ducker>,
    pub permissions: std::sync::Arc<dyn Permissions>,
    pub calendar: std::sync::Arc<dyn Calendar>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drain(rx: &crossbeam_channel::Receiver<Msg>) -> Vec<f32> {
        let mut all = Vec::new();
        while let Ok(msg) = rx.try_recv() {
            match msg {
                Msg::Samples { capture: 3, samples } => all.extend(samples),
                other => panic!("unexpected {other:?}"),
            }
        }
        all
    }

    #[test]
    fn sink_passes_sixteen_kilohertz_mono_through() {
        let (bus, rx) = Bus::new();
        let mut sink = CaptureSink::new(bus, 3);
        sink.push_mono_16k(&[0.1, 0.2]);
        sink.push(&[0.3, 0.4], 1, 16_000);
        sink.push_mono_16k(&[]);
        assert_eq!(drain(&rx), vec![0.1, 0.2, 0.3, 0.4]);
    }

    #[test]
    fn sink_downmixes_and_resamples() {
        let (bus, rx) = Bus::new();
        let mut sink = CaptureSink::new(bus, 3);
        // One second of stereo 48 kHz in 10 ms callbacks.
        let frame: Vec<f32> = (0..480).flat_map(|_| [0.5f32, -0.1]).collect();
        for _ in 0..100 {
            sink.push(&frame, 2, 48_000);
        }
        let out = drain(&rx);
        assert!((out.len() as i64 - 16_000).abs() < 200, "{}", out.len());
        // The mean of the two channels, once the filter has settled.
        assert!(out[2000..].iter().all(|s| (s - 0.2).abs() < 0.01));
    }

    #[test]
    fn nan_and_infinite_samples_become_silence() {
        let (bus, rx) = Bus::new();
        let mut sink = CaptureSink::new(bus, 3);
        sink.push(&[0.5, f32::NAN, f32::INFINITY, -0.25], 1, 16_000);
        assert_eq!(drain(&rx), vec![0.5, 0.0, 0.0, -0.25]);
        // Resampled audio stays finite too: one NaN would spread over the kernel.
        let frame: Vec<f32> = (0..960).map(|i| if i == 100 { f32::NAN } else { 0.1 }).collect();
        for _ in 0..10 {
            sink.push(&frame, 2, 48_000);
        }
        assert!(drain(&rx).iter().all(|s| s.is_finite()));
    }

    #[test]
    fn a_lost_capture_is_reported_with_its_id() {
        let (bus, rx) = Bus::new();
        let sink = CaptureSink::new(bus, 9);
        sink.lost_handle().lost("unplugged");
        assert!(matches!(rx.try_recv(), Ok(Msg::CaptureLost { capture: 9, reason }) if reason == "unplugged"));
    }
}

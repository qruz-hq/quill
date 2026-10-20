//! The helper's state machine: what each command does, in what order events
//! leave, and what happens when a microphone will not open or goes away
//! (sections 2 to 7). Owned by the controller thread. It never touches an OS
//! API itself: everything goes through the traits in [`crate::caps`], and time
//! is passed in, so the whole of it runs under test with fake backends.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crossbeam_channel::Sender;
use serde_json::{json, Map, Value};

use crate::bus::{Bus, CaptureId, Msg};
use crate::caps::*;
use crate::command::{Command, Engine};
use crate::event::{Capabilities, Event, EventSink, HotkeyIntent, Platform};
use crate::gesture::{Gesture, Intent};
use crate::level::{level, peak};
use crate::logln;
use crate::pcm::Chunker;
use crate::spectrum::Spectrum;
use crate::text::{clean_transcript, first_language, resolve_language};
use crate::SAMPLE_RATE;

pub const PROTOCOL_VERSION: u32 = 1;

pub const PARTIAL_INTERVAL: Duration = Duration::from_millis(1500);
/// A partial needs at least this much audio (1.0 s).
pub const PARTIAL_MIN_SAMPLES: usize = SAMPLE_RATE as usize;
pub const CHUNK_INTERVAL: Duration = Duration::from_millis(200);
pub const MIC_TEST_DURATION: Duration = Duration::from_secs(6);
pub const MIC_RETRY_INTERVAL: Duration = Duration::from_millis(250);
/// Retries after the first failed attempt (7 attempts in all).
pub const MIC_RETRIES: u32 = 6;
pub const DEVICE_DEBOUNCE: Duration = Duration::from_millis(250);
pub const HOTKEY_POLL: Duration = Duration::from_secs(2);
/// 0.3 s or shorter is too short to hold speech.
pub const MIN_SAMPLES: usize = (SAMPLE_RATE as usize * 3) / 10;
/// Digital silence: peak below this for longer than [`SILENCE_MIN_SAMPLES`].
pub const SILENCE_PEAK: f32 = 0.0005;
pub const SILENCE_MIN_SAMPLES: usize = SAMPLE_RATE as usize / 2;
pub const DEFAULT_DUCK_LEVEL: f32 = 0.15;

pub const MSG_START_FAILED: &str = "Could not open the microphone. Check the input in Settings and try again.";
pub const MSG_NO_MODEL: &str = "No speech model installed. Pick one in Settings.";
pub const MSG_NO_MODEL_FALLBACK: &str = "Cloud transcription failed and no speech model is installed to fall back on.";
pub const MSG_WAV_FAILED: &str = "Could not save the recording for upload.";
pub const MSG_NO_LOCAL: &str = "This computer cannot run the local speech model. Switch to cloud transcription in Settings.";

/// What the settings commands set. Main re-sends all of it on every spawn, so
/// the defaults only matter for the instant before those lines are read.
#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
    pub model: String,
    pub languages: Vec<String>,
    /// `None` is `duck off`.
    pub duck: Option<f32>,
    pub engine: Engine,
    pub stream: bool,
    pub pinned: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            model: String::new(),
            languages: vec!["en".to_string()],
            duck: Some(DEFAULT_DUCK_LEVEL),
            engine: Engine::Local,
            stream: false,
            pinned: None,
        }
    }
}

struct OpenStream {
    capture: CaptureId,
    /// Held for its `Drop`, which releases the device.
    _stream: Box<dyn CaptureStream>,
    spectrum: Spectrum,
}

struct Recording {
    id: u64,
    /// `None` while the microphone is being retried, or after `interrupted`.
    stream: Option<OpenStream>,
    samples: Vec<f32>,
    /// `stream on` as it was at `start`.
    streaming: bool,
    chunker: Chunker,
    next_chunk: Option<Instant>,
    next_partial: Option<Instant>,
    partial_in_flight: bool,
    /// Set when the recording ends, so a partial still decoding gives up.
    ended: Arc<AtomicBool>,
    /// The attempt due next (1 to [`MIC_RETRIES`]) and when.
    retry: Option<(u32, Instant)>,
}

struct MicTest {
    stream: OpenStream,
    ends_at: Instant,
}

/// A thread that runs jobs one at a time, in order.
struct Worker(Sender<Box<dyn FnOnce() + Send>>);

impl Worker {
    fn spawn(name: &str) -> Option<Worker> {
        let (tx, rx) = crossbeam_channel::unbounded::<Box<dyn FnOnce() + Send>>();
        std::thread::Builder::new()
            .name(name.to_string())
            .spawn(move || {
                for job in rx {
                    job();
                }
            })
            .ok()
            .map(|_| Worker(tx))
    }
}

pub struct Session {
    b: Backends,
    out: Arc<dyn EventSink>,
    bus: Bus,
    helper: String,
    settings: Settings,
    recording: Option<Recording>,
    /// The last finished recording, for `retry`. Memory only.
    kept: Option<Arc<Vec<f32>>>,
    test: Option<MicTest>,
    last_id: u64,
    gesture: Gesture,
    hotkey_enabled: bool,
    hotkey_poll: Option<Instant>,
    devices_due: Option<Instant>,
    insert_worker: Option<Worker>,
    calendar_worker: Option<Worker>,
}

impl Session {
    /// `helper` is the name and version reported in the handshake.
    pub fn new(backends: Backends, out: Arc<dyn EventSink>, bus: Bus, helper: impl Into<String>) -> Self {
        Self {
            b: backends,
            out,
            bus,
            helper: helper.into(),
            settings: Settings::default(),
            recording: None,
            kept: None,
            test: None,
            last_id: 0,
            gesture: Gesture::new(),
            hotkey_enabled: true,
            hotkey_poll: None,
            devices_due: None,
            insert_worker: None,
            calendar_worker: None,
        }
    }

    pub fn settings(&self) -> &Settings {
        &self.settings
    }

    pub fn is_recording(&self) -> bool {
        self.recording.is_some()
    }

    /// For the shutdown path: every way out restores the volume first.
    pub fn ducker(&self) -> Arc<dyn Ducker> {
        self.b.ducker.clone()
    }

    fn emit(&self, event: Event) {
        self.out.emit(&event);
    }

    fn next_id(&mut self) -> u64 {
        self.last_id += 1;
        self.last_id
    }

    // ------------------------------------------------------------- boot

    /// Section 3.1: undo a stale duck, then `boot`, the handshake, and the
    /// unprompted `hotkey-status` and `devices`.
    pub fn boot(&mut self, now: Instant) {
        self.b.ducker.recover();
        self.emit(Event::Boot { pid: std::process::id() });
        let caps = self.capabilities();
        logln!("boot: {} pid {} capabilities [{}]", self.helper, std::process::id(), caps.capabilities.join(", "));
        self.emit(Event::Capabilities(caps));
        if self.b.hotkey.supported() {
            self.install_hotkey(now);
        }
        self.b.watcher.start();
        self.emit_devices();
    }

    /// The handshake of section 11.2: what works in this build, here, now.
    pub fn capabilities(&self) -> Capabilities {
        let audio = self.b.audio.supported();
        let asr = self.b.transcriber.supported();
        let hotkey = self.b.hotkey.supported();
        let mut list: Vec<&str> = Vec::new();
        if audio {
            list.extend(["audio", "devices", "level", "spectrum", "mic-test"]);
        }
        if asr {
            list.push("transcribe");
            if audio && self.b.transcriber.partials() {
                list.push("partials");
            }
            list.extend(["language-detect", "transcribe-file"]);
        }
        if audio {
            list.extend(["cloud-audio", "stream"]);
        }
        if hotkey {
            list.push("hotkey");
            if self.b.hotkey.swallows() {
                list.push("hotkey-swallow");
            }
        }
        if self.b.inserter.supported() {
            list.push("insert");
        }
        if self.b.permissions.has_accessibility_gate() {
            list.push("accessibility");
        }
        if self.b.ducker.supported() {
            list.push("duck");
        }
        if self.b.calendar.supported() {
            list.push("calendar");
        }
        if audio && cfg!(target_os = "macos") {
            list.push("mic-permission-hint");
        }

        let mut notes = Map::new();
        for (key, note) in [
            ("transcribe", self.b.transcriber.note()),
            ("hotkey", self.b.hotkey.note()),
            ("insert", self.b.inserter.note()),
            ("duck", self.b.ducker.note()),
        ] {
            if let Some(note) = note {
                notes.insert(key.to_string(), json!(note));
            }
        }
        Capabilities {
            protocol: PROTOCOL_VERSION,
            platform: Platform::current(),
            helper: self.helper.clone(),
            capabilities: list.into_iter().map(str::to_string).collect(),
            hold_keys: if hotkey { self.b.hotkey.hold_keys() } else { Vec::new() },
            notes,
        }
    }

    // --------------------------------------------------------- messages

    pub fn handle(&mut self, msg: Msg, now: Instant) {
        match msg {
            Msg::Command(command) => self.command(command, now),
            Msg::Eof => {}
            Msg::Samples { capture, samples } => self.on_samples(capture, &samples),
            Msg::CaptureLost { capture, reason } => self.on_capture_lost(capture, &reason, now),
            Msg::DevicesChanged => self.devices_due = Some(now + DEVICE_DEBOUNCE),
            Msg::Key { edge, at } => {
                if self.hotkey_enabled {
                    let intent = self.gesture.edge(edge, at);
                    self.emit_intent(intent);
                }
            }
            Msg::HotkeyStatus { installed, reason } => {
                logln!("hotkey: {}", if installed { "installed".to_string() } else { format!("not installed ({})", reason.as_deref().unwrap_or("")) });
                self.hotkey_poll = (!installed).then(|| now + HOTKEY_POLL);
                self.emit(Event::HotkeyStatus { installed, reason: if installed { None } else { Some(reason.unwrap_or_else(|| "unknown".to_string())) } });
            }
            Msg::CapabilitiesChanged => self.emit(Event::Capabilities(self.capabilities())),
            Msg::PartialDone { recording, text } => {
                // Tied to its recording: a decode that outlived it says nothing.
                if let Some(rec) = self.recording.as_mut().filter(|r| r.id == recording) {
                    rec.partial_in_flight = false;
                    if !text.is_empty() {
                        self.emit(Event::Partial { text });
                    }
                }
            }
            Msg::Emit(event) => self.emit(event),
        }
    }

    fn command(&mut self, command: Command, now: Instant) {
        match command {
            Command::Start => self.start(now),
            Command::Stop { id } => self.stop(id),
            Command::Cancel => self.cancel(),
            Command::Retry { id } => self.retry(id),
            Command::Unlatch => {
                if self.gesture.is_latched() {
                    self.gesture.unlatch();
                    logln!("hotkey: unlatched by the app");
                }
            }
            Command::TranscribeFile { id, path } => self.transcribe_file(id, path),

            Command::Model(path) => {
                logln!("model set to: \"{path}\"");
                self.settings.model = path;
            }
            Command::Lang(languages) => {
                logln!("languages set to: {}", languages.join(", "));
                self.settings.languages = languages;
            }
            Command::Duck(level) => {
                logln!("duck: {}", level.map_or("off".to_string(), |l| format!("to {:.0}%", l * 100.0)));
                self.settings.duck = level;
            }
            Command::HoldKey(key) => {
                logln!("hold key: {}", key.map_or("disabled".to_string(), |k| format!("keycode {k}")));
                self.b.hotkey.set_key(key);
                self.hotkey_enabled = key.is_some();
                self.gesture.reset();
            }
            Command::Mic(uid) => {
                // From the next recording or mic test; one in progress keeps its device.
                logln!("mic: {}", uid.as_deref().unwrap_or("system default"));
                self.settings.pinned = uid;
                self.emit_devices();
            }
            Command::Engine(engine) => {
                logln!("engine: {engine:?}");
                self.settings.engine = engine;
            }
            Command::Stream(on) => {
                logln!("streaming: {on}");
                self.settings.stream = on;
            }
            Command::HoldMs(ms) => self.gesture.hold_threshold = Duration::from_secs_f64(ms / 1000.0),
            Command::DoubleTapMs(ms) => self.gesture.double_tap_window = Duration::from_secs_f64(ms / 1000.0),

            Command::Devices => self.emit_devices(),
            Command::MicTest => self.start_test(now),
            Command::MicTestStop => self.stop_test(),

            Command::Insert(text) => self.insert(text),
            Command::AxCheck => {
                let trusted = self.b.permissions.accessibility_trusted();
                self.emit(Event::Ax { trusted });
                // Main sends this when it sees the grant appear, so the hold
                // key comes up at once instead of on the next poll.
                if trusted && self.b.hotkey.supported() && !self.b.hotkey.installed() {
                    self.install_hotkey(now);
                }
            }
            Command::Cal { id, op, args } => self.calendar(id, op, args),
            // The runtime exits on `quit` before it gets here.
            Command::Quit => {}

            Command::HotkeyInstall => {
                if self.b.hotkey.supported() && !self.b.hotkey.installed() {
                    self.install_hotkey(now);
                }
            }
            Command::HotkeyEnabled(on) => {
                self.hotkey_enabled = on;
                if !on {
                    self.gesture.reset();
                }
            }
            Command::FnCapture(on) => self.b.hotkey.set_swallow(on),
        }
    }

    // ----------------------------------------------------------- timers

    /// The earliest moment [`tick`](Session::tick) has work to do.
    pub fn next_deadline(&self) -> Option<Instant> {
        let rec = self.recording.as_ref();
        [
            rec.and_then(|r| r.retry.map(|(_, at)| at)),
            rec.and_then(|r| r.next_chunk),
            rec.and_then(|r| r.next_partial),
            self.test.as_ref().map(|t| t.ends_at),
            self.devices_due,
            self.hotkey_poll,
            self.gesture.deadline(),
        ]
        .into_iter()
        .flatten()
        .min()
    }

    /// Runs whatever came due by `now`.
    pub fn tick(&mut self, now: Instant) {
        if let Some((attempt, at)) = self.recording.as_ref().and_then(|r| r.retry) {
            if now >= at {
                self.retry_open(attempt, now);
            }
        }
        if let Some(rec) = self.recording.as_mut() {
            if rec.next_chunk.is_some_and(|at| now >= at) {
                rec.next_chunk = Some(now + CHUNK_INTERVAL);
                if let Some(b64) = rec.chunker.flush(&rec.samples) {
                    self.emit(Event::Chunk { b64 });
                }
            }
        }
        if self.recording.as_ref().is_some_and(|r| r.next_partial.is_some_and(|at| now >= at)) {
            self.partial_tick(now);
        }
        if self.test.as_ref().is_some_and(|t| now >= t.ends_at) {
            self.stop_test();
        }
        if self.devices_due.is_some_and(|at| now >= at) {
            self.devices_due = None;
            self.emit_devices();
            // Headphones that dropped out while ducked may be back.
            self.b.ducker.retry_orphans();
        }
        if self.gesture.deadline().is_some_and(|at| now >= at) {
            let intent = self.gesture.on_deadline(now);
            self.emit_intent(intent);
        }
        if self.hotkey_poll.is_some_and(|at| now >= at) {
            self.hotkey_poll = None;
            if !self.b.hotkey.installed() {
                if self.b.permissions.accessibility_trusted() {
                    self.install_hotkey(now);
                } else {
                    self.hotkey_poll = Some(now + HOTKEY_POLL);
                }
            }
        }
    }

    // -------------------------------------------------------- recording

    fn open_capture(&mut self) -> Result<OpenStream, CaptureError> {
        let capture = self.next_id();
        let sink = CaptureSink::new(self.bus.clone(), capture);
        let stream = self.b.audio.open(self.settings.pinned.as_deref(), sink)?;
        logln!("mic: {} (capture {capture})", stream.name());
        Ok(OpenStream { capture, _stream: stream, spectrum: Spectrum::new() })
    }

    fn start(&mut self, now: Instant) {
        if let Some(rec) = &self.recording {
            if rec.stream.is_some() {
                return; // already recording: ignored, no event
            }
            // A recording with no microphone (still retrying, or interrupted
            // and never stopped) is dropped so this start gets a clean attempt.
            logln!("start: abandoning a recording whose microphone was lost");
            self.end_recording();
        }
        // A mic test must never hold the device while a dictation needs it.
        self.stop_test();

        let stream = match self.open_capture() {
            Ok(stream) => Some(stream),
            Err(error) => {
                // Opening the mic is what makes a Bluetooth headset switch to
                // its call profile, and the first attempt often lands mid
                // switch. The recording is kept alive while the device settles.
                logln!("start: microphone not ready ({error}), retrying");
                None
            }
        };
        let retry = stream.is_none().then(|| (1, now + MIC_RETRY_INTERVAL));

        // A device that came back still ducked is put right before it is read.
        self.b.ducker.retry_orphans();
        if let Some(level) = self.settings.duck {
            self.b.ducker.duck(level);
        }

        // Local partials re-decode the same audio; with the cloud already
        // transcribing live there is nothing for them to add.
        let streaming = self.settings.stream;
        let id = self.next_id();
        self.recording = Some(Recording {
            id,
            stream,
            samples: Vec::new(),
            streaming,
            chunker: Chunker::new(),
            next_chunk: streaming.then(|| now + CHUNK_INTERVAL),
            next_partial: (!streaming && self.b.transcriber.partials()).then(|| now + PARTIAL_INTERVAL),
            partial_in_flight: false,
            ended: Arc::new(AtomicBool::new(false)),
            retry,
        });
        self.emit(Event::Started);
        logln!("=== recording started ===");
    }

    /// Takes the recording out of the session: microphone released, volume
    /// restored, any partial told to give up.
    fn end_recording(&mut self) -> Option<Recording> {
        let mut rec = self.recording.take()?;
        rec.ended.store(true, Ordering::Relaxed);
        rec.stream = None;
        self.b.ducker.restore();
        Some(rec)
    }

    fn on_samples(&mut self, capture: CaptureId, samples: &[f32]) {
        if let Some(rec) = self.recording.as_mut() {
            if let Some(stream) = rec.stream.as_mut().filter(|s| s.capture == capture) {
                rec.samples.extend_from_slice(samples);
                let bands = stream.spectrum.feed(samples);
                self.out.emit(&Event::Level { value: level(samples) });
                if let Some(bands) = bands {
                    self.out.emit(&Event::Spectrum { bands });
                }
                return;
            }
        }
        if let Some(test) = self.test.as_mut().filter(|t| t.stream.capture == capture) {
            let bands = test.stream.spectrum.feed(samples);
            self.out.emit(&Event::MicTestLevel { value: level(samples) });
            if let Some(bands) = bands {
                self.out.emit(&Event::Spectrum { bands });
            }
        }
        // Anything else is a buffer from a capture that has been closed.
    }

    fn on_capture_lost(&mut self, capture: CaptureId, reason: &str, now: Instant) {
        if let Some(rec) = self.recording.as_mut() {
            if rec.stream.as_ref().is_some_and(|s| s.capture == capture) {
                // What was captured stays; capture carries on from whatever
                // device is there now, once it has had a moment to settle.
                logln!("mic: lost mid-recording ({reason}), rebuilding");
                rec.stream = None;
                rec.retry = Some((1, now + MIC_RETRY_INTERVAL));
                return;
            }
        }
        if self.test.as_ref().is_some_and(|t| t.stream.capture == capture) {
            logln!("mic test: device lost ({reason})");
            self.stop_test();
        }
    }

    fn retry_open(&mut self, attempt: u32, now: Instant) {
        match self.open_capture() {
            Ok(stream) => {
                if let Some(rec) = self.recording.as_mut() {
                    rec.stream = Some(stream);
                    rec.retry = None;
                }
            }
            Err(error) => {
                let Some(rec) = self.recording.as_mut() else { return };
                if attempt < MIC_RETRIES {
                    rec.retry = Some((attempt + 1, now + MIC_RETRY_INTERVAL));
                } else if rec.samples.is_empty() {
                    // It never opened: there is nothing to finish, so say why.
                    // Its own event, not `error`: main has to end this
                    // recording and must not guess that from an error that may
                    // belong to a dictation still being transcribed.
                    logln!("mic: could not open ({error})");
                    self.end_recording();
                    self.emit(Event::StartFailed { message: MSG_START_FAILED.to_string() });
                } else {
                    logln!("mic: rebuild failed ({error}), finishing with what was recorded");
                    rec.retry = None;
                    self.emit(Event::Interrupted);
                }
            }
        }
    }

    fn stop(&mut self, id: String) {
        let Some(mut rec) = self.end_recording() else {
            self.emit(Event::final_text(id, ""));
            return;
        };
        if rec.streaming {
            if let Some(b64) = rec.chunker.flush(&rec.samples) {
                self.emit(Event::Chunk { b64 });
            }
        }
        // Kept before anything can fail, so a recording that went wrong at any
        // later step can be retried.
        let audio = Arc::new(std::mem::take(&mut rec.samples));
        self.kept = Some(audio.clone());
        self.process(audio, id);
    }

    fn retry(&mut self, id: String) {
        match self.kept.clone().filter(|audio| !audio.is_empty()) {
            Some(audio) if self.recording.is_none() => {
                logln!("=== retrying last recording ===");
                self.process(audio, id);
            }
            _ => {
                logln!("retry: no recording kept");
                self.emit(Event::final_text(id, ""));
            }
        }
    }

    fn cancel(&mut self) {
        self.end_recording();
        self.kept = None;
        self.emit(Event::Cancelled);
    }

    /// The finishing pipeline of section 5.3.
    fn process(&mut self, audio: Arc<Vec<f32>>, id: String) {
        let seconds = audio.len() as f64 / f64::from(SAMPLE_RATE);
        let peak = peak(&audio);
        logln!("=== recording stopped ({seconds:.1}s, peak {peak:.4}) ===");

        // A process without microphone permission is handed digital silence,
        // not an error, so the signal is the only way to tell "permission
        // missing" from "you said nothing".
        if peak < SILENCE_PEAK && audio.len() > SILENCE_MIN_SAMPLES {
            logln!("audio is digital silence, microphone permission is almost certainly missing");
            self.emit(Event::final_error(id, self.b.permissions.silent_microphone_message()));
            return;
        }
        if audio.len() <= MIN_SAMPLES {
            self.emit(Event::final_text(id, ""));
            return;
        }

        // Cloud: write the WAV and hand it over. Checked before the model: the
        // cloud needs none.
        if self.settings.engine == Engine::Cloud {
            self.emit(Event::Transcribing);
            let path = std::env::temp_dir().join(format!("quill-{}.wav", uuid::Uuid::new_v4()));
            match crate::wav::write(&path, &audio, SAMPLE_RATE) {
                Ok(()) => {
                    logln!("cloud mode: wrote {seconds:.1}s to {}", path.display());
                    self.emit(Event::Audio { id, path: path.to_string_lossy().into_owned(), seconds });
                }
                Err(error) => {
                    logln!("cloud mode: could not write {} ({error})", path.display());
                    self.emit(Event::final_error(id, MSG_WAV_FAILED));
                }
            }
            return;
        }

        if !self.b.transcriber.supported() {
            logln!("transcribe aborted: this build or this CPU cannot transcribe locally");
            self.emit(Event::final_error(id, MSG_NO_LOCAL));
            return;
        }
        let Some(model) = self.model() else {
            logln!("transcribe aborted: no model at \"{}\"", self.settings.model);
            self.emit(Event::final_error(id, MSG_NO_MODEL));
            return;
        };
        self.emit(Event::Transcribing);

        let transcriber = self.b.transcriber.clone();
        let languages = self.settings.languages.clone();
        let bus = self.bus.clone();
        let fallback = (self.bus.clone(), id.clone());
        let spawned = spawn("transcribe", move || {
            let started = Instant::now();
            // Whisper gets the recording as its WAV would hold it (see `as_wav_carries`).
            let heard = crate::pcm::as_wav_carries(&audio);
            let language = resolve_language(&languages, || transcriber.detect_language(&model, &heard));
            let text = decode(&*transcriber, &model, &heard, &language, DecodeMode::Final, &AtomicBool::new(false));
            logln!("whisper: \"{text}\" ({} ms for {seconds:.1}s, {language})", started.elapsed().as_millis());
            bus.emit(Event::final_text(id, text));
        });
        if !spawned {
            fallback.0.emit(Event::final_text(fallback.1, ""));
        }
    }

    /// The configured model, when there is one and its file exists.
    fn model(&self) -> Option<PathBuf> {
        let path = Path::new(&self.settings.model);
        (!self.settings.model.is_empty() && path.exists()).then(|| path.to_path_buf())
    }

    fn partial_tick(&mut self, now: Instant) {
        let model = self.model();
        let Some(rec) = self.recording.as_mut() else { return };
        rec.next_partial = Some(now + PARTIAL_INTERVAL);
        if rec.partial_in_flight || rec.samples.len() < PARTIAL_MIN_SAMPLES || !self.b.transcriber.partials() {
            return;
        }
        let Some(model) = model else { return };
        rec.partial_in_flight = true;
        let (recording, ended, audio) = (rec.id, rec.ended.clone(), rec.samples.clone());
        let transcriber = self.b.transcriber.clone();
        // Interim passes skip language detection: the final pass settles it.
        let language = first_language(&self.settings.languages);
        let bus = self.bus.clone();
        let spawned = spawn("partial", move || {
            let text = decode(&*transcriber, &model, &crate::pcm::as_wav_carries(&audio), &language, DecodeMode::Partial, &ended);
            bus.send(Msg::PartialDone { recording, text });
        });
        if !spawned {
            rec.partial_in_flight = false;
        }
    }

    /// `transcribe-file`: always exactly one `final`, never a `transcribing`.
    fn transcribe_file(&mut self, id: String, path: String) {
        let Some(model) = self.model() else {
            logln!("local fallback: no model installed");
            self.emit(Event::final_error(id, MSG_NO_MODEL_FALLBACK));
            return;
        };
        let transcriber = self.b.transcriber.clone();
        let language = first_language(&self.settings.languages);
        let bus = self.bus.clone();
        let fallback = (self.bus.clone(), id.clone());
        // Off the controller, so several can overlap and none holds up a `start`.
        let spawned = spawn("transcribe-file", move || {
            let text = match crate::wav::read(Path::new(&path)) {
                Ok(audio) => {
                    let mut samples = audio.samples;
                    if audio.rate != SAMPLE_RATE {
                        let mut resampler = crate::resample::Resampler::to_16k(audio.rate);
                        let mut out = Vec::new();
                        resampler.process(&samples, &mut out);
                        resampler.flush(&mut out);
                        samples = out;
                    }
                    decode(&*transcriber, &model, &samples, &language, DecodeMode::Final, &AtomicBool::new(false))
                }
                Err(error) => {
                    logln!("local fallback: cannot read {path} ({error})");
                    String::new()
                }
            };
            logln!("local fallback: \"{text}\"");
            bus.emit(Event::final_text(id, text));
        });
        if !spawned {
            fallback.0.emit(Event::final_text(fallback.1, ""));
        }
    }

    // --------------------------------------------------------- mic test

    fn start_test(&mut self, now: Instant) {
        // A running test is restarted quietly: no `ended` for it.
        self.test = None;
        if self.recording.is_some() {
            self.emit(Event::mic_test_ended(None));
            return;
        }
        match self.open_capture() {
            Ok(stream) => {
                self.emit(Event::mic_test_started(stream._stream.name()));
                self.test = Some(MicTest { stream, ends_at: now + MIC_TEST_DURATION });
            }
            Err(error) => self.emit(Event::mic_test_ended(Some(error.message))),
        }
    }

    fn stop_test(&mut self) {
        if self.test.take().is_some() {
            self.emit(Event::mic_test_ended(None));
        }
    }

    // ------------------------------------------- devices, hotkey, typing

    fn emit_devices(&mut self) {
        let devices = self.b.audio.devices();
        self.emit(Event::Devices { devices, pinned: self.settings.pinned.clone().unwrap_or_default() });
    }

    fn install_hotkey(&mut self, now: Instant) {
        match self.b.hotkey.install() {
            Ok(()) => {
                logln!("hotkey: installed");
                self.hotkey_poll = None;
                self.emit(Event::HotkeyStatus { installed: true, reason: None });
            }
            Err(error) => {
                logln!("hotkey: not installed ({}){}", error.reason, if error.retry { ", watching" } else { "" });
                self.hotkey_poll = error.retry.then(|| now + HOTKEY_POLL);
                self.emit(Event::HotkeyStatus { installed: false, reason: Some(error.reason) });
            }
        }
    }

    fn emit_intent(&mut self, intent: Option<Intent>) {
        let Some(intent) = intent else { return };
        logln!("hotkey: {intent:?}");
        self.emit(match intent {
            Intent::Start { latched } => Event::Hotkey { intent: HotkeyIntent::Start, latched: Some(latched) },
            Intent::Stop => Event::Hotkey { intent: HotkeyIntent::Stop, latched: None },
            Intent::Cancel => Event::Hotkey { intent: HotkeyIntent::Cancel, latched: None },
        });
    }

    fn insert(&mut self, text: String) {
        let inserter = self.b.inserter.clone();
        let bus = self.bus.clone();
        let job = move || match inserter.paste(&text) {
            Ok(restore) => {
                bus.emit(Event::Inserted { chars: text.chars().count() });
                if let Some(restore) = restore {
                    // Still on the worker, so the next insert cannot save this
                    // dictation as "what the user had on the clipboard".
                    std::thread::sleep(CLIPBOARD_RESTORE_DELAY);
                    restore();
                }
            }
            Err(error) => {
                logln!("insert blocked: {error}");
                bus.emit(Event::Error { message: error.message });
            }
        };
        if self.insert_worker.is_none() {
            self.insert_worker = Worker::spawn("insert");
        }
        match &self.insert_worker {
            Some(worker) if worker.0.send(Box::new(job)).is_ok() => {}
            _ => logln!("insert dropped: no worker thread"),
        }
    }

    fn calendar(&mut self, id: String, op: String, args: Map<String, Value>) {
        if !CALENDAR_OPS.contains(&op.as_str()) {
            let mut result = Map::new();
            result.insert("error".to_string(), json!(format!("unknown op {op}")));
            self.emit(Event::cal(id, result));
            return;
        }
        let calendar = self.b.calendar.clone();
        let bus = self.bus.clone();
        let lost = (self.bus.clone(), id.clone());
        let job = move || {
            let reply: CalReply = Box::new(move |result| bus.emit(Event::cal(id, result)));
            calendar.call(&op, &args, reply);
        };
        if self.calendar_worker.is_none() {
            self.calendar_worker = Worker::spawn("calendar");
        }
        match &self.calendar_worker {
            Some(worker) if worker.0.send(Box::new(job)).is_ok() => {}
            _ => {
                let mut result = Map::new();
                result.insert("error".to_string(), json!("calendar worker unavailable"));
                lost.0.emit(Event::cal(lost.1, result));
            }
        }
    }
}

fn spawn(name: &str, job: impl FnOnce() + Send + 'static) -> bool {
    std::thread::Builder::new().name(name.to_string()).spawn(job).is_ok()
}

/// One whisper pass, cleaned up. A failure is an empty text in the log, never
/// an `error` event.
fn decode(transcriber: &dyn Transcriber, model: &Path, samples: &[f32], language: &str, mode: DecodeMode, abort: &AtomicBool) -> String {
    match transcriber.transcribe(&TranscribeJob { model, samples, language, mode, abort }) {
        Ok(raw) if is_nan_output(&raw) => {
            // Token 0 over and over: the logits were NaN. Nothing to type, but
            // the recording is kept so the failure can be replayed elsewhere.
            let path = crate::paths::log_file().with_file_name("Quill-failed-recording.wav");
            let saved = crate::wav::write(&path, samples, SAMPLE_RATE).map_or_else(|e| format!("not saved ({e})"), |()| format!("saved to {}", path.display()));
            let bad = samples.iter().filter(|s| !s.is_finite()).count();
            let rms = (samples.iter().filter(|s| s.is_finite()).map(|s| s * s).sum::<f32>() / samples.len().max(1) as f32).sqrt();
            logln!("whisper returned only \"!\" ({mode:?}, NaN logits): {} samples, {bad} not finite, rms {rms:.4}, recording {saved}", samples.len());
            String::new()
        }
        Ok(raw) => clean_transcript(&raw),
        Err(error) => {
            if !abort.load(Ordering::Relaxed) {
                logln!("whisper failed ({mode:?}): {error}");
            }
            String::new()
        }
    }
}

/// Whisper's answer when every logit is NaN: token 0 ("!") until the length
/// limit, with nothing else but spaces.
fn is_nan_output(raw: &str) -> bool {
    let bangs = raw.chars().filter(|&c| c == '!').count();
    bangs >= 5 && raw.chars().all(|c| c == '!' || c.is_whitespace())
}

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;

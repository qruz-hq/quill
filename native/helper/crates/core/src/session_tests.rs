//! The session under fake backends and a hand-moved clock.

use std::sync::atomic::AtomicUsize;
use std::sync::Mutex;

use crossbeam_channel::Receiver;
use serde_json::{json, Value};

use super::*;
use crate::gesture::KeyEdge;
use crate::unsupported;

// ------------------------------------------------------------------ fakes

#[derive(Default)]
struct Collector(Mutex<Vec<Event>>);

impl EventSink for Collector {
    fn emit(&self, event: &Event) {
        self.0.lock().unwrap().push(event.clone());
    }
}

#[derive(Default)]
struct AudioState {
    /// How many of the next opens fail.
    fail: usize,
    /// The uid each open was asked for.
    opens: Vec<Option<String>>,
    sinks: Vec<CaptureSink>,
    live: Arc<AtomicUsize>,
}

struct FakeAudio(Arc<Mutex<AudioState>>);

struct FakeStream(Arc<AtomicUsize>);

impl CaptureStream for FakeStream {
    fn name(&self) -> &str {
        "Fake Microphone"
    }
}

impl Drop for FakeStream {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl AudioCapture for FakeAudio {
    fn supported(&self) -> bool {
        true
    }
    fn devices(&self) -> Vec<DeviceInfo> {
        vec![DeviceInfo { id: 0, uid: "fake-mic".into(), name: "Fake Microphone".into(), is_default: true }]
    }
    fn open(&mut self, uid: Option<&str>, sink: CaptureSink) -> Result<Box<dyn CaptureStream>, CaptureError> {
        let mut state = self.0.lock().unwrap();
        state.opens.push(uid.map(str::to_string));
        if state.fail > 0 {
            state.fail -= 1;
            return Err(CaptureError::open_failed("Fake Microphone"));
        }
        state.sinks.push(sink);
        state.live.fetch_add(1, Ordering::SeqCst);
        Ok(Box::new(FakeStream(state.live.clone())))
    }
}

#[derive(Default)]
struct FakeDucker(Mutex<Vec<String>>);

impl Ducker for FakeDucker {
    fn supported(&self) -> bool {
        true
    }
    fn recover(&self) {
        self.0.lock().unwrap().push("recover".into());
    }
    fn duck(&self, level: f32) {
        self.0.lock().unwrap().push(format!("duck {level}"));
    }
    fn restore(&self) {
        self.0.lock().unwrap().push("restore".into());
    }
    fn retry_orphans(&self) {
        self.0.lock().unwrap().push("orphans".into());
    }
}

/// Answers with the language it was told and how much audio it was given.
struct FakeTranscriber {
    detected: Option<String>,
    /// False for an engine too slow for live text (a CPU build).
    live: bool,
}

impl Transcriber for FakeTranscriber {
    fn supported(&self) -> bool {
        true
    }
    fn transcribe(&self, job: &TranscribeJob<'_>) -> Result<String, TranscribeError> {
        Ok(format!(" [BLANK_AUDIO]\n {:?} {} {}\n", job.mode, job.language, job.samples.len()))
    }
    fn detect_language(&self, _model: &Path, _samples: &[f32]) -> Option<String> {
        self.detected.clone()
    }
    fn partials(&self) -> bool {
        self.live
    }
}

struct FakeHotkey {
    installed: bool,
    fail: Option<HotkeyError>,
    keys: Arc<Mutex<Vec<Option<u32>>>>,
}

impl Hotkey for FakeHotkey {
    fn supported(&self) -> bool {
        true
    }
    fn swallows(&self) -> bool {
        true
    }
    fn hold_keys(&self) -> Vec<u32> {
        vec![63, 54]
    }
    fn install(&mut self) -> Result<(), HotkeyError> {
        match self.fail.take() {
            Some(error) => Err(error),
            None => {
                self.installed = true;
                Ok(())
            }
        }
    }
    fn installed(&self) -> bool {
        self.installed
    }
    fn set_key(&mut self, key: Option<u32>) {
        self.keys.lock().unwrap().push(key);
    }
}

struct Gate(Arc<AtomicBool>);

impl Permissions for Gate {
    fn has_accessibility_gate(&self) -> bool {
        true
    }
    fn accessibility_trusted(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

struct FakeInserter;

impl TextInserter for FakeInserter {
    fn supported(&self) -> bool {
        true
    }
    fn paste(&self, text: &str) -> Result<Option<ClipboardRestore>, InsertError> {
        if text == "refuse" {
            return Err(InsertError { message: "Quill needs Accessibility to type for you.".into() });
        }
        Ok(None)
    }
}

struct FakeCalendar;

impl Calendar for FakeCalendar {
    fn supported(&self) -> bool {
        true
    }
    fn call(&self, op: &str, args: &Map<String, Value>, reply: CalReply) {
        let mut result = Map::new();
        result.insert("op".into(), json!(op));
        result.insert("args".into(), Value::Object(args.clone()));
        reply(result);
    }
}

// -------------------------------------------------------------------- rig

struct Rig {
    s: Session,
    rx: Receiver<Msg>,
    out: Arc<Collector>,
    audio: Arc<Mutex<AudioState>>,
    duck: Arc<FakeDucker>,
    trusted: Arc<AtomicBool>,
    keys: Arc<Mutex<Vec<Option<u32>>>>,
    now: Instant,
    model: PathBuf,
}

impl Drop for Rig {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.model);
    }
}

impl Rig {
    fn new() -> Self {
        Self::with(|_| {})
    }

    /// A session with every capability faked; `adjust` swaps some out.
    fn with(adjust: impl FnOnce(&mut Backends)) -> Self {
        let (bus, rx) = Bus::new();
        let out = Arc::new(Collector::default());
        let audio = Arc::new(Mutex::new(AudioState::default()));
        let duck = Arc::new(FakeDucker::default());
        let trusted = Arc::new(AtomicBool::new(true));
        let keys = Arc::new(Mutex::new(Vec::new()));
        let mut backends = Backends {
            audio: Box::new(FakeAudio(audio.clone())),
            watcher: Box::new(unsupported::NoDeviceWatcher),
            transcriber: Arc::new(FakeTranscriber { detected: None, live: true }),
            hotkey: Box::new(FakeHotkey { installed: false, fail: None, keys: keys.clone() }),
            inserter: Arc::new(FakeInserter),
            ducker: duck.clone(),
            permissions: Arc::new(Gate(trusted.clone())),
            calendar: Arc::new(FakeCalendar),
        };
        adjust(&mut backends);
        // Stands in for an installed model: only its existence is checked.
        let model = std::env::temp_dir().join(format!("quill-core-test-model-{}.bin", uuid::Uuid::new_v4()));
        std::fs::write(&model, b"model").unwrap();
        let s = Session::new(backends, out.clone(), bus, "flow-stt test");
        Rig { s, rx, out, audio, duck, trusted, keys, now: Instant::now(), model }
    }

    fn cmd(&mut self, line: &str) {
        let command = crate::command::parse(line).unwrap_or_else(|| panic!("not a command: {line}"));
        self.s.handle(Msg::Command(command), self.now);
        self.pump();
    }

    fn use_model(&mut self) {
        let line = format!("model {}", self.model.display());
        self.cmd(&line);
    }

    /// Handles everything already queued on the bus.
    fn pump(&mut self) {
        while let Ok(msg) = self.rx.try_recv() {
            self.s.handle(msg, self.now);
        }
    }

    /// Moves the clock, firing each timer at the moment it came due.
    fn advance(&mut self, ms: u64) {
        let target = self.now + Duration::from_millis(ms);
        for _ in 0..10_000 {
            match self.s.next_deadline() {
                Some(due) if due <= target => {
                    self.now = self.now.max(due);
                    self.s.tick(self.now);
                    self.pump();
                }
                _ => {
                    self.now = target;
                    return;
                }
            }
        }
        panic!("a timer never cleared its deadline");
    }

    /// Audio from the capture opened last.
    fn feed(&mut self, samples: &[f32]) {
        self.audio.lock().unwrap().sinks.last().expect("no capture open").push_mono_16k(samples);
        self.pump();
    }

    /// `seconds` of a steady tone, in 10 ms buffers.
    fn speak(&mut self, seconds: f64) {
        let total = (seconds * 16_000.0).round() as usize;
        let tone: Vec<f32> = (0..total).map(|n| 0.3 * (n as f32 * 0.2).sin()).collect();
        for buffer in tone.chunks(160) {
            self.feed(buffer);
        }
    }

    /// Waits for worker threads until an event of `kind` has been collected.
    fn wait_for(&mut self, kind: &str) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !self.kinds().iter().any(|k| k == kind) {
            let msg = self.rx.recv_deadline(deadline).unwrap_or_else(|_| panic!("no {kind}; got {:?}", self.kinds()));
            self.s.handle(msg, self.now);
        }
    }

    fn events(&self) -> Vec<Value> {
        self.out.0.lock().unwrap().iter().map(|e| serde_json::to_value(e).unwrap()).collect()
    }

    fn kinds(&self) -> Vec<String> {
        self.events().iter().map(|e| e["type"].as_str().unwrap().to_string()).collect()
    }

    /// Kinds without the per-buffer meter lines.
    fn quiet_kinds(&self) -> Vec<String> {
        self.kinds().into_iter().filter(|k| k != "level" && k != "spectrum" && k != "mic-test-level").collect()
    }

    fn clear(&mut self) {
        self.out.0.lock().unwrap().clear();
    }

    fn last(&self, kind: &str) -> Value {
        self.events().into_iter().rev().find(|e| e["type"] == kind).unwrap_or_else(|| panic!("no {kind} in {:?}", self.kinds()))
    }

    fn live_streams(&self) -> usize {
        self.audio.lock().unwrap().live.load(Ordering::SeqCst)
    }

    fn duck_log(&self) -> Vec<String> {
        self.duck.0.lock().unwrap().clone()
    }

    fn fail_opens(&mut self, count: usize) {
        self.audio.lock().unwrap().fail = count;
    }
}

fn strs(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

// ------------------------------------------------------------------- boot

#[test]
fn boot_recovers_the_volume_then_announces_itself() {
    let mut r = Rig::new();
    r.s.boot(r.now);
    assert_eq!(r.duck_log(), strs(&["recover"]));
    assert_eq!(r.kinds(), strs(&["boot", "capabilities", "hotkey-status", "devices"]));
    let events = r.events();
    assert_eq!(events[0]["pid"], json!(std::process::id()));
    assert_eq!(events[1]["protocol"], json!(1));
    assert_eq!(events[1]["helper"], json!("flow-stt test"));
    assert_eq!(events[1]["holdKeys"], json!([63, 54]));
    let caps: Vec<&str> = events[1]["capabilities"].as_array().unwrap().iter().map(|c| c.as_str().unwrap()).collect();
    for id in ["audio", "devices", "level", "spectrum", "mic-test", "transcribe", "partials", "language-detect",
        "transcribe-file", "cloud-audio", "stream", "hotkey", "hotkey-swallow", "insert", "accessibility", "duck", "calendar"] {
        assert!(caps.contains(&id), "{id} missing from {caps:?}");
    }
    assert_eq!(events[2], json!({"type": "hotkey-status", "installed": true}));
    assert_eq!(events[3]["pinned"], json!(""));
    assert_eq!(events[3]["devices"][0]["uid"], json!("fake-mic"));
}

#[test]
fn a_build_with_no_backends_lists_no_capabilities_and_still_boots() {
    let mut r = Rig::with(|b| *b = unsupported::backends());
    r.s.boot(r.now);
    // No hotkey capability: no hotkey-status either (section 11.2 rule 5).
    assert_eq!(r.kinds(), strs(&["boot", "capabilities", "devices"]));
    assert_eq!(r.events()[1]["capabilities"], json!([]));
    assert_eq!(r.events()[1]["holdKeys"], json!([]));
    assert_eq!(r.events()[2], json!({"type": "devices", "devices": [], "pinned": ""}));
    assert_eq!(r.s.next_deadline(), None);
}

#[test]
fn a_recording_with_no_audio_backend_ends_in_start_failed() {
    let mut r = Rig::with(|b| *b = unsupported::backends());
    r.cmd("start");
    assert_eq!(r.kinds(), strs(&["started"]));
    r.advance(1400);
    assert_eq!(r.kinds(), strs(&["started"]));
    r.advance(200);
    assert_eq!(r.kinds(), strs(&["started", "start-failed"]));
    assert!(!r.s.is_recording());
}

// ----------------------------------------------------- no recording

#[test]
fn stop_and_retry_with_nothing_answer_empty_finals_in_order() {
    let mut r = Rig::new();
    r.cmd("stop a1");
    r.cmd("retry b2");
    r.cmd("stop");
    r.cmd("stop id with spaces");
    assert_eq!(
        r.events(),
        vec![
            json!({"type": "final", "id": "a1", "text": ""}),
            json!({"type": "final", "id": "b2", "text": ""}),
            json!({"type": "final", "id": "", "text": ""}),
            json!({"type": "final", "id": "id with spaces", "text": ""}),
        ]
    );
    // Nothing was ducked, so nothing may be restored either.
    assert_eq!(r.duck_log(), Vec::<String>::new());
}

#[test]
fn cancel_always_answers() {
    let mut r = Rig::new();
    r.cmd("cancel");
    r.cmd("cancel");
    assert_eq!(r.kinds(), strs(&["cancelled", "cancelled"]));
}

#[test]
fn settings_and_unlatch_say_nothing() {
    let mut r = Rig::new();
    for line in ["model ", "model /nonexistent/model.bin", "lang en,fr", "lang ", "duck off", "holdkey off", "engine cloud",
        "engine local", "stream on", "stream off", "hold-ms 300", "doubletap-ms 350", "unlatch", "mic-test-stop",
        "hotkey-on", "hotkey-off", "fn-capture-on", "fn-capture-off"] {
        r.cmd(line);
    }
    assert_eq!(r.kinds(), Vec::<String>::new());
    assert_eq!(r.s.settings().languages, strs(&["auto"]));
    assert_eq!(r.s.settings().duck, None);
    assert_eq!(*r.keys.lock().unwrap(), vec![None]);
}

// -------------------------------------------------------------- recording

#[test]
fn a_recording_meters_what_it_hears() {
    let mut r = Rig::new();
    r.cmd("start");
    assert_eq!(r.kinds(), strs(&["started"]));
    assert_eq!(r.live_streams(), 1);
    r.feed(&[0.5; 160]);
    r.feed(&[0.5; 512]);
    let events = r.events();
    assert_eq!(r.kinds(), strs(&["started", "level", "level", "spectrum"]));
    assert!(events[1]["value"].as_f64().unwrap() > 0.8);
    assert_eq!(events[3]["bands"].as_array().unwrap().len(), 28);
    // A second start while recording is ignored outright.
    r.cmd("start");
    assert_eq!(r.quiet_kinds(), strs(&["started"]));
    assert_eq!(r.audio.lock().unwrap().opens.len(), 1);
}

#[test]
fn start_ducks_and_stop_restores() {
    let mut r = Rig::new();
    r.cmd("start");
    assert_eq!(r.duck_log(), strs(&["orphans", "duck 0.15"]));
    r.cmd("stop 1");
    assert_eq!(r.duck_log(), strs(&["orphans", "duck 0.15", "restore"]));
    assert_eq!(r.live_streams(), 0);
}

#[test]
fn duck_off_never_lowers_the_volume() {
    let mut r = Rig::new();
    r.cmd("duck off");
    r.cmd("start");
    r.cmd("cancel");
    r.cmd("duck 40");
    r.cmd("start");
    r.cmd("cancel");
    assert_eq!(r.duck_log(), strs(&["orphans", "restore", "orphans", "duck 0.4", "restore"]));
}

#[test]
fn a_short_recording_is_an_empty_final_without_transcribing() {
    let mut r = Rig::new();
    r.use_model();
    r.cmd("start");
    r.speak(0.3);
    r.cmd("stop 7");
    assert_eq!(r.quiet_kinds(), strs(&["started", "final"]));
    assert_eq!(r.last("final"), json!({"type": "final", "id": "7", "text": ""}));
    // It was kept all the same, and retrying it is just as short.
    r.clear();
    r.cmd("retry 8");
    assert_eq!(r.events(), vec![json!({"type": "final", "id": "8", "text": ""})]);
}

#[test]
fn digital_silence_is_reported_as_a_microphone_problem() {
    let mut r = Rig::new();
    r.use_model();
    r.cmd("start");
    for _ in 0..60 {
        r.feed(&[0.0; 160]); // 0.6 s
    }
    r.cmd("stop 3");
    let answer = r.last("final");
    assert_eq!(answer["text"], json!(""));
    assert!(answer["error"].as_str().unwrap().to_lowercase().contains("microphone"));
    assert!(!r.kinds().contains(&"transcribing".to_string()));
}

#[test]
fn silence_of_half_a_second_or_less_is_not_called_silent() {
    let mut r = Rig::new();
    r.cmd("engine cloud");
    r.cmd("start");
    for _ in 0..50 {
        r.feed(&[0.0; 160]); // exactly 0.5 s
    }
    r.cmd("stop 4");
    let audio = r.last("audio");
    std::fs::remove_file(audio["path"].as_str().unwrap()).unwrap();
    assert_eq!(audio["seconds"], json!(0.5));
}

#[test]
fn local_stop_transcribes_and_retry_runs_it_again() {
    let mut r = Rig::new();
    r.use_model();
    r.cmd("lang pt");
    r.cmd("start");
    r.speak(0.5);
    r.cmd("stop 11");
    r.wait_for("final");
    assert_eq!(r.quiet_kinds(), strs(&["started", "transcribing", "final"]));
    // The fake echoes mode, language and sample count; the bracketed line is dropped.
    assert_eq!(r.last("final"), json!({"type": "final", "id": "11", "text": "Final pt 8000"}));

    r.clear();
    r.cmd("lang en");
    r.cmd("retry 12");
    r.wait_for("final");
    assert_eq!(r.kinds(), strs(&["transcribing", "final"]));
    assert_eq!(r.last("final")["text"], json!("Final en 8000"));
    // The kept recording stays kept.
    r.clear();
    r.cmd("retry 13");
    r.wait_for("final");
    assert_eq!(r.last("final")["id"], json!("13"));
}

#[test]
fn several_languages_run_detection_and_snap_to_the_set() {
    for (detected, expected) in [(Some("fr"), "Final fr 8000"), (Some("de"), "Final en 8000"), (None, "Final en 8000")] {
        let mut r = Rig::with(|b| b.transcriber = Arc::new(FakeTranscriber { detected: detected.map(str::to_string), live: true }));
        r.use_model();
        r.cmd("lang en,fr");
        r.cmd("start");
        r.speak(0.5);
        r.cmd("stop 1");
        r.wait_for("final");
        assert_eq!(r.last("final")["text"], json!(expected));
    }
}

#[test]
fn no_model_is_the_reason_in_the_final() {
    let mut r = Rig::new();
    for model in ["model ", "model /nonexistent/model.bin"] {
        r.clear();
        r.cmd(model);
        r.cmd("start");
        r.speak(0.5);
        r.cmd("stop 5");
        assert_eq!(r.quiet_kinds(), strs(&["started", "final"]));
        assert_eq!(r.last("final"), json!({"type": "final", "id": "5", "text": "", "error": MSG_NO_MODEL}));
    }
}

#[test]
fn cloud_hands_over_a_wav_and_needs_no_model() {
    let mut r = Rig::new();
    r.cmd("engine cloud");
    r.cmd("start");
    r.speak(0.5);
    r.cmd("stop 21");
    assert_eq!(r.quiet_kinds(), strs(&["started", "transcribing", "audio"]));
    let audio = r.last("audio");
    assert_eq!((&audio["id"], &audio["seconds"]), (&json!("21"), &json!(0.5)));
    let path = PathBuf::from(audio["path"].as_str().unwrap());
    assert!(path.is_absolute());
    assert!(path.file_name().unwrap().to_str().unwrap().starts_with("quill-"));
    let wav = crate::wav::read(&path).unwrap();
    std::fs::remove_file(&path).unwrap();
    assert_eq!((wav.rate, wav.channels, wav.samples.len()), (16_000, 1, 8000));

    // Retry hands the same audio over again, as a new file.
    r.clear();
    r.cmd("retry 22");
    let again = r.last("audio");
    assert_ne!(again["path"], audio["path"]);
    let second = crate::wav::read(Path::new(again["path"].as_str().unwrap())).unwrap();
    std::fs::remove_file(again["path"].as_str().unwrap()).unwrap();
    assert_eq!(second.samples, wav.samples);
}

#[test]
fn retry_during_a_recording_answers_empty_and_leaves_it_alone() {
    let mut r = Rig::new();
    r.cmd("engine cloud");
    r.cmd("start");
    r.speak(0.5);
    r.cmd("stop 1");
    std::fs::remove_file(r.last("audio")["path"].as_str().unwrap()).unwrap();
    r.cmd("start");
    r.clear();
    r.cmd("retry 2");
    assert_eq!(r.events(), vec![json!({"type": "final", "id": "2", "text": ""})]);
    assert!(r.s.is_recording());
}

#[test]
fn cancel_drops_the_recording_and_what_was_kept() {
    let mut r = Rig::new();
    r.cmd("engine cloud");
    r.cmd("start");
    r.speak(0.5);
    r.cmd("stop 1");
    std::fs::remove_file(r.last("audio")["path"].as_str().unwrap()).unwrap();
    r.cmd("start");
    r.speak(0.5);
    r.clear();
    r.cmd("cancel");
    assert_eq!(r.kinds(), strs(&["cancelled"]));
    assert_eq!(r.live_streams(), 0);
    r.cmd("retry 2");
    assert_eq!(r.last("final"), json!({"type": "final", "id": "2", "text": ""}));
    // Buffers still in flight from the closed capture are dropped.
    r.clear();
    r.feed(&[0.5; 512]);
    r.advance(3000);
    assert_eq!(r.kinds(), Vec::<String>::new());
}

#[test]
fn an_empty_recording_replaces_the_kept_one() {
    let mut r = Rig::new();
    r.cmd("engine cloud");
    r.cmd("start");
    r.speak(0.5);
    r.cmd("stop 1");
    std::fs::remove_file(r.last("audio")["path"].as_str().unwrap()).unwrap();
    r.cmd("start");
    r.cmd("stop 2");
    r.clear();
    r.cmd("retry 3");
    assert_eq!(r.events(), vec![json!({"type": "final", "id": "3", "text": ""})]);
}

#[test]
fn stop_with_nothing_recording_leaves_the_kept_recording() {
    let mut r = Rig::new();
    r.cmd("engine cloud");
    r.cmd("start");
    r.speak(0.5);
    r.cmd("stop 1");
    std::fs::remove_file(r.last("audio")["path"].as_str().unwrap()).unwrap();
    r.cmd("stop 2");
    r.clear();
    r.cmd("retry 3");
    std::fs::remove_file(r.last("audio")["path"].as_str().unwrap()).unwrap();
}

// ----------------------------------------------------- streaming, partials

#[test]
fn chunks_add_up_to_the_recording_and_stop_flushes_the_rest() {
    use base64::Engine as _;
    let mut r = Rig::new();
    r.cmd("engine cloud");
    r.cmd("stream on");
    r.cmd("start");
    for _ in 0..5 {
        r.speak(0.1);
        r.advance(100);
    }
    r.speak(0.05); // not yet flushed by a timer
    r.cmd("stop 9");
    let kinds = r.quiet_kinds();
    assert_eq!(kinds.first().map(String::as_str), Some("started"));
    assert_eq!(&kinds[kinds.len() - 2..], &strs(&["transcribing", "audio"])[..]);
    assert!(kinds[1..kinds.len() - 2].iter().all(|k| k == "chunk") && kinds.len() >= 5, "{kinds:?}");
    assert!(!kinds.contains(&"partial".to_string()));

    let mut bytes = Vec::new();
    for event in r.events().iter().filter(|e| e["type"] == "chunk") {
        let chunk = base64::engine::general_purpose::STANDARD.decode(event["b64"].as_str().unwrap()).unwrap();
        assert!(!chunk.is_empty());
        bytes.extend(chunk);
    }
    let path = r.last("audio")["path"].as_str().unwrap().to_string();
    let file = std::fs::read(&path).unwrap();
    std::fs::remove_file(&path).unwrap();
    assert_eq!(bytes, file[44..]);
}

#[test]
fn no_chunks_without_new_audio_none_after_cancel_none_with_stream_off() {
    let mut r = Rig::new();
    r.cmd("stream on");
    r.cmd("start");
    r.advance(1000);
    assert_eq!(r.kinds(), strs(&["started"])); // never an empty chunk
    r.speak(0.05);
    r.cmd("cancel");
    r.advance(1000);
    assert_eq!(r.quiet_kinds(), strs(&["started", "cancelled"]));

    r.clear();
    r.cmd("stream off");
    r.cmd("start");
    r.speak(0.4);
    r.advance(1000);
    assert_eq!(r.quiet_kinds(), strs(&["started"]));
}

#[test]
fn the_stream_setting_is_read_at_start() {
    let mut r = Rig::new();
    r.cmd("engine cloud");
    r.cmd("start");
    r.cmd("stream on"); // belongs to the next recording
    r.speak(0.5);
    r.advance(400);
    r.cmd("stop 1");
    std::fs::remove_file(r.last("audio")["path"].as_str().unwrap()).unwrap();
    assert!(!r.kinds().contains(&"chunk".to_string()));
}

#[test]
fn partials_come_every_interval_once_there_is_a_second_of_audio() {
    let mut r = Rig::new();
    r.use_model();
    r.cmd("start");
    r.speak(0.9);
    r.advance(1500);
    r.advance(10);
    assert!(!r.kinds().contains(&"partial".to_string())); // under 1.0 s: none
    r.speak(0.6);
    r.advance(1490);
    r.wait_for("partial");
    assert_eq!(r.last("partial"), json!({"type": "partial", "text": "Partial en 24000"}));
}

#[test]
fn a_partial_that_outlives_its_recording_is_dropped() {
    let mut r = Rig::new();
    r.use_model();
    r.cmd("start");
    r.speak(1.2);
    r.advance(1500); // a partial decode is now in flight
    // Straight to the session, so the decode's answer stays queued behind these.
    r.s.handle(Msg::Command(Command::Cancel), r.now);
    r.s.handle(Msg::Command(Command::Start), r.now);
    let finished = r.rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(matches!(finished, Msg::PartialDone { .. }));
    r.s.handle(finished, r.now);
    assert!(!r.kinds().contains(&"partial".to_string()));
}

#[test]
fn no_partials_without_a_model_or_in_streaming_mode() {
    let mut r = Rig::new();
    r.cmd("start");
    r.speak(1.2);
    r.advance(3100);
    assert!(r.rx.recv_timeout(Duration::from_millis(100)).is_err());
    r.cmd("cancel");
    r.use_model();
    r.cmd("stream on");
    r.cmd("start");
    r.speak(1.2);
    r.advance(3100);
    assert!(r.rx.recv_timeout(Duration::from_millis(100)).is_err());
    assert!(!r.kinds().contains(&"partial".to_string()));
}

#[test]
fn an_engine_too_slow_for_live_text_gets_no_partials_but_still_a_final() {
    let mut r = Rig::with(|b| b.transcriber = Arc::new(FakeTranscriber { detected: None, live: false }));
    r.s.boot(r.now);
    let caps = r.events()[1]["capabilities"].clone();
    assert!(!caps.as_array().unwrap().contains(&json!("partials")), "{caps}");
    assert!(caps.as_array().unwrap().contains(&json!("transcribe")), "{caps}");
    r.clear();
    r.use_model();
    r.cmd("start");
    r.speak(1.2);
    r.advance(3100);
    assert!(r.rx.recv_timeout(Duration::from_millis(100)).is_err());
    r.cmd("stop 1");
    r.wait_for("final");
    assert!(!r.kinds().contains(&"partial".to_string()));
    assert_eq!(r.last("final")["text"], json!("Final en 19200"));
}

#[test]
fn a_build_that_cannot_transcribe_says_so_in_the_final() {
    let mut r = Rig::with(|b| b.transcriber = Arc::new(unsupported::NoTranscriber));
    r.use_model();
    r.cmd("start");
    r.speak(0.5);
    r.cmd("stop 3");
    assert_eq!(r.quiet_kinds(), strs(&["started", "final"]));
    assert_eq!(r.last("final"), json!({"type": "final", "id": "3", "text": "", "error": MSG_NO_LOCAL}));
}

// ------------------------------------------- opening and losing the mic

#[test]
fn a_microphone_that_opens_on_a_retry_reports_nothing() {
    let mut r = Rig::new();
    r.fail_opens(3);
    r.cmd("start");
    assert_eq!(r.kinds(), strs(&["started"])); // started is sent regardless
    assert_eq!(r.live_streams(), 0);
    r.advance(740);
    assert_eq!(r.live_streams(), 0);
    r.advance(20);
    assert_eq!(r.live_streams(), 1);
    r.advance(5000);
    assert_eq!(r.audio.lock().unwrap().opens.len(), 4);
    r.feed(&[0.2; 160]);
    assert_eq!(r.kinds(), strs(&["started", "level"]));
}

#[test]
fn seven_failed_attempts_end_in_start_failed() {
    let mut r = Rig::new();
    r.fail_opens(usize::MAX);
    r.cmd("start");
    r.advance(1499);
    assert_eq!(r.kinds(), strs(&["started"]));
    r.advance(2);
    assert_eq!(r.events()[1], json!({"type": "start-failed", "message": MSG_START_FAILED}));
    assert_eq!(r.audio.lock().unwrap().opens.len(), 7);
    assert!(!r.s.is_recording());
    assert_eq!(r.duck_log().last().map(String::as_str), Some("restore"));
    // The recording is over: no final follows, and a stop finds nothing.
    r.advance(5000);
    r.cmd("stop 1");
    assert_eq!(r.quiet_kinds(), strs(&["started", "start-failed", "final"]));
    assert_eq!(r.last("final"), json!({"type": "final", "id": "1", "text": ""}));
}

#[test]
fn stop_during_the_retries_ends_them() {
    let mut r = Rig::new();
    r.fail_opens(usize::MAX);
    r.cmd("start");
    r.advance(600);
    r.cmd("stop 1");
    let opens = r.audio.lock().unwrap().opens.len();
    r.advance(5000);
    assert_eq!(r.kinds(), strs(&["started", "final"]));
    assert_eq!(r.audio.lock().unwrap().opens.len(), opens);
}

#[test]
fn a_lost_microphone_is_reopened_and_the_audio_kept() {
    let mut r = Rig::new();
    r.cmd("engine cloud");
    r.cmd("start");
    r.speak(0.4);
    let lost = r.audio.lock().unwrap().sinks.last().unwrap().lost_handle();
    lost.lost("unplugged");
    r.pump();
    assert_eq!(r.live_streams(), 0);
    r.advance(250);
    assert_eq!(r.live_streams(), 1);
    r.speak(0.4);
    r.cmd("stop 1");
    let audio = r.last("audio");
    std::fs::remove_file(audio["path"].as_str().unwrap()).unwrap();
    assert_eq!(audio["seconds"], json!(0.8));
    assert!(!r.kinds().contains(&"interrupted".to_string()));
}

#[test]
fn a_microphone_that_stays_lost_interrupts_once_and_waits_for_stop() {
    let mut r = Rig::new();
    r.cmd("engine cloud");
    r.cmd("start");
    r.speak(0.5);
    r.fail_opens(usize::MAX);
    r.audio.lock().unwrap().sinks.last().unwrap().lost_handle().lost("unplugged");
    r.pump();
    r.advance(1499);
    assert!(!r.kinds().contains(&"interrupted".to_string()));
    r.advance(2);
    assert_eq!(r.quiet_kinds(), strs(&["started", "interrupted"]));
    r.advance(10_000);
    assert_eq!(r.quiet_kinds(), strs(&["started", "interrupted"]));
    assert!(r.s.is_recording());
    // Still ducked until main finishes it.
    assert_eq!(r.duck_log().last().map(String::as_str), Some("duck 0.15"));
    r.cmd("stop 6");
    let audio = r.last("audio");
    std::fs::remove_file(audio["path"].as_str().unwrap()).unwrap();
    assert_eq!((&audio["id"], &audio["seconds"]), (&json!("6"), &json!(0.5)));
}

#[test]
fn start_replaces_a_recording_that_has_no_microphone() {
    let mut r = Rig::new();
    r.cmd("engine cloud");
    r.cmd("start");
    r.speak(0.5);
    r.fail_opens(7);
    r.audio.lock().unwrap().sinks.last().unwrap().lost_handle().lost("unplugged");
    r.pump();
    r.advance(2000);
    assert_eq!(r.quiet_kinds(), strs(&["started", "interrupted"]));
    r.clear();
    r.fail_opens(0);
    r.cmd("start");
    assert_eq!(r.kinds(), strs(&["started"]));
    assert_eq!(r.live_streams(), 1);
    // The dropped recording's audio went with it.
    r.cmd("stop 2");
    assert_eq!(r.last("final"), json!({"type": "final", "id": "2", "text": ""}));

    // The same while the retries are still running.
    r.fail_opens(2);
    r.cmd("start");
    r.clear();
    r.cmd("start");
    assert_eq!(r.kinds(), strs(&["started"]));
}

#[test]
fn the_pinned_microphone_is_what_gets_opened() {
    let mut r = Rig::new();
    r.cmd("mic Some Device: With Spaces");
    assert_eq!(r.last("devices")["pinned"], json!("Some Device: With Spaces"));
    r.cmd("start");
    r.cmd("mic default"); // the recording keeps its device
    assert_eq!(r.last("devices")["pinned"], json!(""));
    r.cmd("cancel");
    r.cmd("mic-test");
    r.cmd("devices");
    assert_eq!(r.audio.lock().unwrap().opens, vec![Some("Some Device: With Spaces".to_string()), None]);
    assert_eq!(r.quiet_kinds(), strs(&["devices", "started", "devices", "cancelled", "mic-test", "devices"]));
}

// --------------------------------------------------------------- mic test

#[test]
fn a_mic_test_meters_and_ends_by_itself() {
    let mut r = Rig::new();
    r.cmd("mic-test");
    assert_eq!(r.events(), vec![json!({"type": "mic-test", "state": "started", "device": "Fake Microphone"})]);
    r.feed(&[0.4; 512]);
    assert_eq!(r.kinds(), strs(&["mic-test", "mic-test-level", "spectrum"]));
    r.advance(5999);
    assert_eq!(r.live_streams(), 1);
    r.advance(1);
    assert_eq!(r.last("mic-test"), json!({"type": "mic-test", "state": "ended"}));
    assert_eq!(r.live_streams(), 0);
    // It never ducks, and it keeps nothing to retry.
    assert_eq!(r.duck_log(), Vec::<String>::new());
    r.clear();
    r.feed(&[0.4; 512]);
    r.cmd("retry 1");
    assert_eq!(r.events(), vec![json!({"type": "final", "id": "1", "text": ""})]);
}

#[test]
fn a_second_mic_test_restarts_quietly_and_stop_ends_it_once() {
    let mut r = Rig::new();
    r.cmd("mic-test");
    r.advance(4000);
    r.cmd("mic-test");
    assert_eq!(r.live_streams(), 1);
    r.advance(4000); // the first test's timeout must not end the second
    assert_eq!(r.kinds(), strs(&["mic-test", "mic-test"]));
    assert!(r.events().iter().all(|e| e["state"] == "started"));
    r.cmd("mic-test-stop");
    r.cmd("mic-test-stop");
    assert_eq!(r.kinds(), strs(&["mic-test", "mic-test", "mic-test"]));
    assert_eq!(r.last("mic-test")["state"], json!("ended"));
}

#[test]
fn stop_retry_and_cancel_leave_a_mic_test_running() {
    let mut r = Rig::new();
    r.cmd("mic-test");
    r.cmd("stop 1");
    r.cmd("retry 2");
    r.cmd("cancel");
    assert_eq!(r.kinds(), strs(&["mic-test", "final", "final", "cancelled"]));
    assert_eq!(r.live_streams(), 1);
}

#[test]
fn start_takes_the_microphone_from_a_mic_test() {
    let mut r = Rig::new();
    r.cmd("mic-test");
    r.cmd("start");
    let events = r.events();
    assert_eq!(r.kinds(), strs(&["mic-test", "mic-test", "started"]));
    assert_eq!(events[1], json!({"type": "mic-test", "state": "ended"}));
    assert_eq!(r.live_streams(), 1);
    r.feed(&[0.4; 160]);
    assert_eq!(r.kinds().last().map(String::as_str), Some("level"));
}

#[test]
fn a_mic_test_during_a_recording_only_answers_ended() {
    let mut r = Rig::new();
    r.cmd("start");
    r.clear();
    r.cmd("mic-test");
    assert_eq!(r.events(), vec![json!({"type": "mic-test", "state": "ended"})]);
    assert_eq!(r.audio.lock().unwrap().opens.len(), 1);
    assert!(r.s.is_recording());
}

#[test]
fn a_mic_test_that_cannot_open_says_why_and_a_lost_device_ends_it() {
    let mut r = Rig::new();
    r.fail_opens(1);
    r.cmd("mic-test");
    assert_eq!(
        r.events(),
        vec![json!({"type": "mic-test", "state": "ended", "error": "Could not open Fake Microphone. Pick another input in Settings."})]
    );
    r.clear();
    r.cmd("mic-test");
    r.audio.lock().unwrap().sinks.last().unwrap().lost_handle().lost("unplugged");
    r.pump();
    assert_eq!(r.kinds(), strs(&["mic-test", "mic-test"]));
    assert_eq!(r.last("mic-test")["state"], json!("ended"));
}

// ------------------------------------------------ devices, hotkey, typing

#[test]
fn device_changes_are_debounced_into_one_list() {
    let mut r = Rig::new();
    for _ in 0..3 {
        r.s.handle(Msg::DevicesChanged, r.now);
        r.advance(100);
    }
    assert_eq!(r.kinds(), Vec::<String>::new());
    r.advance(250);
    assert_eq!(r.kinds(), strs(&["devices"]));
    assert_eq!(r.duck_log(), strs(&["orphans"]));
}

#[test]
fn key_edges_become_hotkey_intents() {
    let mut r = Rig::new();
    let t0 = r.now;
    r.s.handle(Msg::Key { edge: KeyEdge::Down, at: t0 }, r.now);
    r.advance(400);
    r.s.handle(Msg::Key { edge: KeyEdge::Up, at: t0 + Duration::from_millis(400) }, r.now);
    assert_eq!(
        r.events(),
        vec![json!({"type": "hotkey", "intent": "start", "latched": false}), json!({"type": "hotkey", "intent": "stop"})]
    );
    // A lone quick tap: the cancel comes from the session's own timer.
    r.clear();
    r.advance(2000);
    let t1 = r.now;
    r.s.handle(Msg::Key { edge: KeyEdge::Down, at: t1 }, r.now);
    r.s.handle(Msg::Key { edge: KeyEdge::Up, at: t1 + Duration::from_millis(60) }, r.now);
    r.advance(409);
    assert_eq!(r.kinds(), strs(&["hotkey"]));
    r.advance(2);
    assert_eq!(r.last("hotkey"), json!({"type": "hotkey", "intent": "cancel"}));
}

#[test]
fn unlatch_and_holdkey_off_reach_the_gesture() {
    let mut r = Rig::new();
    let t0 = r.now;
    for (edge, ms) in [(KeyEdge::Down, 0), (KeyEdge::Up, 50), (KeyEdge::Down, 150), (KeyEdge::Up, 200)] {
        r.s.handle(Msg::Key { edge, at: t0 + Duration::from_millis(ms) }, r.now);
    }
    assert_eq!(r.last("hotkey"), json!({"type": "hotkey", "intent": "start", "latched": true}));
    r.cmd("unlatch");
    r.clear();
    r.s.handle(Msg::Key { edge: KeyEdge::Down, at: t0 + Duration::from_secs(5) }, r.now);
    assert_eq!(r.events(), vec![json!({"type": "hotkey", "intent": "start", "latched": false})]);

    r.clear();
    r.cmd("holdkey off");
    for (edge, ms) in [(KeyEdge::Up, 9000), (KeyEdge::Down, 12_000), (KeyEdge::Up, 13_000)] {
        r.s.handle(Msg::Key { edge, at: t0 + Duration::from_millis(ms) }, r.now);
    }
    assert_eq!(r.kinds(), Vec::<String>::new());
    r.cmd("holdkey 54");
    assert_eq!(*r.keys.lock().unwrap(), vec![None, Some(54)]);
    r.s.handle(Msg::Key { edge: KeyEdge::Down, at: t0 + Duration::from_secs(20) }, r.now);
    assert_eq!(r.kinds(), strs(&["hotkey"]));
}

#[test]
fn a_hook_without_permission_is_installed_when_the_grant_appears() {
    let refused = HotkeyError { reason: "accessibility".into(), retry: true };
    let mut r = Rig::with(|b| b.hotkey = Box::new(FakeHotkey { installed: false, fail: Some(refused), keys: Default::default() }));
    r.trusted.store(false, Ordering::SeqCst);
    r.s.boot(r.now);
    assert_eq!(r.events()[2], json!({"type": "hotkey-status", "installed": false, "reason": "accessibility"}));
    r.clear();
    r.advance(7000); // polled every 2 s, silently, while the grant is missing
    assert_eq!(r.kinds(), Vec::<String>::new());
    r.cmd("ax-check");
    assert_eq!(r.events(), vec![json!({"type": "ax", "trusted": false})]);
    r.trusted.store(true, Ordering::SeqCst);
    r.advance(2000);
    assert_eq!(r.last("hotkey-status"), json!({"type": "hotkey-status", "installed": true}));
    assert_eq!(r.s.next_deadline(), None);
}

#[test]
fn ax_check_installs_the_hook_at_once() {
    let refused = HotkeyError { reason: "accessibility".into(), retry: true };
    let mut r = Rig::with(|b| b.hotkey = Box::new(FakeHotkey { installed: false, fail: Some(refused), keys: Default::default() }));
    r.trusted.store(false, Ordering::SeqCst);
    r.s.boot(r.now);
    r.clear();
    r.trusted.store(true, Ordering::SeqCst);
    r.cmd("ax-check");
    assert_eq!(r.events(), vec![json!({"type": "ax", "trusted": true}), json!({"type": "hotkey-status", "installed": true})]);
    r.cmd("ax-check");
    assert_eq!(r.kinds(), strs(&["ax", "hotkey-status", "ax"]));
}

#[test]
fn insert_reports_the_character_count_or_the_reason() {
    let mut r = Rig::new();
    r.cmd("insert aMOpbGxvIPCfkYs="); // "héllo 👋"
    r.wait_for("inserted");
    assert_eq!(r.last("inserted"), json!({"type": "inserted", "chars": 7}));
    r.cmd("insert cmVmdXNl"); // "refuse"
    r.wait_for("error");
    assert_eq!(r.last("error")["message"], json!("Quill needs Accessibility to type for you."));
}

#[test]
fn calendar_ops_echo_their_id_and_unknown_ops_are_refused() {
    let mut r = Rig::new();
    r.cmd(r#"cal {"id":"c1","op":"delete","eventId":"e9"}"#);
    r.wait_for("cal");
    assert_eq!(r.last("cal"), json!({"type": "cal", "id": "c1", "op": "delete", "args": {"eventId": "e9"}}));
    r.clear();
    r.cmd(r#"cal {"id":"c2","op":"no-such-op"}"#);
    assert_eq!(r.events(), vec![json!({"type": "cal", "id": "c2", "error": "unknown op no-such-op"})]);

    let mut none = Rig::with(|b| b.calendar = Arc::new(unsupported::NoCalendar));
    none.cmd(r#"cal {"id":"c3","op":"status"}"#);
    none.wait_for("cal");
    assert_eq!(none.last("cal"), json!({"type": "cal", "id": "c3", "error": "unsupported"}));
}

// -------------------------------------------------------- transcribe-file

#[test]
fn transcribe_file_answers_one_final_and_never_transcribing() {
    let mut r = Rig::new();
    let wav = std::env::temp_dir().join(format!("quill-core-test {}.wav", uuid::Uuid::new_v4()));
    crate::wav::write(&wav, &[0.25; 4000], 16_000).unwrap();

    // No model: the reason travels in the final.
    r.cmd(&format!("transcribe-file tf-1 {}", wav.display()));
    assert_eq!(r.events(), vec![json!({"type": "final", "id": "tf-1", "text": "", "error": MSG_NO_MODEL_FALLBACK})]);

    r.clear();
    r.use_model();
    r.cmd("lang fr,en");
    r.cmd(&format!("transcribe-file tf-2 {}", wav.display()));
    r.wait_for("final");
    // The first configured language, no detection pass. The path had a space in it.
    assert_eq!(r.events(), vec![json!({"type": "final", "id": "tf-2", "text": "Final fr 4000"})]);
    assert!(wav.exists(), "the file is main's to delete");
    std::fs::remove_file(&wav).unwrap();

    r.clear();
    r.cmd("transcribe-file tf-3 /nonexistent/quill conformance.wav");
    r.wait_for("final");
    assert_eq!(r.events(), vec![json!({"type": "final", "id": "tf-3", "text": ""})]);
}

#[test]
fn transcribe_file_resamples_what_is_not_sixteen_kilohertz() {
    let mut r = Rig::new();
    r.use_model();
    let wav = std::env::temp_dir().join(format!("quill-core-test-{}.wav", uuid::Uuid::new_v4()));
    crate::wav::write(&wav, &vec![0.25; 48_000], 48_000).unwrap();
    r.cmd(&format!("transcribe-file tf-4 {}", wav.display()));
    r.wait_for("final");
    std::fs::remove_file(&wav).unwrap();
    let text = r.last("final")["text"].as_str().unwrap().to_string();
    let samples: i64 = text.rsplit(' ').next().unwrap().parse().unwrap();
    assert!((samples - 16_000).abs() <= 2, "{text}");
}

#[test]
fn a_line_of_bangs_is_nan_output_and_real_text_is_not() {
    assert!(super::is_nan_output("!!!!!!!!!!!!!!!!!!!!"));
    assert!(super::is_nan_output(" !!!!!\n!!!!! "));
    assert!(!super::is_nan_output("Bonjour !!!!!"));
    assert!(!super::is_nan_output("!!"));
    assert!(!super::is_nan_output(""));
}

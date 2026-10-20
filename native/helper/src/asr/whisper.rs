//! The whisper.cpp engine (built by `vendor/whisper-rs-sys` at the commit the
//! app's whisper-cli uses; Metal on macOS).
//!
//! The Swift helper started `whisper-cli` for every pass, so every pass paid
//! for loading the model. Here the model is loaded once and stays in memory
//! until `model` names another file (or the file itself is replaced), which
//! is what makes a partial cost little more than its decode.
//!
//! - One whisper context per model, shared by every pass.
//! - One fresh whisper state per pass, as whisper-cli has: a final, a
//!   partial that is still winding down and a `transcribe-file` can run at the
//!   same time without waiting for each other. Not on a CPU build: there every
//!   pass already uses all but one core, so passes take turns (`pass_turn`)
//!   instead of stacking thread pools on the same cores. States are deliberately not
//!   reused: a state that has decoded something else before can give a
//!   slightly different text for the same audio (measured: a comma for a full
//!   stop), and a fresh one costs about 8 ms with tiny.en.
//! - The decoding options are whisper-cli's (see `options.rs`). The context,
//!   the states and the pass itself go through whisper.cpp's C interface
//!   (`whisper_rs_sys`) rather than whisper-rs's wrappers, because the wrapper
//!   cannot set `best_of` together with a beam search, and whisper-cli does.
//! - `job.abort` is whisper's abort callback: it is asked after the encoder
//!   and after every decoded token.
//! - whisper.cpp and ggml log through a hook into the helper's log file
//!   (warnings and errors only); nothing reaches stderr.
//! - ggml's Metal backend asserts in its own exit handler, and aborts the
//!   process, when a model is still loaded at that point. `runtime::exit`
//!   leaves with `_exit`, which runs no exit handlers at all, so the helper's
//!   own exits never get there. `release_at_exit` is the backstop for an exit
//!   that goes another way (a library calling `exit`): it frees the model
//!   ahead of ggml's handler.

use std::ffi::{c_void, CStr, CString};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Once};
use std::time::{Duration, Instant, SystemTime};

use quill_core::caps::{DecodeMode, TranscribeError, TranscribeJob, Transcriber};
use quill_core::logln;
use whisper_rs::whisper_rs_sys as sys;

use super::options;

pub fn create() -> Arc<dyn Transcriber> {
    Arc::new(Whisper::new())
}

pub struct Whisper {
    threads: usize,
}

/// The model in memory, one per process. The lock is held while a model
/// loads, so two passes that arrive together load it once and the second
/// finds it there. A static rather than a field because the exit handler has
/// to reach it.
fn slot() -> &'static Mutex<Option<Arc<Loaded>>> {
    static SLOT: Mutex<Option<Arc<Loaded>>> = Mutex::new(None);
    &SLOT
}

/// Held for the whole of a pass on a CPU build, so only one runs at a time.
fn pass_turn() -> &'static Mutex<()> {
    static TURN: Mutex<()> = Mutex::new(());
    &TURN
}

/// Set once the process is on its way out: every pass in flight aborts at its
/// next check and no model is loaded any more.
static EXITING: AtomicBool = AtomicBool::new(false);

/// How long the exit handler waits for a load to end and for passes in flight
/// to notice `EXITING`. Passes check after the encoder and after every token,
/// so they are gone in milliseconds; only the load of a large model can use
/// this up.
const EXIT_WAIT: Duration = Duration::from_millis(1500);

extern "C" {
    /// C's `atexit`, present in every C runtime the helper links.
    fn atexit(callback: extern "C" fn()) -> std::ffi::c_int;
}

/// Registers `free_model_at_exit` so that it runs before ggml tears its GPU
/// device down, whenever the process exits.
///
/// Exit handlers run last registered first, and ggml registers its own when
/// its device is first asked for. So the device is asked for here (listing
/// the backends does that), and only then is the handler registered: it runs
/// ahead of ggml's.
///
/// Called with the slot locked, from the first model load and not at boot:
/// with whisper.cpp 1.9 creating the Metal device also compiles its shader
/// library, which holds about 110 MB, and a helper that only ever hands audio
/// to the cloud should not carry that. The price is about 60 ms on the first
/// load of a run.
fn release_at_exit() {
    static REGISTERED: Once = Once::new();
    REGISTERED.call_once(|| {
        let started = Instant::now();
        let info = whisper_rs::print_system_info().trim_end_matches([' ', '|']).to_string();
        // SAFETY: the handler is a plain function that never unwinds.
        if unsafe { atexit(free_model_at_exit) } != 0 {
            logln!("whisper: could not register the exit handler");
        }
        logln!("whisper.cpp {} ready in {}ms: {info}", whisper_rs::get_whisper_version(), started.elapsed().as_millis());
    });
}

/// Frees the model before ggml tears its GPU device down.
/// Without this, ggml-metal finds the model's buffers still alive in its own
/// exit handler, fails an assertion and aborts: the helper would end with
/// SIGABRT and a backtrace on stderr instead of exit code 0.
extern "C" fn free_model_at_exit() {
    let _ = std::panic::catch_unwind(|| {
        EXITING.store(true, Ordering::Relaxed);
        let deadline = Instant::now() + EXIT_WAIT;
        // A load in flight holds the slot; it cannot be interrupted, only
        // waited for.
        let loaded = loop {
            match slot().try_lock() {
                Ok(mut slot) => break slot.take(),
                Err(std::sync::TryLockError::Poisoned(e)) => break e.into_inner().take(),
                Err(std::sync::TryLockError::WouldBlock) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
                Err(std::sync::TryLockError::WouldBlock) => exit_now("a model was still loading"),
            }
        };
        let Some(loaded) = loaded else { return };
        // A pass in flight holds the model too. It aborts at its next check;
        // wait for it, because the model is only freed with its last holder.
        while Arc::strong_count(&loaded) > 1 {
            if Instant::now() >= deadline {
                exit_now("a pass was still running");
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        drop(loaded);
    });
}

/// The model could not be freed in time. Going on would run ggml's teardown
/// under a live model (an assertion, then SIGABRT), so the process ends here,
/// skipping the exit handlers that are left. The helper has nothing else of
/// its own in them: the volume is restored and stdout is sealed before the
/// process starts to exit.
fn exit_now(why: &str) -> ! {
    extern "C" {
        fn _exit(code: std::ffi::c_int) -> !;
    }
    logln!("whisper: {why} at exit, leaving without teardown");
    // SAFETY: `_exit` ends the process and does not return.
    unsafe { _exit(0) }
}

/// A model file as it was when it was loaded: a download that replaces the
/// file under the same name is a different model.
#[derive(Debug, Clone, PartialEq)]
struct Stamp {
    len: u64,
    modified: Option<SystemTime>,
}

impl Stamp {
    fn of(path: &Path) -> Option<Self> {
        let meta = std::fs::metadata(path).ok()?;
        meta.is_file().then(|| Stamp { len: meta.len(), modified: meta.modified().ok() })
    }
}

/// A loaded model (`whisper_context`), freed when its last holder lets go.
struct Model(*mut sys::whisper_context);

// SAFETY: whisper.cpp only reads a context once it is loaded; everything a
// pass writes lives in its own state. whisper-cli's server and whisper-rs
// share one context between threads the same way.
unsafe impl Send for Model {}
unsafe impl Sync for Model {}

impl Model {
    fn load(path: &Path) -> Option<Self> {
        let c_path = c_path(path)?;
        // SAFETY: plain value returned by the library.
        let mut params = unsafe { sys::whisper_context_default_params() };
        // whisper-cli's defaults: GPU when the build has one, flash attention on.
        params.use_gpu = true;
        params.flash_attn = true;
        // SAFETY: `c_path` is NUL terminated and outlives the call. The
        // `_no_state` form keeps the context free of a state of its own:
        // every pass brings one.
        let ctx = unsafe { sys::whisper_init_from_file_with_params_no_state(c_path.as_ptr(), params) };
        (!ctx.is_null()).then_some(Model(ctx))
    }

    fn multilingual(&self) -> bool {
        // SAFETY: the context is live for as long as `self`.
        unsafe { sys::whisper_is_multilingual(self.0) != 0 }
    }
}

impl Drop for Model {
    fn drop(&mut self) {
        // SAFETY: the pointer came from whisper_init and is freed once.
        unsafe { sys::whisper_free(self.0) }
    }
}

/// The file name as the C library wants it.
fn c_path(path: &Path) -> Option<CString> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        CString::new(path.as_os_str().as_bytes()).ok()
    }
    #[cfg(not(unix))]
    {
        // whisper.cpp converts UTF-8 to a wide path itself on Windows.
        CString::new(path.to_str()?).ok()
    }
}

/// What one pass decodes in (`whisper_state`). It borrows the model, so it
/// cannot outlive it.
struct State<'m> {
    model: &'m Model,
    ptr: *mut sys::whisper_state,
}

impl State<'_> {
    /// `whisper_full_with_state`. `language` and whatever `params` points at
    /// must outlive the call, which the borrow of `language` and the callers
    /// see to.
    fn full(&mut self, mut params: sys::whisper_full_params, language: &CStr, samples: &[f32]) -> Result<(), String> {
        params.language = language.as_ptr();
        // SAFETY: context and state are live, `samples` is a valid slice for
        // the whole call, and the strings and the abort flag `params` points
        // at are borrowed past it.
        let code = unsafe { sys::whisper_full_with_state(self.model.0, self.ptr, params, samples.as_ptr(), samples.len() as std::ffi::c_int) };
        if code == 0 { Ok(()) } else { Err(format!("whisper_full returned {code}")) }
    }

    /// The text of every segment, in order.
    fn segments(&self) -> Vec<String> {
        // SAFETY: the state is live; a segment's text is a NUL terminated
        // string owned by the state and copied before anything else runs.
        unsafe {
            let count = sys::whisper_full_n_segments_from_state(self.ptr);
            (0..count)
                .filter_map(|i| {
                    let text = sys::whisper_full_get_segment_text_from_state(self.ptr, i);
                    (!text.is_null()).then(|| CStr::from_ptr(text).to_string_lossy().into_owned())
                })
                .collect()
        }
    }

    fn language_id(&self) -> std::ffi::c_int {
        // SAFETY: the state is live.
        unsafe { sys::whisper_full_lang_id_from_state(self.ptr) }
    }
}

impl Drop for State<'_> {
    fn drop(&mut self) {
        // SAFETY: the pointer came from whisper_init_state and is freed once.
        unsafe { sys::whisper_free_state(self.ptr) }
    }
}

struct Loaded {
    path: PathBuf,
    stamp: Stamp,
    ctx: Model,
    multilingual: bool,
}

impl Loaded {
    fn new_state(&self) -> Result<State<'_>, TranscribeError> {
        // SAFETY: the context is live for as long as `self`.
        let ptr = unsafe { sys::whisper_init_state(self.ctx.0) };
        if ptr.is_null() {
            return Err(TranscribeError("could not create a whisper state".to_string()));
        }
        Ok(State { model: &self.ctx, ptr })
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

impl Whisper {
    pub fn new() -> Self {
        install_log_hook();
        let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        // QUILL_WHISPER_THREADS overrides the count, for tests that need a
        // given machine's thread count on another one.
        let forced = std::env::var("QUILL_WHISPER_THREADS").ok().and_then(|v| v.trim().parse::<usize>().ok()).filter(|&n| n > 0);
        Self { threads: forced.unwrap_or_else(|| options::threads(cores, cpu())) }
    }

    /// Waits for the other passes on a CPU build (`None` elsewhere). A pass
    /// that waited through the start of an exit gives up instead of starting.
    fn take_turn(&self) -> Result<Option<MutexGuard<'static, ()>>, TranscribeError> {
        if !cpu() {
            return Ok(None);
        }
        let turn = lock(pass_turn());
        if EXITING.load(Ordering::Relaxed) {
            return Err(TranscribeError("exiting".to_string()));
        }
        Ok(Some(turn))
    }

    /// The loaded model for `path`, loading it (and dropping the previous
    /// one) when it is not the one in memory.
    fn model(&self, path: &Path) -> Result<Arc<Loaded>, TranscribeError> {
        let stamp = Stamp::of(path).ok_or_else(|| TranscribeError(format!("no model at \"{}\"", path.display())))?;
        let mut slot = lock(slot());
        if EXITING.load(Ordering::Relaxed) {
            return Err(TranscribeError("exiting".to_string()));
        }
        if let Some(loaded) = slot.as_ref() {
            if loaded.path == path && loaded.stamp == stamp {
                return Ok(loaded.clone());
            }
        }
        // Free the old model before the new one is read: two large models do
        // not have to fit in memory together. A pass still running on the old
        // one keeps it alive until it ends.
        *slot = None;
        release_at_exit();

        let started = Instant::now();
        let ctx = Model::load(path).ok_or_else(|| TranscribeError(format!("could not load the model at \"{}\"", path.display())))?;
        let loaded = Arc::new(Loaded {
            path: path.to_path_buf(),
            stamp,
            multilingual: ctx.multilingual(),
            ctx,
        });
        // The first state compiles the Metal pipelines; do it here so that it
        // is part of the load, not of the first decode, and so that a model
        // that cannot run fails now.
        drop(loaded.new_state()?);
        logln!(
            "whisper: loaded {} in {}ms ({}, {} threads, {})",
            file_name(path),
            started.elapsed().as_millis(),
            if loaded.multilingual { "multilingual" } else { "english only" },
            self.threads,
            backend_note(),
        );
        *slot = Some(loaded.clone());
        Ok(loaded)
    }

    /// The parameters of one pass, built the way whisper-cli builds them:
    /// the library's defaults for a greedy pass, then the strategy, then both
    /// `best_of` and `beam_size`. The language is set by `State::full`.
    fn params(&self, mode: DecodeMode, abort: &AtomicBool) -> sys::whisper_full_params {
        let sampling = options::sampling(mode, cpu());
        // SAFETY: plain value returned by the library.
        let mut params = unsafe { sys::whisper_full_default_params(sys::whisper_sampling_strategy_WHISPER_SAMPLING_GREEDY) };
        params.strategy = if sampling.beam_search() {
            sys::whisper_sampling_strategy_WHISPER_SAMPLING_BEAM_SEARCH
        } else {
            sys::whisper_sampling_strategy_WHISPER_SAMPLING_GREEDY
        };
        params.greedy.best_of = sampling.best_of;
        params.beam_search.beam_size = sampling.beam_size;
        params.n_threads = self.threads as std::ffi::c_int;
        params.translate = false;
        // `-nt`: no timestamp tokens, so a short dictation is one segment.
        params.no_timestamps = true;
        // `--no-prints`, and whisper must never write to stdout: that is the
        // event stream.
        params.print_special = false;
        params.print_progress = false;
        params.print_realtime = false;
        params.print_timestamps = false;
        // Every pass stands alone (and has its own state anyway).
        params.no_context = true;
        params.single_segment = false;
        params.token_timestamps = false;
        params.detect_language = false;
        params.temperature = options::TEMPERATURE;
        params.temperature_inc = options::TEMPERATURE_INC;
        params.entropy_thold = options::ENTROPY_THOLD;
        params.logprob_thold = options::LOGPROB_THOLD;
        params.no_speech_thold = options::NO_SPEECH_THOLD;
        params.suppress_nst = false;
        // The callback only reads the AtomicBool behind `user_data`, which the
        // caller keeps alive for the whole pass (it is borrowed from the job,
        // and the pass returns before the job ends).
        params.abort_callback = Some(abort_requested);
        params.abort_callback_user_data = abort as *const AtomicBool as *mut c_void;
        params
    }
}

unsafe extern "C" fn abort_requested(user_data: *mut c_void) -> bool {
    if user_data.is_null() {
        return EXITING.load(Ordering::Relaxed);
    }
    // SAFETY: see `Whisper::params`.
    EXITING.load(Ordering::Relaxed) || unsafe { &*(user_data as *const AtomicBool) }.load(Ordering::Relaxed)
}

impl Transcriber for Whisper {
    fn supported(&self) -> bool {
        true
    }

    fn transcribe(&self, job: &TranscribeJob<'_>) -> Result<String, TranscribeError> {
        if job.samples.is_empty() {
            return Ok(String::new());
        }
        let loaded = self.model(job.model)?;
        if job.abort.load(Ordering::Relaxed) {
            return Err(TranscribeError("aborted".to_string()));
        }
        let language = options::language(job.language, loaded.multilingual, |code| whisper_rs::get_lang_id(code).is_some())
            .map_err(|e| TranscribeError(e.to_string()))?;

        let language = CString::new(language).map_err(|_| TranscribeError("bad language code".to_string()))?;

        let turn = self.take_turn()?;
        if job.abort.load(Ordering::Relaxed) {
            return Err(TranscribeError("aborted".to_string()));
        }
        let started = Instant::now();
        let mut state = loaded.new_state()?;
        let result = state.full(self.params(job.mode, job.abort), &language, job.samples);
        let text = match result {
            Ok(()) => Ok(options::join_segments(state.segments())),
            Err(_) if job.abort.load(Ordering::Relaxed) => Err(TranscribeError("aborted".to_string())),
            Err(error) => Err(TranscribeError(format!("whisper failed: {error}"))),
        };
        // Before `loaded`: the exit handler counts the model's holders.
        drop(state);
        drop(turn);

        // The reference logs the time of a final pass only; a partial every
        // 1.5 s would fill the log.
        if job.mode == DecodeMode::Final && text.is_ok() {
            logln!("whisper took {}ms for {:.1}s audio", started.elapsed().as_millis(), job.samples.len() as f64 / 16_000.0);
        }
        text
    }

    /// `whisper-cli -dl`: the encoder and one decoder step over the first 30 s.
    /// An English-only model cannot detect, which the caller treats as "use
    /// the first configured language" (exactly what the reference ends up
    /// doing when whisper-cli fails).
    fn detect_language(&self, model: &Path, samples: &[f32]) -> Option<String> {
        if samples.is_empty() {
            return None;
        }
        let loaded = match self.model(model) {
            Ok(loaded) => loaded,
            Err(error) => {
                logln!("language detect failed: {error}");
                return None;
            }
        };
        if !loaded.multilingual {
            return None;
        }
        let _turn = self.take_turn().ok()?;
        let mut state = loaded.new_state().ok()?;
        let never = AtomicBool::new(false);
        let mut params = self.params(DecodeMode::Final, &never);
        params.detect_language = true;
        let code = match state.full(params, c"auto", samples) {
            Ok(()) => whisper_rs::get_lang_str(state.language_id()).map(str::to_string),
            Err(error) => {
                logln!("language detect failed: {error}");
                None
            }
        };
        drop(state);
        code
    }

    /// No live text on a CPU build: each partial re-decodes the whole
    /// recording, so they would run back to back on every core for as long as
    /// the key is held.
    fn partials(&self) -> bool {
        !cpu()
    }

    fn note(&self) -> Option<String> {
        Some(backend_note().to_string())
    }
}

/// True when the build decodes on the processor rather than a GPU.
fn cpu() -> bool {
    backend_note() == "cpu"
}

/// What the build decodes on, for the handshake's notes and the log.
fn backend_note() -> &'static str {
    if cfg!(target_os = "macos") {
        "metal"
    } else if cfg!(feature = "asr-vulkan") {
        "vulkan"
    } else {
        "cpu"
    }
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string())
}

// ------------------------------------------------------------------ logging

static LOG_HOOK: Once = Once::new();

/// Takes whisper.cpp's and ggml's logging away from stderr, which main copies
/// into its own log line by line.
fn install_log_hook() {
    LOG_HOOK.call_once(|| {
        // SAFETY: `log_hook` never unwinds and reads only the string it is
        // given; whisper_log_set installs it for ggml too.
        unsafe {
            whisper_rs::set_log_callback(Some(log_hook), std::ptr::null_mut());
        }
    });
}

/// The level is a C enum: an unsigned int everywhere but under MSVC, where it
/// is a signed one. `sys::ggml_log_level` is whatever bindgen found for the
/// target, so the hook compiles on every OS and Windows keeps whisper's
/// warnings and errors in the log too.
unsafe extern "C" fn log_hook(level: sys::ggml_log_level, text: *const std::ffi::c_char, _user_data: *mut c_void) {
    #[allow(clippy::unnecessary_cast)]
    let level = level as u32;
    if text.is_null() {
        return;
    }
    // SAFETY: whisper.cpp passes a NUL terminated string that lives for the call.
    let text = unsafe { std::ffi::CStr::from_ptr(text) }.to_string_lossy();
    // Called from whisper's own threads: a panic must not cross into C.
    let _ = std::panic::catch_unwind(|| {
        if let Some(line) = options::log_line(level, &text) {
            logln!("{line}");
        }
    });
}

// -------------------------------------------------------------------- tests

/// These need a model and a recording, so they only run when asked:
///
/// ```text
/// QUILL_TEST_MODEL=~/Library/Application\ Support/quill/models/ggml-tiny.en.bin \
/// QUILL_TEST_WAV=/path/to/speech.wav \
///   cargo test --release --features asr -- --ignored --nocapture asr::
/// ```
#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Option<(PathBuf, Vec<f32>)> {
        // Unit tests run in the developer's own account: leave the installed
        // app's log alone.
        quill_core::log::set_enabled(false);
        let model = PathBuf::from(std::env::var_os("QUILL_TEST_MODEL")?);
        let wav = quill_core::wav::read(Path::new(&std::env::var_os("QUILL_TEST_WAV")?)).ok()?;
        assert_eq!(wav.rate, 16_000, "the test recording must be 16 kHz");
        Some((model, wav.samples))
    }

    fn pass(whisper: &Whisper, model: &Path, samples: &[f32], mode: DecodeMode) -> (String, Duration) {
        let abort = AtomicBool::new(false);
        let started = Instant::now();
        let raw = whisper.transcribe(&TranscribeJob { model, samples, language: "en", mode, abort: &abort }).expect("transcribe");
        (quill_core::text::clean_transcript(&raw), started.elapsed())
    }

    #[test]
    fn a_missing_model_is_an_error_not_a_crash() {
        quill_core::log::set_enabled(false);
        let whisper = Whisper::new();
        let abort = AtomicBool::new(false);
        let samples = vec![0.0f32; 16_000];
        let job = TranscribeJob { model: Path::new("/nonexistent/model.bin"), samples: &samples, language: "en", mode: DecodeMode::Final, abort: &abort };
        assert!(whisper.transcribe(&job).is_err());
        assert_eq!(whisper.detect_language(Path::new("/nonexistent/model.bin"), &samples), None);
        assert!(whisper.supported());
    }

    #[test]
    fn a_file_that_is_not_a_model_is_an_error_not_a_crash() {
        quill_core::log::set_enabled(false);
        let path = std::env::temp_dir().join(format!("quill-not-a-model-{}.bin", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"this is not a ggml file").unwrap();
        let whisper = Whisper::new();
        let abort = AtomicBool::new(false);
        let samples = vec![0.0f32; 16_000];
        let job = TranscribeJob { model: &path, samples: &samples, language: "en", mode: DecodeMode::Final, abort: &abort };
        let result = whisper.transcribe(&job);
        let _ = std::fs::remove_file(&path);
        assert!(result.is_err());
    }

    #[test]
    #[ignore = "needs QUILL_TEST_MODEL and QUILL_TEST_WAV"]
    fn latency_of_partials_and_finals() {
        let Some((model, samples)) = fixture() else { panic!("set QUILL_TEST_MODEL and QUILL_TEST_WAV") };
        let whisper = Whisper::new();
        let started = Instant::now();
        whisper.model(&model).expect("load");
        println!("model load: {} ms", started.elapsed().as_millis());

        for seconds in [3usize, 6] {
            let clip = &samples[..samples.len().min(seconds * 16_000)];
            let actual = clip.len() as f64 / 16_000.0;
            let mut partials = Vec::new();
            let mut text = String::new();
            for _ in 0..5 {
                let (t, took) = pass(&whisper, &model, clip, DecodeMode::Partial);
                partials.push(took.as_millis());
                text = t;
            }
            let (final_text, final_took) = pass(&whisper, &model, clip, DecodeMode::Final);
            println!("{actual:.1}s clip: partial {partials:?} ms \"{text}\"; final {} ms \"{final_text}\"", final_took.as_millis());
            assert!(!final_text.is_empty());
        }
    }

    /// With a multilingual model in QUILL_TEST_MODEL this prints what was
    /// detected; with an English-only one detection must decline.
    #[test]
    #[ignore = "needs QUILL_TEST_MODEL and QUILL_TEST_WAV"]
    fn language_detection_answers_or_declines() {
        let Some((model, samples)) = fixture() else { panic!("set QUILL_TEST_MODEL and QUILL_TEST_WAV") };
        let whisper = Whisper::new();
        let multilingual = whisper.model(&model).expect("load").multilingual;
        let started = Instant::now();
        let detected = whisper.detect_language(&model, &samples);
        println!("multilingual {multilingual}: detected {detected:?} in {} ms", started.elapsed().as_millis());
        match detected {
            Some(code) => assert!(multilingual && whisper_rs::get_lang_id(&code).is_some()),
            None => assert!(!multilingual, "a multilingual model must detect a language"),
        }
    }

    #[test]
    #[ignore = "needs QUILL_TEST_MODEL and QUILL_TEST_WAV"]
    fn passes_overlap_and_an_abort_ends_one_early() {
        let Some((model, samples)) = fixture() else { panic!("set QUILL_TEST_MODEL and QUILL_TEST_WAV") };
        let whisper = Arc::new(Whisper::new());
        let (expected, _) = pass(&whisper, &model, &samples, DecodeMode::Final);
        assert!(!expected.is_empty());

        // A final, a partial and a second final at once, several rounds: each
        // gets its own state and the same words.
        for _ in 0..3 {
            let handles: Vec<_> = [DecodeMode::Final, DecodeMode::Partial, DecodeMode::Final]
                .into_iter()
                .map(|mode| {
                    let (whisper, model, samples) = (whisper.clone(), model.clone(), samples.clone());
                    std::thread::spawn(move || pass(&whisper, &model, &samples, mode).0)
                })
                .collect();
            let texts: Vec<String> = handles.into_iter().map(|h| h.join().expect("no panic")).collect();
            assert_eq!(texts[0], expected);
            assert_eq!(texts[2], expected);
            assert!(!texts[1].is_empty());
        }

        // Already aborted: no decode at all.
        let abort = AtomicBool::new(true);
        let job = TranscribeJob { model: &model, samples: &samples, language: "en", mode: DecodeMode::Partial, abort: &abort };
        let started = Instant::now();
        assert!(whisper.transcribe(&job).is_err());
        println!("aborted pass returned in {} ms", started.elapsed().as_millis());

        // And the engine is fine afterwards.
        assert_eq!(pass(&whisper, &model, &samples, DecodeMode::Final).0, expected);

        // An English-only model is told English whatever is asked, and cannot detect.
        if !whisper.model(&model).unwrap().multilingual {
            let abort = AtomicBool::new(false);
            let job = TranscribeJob { model: &model, samples: &samples, language: "pt", mode: DecodeMode::Final, abort: &abort };
            assert_eq!(quill_core::text::clean_transcript(&whisper.transcribe(&job).unwrap()), expected);
            assert_eq!(whisper.detect_language(&model, &samples), None);
        }
    }
}

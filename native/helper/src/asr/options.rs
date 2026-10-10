//! What a whisper pass is told, kept apart from the engine so it is tested
//! without building whisper.cpp.
//!
//! The reference is the Swift helper, which ran `whisper-cli` once per pass
//! (docs/HELPER-PROTOCOL.md section 5.3):
//!
//! | Pass | whisper-cli arguments |
//! |---|---|
//! | Final, `transcribe-file` | `-nt --no-prints -t 8 -l <code or auto>` (beam search, 5 beams, best of 5 on a retry) |
//! | Partial | the same plus `-bo 1 -bs 1` (greedy) |
//!
//! Everything else is whisper-cli's default, which is spelled out here because
//! the library's own defaults are not the command line tool's.

use quill_core::caps::DecodeMode;

/// `-t 8` in the reference helper.
pub const MAX_THREADS: usize = 8;

/// whisper-cli's default `--beam-size` and `--best-of`.
pub const BEAM_SIZE: i32 = 5;
pub const BEST_OF: i32 = 5;

/// whisper-cli's defaults, the same for every pass.
pub const TEMPERATURE: f32 = 0.0;
pub const TEMPERATURE_INC: f32 = 0.2;
pub const ENTROPY_THOLD: f32 = 2.4;
pub const LOGPROB_THOLD: f32 = -1.0;
pub const NO_SPEECH_THOLD: f32 = 0.6;

/// `--beam-size` and `--best-of` as whisper-cli hands them to the library. It
/// sets both whatever the strategy, and both matter in a beam search: the
/// first decode runs `beam_size` beams, and when that decode fails its checks
/// whisper retries at a higher temperature with `best_of` sampled candidates.
/// Leaving `best_of` at the library's own default for a beam search (one
/// candidate) gives a different text on exactly those retries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Sampling {
    pub beam_size: i32,
    pub best_of: i32,
}

impl Sampling {
    /// whisper-cli's rule for the strategy: a beam search when there is more
    /// than one beam, greedy otherwise.
    pub fn beam_search(&self) -> bool {
        self.beam_size > 1
    }
}

pub fn sampling(mode: DecodeMode) -> Sampling {
    match mode {
        // No `-bs`, no `-bo`: the defaults.
        DecodeMode::Final => Sampling { beam_size: BEAM_SIZE, best_of: BEST_OF },
        // `-bo 1 -bs 1`.
        DecodeMode::Partial => Sampling { beam_size: 1, best_of: 1 },
    }
}

/// The reference passes 8 whatever the machine. Asking for more threads than
/// there are cores only makes them fight, so a smaller machine gets its own
/// core count.
pub fn threads(cores: usize) -> usize {
    cores.clamp(1, MAX_THREADS)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LanguageError {
    Unknown(String),
}

impl std::fmt::Display for LanguageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LanguageError::Unknown(code) => write!(f, "unknown language '{code}'"),
        }
    }
}

/// The language whisper is given, by whisper-cli's rules, in its order:
///
/// - a code whisper does not know fails the pass, whatever the model
///   (whisper-cli exits, and the reference helper turns that into an empty
///   text);
/// - a model that only knows English is then always told `en`;
/// - `auto` (or nothing) lets a multilingual model choose.
pub fn language(requested: &str, multilingual: bool, known: impl Fn(&str) -> bool) -> Result<String, LanguageError> {
    let code = requested.trim().to_ascii_lowercase();
    let auto = code.is_empty() || code == "auto";
    if !auto && !known(&code) {
        return Err(LanguageError::Unknown(code));
    }
    if !multilingual {
        return Ok("en".to_string());
    }
    Ok(if auto { "auto".to_string() } else { code })
}

/// Segments as the session wants them: one per line. A segment that contains
/// a line break of its own is flattened first, so it stays one line.
pub fn join_segments<S: AsRef<str>>(segments: impl IntoIterator<Item = S>) -> String {
    let mut out = String::new();
    for segment in segments {
        let flat = segment.as_ref().replace(['\r', '\n'], " ");
        let flat = flat.trim();
        if flat.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(flat);
    }
    out
}

/// ggml log levels (`enum ggml_log_level`).
pub const LOG_LEVEL_WARN: u32 = 3;
pub const LOG_LEVEL_ERROR: u32 = 4;

/// Which of whisper.cpp's own log lines reach the helper's log: warnings and
/// errors only (loading a model alone prints dozens of info lines), trimmed,
/// and never an empty one.
pub fn log_line(level: u32, text: &str) -> Option<String> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    match level {
        LOG_LEVEL_WARN => Some(format!("whisper.cpp warning: {text}")),
        LOG_LEVEL_ERROR => Some(format!("whisper.cpp error: {text}")),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn known(code: &str) -> bool {
        ["en", "fr", "pt", "de"].contains(&code)
    }

    #[test]
    fn final_is_beam_search_and_partial_is_greedy() {
        let last = sampling(DecodeMode::Final);
        assert_eq!(last, Sampling { beam_size: 5, best_of: 5 });
        assert!(last.beam_search());
        let partial = sampling(DecodeMode::Partial);
        assert_eq!(partial, Sampling { beam_size: 1, best_of: 1 });
        assert!(!partial.beam_search());
    }

    #[test]
    fn eight_threads_unless_the_machine_has_fewer() {
        assert_eq!(threads(18), 8);
        assert_eq!(threads(8), 8);
        assert_eq!(threads(4), 4);
        assert_eq!(threads(0), 1);
    }

    #[test]
    fn an_english_only_model_is_always_told_english() {
        assert_eq!(language("pt", false, known), Ok("en".to_string()));
        assert_eq!(language("auto", false, known), Ok("en".to_string()));
        assert_eq!(language("", false, known), Ok("en".to_string()));
    }

    #[test]
    fn a_multilingual_model_gets_the_code_or_auto() {
        assert_eq!(language("pt", true, known), Ok("pt".to_string()));
        assert_eq!(language(" FR ", true, known), Ok("fr".to_string()));
        assert_eq!(language("auto", true, known), Ok("auto".to_string()));
        assert_eq!(language("", true, known), Ok("auto".to_string()));
    }

    #[test]
    fn an_unknown_code_fails_the_pass() {
        assert_eq!(language("xx", true, known), Err(LanguageError::Unknown("xx".to_string())));
        // whisper-cli checks the code before it looks at the model.
        assert_eq!(language("xx", false, known), Err(LanguageError::Unknown("xx".to_string())));
        assert_eq!(LanguageError::Unknown("xx".to_string()).to_string(), "unknown language 'xx'");
    }

    #[test]
    fn segments_become_lines() {
        assert_eq!(join_segments([" The quick brown fox", " jumps over."]), "The quick brown fox\njumps over.");
        assert_eq!(join_segments([" [BLANK_AUDIO]"]), "[BLANK_AUDIO]");
        assert_eq!(join_segments(["", "  ", " one\ntwo "]), "one two");
        assert_eq!(join_segments(Vec::<String>::new()), "");
    }

    #[test]
    fn the_session_drops_a_bracketed_segment_and_keeps_the_rest() {
        let raw = join_segments([" [BLANK_AUDIO]", " Hello.", " [Music]", " there"]);
        assert_eq!(quill_core::text::clean_transcript(&raw), "Hello. there");
    }

    #[test]
    fn only_warnings_and_errors_are_logged() {
        assert_eq!(log_line(2, "whisper_init_state: kv self size = 3 MB\n"), None);
        assert_eq!(log_line(1, "debug"), None);
        assert_eq!(log_line(0, "."), None);
        assert_eq!(log_line(3, " input is too short \n").as_deref(), Some("whisper.cpp warning: input is too short"));
        assert_eq!(log_line(4, "failed to load model\n").as_deref(), Some("whisper.cpp error: failed to load model"));
        assert_eq!(log_line(4, " \n"), None);
    }
}

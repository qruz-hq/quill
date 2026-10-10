//! Where the helper keeps its two files (section 10).

use std::path::PathBuf;

fn env_dir(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// The folder holding the log and the duck state file.
///
/// macOS: `~/Library/Logs`, as the Swift helper. Windows:
/// `%LOCALAPPDATA%\Quill\Logs`. Linux: `$XDG_STATE_HOME/quill` (or
/// `~/.local/state/quill`).
pub fn state_dir() -> PathBuf {
    if cfg!(target_os = "macos") {
        env_dir("HOME").unwrap_or_else(std::env::temp_dir).join("Library").join("Logs")
    } else if cfg!(windows) {
        env_dir("LOCALAPPDATA")
            .or_else(|| env_dir("USERPROFILE").map(|p| p.join("AppData").join("Local")))
            .unwrap_or_else(std::env::temp_dir)
            .join("Quill")
            .join("Logs")
    } else {
        env_dir("XDG_STATE_HOME")
            .or_else(|| env_dir("HOME").map(|p| p.join(".local").join("state")))
            .unwrap_or_else(std::env::temp_dir)
            .join("quill")
    }
}

pub fn log_file() -> PathBuf {
    state_dir().join("Quill-stt.log")
}

/// Present only while an output device is ducked or waiting to be restored.
pub fn duck_state_file() -> PathBuf {
    state_dir().join("Quill-duck.json")
}

//! The helper's log file: `[ISO-8601 UTC] text`, append only (section 10).
//!
//! Never stdout (that is the event stream) and never stderr (main copies it
//! into its own log line by line).

use std::fs::OpenOptions;
use std::io::Write;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

static LOCK: Mutex<()> = Mutex::new(());
static OFF: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Turns the log off or on for this process (tests that must leave the real
/// log alone).
pub fn set_enabled(enabled: bool) {
    OFF.store(!enabled, std::sync::atomic::Ordering::Relaxed);
}

/// Appends one line. The file is opened per line, so a log that was rotated or
/// deleted under a running helper simply starts again.
pub fn line(text: &str) {
    // Unit tests run in the developer's own account: they must not write to
    // the log of the app that is installed there.
    if cfg!(test) || OFF.load(std::sync::atomic::Ordering::Relaxed) {
        return;
    }
    let stamp = iso8601(SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0));
    let flat = text.replace('\n', " ");
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = crate::paths::log_file();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = file.write_all(format!("[{stamp}] {flat}\n").as_bytes());
    }
}

/// `logln!("mic: {name}")`, formatted like `println!`.
#[macro_export]
macro_rules! logln {
    ($($arg:tt)*) => { $crate::log::line(&format!($($arg)*)) };
}

/// Seconds since the Unix epoch as `2026-10-10T12:34:56Z`.
pub fn iso8601(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Civil date from a day count (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::iso8601;

    #[test]
    fn formats_known_instants() {
        assert_eq!(iso8601(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(iso8601(1_791_635_696), "2026-10-10T12:34:56Z");
        assert_eq!(iso8601(4_102_444_799), "2099-12-31T23:59:59Z");
    }
}

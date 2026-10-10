//! Reading Windows' microphone privacy switches, the part with no OS types.
//!
//! Settings > Privacy & security > Microphone has three switches that matter
//! to a desktop program, each stored as the string `Allow` or `Deny` in a
//! registry value named `Value`:
//!
//! | Switch | Key (under `...\CurrentVersion\CapabilityAccessManager\ConsentStore`) |
//! |---|---|
//! | Microphone access (the whole device) | `HKLM\...\microphone` |
//! | Let apps access your microphone | `HKCU\...\microphone` |
//! | Let desktop apps access your microphone | `HKCU\...\microphone\NonPackaged` |
//!
//! There is no prompt and no per-program grant for a program like this one:
//! with any switch off, opening the microphone fails or delivers silence.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MicAccess {
    Allowed,
    /// At least one switch is off.
    Denied,
    /// No switch could be read (an older Windows, or a locked-down registry).
    Unknown,
}

/// `values` are the three switches as read, `None` for one that is not there.
pub fn mic_access(values: &[Option<&str>]) -> MicAccess {
    let known: Vec<&str> = values.iter().flatten().map(|value| value.trim()).collect();
    if known.iter().any(|value| value.eq_ignore_ascii_case("deny")) {
        MicAccess::Denied
    } else if known.iter().any(|value| value.eq_ignore_ascii_case("allow")) {
        MicAccess::Allowed
    } else {
        MicAccess::Unknown
    }
}

/// Shown to the user as is, as a `final.error` or a mic test's `error`.
pub const DENIED: &str = "Windows is blocking the microphone. Turn on Settings > Privacy & security > Microphone, \
     including \"Let desktop apps access your microphone\".";
/// A silent recording with the switches on (or unreadable).
pub const SILENT: &str = "No audio from the microphone. Check the input device and its level in Settings > System > Sound.";

/// `final.error` for a recording of digital silence.
pub fn silent_message(access: MicAccess) -> &'static str {
    if access == MicAccess::Denied { DENIED } else { SILENT }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_switch_on_is_allowed() {
        assert_eq!(mic_access(&[Some("Allow"), Some("Allow"), Some("Allow")]), MicAccess::Allowed);
    }

    #[test]
    fn any_switch_off_is_denied() {
        assert_eq!(mic_access(&[Some("Deny"), Some("Allow"), Some("Allow")]), MicAccess::Denied);
        assert_eq!(mic_access(&[Some("Allow"), Some("Deny"), Some("Allow")]), MicAccess::Denied);
        assert_eq!(mic_access(&[Some("Allow"), Some("Allow"), Some("Deny")]), MicAccess::Denied);
        assert_eq!(mic_access(&[None, None, Some("deny\0")].map(|v: Option<&str>| v.map(|s| s.trim_end_matches('\0')))), MicAccess::Denied);
    }

    #[test]
    fn a_missing_switch_does_not_deny() {
        assert_eq!(mic_access(&[None, Some("Allow"), None]), MicAccess::Allowed);
        assert_eq!(mic_access(&[None, None, None]), MicAccess::Unknown);
        assert_eq!(mic_access(&[]), MicAccess::Unknown);
    }

    #[test]
    fn values_this_code_does_not_know_are_not_a_denial() {
        // "Prompt" is used for packaged apps.
        assert_eq!(mic_access(&[Some("Prompt"), None, None]), MicAccess::Unknown);
        assert_eq!(mic_access(&[Some("Prompt"), Some("Allow"), None]), MicAccess::Allowed);
    }

    #[test]
    fn both_messages_name_the_microphone() {
        // Section 5.3: main matches on the word.
        assert!(silent_message(MicAccess::Denied).contains("microphone"));
        assert!(silent_message(MicAccess::Allowed).contains("microphone"));
        assert!(silent_message(MicAccess::Unknown).contains("microphone"));
        assert_ne!(silent_message(MicAccess::Denied), silent_message(MicAccess::Allowed));
    }
}

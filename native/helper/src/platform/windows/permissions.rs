//! Permissions on Windows.
//!
//! There is no Accessibility grant: `ax-check` answers `trusted: true` and the
//! `accessibility` capability is never listed (section 11.2 rule 6). The key
//! hook and `SendInput` need nothing from the user.
//!
//! The one gate is the microphone privacy setting. Windows shows no prompt for
//! it: a blocked microphone fails to open or records silence. The switches are
//! read from the registry (`permissions/consent.rs`) to word the message, and
//! only then: nothing here changes a setting or opens a dialog.
//!
//! Compiles, but has not been run on Windows yet.

use std::sync::Arc;

use quill_core::caps::Permissions;
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};

mod consent;

pub use consent::MicAccess;

const STORE: PCWSTR = w!(r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone");
const STORE_DESKTOP: PCWSTR =
    w!(r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\NonPackaged");

/// The string in `key\Value`, if there is one.
fn consent_value(root: HKEY, key: PCWSTR) -> Option<String> {
    let mut buffer = [0u16; 64];
    let mut bytes = std::mem::size_of_val(&buffer) as u32;
    // SAFETY: the key and value names are constant, null-terminated strings;
    // `buffer` holds `bytes` bytes and the call sets `bytes` to what it wrote.
    let status = unsafe {
        RegGetValueW(root, key, w!("Value"), RRF_RT_REG_SZ, None, Some(buffer.as_mut_ptr().cast()), Some(&mut bytes))
    };
    if status != ERROR_SUCCESS {
        return None;
    }
    let units = (bytes as usize / 2).min(buffer.len());
    Some(String::from_utf16_lossy(&buffer[..units]).trim_end_matches('\0').to_string())
}

/// The microphone privacy setting as it is right now.
pub fn mic_access() -> MicAccess {
    let values = [
        consent_value(HKEY_LOCAL_MACHINE, STORE),
        consent_value(HKEY_CURRENT_USER, STORE),
        consent_value(HKEY_CURRENT_USER, STORE_DESKTOP),
    ];
    consent::mic_access(&values.each_ref().map(|value| value.as_deref()))
}

/// What to tell the user when the microphone is blocked by the setting.
pub fn mic_denied_message() -> &'static str {
    consent::DENIED
}

struct Privacy;

impl Permissions for Privacy {
    fn has_accessibility_gate(&self) -> bool {
        false
    }

    fn accessibility_trusted(&self) -> bool {
        true
    }

    fn silent_microphone_message(&self) -> String {
        consent::silent_message(mic_access()).to_string()
    }
}

pub fn create() -> Arc<dyn Permissions> {
    Arc::new(Privacy)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn there_is_no_accessibility_gate() {
        let permissions = create();
        assert!(!permissions.has_accessibility_gate());
        assert!(permissions.accessibility_trusted());
    }

    #[test]
    fn the_setting_can_be_read_and_the_wording_names_the_microphone() {
        // Whatever this machine says, reading it must not fail.
        let _ = mic_access();
        assert!(create().silent_microphone_message().contains("microphone"));
    }
}

//! Capability `accessibility`, and macOS wording for the user.
//!
//! Typing into other apps and the hold key's event tap both sit behind the
//! Accessibility grant (TCC). The helper only ever reads the grant: the app's
//! onboarding asks for it, after explaining why. A system dialog raised by a
//! background helper would read as unexplained.

use std::sync::Arc;

use quill_core::caps::Permissions;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    /// `Boolean AXIsProcessTrusted(void)`: the grant for this process (TCC
    /// attributes the helper to the app that launched it). Never prompts.
    fn AXIsProcessTrusted() -> u8;
}

/// The Accessibility grant as it is right now, without prompting. Cheap enough
/// to call before every insert and on every poll.
pub fn accessibility_trusted() -> bool {
    // SAFETY: takes no arguments, returns a plain Boolean, allocates nothing
    // the caller owns, and is documented as callable from any thread.
    unsafe { AXIsProcessTrusted() != 0 }
}

struct Tcc;

impl Permissions for Tcc {
    fn has_accessibility_gate(&self) -> bool {
        true
    }

    fn accessibility_trusted(&self) -> bool {
        accessibility_trusted()
    }

    fn silent_microphone_message(&self) -> String {
        "No audio from the microphone. Allow Quill under Privacy & Security > Microphone.".to_string()
    }
}

pub fn create() -> Arc<dyn Permissions> {
    Arc::new(Tcc)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_grant_can_be_read_without_prompting() {
        // Whatever the answer is on this machine, reading it must not crash,
        // and two reads in a row agree.
        let permissions = create();
        assert!(permissions.has_accessibility_gate());
        assert_eq!(permissions.accessibility_trusted(), accessibility_trusted());
    }

    #[test]
    fn the_silent_microphone_wording_names_the_microphone() {
        assert!(create().silent_microphone_message().contains("microphone"));
    }
}

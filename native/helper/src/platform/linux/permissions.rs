//! Permissions on Linux: there is no system gate to read.
//!
//! No Accessibility grant exists here, so `ax-check` answers `trusted: true`
//! and the `accessibility` capability is never listed (section 11.2 rule 6).
//! What a session cannot do (a hold key or a synthetic paste under Wayland)
//! is not a permission the user could grant: it is reported by leaving the
//! capability out of the handshake, with a note (`hotkey.rs`, `insert.rs`).
//!
//! The microphone has no per-app permission either (a sandboxed build would
//! go through a portal), so a recording of pure silence gets the general
//! wording: check the input device.

use std::sync::Arc;

use quill_core::caps::Permissions;
use quill_core::unsupported::NoGate;

pub fn create() -> Arc<dyn Permissions> {
    Arc::new(NoGate)
}

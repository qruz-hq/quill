//! Platform-neutral half of the Quill helper.
//!
//! The contract is `docs/HELPER-PROTOCOL.md`; section numbers in comments refer
//! to it. Nothing in this crate talks to an operating system API: the session
//! state machine drives the capability traits in [`caps`], and the binary crate
//! supplies one implementation per OS.

pub mod bus;
pub mod caps;
pub mod command;
pub mod event;
pub mod gesture;
pub mod level;
pub mod log;
pub mod paths;
pub mod pcm;
pub mod resample;
pub mod runtime;
pub mod session;
pub mod spectrum;
pub mod text;
pub mod unsupported;
pub mod wav;

/// The rate everything downstream of a capture works at (section 5.1).
pub const SAMPLE_RATE: u32 = 16_000;

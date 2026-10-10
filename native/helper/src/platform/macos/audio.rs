//! Capability `audio` on macOS: CoreAudio through cpal (`audio_shared.rs` has
//! the reasoning and the code; Windows and Linux use the same path).
//!
//! A device's `uid` here is its CoreAudio UID, the same string the Swift
//! helper reports and the app stores as the pinned microphone.

use quill_core::bus::Bus;
use quill_core::caps::AudioCapture;

use crate::audio_shared::CpalAudio;

/// The capture needs no bus of its own: each `open` is handed a `CaptureSink`.
pub fn create(_bus: &Bus) -> Box<dyn AudioCapture> {
    Box::new(CpalAudio::new())
}

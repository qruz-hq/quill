//! Capability `audio`: the sound server through cpal, the same code path as
//! macOS (`audio_shared.rs`).
//!
//! cpal picks its PulseAudio host when a PulseAudio or PipeWire socket is
//! there (every current desktop) and ALSA otherwise. With the sound server a
//! device's `uid` is its source name (`alsa_input.usb-Blue_Yeti-00.analog-stereo`),
//! which stays the same across replugs and reboots; with plain ALSA it is the
//! PCM id. Monitor sources (the loopback of an output) are left out of the
//! list by the shared code.
//!
//! Compiles, but has not been run on this OS yet.

use quill_core::bus::Bus;
use quill_core::caps::AudioCapture;

use crate::audio_shared::CpalAudio;

/// The capture needs no bus of its own: each `open` is handed a `CaptureSink`.
pub fn create(_bus: &Bus) -> Box<dyn AudioCapture> {
    Box::new(CpalAudio::new())
}

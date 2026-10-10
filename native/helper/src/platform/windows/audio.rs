//! Capability `audio`: WASAPI through cpal, the same code path as macOS
//! (`audio_shared.rs`): shared mode, any sample rate and channel count, mixed
//! to mono and resampled to 16 kHz by the shared code, which also feeds the
//! level meter and the spectrum.
//!
//! A device's `uid` is its endpoint id (`{0.0.1.00000000}.{guid}`), which
//! Windows keeps across unplugging and replugging, so a pinned microphone
//! stays pinned.
//!
//! One thing is added here: when a microphone cannot be opened and Windows'
//! privacy setting is the reason, the error says so.
//!
//! Compiles, but has not been run on Windows yet.

use quill_core::bus::Bus;
use quill_core::caps::{AudioCapture, CaptureError, CaptureSink, CaptureStream, DeviceInfo};

use super::permissions::{mic_access, mic_denied_message, MicAccess};
use crate::audio_shared::CpalAudio;

struct WasapiAudio {
    inner: CpalAudio,
}

impl AudioCapture for WasapiAudio {
    fn supported(&self) -> bool {
        self.inner.supported()
    }

    fn devices(&self) -> Vec<DeviceInfo> {
        self.inner.devices()
    }

    fn open(&mut self, uid: Option<&str>, sink: CaptureSink) -> Result<Box<dyn CaptureStream>, CaptureError> {
        self.inner.open(uid, sink).map_err(|error| {
            // Only looked at after a failure: the common path reads nothing.
            if mic_access() == MicAccess::Denied {
                CaptureError::new(mic_denied_message())
            } else {
                error
            }
        })
    }
}

/// The capture needs no bus of its own: each `open` is handed a `CaptureSink`.
pub fn create(_bus: &Bus) -> Box<dyn AudioCapture> {
    Box::new(WasapiAudio { inner: CpalAudio::new() })
}

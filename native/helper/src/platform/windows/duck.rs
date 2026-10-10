//! Capability `duck` on Windows: lower the output volume while recording, and
//! always put it back (section 7).
//!
//! `IAudioEndpointVolume` on the default render endpoint: the same slider the
//! volume flyout moves. The rules (what to save, when to restore, the duck
//! state file) are in `duck_shared.rs`, shared with macOS; this file is the
//! handful of Core Audio calls underneath them. A device is remembered by its
//! endpoint id, which survives unplugging and replugging, so a duck that a
//! killed helper left behind is undone by the next launch on the right device.
//!
//! Which controls are touched is decided in `duck/controls.rs`: the master
//! volume, or each channel when the user has set a balance.
//!
//! Compiles, but has not been run on Windows yet.

use std::sync::{Arc, Mutex, MutexGuard};

use quill_core::caps::Ducker;
use quill_core::paths;
use windows::core::{GUID, HSTRING, PWSTR};
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{eConsole, eRender, IMMDevice, DEVICE_STATE_ACTIVE};
use windows::Win32::System::Com::{CoTaskMemFree, CLSCTX_ALL};

use super::com;

#[path = "../duck_shared.rs"]
mod shared;

mod controls;

use controls::{Names, MASTER};
use shared::{DuckCore, OutputVolume};

pub fn create() -> Arc<dyn Ducker> {
    Arc::new(DuckCore::new(EndpointOutput::default(), paths::duck_state_file()))
}

/// Passed with every volume change, so anything listening for volume changes
/// in this process can tell the helper's own from the user's.
const CONTEXT: GUID = GUID::from_u128(0x7175_696c_6c00_4a1e_9d3b_5c2f_8e41_d0a7);

/// The endpoint's id, taking ownership of the string COM allocated for it.
fn id_of(device: &IMMDevice) -> Option<String> {
    // SAFETY: `GetId` returns a string allocated with CoTaskMemAlloc that the
    // caller frees; it is read once and freed once, here.
    unsafe {
        let raw: PWSTR = device.GetId().ok()?;
        let id = raw.to_string().ok();
        CoTaskMemFree(Some(raw.0.cast_const().cast()));
        id.filter(|id| !id.is_empty())
    }
}

/// The connected endpoint with that id. An unplugged endpoint still has an
/// entry in Windows' list, so its state is checked.
fn active_device(id: &str) -> Option<IMMDevice> {
    let enumerator = com::device_enumerator().ok()?;
    // SAFETY: plain COM calls on live interface pointers; the id string
    // outlives the call that reads it.
    unsafe {
        let device = enumerator.GetDevice(&HSTRING::from(id)).ok()?;
        (device.GetState().ok()? == DEVICE_STATE_ACTIVE).then_some(device)
    }
}

#[derive(Default)]
struct EndpointOutput {
    names: Mutex<Names>,
}

impl EndpointOutput {
    fn names(&self) -> MutexGuard<'_, Names> {
        self.names.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn volume_of(&self, device: usize) -> Option<IAudioEndpointVolume> {
        let id = self.names().id(device)?.to_string();
        let device = active_device(&id)?;
        // SAFETY: activates an interface on a live endpoint; no parameters.
        unsafe { device.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None) }.ok()
    }
}

impl OutputVolume for EndpointOutput {
    type Device = usize;

    fn default_output(&self) -> Option<usize> {
        let enumerator = com::device_enumerator().ok()?;
        // SAFETY: a plain COM call on a live interface pointer. It fails when
        // there is no output device at all.
        let device = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }.ok()?;
        Some(self.names().intern(&id_of(&device)?))
    }

    fn uid(&self, device: usize) -> Option<String> {
        self.names().id(device).map(str::to_string)
    }

    fn find(&self, uid: &str) -> Option<usize> {
        active_device(uid)?;
        Some(self.names().intern(uid))
    }

    fn controls(&self, device: usize) -> Vec<u32> {
        let Some(volume) = self.volume_of(device) else { return Vec::new() };
        // SAFETY: plain COM calls on a live interface pointer.
        unsafe {
            let master = volume.GetMasterVolumeLevelScalar().ok();
            let count = volume.GetChannelCount().unwrap_or(0);
            let channels: Vec<Option<f32>> = (0..count).map(|channel| volume.GetChannelVolumeLevelScalar(channel).ok()).collect();
            controls::pick(master, &channels)
        }
    }

    fn volume(&self, device: usize, control: u32) -> Option<f32> {
        let volume = self.volume_of(device)?;
        // SAFETY: plain COM calls on a live interface pointer.
        unsafe {
            if control == MASTER {
                volume.GetMasterVolumeLevelScalar().ok()
            } else {
                volume.GetChannelVolumeLevelScalar(control - 1).ok()
            }
        }
    }

    fn set_volume(&self, device: usize, control: u32, value: f32) -> bool {
        let Some(volume) = self.volume_of(device) else { return false };
        let value = value.clamp(0.0, 1.0);
        // SAFETY: plain COM calls on a live interface pointer; `CONTEXT` is a
        // constant that outlives the call.
        unsafe {
            if control == MASTER {
                volume.SetMasterVolumeLevelScalar(value, &CONTEXT).is_ok()
            } else {
                volume.SetChannelVolumeLevelScalar(control - 1, value, &CONTEXT).is_ok()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reads only: the user's volume is not written by any unit test.
    #[test]
    fn the_default_output_is_found_again_by_its_id() {
        let out = EndpointOutput::default();
        // A machine with no output device at all (a CI runner) has nothing to check.
        let Some(device) = out.default_output() else { return };
        let uid = out.uid(device).expect("an endpoint has an id");
        assert!(!uid.is_empty());
        assert_eq!(out.find(&uid), Some(device));
        assert_eq!(out.find("quill-test-no-such-device"), None);
        for control in out.controls(device) {
            let value = out.volume(device, control).expect("a listed control can be read");
            assert!((0.0..=1.0).contains(&value), "control {control} reads {value}");
        }
    }
}

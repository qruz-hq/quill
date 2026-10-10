//! Capability `duck` on macOS: lower the output volume while recording, and
//! always put it back (section 7).
//!
//! CoreAudio's `VolumeScalar` on the default output device. The rules (what
//! to save, when to restore, the duck state file) are in `duck_shared.rs`;
//! this file is the five HAL calls underneath them. The state file is the one
//! the Swift helper writes, in the same format, so either helper undoes a duck
//! the other left behind.

use std::ffi::c_void;
use std::ptr::{null, NonNull};
use std::sync::Arc;

use objc2_core_audio::{
    kAudioDevicePropertyDeviceUID, kAudioDevicePropertyVolumeScalar, kAudioHardwarePropertyDefaultOutputDevice,
    kAudioHardwarePropertyDevices, kAudioObjectPropertyElementMain, kAudioObjectPropertyScopeGlobal,
    kAudioObjectPropertyScopeOutput, kAudioObjectSystemObject, AudioDeviceID, AudioObjectGetPropertyData,
    AudioObjectGetPropertyDataSize, AudioObjectHasProperty, AudioObjectID, AudioObjectPropertyAddress,
    AudioObjectSetPropertyData,
};
use objc2_core_foundation::{CFRetained, CFString};
use quill_core::caps::Ducker;
use quill_core::paths;

#[path = "../duck_shared.rs"]
mod shared;

use shared::{DuckCore, OutputVolume};

pub fn create() -> Arc<dyn Ducker> {
    Arc::new(DuckCore::new(CoreAudioOutput, paths::duck_state_file()))
}

const SYSTEM: AudioObjectID = kAudioObjectSystemObject as AudioObjectID;
/// Channels looked at when a device has no main volume.
const CHANNELS: std::ops::RangeInclusive<u32> = 1..=8;

fn global(selector: u32) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress {
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
    }
}

fn volume_address(element: u32) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress {
        mSelector: kAudioDevicePropertyVolumeScalar,
        mScope: kAudioObjectPropertyScopeOutput,
        mElement: element,
    }
}

/// Reads one fixed-size property into `value`. False when the HAL refused or
/// answered with a different size.
fn get<T>(object: AudioObjectID, address: AudioObjectPropertyAddress, value: &mut T) -> bool {
    let mut address = address;
    let mut size = std::mem::size_of::<T>() as u32;
    // SAFETY: `address` and `size` are live locals, and `value` is a buffer of
    // exactly `size` bytes that the HAL fills with a plain-data property.
    let status = unsafe {
        AudioObjectGetPropertyData(
            object,
            NonNull::from(&mut address),
            0,
            null(),
            NonNull::from(&mut size),
            NonNull::from(value).cast::<c_void>(),
        )
    };
    status == 0 && size as usize == std::mem::size_of::<T>()
}

fn has_volume(device: AudioDeviceID, element: u32) -> bool {
    let mut address = volume_address(element);
    // SAFETY: `address` is a live local.
    unsafe { AudioObjectHasProperty(device, NonNull::from(&mut address)) }
}

fn all_devices() -> Vec<AudioDeviceID> {
    let mut address = global(kAudioHardwarePropertyDevices);
    let mut size = 0u32;
    // SAFETY: `address` and `size` are live locals.
    let status = unsafe {
        AudioObjectGetPropertyDataSize(SYSTEM, NonNull::from(&mut address), 0, null(), NonNull::from(&mut size))
    };
    let count = size as usize / std::mem::size_of::<AudioDeviceID>();
    if status != 0 || count == 0 {
        return Vec::new();
    }
    let mut ids: Vec<AudioDeviceID> = vec![0; count];
    let mut size = (count * std::mem::size_of::<AudioDeviceID>()) as u32;
    // SAFETY: `ids` holds `size` bytes; the HAL writes at most that many and
    // sets `size` to what it wrote (the list can shrink between the two calls).
    let status = unsafe {
        AudioObjectGetPropertyData(
            SYSTEM,
            NonNull::from(&mut address),
            0,
            null(),
            NonNull::from(&mut size),
            NonNull::new_unchecked(ids.as_mut_ptr()).cast::<c_void>(),
        )
    };
    if status != 0 {
        return Vec::new();
    }
    ids.truncate(size as usize / std::mem::size_of::<AudioDeviceID>());
    ids
}

struct CoreAudioOutput;

impl OutputVolume for CoreAudioOutput {
    type Device = AudioDeviceID;

    fn default_output(&self) -> Option<AudioDeviceID> {
        let mut id: AudioDeviceID = 0;
        (get(SYSTEM, global(kAudioHardwarePropertyDefaultOutputDevice), &mut id) && id != 0).then_some(id)
    }

    fn uid(&self, device: AudioDeviceID) -> Option<String> {
        let mut value: *const CFString = null();
        if !get(device, global(kAudioDevicePropertyDeviceUID), &mut value) {
            return None;
        }
        // SAFETY: the HAL hands back a CFString the caller owns (+1), or null.
        let uid = unsafe { CFRetained::from_raw(NonNull::new(value.cast_mut())?) };
        Some(uid.to_string())
    }

    fn find(&self, uid: &str) -> Option<AudioDeviceID> {
        all_devices().into_iter().find(|&device| self.uid(device).as_deref() == Some(uid))
    }

    /// The main volume when the device has one, otherwise each channel.
    /// Bluetooth headsets only expose per-channel volume, and ducking just
    /// the first of them leaves one ear quiet.
    fn controls(&self, device: AudioDeviceID) -> Vec<u32> {
        if has_volume(device, kAudioObjectPropertyElementMain) {
            return vec![kAudioObjectPropertyElementMain];
        }
        CHANNELS.filter(|&channel| has_volume(device, channel)).collect()
    }

    fn volume(&self, device: AudioDeviceID, control: u32) -> Option<f32> {
        let mut value = 0f32;
        get(device, volume_address(control), &mut value).then_some(value)
    }

    fn set_volume(&self, device: AudioDeviceID, control: u32, value: f32) -> bool {
        let mut address = volume_address(control);
        let mut value = value;
        // SAFETY: `address` and `value` are live locals; the property is one f32.
        let status = unsafe {
            AudioObjectSetPropertyData(
                device,
                NonNull::from(&mut address),
                0,
                null(),
                std::mem::size_of::<f32>() as u32,
                NonNull::from(&mut value).cast::<c_void>(),
            )
        };
        status == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reads only: the user's volume is not written by any unit test.
    #[test]
    fn the_default_output_is_found_again_by_its_uid() {
        let out = CoreAudioOutput;
        // A Mac with no output device at all (a CI runner) has nothing to check.
        let Some(device) = out.default_output() else { return };
        let uid = out.uid(device).expect("an output device has a uid");
        assert!(!uid.is_empty());
        assert_eq!(out.find(&uid), Some(device));
        assert_eq!(out.find("quill-test-no-such-device"), None);
        for control in out.controls(device) {
            let value = out.volume(device, control).expect("a listed control can be read");
            assert!((0.0..=1.0).contains(&value), "control {control} reads {value}");
        }
    }

    /// For checking recovery by hand without changing the volume: prints a
    /// duck state file that "restores" the default output to what it is now.
    /// `cargo test --bin flow-stt print_a_state_file -- --ignored --nocapture`
    #[test]
    #[ignore = "prints, checks nothing"]
    fn print_a_state_file_for_the_current_output() {
        let out = CoreAudioOutput;
        let Some(device) = out.default_output() else { return };
        let volumes = out.controls(device).into_iter().filter_map(|c| Some((c, out.volume(device, c)?))).collect();
        let now = shared::Ducked { uid: out.uid(device).unwrap_or_default(), volumes };
        println!("STATE {}", shared::encode_state(&[now]));
    }

    #[test]
    fn every_device_has_a_uid() {
        let out = CoreAudioOutput;
        for device in all_devices() {
            assert!(out.uid(device).is_some_and(|uid| !uid.is_empty()));
        }
    }
}

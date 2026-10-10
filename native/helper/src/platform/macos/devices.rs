//! Capability `devices` (the hot-plug half) on macOS: CoreAudio property
//! listeners on the system object, for the device list and the default input.
//! The same two properties the Swift helper watches. One plug fires several
//! notifications; the session debounces them into one `devices` event.

use std::ffi::c_void;
use std::ptr::NonNull;

use objc2_core_audio::{
    kAudioHardwarePropertyDefaultInputDevice, kAudioHardwarePropertyDevices, kAudioObjectPropertyElementMain,
    kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject, AudioObjectAddPropertyListener, AudioObjectID,
    AudioObjectPropertyAddress,
};
use quill_core::bus::Bus;
use quill_core::caps::DeviceWatcher;
use quill_core::logln;

pub fn create(bus: &Bus) -> Box<dyn DeviceWatcher> {
    Box::new(CoreAudioWatcher { bus: bus.clone(), started: false })
}

struct CoreAudioWatcher {
    bus: Bus,
    started: bool,
}

/// Called by CoreAudio on one of its own threads.
unsafe extern "C-unwind" fn changed(
    _object: AudioObjectID,
    _count: u32,
    _addresses: NonNull<AudioObjectPropertyAddress>,
    client: *mut c_void,
) -> i32 {
    // SAFETY: `client` is the `Bus` leaked in `start`, which lives as long as
    // the process, and `Bus::send` may be called from any thread.
    if let Some(bus) = unsafe { client.cast::<Bus>().as_ref() } {
        bus.devices_changed();
    }
    0
}

impl DeviceWatcher for CoreAudioWatcher {
    fn start(&mut self) {
        if std::mem::replace(&mut self.started, true) {
            return;
        }
        // The listeners stay for the life of the process, so the bus they
        // post to is never freed.
        let client: *mut Bus = Box::into_raw(Box::new(self.bus.clone()));
        for (selector, what) in
            [(kAudioHardwarePropertyDevices, "device list"), (kAudioHardwarePropertyDefaultInputDevice, "default input")]
        {
            let address = AudioObjectPropertyAddress {
                mSelector: selector,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain,
            };
            // SAFETY: the address is valid for the call (CoreAudio copies it),
            // the callback matches the listener signature, and `client`
            // outlives the registration.
            let status = unsafe {
                AudioObjectAddPropertyListener(
                    kAudioObjectSystemObject as AudioObjectID,
                    NonNull::from(&address),
                    Some(changed),
                    client.cast(),
                )
            };
            if status != 0 {
                logln!("devices: could not watch the {what} (CoreAudio status {status})");
            }
        }
    }
}

//! Capability `devices` (the hot-plug half) on Windows: an
//! `IMMNotificationClient` on the audio endpoint enumerator, which Windows
//! calls the moment a device is plugged in, removed, enabled, disabled, or
//! the default input or output moves. One plug fires several notifications;
//! the session debounces them into one `devices` event.
//!
//! Output devices are reported too: the session uses the same signal to put
//! back the volume of headphones that dropped out while ducked.
//!
//! If the registration fails, the list is polled every two seconds instead
//! (`PollingWatcher`).
//!
//! Compiles, but has not been run on Windows yet.

use quill_core::bus::Bus;
use quill_core::caps::DeviceWatcher;
use quill_core::logln;
use windows::core::{implement, PCWSTR};
use windows::Win32::Foundation::PROPERTYKEY;
use windows::Win32::Media::Audio::{
    EDataFlow, ERole, IMMNotificationClient, IMMNotificationClient_Impl, DEVICE_STATE,
};

use super::com;
use crate::audio_shared::PollingWatcher;

pub fn create(bus: &Bus) -> Box<dyn DeviceWatcher> {
    Box::new(EndpointWatcher { bus: bus.clone(), started: false })
}

/// Called by Windows on threads of its own.
#[implement(IMMNotificationClient)]
struct Client {
    bus: Bus,
}

impl IMMNotificationClient_Impl for Client_Impl {
    fn OnDeviceStateChanged(&self, _id: &PCWSTR, _state: DEVICE_STATE) -> windows::core::Result<()> {
        self.bus.devices_changed();
        Ok(())
    }

    fn OnDeviceAdded(&self, _id: &PCWSTR) -> windows::core::Result<()> {
        self.bus.devices_changed();
        Ok(())
    }

    fn OnDeviceRemoved(&self, _id: &PCWSTR) -> windows::core::Result<()> {
        self.bus.devices_changed();
        Ok(())
    }

    fn OnDefaultDeviceChanged(&self, _flow: EDataFlow, _role: ERole, _id: &PCWSTR) -> windows::core::Result<()> {
        self.bus.devices_changed();
        Ok(())
    }

    /// Fires for every property of every endpoint (formats, volumes of some
    /// drivers), many times a second while a device settles. Nothing in the
    /// `devices` event depends on it except a renamed device, which the next
    /// real change picks up.
    fn OnPropertyValueChanged(&self, _id: &PCWSTR, _key: &PROPERTYKEY) -> windows::core::Result<()> {
        Ok(())
    }
}

/// Registers the client and then keeps the enumerator alive: the
/// registration lasts as long as the enumerator it was made on.
fn watch(bus: Bus) -> windows::core::Result<()> {
    let enumerator = com::device_enumerator()?;
    let client: IMMNotificationClient = Client { bus }.into();
    // SAFETY: a plain COM call; the enumerator takes its own reference to the client.
    unsafe { enumerator.RegisterEndpointNotificationCallback(&client)? };
    logln!("devices: watching audio endpoints");
    loop {
        // Never unregistered: the watcher lives as long as the process.
        std::thread::park();
    }
}

struct EndpointWatcher {
    bus: Bus,
    started: bool,
}

impl DeviceWatcher for EndpointWatcher {
    fn start(&mut self) {
        if std::mem::replace(&mut self.started, true) {
            return;
        }
        let bus = self.bus.clone();
        let spawned = std::thread::Builder::new().name("device-watch".to_string()).spawn(move || {
            if let Err(error) = watch(bus.clone()) {
                logln!("devices: no endpoint notifications ({error}), polling instead");
                PollingWatcher::new(&bus).start();
            }
        });
        if let Err(error) = spawned {
            logln!("devices: could not start the watcher ({error})");
        }
    }
}

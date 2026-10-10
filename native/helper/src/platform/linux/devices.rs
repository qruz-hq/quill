//! Capability `devices` (the hot-plug half): tell the session when inputs change.
//!
//! cpal has no "device list changed" notification on any OS, so each one
//! brings its own. Here it is a subscription on the sound server (PulseAudio
//! or PipeWire, `pulse.rs`): a microphone or a headset coming or going, or
//! the default input moving, is reported the moment the server knows. One
//! plug fires several events; the session debounces them into one `devices`.
//!
//! Without such a server (plain ALSA), or if the subscription ends (the
//! server was restarted), the watcher falls back to looking at the list every
//! two seconds, which is `PollingWatcher` in `audio_shared.rs`.

use quill_core::bus::Bus;
use quill_core::caps::DeviceWatcher;
use quill_core::logln;

use crate::audio_shared::PollingWatcher;

use super::pulse::{self, Pulse, PulseFailure};

pub fn create(bus: &Bus) -> Box<dyn DeviceWatcher> {
    Box::new(SoundServerWatcher { bus: bus.clone(), started: false })
}

struct SoundServerWatcher {
    bus: Bus,
    started: bool,
}

/// Reports changes until the connection ends, which is the only way out.
fn watch(mut pulse: Pulse, bus: &Bus) -> PulseFailure {
    loop {
        match pulse.next_event() {
            Ok(event) if pulse::is_device_change(&event) => bus.devices_changed(),
            Ok(_) => {}
            Err(error) => return error,
        }
    }
}

/// Connects without a read deadline: between two plugs there may be days.
fn subscribe() -> Result<Pulse, PulseFailure> {
    let mut pulse = Pulse::connect(c"Quill devices", None)?;
    pulse.subscribe()?;
    Ok(pulse)
}

impl DeviceWatcher for SoundServerWatcher {
    fn start(&mut self) {
        if std::mem::replace(&mut self.started, true) {
            return;
        }
        let bus = self.bus.clone();
        let spawned = std::thread::Builder::new().name("device-watch".to_string()).spawn(move || {
            let why = match subscribe() {
                Ok(pulse) => {
                    logln!("devices: watching the sound server");
                    let why = watch(pulse, &bus);
                    // Whatever ended it may have changed the list as well.
                    bus.devices_changed();
                    why
                }
                Err(error) => error,
            };
            logln!("devices: no sound server subscription ({why}), polling the list instead");
            PollingWatcher::new(&bus).start();
        });
        if let Err(error) = spawned {
            logln!("devices: could not start the watcher ({error})");
        }
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::net::UnixStream;
    use std::time::Duration;

    use pulseaudio::protocol::{
        self, Command, SubscriptionEvent, SubscriptionEventFacility as Facility, SubscriptionEventType as Kind,
    };
    use quill_core::bus::Msg;

    use super::*;

    #[test]
    fn plugs_are_reported_and_volume_changes_are_not() {
        let (ours, mut theirs) = UnixStream::pair().unwrap();
        let pulse = Pulse::over(ours, Some(Duration::from_secs(5))).unwrap();
        let (bus, rx) = Bus::new();
        for (event_facility, event_type) in [
            (Facility::Source, Kind::Changed),
            (Facility::Card, Kind::New),
            (Facility::Source, Kind::New),
            (Facility::SinkInput, Kind::New),
            (Facility::Server, Kind::Changed),
            (Facility::Sink, Kind::Changed),
            (Facility::Source, Kind::Removed),
        ] {
            let event = SubscriptionEvent { event_facility, event_type, index: Some(1) };
            protocol::write_command_message(&mut theirs, u32::MAX, &Command::SubscribeEvent(event), protocol::MAX_VERSION).unwrap();
        }
        // The server goes away: `watch` returns instead of spinning.
        drop(theirs);
        let why = watch(pulse, &bus);
        assert!(matches!(why, PulseFailure::Broken(_)));
        let mut changes = 0;
        while let Ok(msg) = rx.try_recv() {
            assert!(matches!(msg, Msg::DevicesChanged));
            changes += 1;
        }
        assert_eq!(changes, 4);
    }
}

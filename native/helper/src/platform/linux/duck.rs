//! Capability `duck` on Linux: lower the output volume while recording, and
//! always put it back (section 7).
//!
//! The volume of the default sink, per channel, on PulseAudio or PipeWire
//! (`pulse.rs` says why that client). The rules (what to save, when to
//! restore, the duck state file that survives a crash) are in
//! `duck_shared.rs`, the same code macOS runs; this file is the handful of
//! requests underneath them.
//!
//! - A sink is remembered by its name (`alsa_output.pci-0000_00_1f.3.analog-stereo`,
//!   `bluez_output.AA_BB_CC.1`), which survives a replug; its index does not.
//! - A control is a channel. Each keeps its own value, so a balance the user
//!   set is still there afterwards.
//! - The scale is the one the desktop's slider shows: 0.5 is 50 %. A sink
//!   boosted past 100 % is restored exactly by this process; after a crash
//!   the state file brings it back to 100 %, never above.
//!
//! On a machine with neither server (plain ALSA) there is no single "output
//! volume" to lower, so the capability is left out of the handshake.

use std::sync::{Arc, Mutex, MutexGuard};

use quill_core::caps::Ducker;
use quill_core::logln;
use quill_core::paths;
use quill_core::unsupported::NoDucker;

use super::pulse::{self, Pulse, PulseFailure, REQUEST_TIMEOUT};

#[path = "../duck_shared.rs"]
mod shared;

use shared::{DuckCore, OutputVolume};

const NOTE_NO_SERVER: &str = "no PulseAudio or PipeWire sound server: the output volume cannot be changed";

pub fn create() -> Arc<dyn Ducker> {
    if pulse::find_socket().is_none() {
        logln!("duck: {NOTE_NO_SERVER}");
        return Arc::new(Unavailable);
    }
    Arc::new(DuckCore::new(PulseOutput::new(|| Pulse::connect(c"Quill", Some(REQUEST_TIMEOUT))), paths::duck_state_file()))
}

/// No sound server to ask. Behaves as the stand-in, and says why.
struct Unavailable;

impl Ducker for Unavailable {
    fn supported(&self) -> bool {
        NoDucker.supported()
    }
    fn recover(&self) {}
    fn duck(&self, _level: f32) {}
    fn restore(&self) {}
    fn retry_orphans(&self) {}
    fn note(&self) -> Option<String> {
        Some(NOTE_NO_SERVER.to_string())
    }
}

type Connect = Box<dyn Fn() -> Result<Pulse, PulseFailure> + Send + Sync>;

/// The default sink's volume. One connection, opened on first use and opened
/// again if the server went away in between (PipeWire restarts on an update).
struct PulseOutput {
    connect: Connect,
    connection: Mutex<Option<Pulse>>,
}

impl PulseOutput {
    fn new(connect: impl Fn() -> Result<Pulse, PulseFailure> + Send + Sync + 'static) -> Self {
        Self { connect: Box::new(connect), connection: Mutex::new(None) }
    }

    fn lock(&self) -> MutexGuard<'_, Option<Pulse>> {
        // Used from the exit path as well, which must get through.
        self.connection.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Runs one exchange with the server. `None` when the server refused
    /// (no such sink) or could not be reached, after one fresh connection
    /// has been tried: a connection that sat idle for an hour may be dead.
    fn ask<T>(&self, exchange: impl Fn(&mut Pulse) -> Result<T, PulseFailure>) -> Option<T> {
        let mut slot = self.lock();
        for attempt in 0..2 {
            if slot.is_none() {
                match (self.connect)() {
                    Ok(pulse) => *slot = Some(pulse),
                    Err(error) => {
                        logln!("duck: cannot reach the sound server ({error})");
                        return None;
                    }
                }
            }
            let pulse = slot.as_mut()?;
            match exchange(pulse) {
                Ok(value) => return Some(value),
                Err(PulseFailure::Refused(_)) => return None,
                Err(PulseFailure::Broken(error)) => {
                    *slot = None;
                    if attempt == 1 {
                        logln!("duck: the sound server did not answer ({error})");
                    }
                }
            }
        }
        None
    }
}

impl OutputVolume for PulseOutput {
    /// A sink's index: good for the length of one call, like every handle here.
    type Device = u32;

    fn default_output(&self) -> Option<u32> {
        self.ask(|pulse| pulse.default_sink()).map(|sink| sink.index)
    }

    fn uid(&self, device: u32) -> Option<String> {
        let sink = self.ask(|pulse| pulse.sink(device))?;
        sink.name.into_string().ok().filter(|name| !name.is_empty())
    }

    fn find(&self, uid: &str) -> Option<u32> {
        self.ask(|pulse| pulse.sink_named(uid)).map(|sink| sink.index)
    }

    fn controls(&self, device: u32) -> Vec<u32> {
        let channels = self.ask(|pulse| pulse.sink(device)).map_or(0, |sink| sink.cvolume.channels().len());
        (0..channels as u32).collect()
    }

    fn volume(&self, device: u32, control: u32) -> Option<f32> {
        let sink = self.ask(|pulse| pulse.sink(device))?;
        sink.cvolume.channels().get(control as usize).map(|&volume| pulse::to_scalar(volume))
    }

    fn set_volume(&self, device: u32, control: u32, value: f32) -> bool {
        // The server takes all channels at once, so the others are read back
        // and sent along unchanged.
        self.ask(|pulse| {
            let sink = pulse.sink(device)?;
            match pulse::with_channel(&sink.cvolume, control, value) {
                Some(volume) => pulse.set_sink_volume(device, volume).map(|()| true),
                None => Ok(false),
            }
        })
        .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::net::UnixStream;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use super::super::pulse::testing::{rig, serve, SharedRig};
    use super::*;

    /// An output whose every connection is a new socket pair to `rig`.
    fn output(rig: &SharedRig) -> (PulseOutput, Arc<AtomicUsize>) {
        let connections = Arc::new(AtomicUsize::new(0));
        let (rig, count) = (rig.clone(), connections.clone());
        let out = PulseOutput::new(move || {
            count.fetch_add(1, Ordering::Relaxed);
            let (ours, theirs) = UnixStream::pair()?;
            let rig = rig.clone();
            std::thread::spawn(move || serve(theirs, rig));
            let mut pulse = Pulse::over(ours, Some(Duration::from_secs(5)))?;
            pulse.handshake(c"quill-test", Vec::new())?;
            Ok(pulse)
        });
        (out, connections)
    }

    fn state_file(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("quill-duck-linux-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("Quill-duck.json")
    }

    fn raw(rig: &SharedRig, index: u32) -> Vec<u32> {
        rig.lock().unwrap().sinks[&index].1.clone()
    }

    #[test]
    fn the_default_sink_is_found_again_by_its_name() {
        let rig = rig(&[(4, "speakers", &[65536, 65536]), (9, "bluez_output.headset", &[32768, 16384])], Some("bluez_output.headset"));
        let (out, connections) = output(&rig);
        let device = out.default_output().unwrap();
        assert_eq!(device, 9);
        assert_eq!(out.uid(device).as_deref(), Some("bluez_output.headset"));
        assert_eq!(out.find("bluez_output.headset"), Some(9));
        assert_eq!(out.find("gone"), None);
        assert_eq!(out.controls(device), vec![0, 1]);
        assert_eq!(out.volume(device, 0), Some(0.5));
        assert_eq!(out.volume(device, 1), Some(0.25));
        assert_eq!(out.volume(device, 2), None);
        assert_eq!(connections.load(Ordering::Relaxed), 1, "one connection serves every call");
    }

    #[test]
    fn one_channel_is_written_without_touching_the_other() {
        let rig = rig(&[(4, "speakers", &[65536, 32768])], Some("speakers"));
        let (out, _) = output(&rig);
        assert!(out.set_volume(4, 1, 0.25));
        assert_eq!(raw(&rig, 4), vec![65536, 16384]);
        assert!(!out.set_volume(4, 5, 0.25), "no such channel");
        assert!(!out.set_volume(77, 0, 0.25), "no such sink");
        assert_eq!(raw(&rig, 4), vec![65536, 16384]);
    }

    #[test]
    fn a_machine_without_a_default_sink_has_nothing_to_duck() {
        let rig = rig(&[], None);
        let (out, _) = output(&rig);
        assert_eq!(out.default_output(), None);
        assert!(out.controls(3).is_empty());
    }

    #[test]
    fn a_dead_connection_is_replaced_once() {
        let rig = rig(&[(4, "speakers", &[65536])], Some("speakers"));
        let (out, connections) = output(&rig);
        assert_eq!(out.default_output(), Some(4));
        // The server restarts: the socket this side holds is closed under it.
        if let Some(pulse) = out.lock().as_mut() {
            pulse.hang_up();
        }
        assert_eq!(out.default_output(), Some(4));
        assert_eq!(connections.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn an_unreachable_server_is_a_quiet_no() {
        let out = PulseOutput::new(|| Err(PulseFailure::Broken("nobody home".to_string())));
        assert_eq!(out.default_output(), None);
        assert_eq!(out.find("speakers"), None);
        assert!(!out.set_volume(1, 0, 0.5));
    }

    #[test]
    fn ducking_lowers_every_channel_and_restore_puts_each_back() {
        let rig = rig(&[(4, "speakers", &[52429, 39322])], Some("speakers"));
        let (out, _) = output(&rig);
        let duck = DuckCore::new(out, state_file("round-trip"));
        duck.duck(0.5);
        assert_eq!(raw(&rig, 4), vec![26215, 19661]);
        // Already ducked: a second start does not halve it again.
        duck.duck(0.5);
        assert_eq!(raw(&rig, 4), vec![26215, 19661]);
        duck.restore();
        assert_eq!(raw(&rig, 4), vec![52429, 39322], "back to the exact raw values, balance kept");
        let writes = rig.lock().unwrap().writes;
        duck.restore();
        assert_eq!(rig.lock().unwrap().writes, writes, "nothing ducked, nothing written");
    }

    #[test]
    fn with_nothing_ducked_the_server_is_never_asked() {
        let rig = rig(&[(4, "speakers", &[65536])], Some("speakers"));
        let (out, connections) = output(&rig);
        let duck = DuckCore::new(out, state_file("untouched"));
        duck.recover();
        duck.restore();
        duck.retry_orphans();
        assert_eq!(connections.load(Ordering::Relaxed), 0);
        assert_eq!(rig.lock().unwrap().requests, 0);
    }

    #[test]
    fn a_duck_left_by_a_run_that_died_is_undone_at_the_next_boot() {
        let rig = rig(&[(4, "speakers", &[65536, 65536])], Some("speakers"));
        let file = state_file("crash");
        {
            let (out, _) = output(&rig);
            let first = DuckCore::new(out, file.clone());
            first.duck(0.15);
            assert_eq!(raw(&rig, 4), vec![9830, 9830]);
            assert!(file.exists());
            // Killed here: no restore runs.
        }
        let (out, _) = output(&rig);
        let second = DuckCore::new(out, file.clone());
        second.recover();
        assert_eq!(raw(&rig, 4), vec![65536, 65536]);
        assert!(!file.exists());
    }

    #[test]
    fn a_headset_that_dropped_out_gets_its_volume_back_when_it_returns() {
        let rig = rig(&[(4, "speakers", &[65536]), (9, "bluez_output.headset", &[45875, 45875])], Some("bluez_output.headset"));
        let file = state_file("orphan");
        let (out, _) = output(&rig);
        let duck = DuckCore::new(out, file.clone());
        duck.duck(0.2);
        assert_eq!(raw(&rig, 9), vec![9175, 9175]);
        // It disconnects mid-recording; the server falls back to the speakers.
        let gone = {
            let mut rig = rig.lock().unwrap();
            rig.default = Some("speakers".to_string());
            rig.sinks.remove(&9).unwrap()
        };
        duck.restore();
        assert_eq!(raw(&rig, 4), vec![65536], "the speakers were never ducked and are not touched");
        assert!(file.exists(), "the headset's volume is still owed");
        // It reconnects under a new index, still quiet, with the same name.
        rig.lock().unwrap().sinks.insert(12, gone);
        duck.retry_orphans();
        assert_eq!(raw(&rig, 12), vec![45875, 45875]);
        assert!(!file.exists());
    }

    #[test]
    fn a_silent_sink_is_left_alone() {
        let rig = rig(&[(4, "speakers", &[0, 0])], Some("speakers"));
        let (out, _) = output(&rig);
        let file = state_file("silent");
        let duck = DuckCore::new(out, file.clone());
        duck.duck(0.15);
        assert_eq!(rig.lock().unwrap().writes, 0);
        assert!(!file.exists());
    }

    #[test]
    fn the_stand_in_says_why() {
        let none = Unavailable;
        assert!(!none.supported());
        assert!(none.note().unwrap().contains("PipeWire"));
        none.duck(0.5);
        none.restore();
    }
}

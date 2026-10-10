//! Output ducking, the part that is the same on every OS (section 7).
//!
//! What to lower, what to remember, when to put it back, and the duck state
//! file that lets the next launch undo a duck this process did not live to
//! undo. An OS backend only supplies [`OutputVolume`]: find the default output,
//! name it, list its volume controls, read one, write one.
//!
//! Not declared in `platform/mod.rs`: each OS's `duck.rs` pulls it in with
//! `#[path = "../duck_shared.rs"] mod shared;`.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

use quill_core::caps::Ducker;
use quill_core::logln;
use serde::ser::{SerializeMap, SerializeSeq};
use serde::{Serialize, Serializer};
use serde_json::Value;

/// At or below this the output counts as silent and is left alone.
const SILENT: f32 = 0.001;

/// The output volume of this OS. `Device` is whatever handle the OS uses; it is
/// only ever held for the length of one call, a device is remembered by `uid`.
pub trait OutputVolume: Send + Sync {
    type Device: Copy;

    /// The device sound is playing through now.
    fn default_output(&self) -> Option<Self::Device>;
    /// A name for the device that survives it being unplugged and replugged.
    fn uid(&self, device: Self::Device) -> Option<String>;
    /// The connected device with that uid, if it is connected.
    fn find(&self, uid: &str) -> Option<Self::Device>;
    /// Every volume control the device has. On CoreAudio: element 0 when the
    /// device has a main volume, else each channel that has one.
    fn controls(&self, device: Self::Device) -> Vec<u32>;
    /// 0 to 1.
    fn volume(&self, device: Self::Device, control: u32) -> Option<f32>;
    fn set_volume(&self, device: Self::Device, control: u32, value: f32) -> bool;
}

/// What was changed, so that it is put back on the same device even if the
/// default output moves while ducked (a headset switching profile does).
#[derive(Debug, Clone, PartialEq)]
pub struct Ducked {
    pub uid: String,
    /// Control to the volume it had before the duck.
    pub volumes: BTreeMap<u32, f32>,
}

impl Ducked {
    fn loudest(&self) -> Option<f32> {
        self.volumes.values().copied().reduce(f32::max)
    }
}

/// `volumes` the way Swift's JSONEncoder writes a `[UInt32: Float]`: one flat
/// array, `[control, value, control, value, ...]`.
struct FlatVolumes<'a>(&'a BTreeMap<u32, f32>);

impl Serialize for FlatVolumes<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut seq = serializer.serialize_seq(Some(self.0.len() * 2))?;
        for (control, value) in self.0 {
            seq.serialize_element(control)?;
            // As an f32, so 0.15 is written "0.15" and reads back bit for bit.
            seq.serialize_element(value)?;
        }
        seq.end()
    }
}

impl Serialize for Ducked {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(2))?;
        map.serialize_entry("uid", &self.uid)?;
        map.serialize_entry("volumes", &FlatVolumes(&self.volumes))?;
        map.end()
    }
}

/// The duck state file's text: a JSON array of `{uid, volumes}` (section 10).
pub fn encode_state(all: &[Ducked]) -> String {
    serde_json::to_string(all).unwrap_or_else(|_| "[]".to_string())
}

/// Reads a duck state file written by this helper or by the Swift one. Older
/// Swift builds wrote one bare object instead of a list. Anything that cannot
/// be read is dropped: a volume is never set from a guess.
pub fn decode_state(text: &str) -> Vec<Ducked> {
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Array(items)) => items.iter().filter_map(decode_one).collect(),
        Ok(one @ Value::Object(_)) => decode_one(&one).into_iter().collect(),
        _ => Vec::new(),
    }
}

fn decode_one(value: &Value) -> Option<Ducked> {
    let uid = value.get("uid")?.as_str()?.to_string();
    let mut volumes = BTreeMap::new();
    match value.get("volumes")? {
        Value::Array(flat) => {
            if flat.len() % 2 != 0 {
                return None;
            }
            for pair in flat.chunks(2) {
                volumes.insert(control(&pair[0])?, level(&pair[1])?);
            }
        }
        // Not written by any build, but it is what a map would look like
        // had its keys been strings.
        Value::Object(map) => {
            for (key, value) in map {
                volumes.insert(key.parse().ok()?, level(value)?);
            }
        }
        _ => return None,
    }
    Some(Ducked { uid, volumes })
}

fn control(value: &Value) -> Option<u32> {
    u32::try_from(value.as_u64()?).ok()
}

fn level(value: &Value) -> Option<f32> {
    let v = value.as_f64()? as f32;
    v.is_finite().then(|| v.clamp(0.0, 1.0))
}

#[derive(Default)]
struct State {
    ducked: Option<Ducked>,
    /// Ducks whose device was gone when it was time to restore (headphones
    /// that dropped out mid-recording). Kept, in memory and on disk, and put
    /// back when the device returns, so it does not come back quiet.
    orphans: Vec<Ducked>,
}

/// The [`Ducker`] of every OS, over that OS's [`OutputVolume`].
pub struct DuckCore<O: OutputVolume> {
    out: O,
    file: PathBuf,
    state: Mutex<State>,
}

impl<O: OutputVolume> DuckCore<O> {
    /// `file` is the duck state file (`paths::duck_state_file()`).
    pub fn new(out: O, file: PathBuf) -> Self {
        Self { out, file, state: Mutex::new(State::default()) }
    }

    /// Every exit path ends in `restore`, including the one a panic takes, so
    /// a poisoned lock is still used: the saved volumes in it are intact.
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Everything not yet restored, kept on disk. If the helper dies first,
    /// the next launch reads it and puts the volume back.
    fn persist(&self, state: &State) {
        let all: Vec<Ducked> = state.orphans.iter().chain(state.ducked.iter()).cloned().collect();
        if all.is_empty() {
            let _ = std::fs::remove_file(&self.file);
            return;
        }
        if let Some(dir) = self.file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // Whole or not at all: a half-written file would lose the volumes.
        let scratch = self.file.with_extension(format!("json.{}.tmp", std::process::id()));
        let written = std::fs::write(&scratch, encode_state(&all)).and_then(|()| std::fs::rename(&scratch, &self.file));
        if let Err(error) = written {
            let _ = std::fs::remove_file(&scratch);
            logln!("duck: could not save the volume to restore ({error})");
        }
    }

    /// False when the device is not connected, so nothing could be put back.
    fn apply(&self, saved: &Ducked) -> bool {
        let Some(device) = self.out.find(&saved.uid) else { return false };
        for (&control, &value) in &saved.volumes {
            self.out.set_volume(device, control, value);
        }
        if let Some(loudest) = saved.loudest() {
            logln!("restored output to {:.0}%", loudest * 100.0);
        }
        true
    }
}

impl<O: OutputVolume> Ducker for DuckCore<O> {
    fn supported(&self) -> bool {
        true
    }

    fn recover(&self) {
        let Ok(text) = std::fs::read_to_string(&self.file) else { return };
        let saved = decode_state(&text);
        if !saved.is_empty() {
            logln!("restoring output volume left ducked by a previous run");
        }
        let mut state = self.lock();
        for one in saved {
            if !self.apply(&one) {
                state.orphans.retain(|o| o.uid != one.uid);
                state.orphans.push(one);
            }
        }
        self.persist(&state);
    }

    fn duck(&self, level: f32) {
        let mut state = self.lock();
        if state.ducked.is_some() {
            return;
        }
        let Some(device) = self.out.default_output() else { return };
        let Some(uid) = self.out.uid(device) else { return };
        let mut volumes = BTreeMap::new();
        for control in self.out.controls(device) {
            if let Some(value) = self.out.volume(device, control).filter(|v| v.is_finite()) {
                volumes.insert(control, value);
            }
        }
        let saved = Ducked { uid, volumes };
        // Nothing audible playing, nothing to duck.
        let Some(loudest) = saved.loudest().filter(|&l| l > SILENT) else { return };
        let level = if level.is_finite() { level.clamp(0.0, 1.0) } else { return };

        // On disk before the first control moves: a kill between the two
        // leaves a file that restores the volume to what it already is.
        state.ducked = Some(saved.clone());
        self.persist(&state);
        for (&control, &value) in &saved.volumes {
            self.out.set_volume(device, control, value * level);
        }
        logln!(
            "ducked output {:.0}% -> {:.0}% on {} control(s)",
            loudest * 100.0,
            loudest * level * 100.0,
            saved.volumes.len()
        );
    }

    fn restore(&self) {
        let mut state = self.lock();
        let Some(saved) = state.ducked.take() else { return };
        if !self.apply(&saved) {
            logln!("ducked device is gone, will restore its volume when it returns");
            state.orphans.retain(|o| o.uid != saved.uid);
            state.orphans.push(saved);
        }
        self.persist(&state);
    }

    fn retry_orphans(&self) {
        let mut state = self.lock();
        if state.orphans.is_empty() {
            return;
        }
        let orphans = std::mem::take(&mut state.orphans);
        state.orphans = orphans.into_iter().filter(|o| !self.apply(o)).collect();
        self.persist(&state);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// A machine with named outputs, each with its own controls.
    #[derive(Default)]
    struct Rig {
        devices: Vec<(String, BTreeMap<u32, f32>)>,
        connected: Vec<bool>,
        default: Option<usize>,
        reads: usize,
        writes: Vec<(String, u32, f32)>,
    }

    #[derive(Clone, Default)]
    struct FakeOut(Arc<Mutex<Rig>>);

    impl FakeOut {
        fn add(&self, uid: &str, controls: &[(u32, f32)]) -> usize {
            let mut rig = self.0.lock().unwrap();
            rig.devices.push((uid.to_string(), controls.iter().copied().collect()));
            rig.connected.push(true);
            if rig.default.is_none() {
                rig.default = Some(0);
            }
            rig.devices.len() - 1
        }
        fn unplug(&self, index: usize) {
            let mut rig = self.0.lock().unwrap();
            rig.connected[index] = false;
            if rig.default == Some(index) {
                rig.default = rig.connected.iter().position(|c| *c);
            }
        }
        fn plug(&self, index: usize) {
            self.0.lock().unwrap().connected[index] = true;
        }
        fn make_default(&self, index: usize) {
            self.0.lock().unwrap().default = Some(index);
        }
        fn set(&self, index: usize, control: u32, value: f32) {
            self.0.lock().unwrap().devices[index].1.insert(control, value);
        }
        fn get(&self, index: usize, control: u32) -> f32 {
            self.0.lock().unwrap().devices[index].1[&control]
        }
        fn touched(&self) -> usize {
            let rig = self.0.lock().unwrap();
            rig.reads + rig.writes.len()
        }
        fn writes(&self) -> usize {
            self.0.lock().unwrap().writes.len()
        }
    }

    impl OutputVolume for FakeOut {
        type Device = usize;

        fn default_output(&self) -> Option<usize> {
            let mut rig = self.0.lock().unwrap();
            rig.reads += 1;
            rig.default
        }
        fn uid(&self, device: usize) -> Option<String> {
            Some(self.0.lock().unwrap().devices[device].0.clone())
        }
        fn find(&self, uid: &str) -> Option<usize> {
            let rig = self.0.lock().unwrap();
            rig.devices.iter().position(|d| d.0 == uid).filter(|&i| rig.connected[i])
        }
        fn controls(&self, device: usize) -> Vec<u32> {
            self.0.lock().unwrap().devices[device].1.keys().copied().collect()
        }
        fn volume(&self, device: usize, control: u32) -> Option<f32> {
            let mut rig = self.0.lock().unwrap();
            rig.reads += 1;
            rig.devices[device].1.get(&control).copied()
        }
        fn set_volume(&self, device: usize, control: u32, value: f32) -> bool {
            let mut rig = self.0.lock().unwrap();
            let uid = rig.devices[device].0.clone();
            rig.writes.push((uid, control, value));
            rig.devices[device].1.insert(control, value);
            true
        }
    }

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    /// A state file of its own per test, in a folder that does not exist yet.
    fn scratch() -> PathBuf {
        quill_core::log::set_enabled(false);
        let n = NEXT.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!("quill-duck-test-{}-{n}", std::process::id())).join("Quill-duck.json")
    }

    fn core(out: &FakeOut, file: &PathBuf) -> DuckCore<FakeOut> {
        DuckCore::new(out.clone(), file.clone())
    }

    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-6
    }

    #[test]
    fn ducks_to_a_fraction_and_puts_back_the_exact_value() {
        let out = FakeOut::default();
        let speakers = out.add("BuiltInSpeakerDevice", &[(0, 0.4375)]);
        let file = scratch();
        let ducker = core(&out, &file);

        ducker.duck(0.15);
        assert!(close(out.get(speakers, 0), 0.4375 * 0.15));
        assert_eq!(decode_state(&std::fs::read_to_string(&file).unwrap()), vec![Ducked {
            uid: "BuiltInSpeakerDevice".to_string(),
            volumes: [(0, 0.4375)].into_iter().collect(),
        }]);

        ducker.restore();
        assert_eq!(out.get(speakers, 0), 0.4375);
        assert!(!file.exists(), "nothing left to restore, so no state file");
    }

    #[test]
    fn every_channel_of_a_headset_is_ducked_and_restored() {
        let out = FakeOut::default();
        let headset = out.add("AA-BB:output", &[(1, 0.5), (2, 0.625)]);
        let ducker = core(&out, &scratch());

        ducker.duck(0.5);
        assert!(close(out.get(headset, 1), 0.25));
        assert!(close(out.get(headset, 2), 0.3125));
        ducker.restore();
        assert_eq!((out.get(headset, 1), out.get(headset, 2)), (0.5, 0.625));
    }

    #[test]
    fn level_zero_mutes() {
        let out = FakeOut::default();
        let speakers = out.add("spk", &[(0, 0.8)]);
        let ducker = core(&out, &scratch());
        ducker.duck(0.0);
        assert_eq!(out.get(speakers, 0), 0.0);
        ducker.restore();
        assert_eq!(out.get(speakers, 0), 0.8);
    }

    #[test]
    fn a_second_duck_does_not_save_the_ducked_volume() {
        let out = FakeOut::default();
        let speakers = out.add("spk", &[(0, 0.8)]);
        let ducker = core(&out, &scratch());
        ducker.duck(0.5);
        ducker.duck(0.5);
        assert!(close(out.get(speakers, 0), 0.4));
        ducker.restore();
        assert_eq!(out.get(speakers, 0), 0.8);
    }

    #[test]
    fn a_silent_output_is_left_alone() {
        let out = FakeOut::default();
        out.add("spk", &[(0, 0.001)]);
        let file = scratch();
        let ducker = core(&out, &file);
        ducker.duck(0.15);
        assert_eq!(out.writes(), 0);
        assert!(!file.exists());
        // And it was not counted as ducked: a later start can still duck.
        out.set(0, 0, 0.5);
        ducker.duck(0.5);
        assert!(close(out.get(0, 0), 0.25));
    }

    #[test]
    fn no_output_or_no_volume_control_is_not_a_duck() {
        let file = scratch();
        let none = FakeOut::default();
        core(&none, &file).duck(0.15);
        assert!(!file.exists());

        let fixed = FakeOut::default();
        fixed.add("hdmi", &[]);
        let ducker = core(&fixed, &file);
        ducker.duck(0.15);
        ducker.restore();
        assert_eq!(fixed.writes(), 0);
        assert!(!file.exists());
    }

    #[test]
    fn restore_with_nothing_ducked_touches_nothing() {
        let out = FakeOut::default();
        out.add("spk", &[(0, 0.8)]);
        let file = scratch();
        let ducker = core(&out, &file);
        ducker.recover();
        ducker.restore();
        ducker.retry_orphans();
        ducker.restore();
        assert_eq!(out.touched(), 0, "duck off: the volume is never read or written");
        assert!(!file.exists());
    }

    #[test]
    fn restores_the_ducked_device_even_when_the_default_moved() {
        let out = FakeOut::default();
        let speakers = out.add("spk", &[(0, 0.8)]);
        let headset = out.add("headset", &[(1, 0.3), (2, 0.3)]);
        let ducker = core(&out, &scratch());

        ducker.duck(0.5);
        out.make_default(headset);
        ducker.restore();
        assert_eq!(out.get(speakers, 0), 0.8);
        assert_eq!((out.get(headset, 1), out.get(headset, 2)), (0.3, 0.3));
    }

    #[test]
    fn a_device_gone_at_restore_is_put_right_when_it_returns() {
        let out = FakeOut::default();
        let headset = out.add("headset", &[(1, 0.6), (2, 0.6)]);
        let speakers = out.add("spk", &[(0, 0.9)]);
        let file = scratch();
        let ducker = core(&out, &file);

        ducker.duck(0.5);
        out.unplug(headset);
        ducker.restore();
        assert!(file.exists(), "the orphan stays on disk");
        assert!(close(out.get(headset, 1), 0.3), "still ducked, it was not there to restore");

        // The next recording ducks the speakers; the orphan is kept beside it.
        ducker.retry_orphans();
        ducker.duck(0.5);
        assert_eq!(decode_state(&std::fs::read_to_string(&file).unwrap()).len(), 2);
        ducker.restore();
        assert_eq!(out.get(speakers, 0), 0.9);
        assert_eq!(decode_state(&std::fs::read_to_string(&file).unwrap()).len(), 1);

        out.plug(headset);
        ducker.retry_orphans();
        assert_eq!((out.get(headset, 1), out.get(headset, 2)), (0.6, 0.6));
        assert!(!file.exists());
    }

    #[test]
    fn a_device_orphaned_twice_keeps_its_latest_volumes_once() {
        let out = FakeOut::default();
        let headset = out.add("headset", &[(1, 0.6)]);
        let file = scratch();
        let ducker = core(&out, &file);

        ducker.duck(0.5);
        out.unplug(headset);
        ducker.restore();
        // Back, but before anyone told the helper; the user turns it up, and
        // it drops out again during the next recording.
        out.plug(headset);
        out.make_default(headset);
        out.set(headset, 1, 0.8);
        ducker.duck(0.5);
        out.unplug(headset);
        ducker.restore();

        let saved = decode_state(&std::fs::read_to_string(&file).unwrap());
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].volumes[&1], 0.8);
    }

    #[test]
    fn the_next_launch_undoes_a_duck_that_was_never_restored() {
        let out = FakeOut::default();
        let speakers = out.add("spk", &[(0, 0.7)]);
        let file = scratch();
        // Killed while ducked: the first helper never runs restore.
        core(&out, &file).duck(0.15);
        assert!(close(out.get(speakers, 0), 0.7 * 0.15));

        core(&out, &file).recover();
        assert_eq!(out.get(speakers, 0), 0.7);
        assert!(!file.exists());
    }

    #[test]
    fn recovery_keeps_what_it_cannot_restore_yet() {
        let out = FakeOut::default();
        let headset = out.add("headset", &[(1, 0.6), (2, 0.6)]);
        out.add("spk", &[(0, 0.9)]);
        let file = scratch();
        core(&out, &file).duck(0.5);
        out.unplug(headset);

        let next = core(&out, &file);
        next.recover();
        assert!(file.exists());
        out.plug(headset);
        next.retry_orphans();
        assert_eq!(out.get(headset, 1), 0.6);
        assert!(!file.exists());
    }

    #[test]
    fn recovery_reads_what_the_swift_helper_writes() {
        let out = FakeOut::default();
        let headset = out.add("AA-BB:output", &[(1, 0.1), (2, 0.1)]);
        let speakers = out.add("BuiltInSpeakerDevice", &[(0, 0.05)]);
        let file = scratch();
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        // JSONEncoder on [Ducked], with [UInt32: Float] as a flat array.
        std::fs::write(
            &file,
            r#"[{"uid":"AA-BB:output","volumes":[2,0.5625,1,0.5]},{"uid":"BuiltInSpeakerDevice","volumes":[0,0.30000001192092896]}]"#,
        )
        .unwrap();

        core(&out, &file).recover();
        assert_eq!((out.get(headset, 1), out.get(headset, 2)), (0.5, 0.5625));
        assert_eq!(out.get(speakers, 0), 0.3);
        assert!(!file.exists());
    }

    #[test]
    fn recovery_reads_the_single_object_of_older_builds() {
        let out = FakeOut::default();
        let speakers = out.add("spk", &[(0, 0.05)]);
        let file = scratch();
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, r#"{"uid":"spk","volumes":[0,0.75]}"#).unwrap();
        core(&out, &file).recover();
        assert_eq!(out.get(speakers, 0), 0.75);
        assert!(!file.exists());
    }

    #[test]
    fn an_unreadable_state_file_is_removed_and_sets_nothing() {
        let out = FakeOut::default();
        out.add("spk", &[(0, 0.5)]);
        let file = scratch();
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        for junk in ["", "not json", "7", r#"[{"uid":"spk"}]"#, r#"[{"uid":"spk","volumes":[0]}]"#,
            r#"[{"uid":"spk","volumes":[-1,0.5]}]"#, r#"[{"uid":"spk","volumes":["0",0.5]}]"#,
            r#"[{"uid":7,"volumes":[0,0.5]}]"#]
        {
            std::fs::write(&file, junk).unwrap();
            core(&out, &file).recover();
            assert_eq!(out.writes(), 0, "{junk}");
            assert!(!file.exists(), "{junk}");
        }
    }

    #[test]
    fn the_state_file_is_written_the_way_swift_reads_it() {
        let all = vec![
            Ducked { uid: "AA-BB:output".to_string(), volumes: [(1, 0.5), (2, 0.5625)].into_iter().collect() },
            Ducked { uid: "Quote\"d".to_string(), volumes: [(0, 0.15)].into_iter().collect() },
        ];
        let text = encode_state(&all);
        assert_eq!(text, r#"[{"uid":"AA-BB:output","volumes":[1,0.5,2,0.5625]},{"uid":"Quote\"d","volumes":[0,0.15]}]"#);
        assert_eq!(decode_state(&text), all);
    }

    #[test]
    fn saved_volumes_outside_the_scale_are_clamped() {
        let saved = decode_state(r#"[{"uid":"spk","volumes":[0,1.5,1,-0.2]}]"#);
        assert_eq!(saved[0].volumes[&0], 1.0);
        assert_eq!(saved[0].volumes[&1], 0.0);
    }

    #[test]
    fn restore_from_another_thread_waits_for_a_duck_in_progress() {
        let out = FakeOut::default();
        let speakers = out.add("spk", &[(0, 0.8)]);
        let ducker = Arc::new(core(&out, &scratch()));
        for _ in 0..50 {
            let a = ducker.clone();
            let b = ducker.clone();
            let duck = std::thread::spawn(move || a.duck(0.15));
            let quit = std::thread::spawn(move || b.restore());
            duck.join().unwrap();
            quit.join().unwrap();
            // Whichever ran first, the exit path's own restore ends at 0.8.
            ducker.restore();
            assert_eq!(out.get(speakers, 0), 0.8);
        }
    }
}

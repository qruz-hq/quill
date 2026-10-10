//! Capture code shared by every OS: a cpal input stream feeding a
//! `CaptureSink`, and the device list. Owned by the audio capability; the
//! per-platform `audio.rs` and `devices.rs` files call into it.
//!
//! Why cpal and not AVCaptureSession (what the Swift helper uses): cpal 0.18
//! gives one code path for CoreAudio, WASAPI and ALSA, and on macOS it covers
//! what the helper needs:
//!
//! - its device id IS the CoreAudio UID (`kAudioDevicePropertyDeviceUID`), so
//!   a pinned `BuiltInMicrophoneDevice` keeps working unchanged;
//! - the stream is an AUHAL unit bound to one explicit device, so pinning the
//!   built-in microphone does not depend on what the output device is;
//! - dropping the stream stops, uninitialises and disposes the unit before
//!   `drop` returns, which is what lets a Bluetooth headset leave its call
//!   profile;
//! - a device that dies (`kAudioDevicePropertyDeviceIsAlive`) or changes its
//!   sample rate reaches the stream's error callback.
//!
//! What cpal does not have is a "device list changed" notification, so each
//! OS brings its own watcher (CoreAudio listeners on macOS, [`PollingWatcher`]
//! elsewhere until native ones are written).
//!
//! A cpal host can die under the helper. On Linux the PulseAudio host is one
//! connection to the sound server, and it does not reconnect: once the server
//! restarts (a PipeWire restart, a package upgrade, a crash) every question
//! put to that host fails for good. So nothing here trusts a host that fails
//! to list its devices: it is replaced by a new one and asked again (see
//! [`Host`]).
//!
//! Threads. The audio callback runs on the OS's real-time thread: it only
//! converts to float, mixes to one channel and writes into a lock-free ring.
//! A pump thread per capture empties the ring into the `CaptureSink`, which
//! resamples to 16 kHz and posts to the controller.

use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle, Thread};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{ErrorKind, FromSample, SampleFormat, I24};
use quill_core::bus::Bus;
use quill_core::caps::{AudioCapture, CaptureError, CaptureSink, CaptureStream, DeviceInfo, DeviceWatcher};
use quill_core::logln;
use rtrb::{Consumer, Producer, RingBuffer};

/// How long the ring can hold audio while the pump is held up.
const RING_SECONDS: usize = 2;
/// The pump hands audio on in blocks of at least this long, so a device with
/// tiny buffers does not turn into hundreds of `level` lines a second. 10 ms
/// gives at most 100 a second (the Swift helper sends about 90).
const BLOCK_MS: u32 = 10;
/// The pump wakes at least this often even if a wake-up from the audio thread
/// went missing.
const PUMP_IDLE: Duration = Duration::from_millis(20);
/// How long opening a device may wait for it to settle. The session retries.
const OPEN_TIMEOUT: Duration = Duration::from_millis(1500);
/// How often [`PollingWatcher`] looks at the device list.
const POLL_INTERVAL: Duration = Duration::from_secs(2);

// ------------------------------------------------------------ pure logic

/// One frame of interleaved samples as one float. Mono passes through, stereo
/// is averaged, and anything wider takes its first channel: on an interface
/// with eight inputs the microphone is in one of them, and averaging all
/// eight would bury it under seven silent ones.
#[inline]
fn mono<T: Copy>(frame: &[T], to_f32: &impl Fn(T) -> f32) -> f32 {
    match frame {
        [only] => to_f32(*only),
        [left, right] => (to_f32(*left) + to_f32(*right)) * 0.5,
        [first, ..] => to_f32(*first),
        [] => 0.0,
    }
}

/// Mixes interleaved frames to mono into the ring. Never blocks, never
/// allocates. Returns how many frames did not fit.
fn write_mono<T: Copy>(input: &[T], channels: usize, ring: &mut Producer<f32>, to_f32: impl Fn(T) -> f32) -> usize {
    let channels = channels.max(1);
    let frames = input.len() / channels;
    let room = ring.slots().min(frames);
    if room > 0 {
        if let Ok(chunk) = ring.write_chunk_uninit(room) {
            chunk.fill_from_iter(input.chunks_exact(channels).take(room).map(|frame| mono(frame, &to_f32)));
        }
    }
    frames - room
}

/// Frames the pump collects before handing a block on.
fn block_frames(rate: u32) -> usize {
    ((u64::from(rate) * u64::from(BLOCK_MS) / 1000) as usize).max(1)
}

/// Whether a stream error means the capture is over. Glitches are not: an
/// overrun loses a few milliseconds and the stream carries on.
fn is_fatal(kind: ErrorKind) -> bool {
    !matches!(kind, ErrorKind::Xrun | ErrorKind::RealtimeDenied)
}

/// Builds the `devices` payload from `(uid, name)` pairs in the OS's order.
/// A uid appears once (the first wins), a blank name falls back to the uid,
/// and at most one entry is the default.
fn device_list(entries: Vec<(String, String)>, default_uid: Option<&str>) -> Vec<DeviceInfo> {
    let mut list: Vec<DeviceInfo> = Vec::with_capacity(entries.len());
    for (uid, name) in entries {
        if uid.is_empty() || list.iter().any(|d| d.uid == uid) {
            continue;
        }
        let is_default = default_uid == Some(uid.as_str());
        let name = if name.trim().is_empty() { uid.clone() } else { name };
        list.push(DeviceInfo { id: list.len() as u32, uid, name, is_default });
    }
    list
}

/// Everything a change in the device list or the default input would alter.
fn signature(devices: &[DeviceInfo]) -> Vec<(String, String, bool)> {
    devices.iter().map(|d| (d.uid.clone(), d.name.clone(), d.is_default)).collect()
}

// ------------------------------------------------------------------ cpal

/// PulseAudio and PipeWire list every output's loopback as a source named
/// `<sink>.monitor`. It records what the speakers play, so it is not offered
/// as a microphone. Other systems have no such naming.
fn is_monitor(uid: &str) -> bool {
    cfg!(target_os = "linux") && uid.ends_with(".monitor")
}

fn uid_of(device: &cpal::Device) -> Option<String> {
    device.id().ok().map(|id| id.id().to_string())
}

fn name_of(device: &cpal::Device) -> Option<String> {
    device.description().ok().map(|d| d.name().to_string()).filter(|name| !name.trim().is_empty())
}

fn list_devices(host: &cpal::Host) -> Result<Vec<DeviceInfo>, cpal::Error> {
    // The list first: it is the call that fails when the host is gone.
    let entries = host
        .input_devices()?
        .filter_map(|device| {
            let uid = uid_of(&device)?;
            if is_monitor(&uid) {
                return None;
            }
            let name = name_of(&device).unwrap_or_else(|| uid.clone());
            Some((uid, name))
        })
        .collect();
    let default_uid = host.default_input_device().as_ref().and_then(uid_of);
    Ok(device_list(entries, default_uid.as_deref()))
}

/// The system default input as a device of its own. Some backends hand out a
/// "whatever the default is" handle that follows the default around; a
/// capture is tied to one device for its whole life (section 5.1), so the
/// handle is swapped for the device it points at right now.
fn default_input(host: &cpal::Host) -> Option<cpal::Device> {
    let device = host.default_input_device()?;
    if cfg!(target_os = "macos") {
        // CoreAudio's default input already is a plain device.
        return Some(device);
    }
    let explicit = device.id().ok().and_then(|id| host.device_by_id(&id));
    Some(explicit.unwrap_or(device))
}

/// The device a capture should open: the pinned one when it is connected,
/// otherwise the system default. `Ok(None)` means the host answered and there
/// is no microphone; `Err` means the host could not be asked at all.
fn pick_device(host: &cpal::Host, uid: Option<&str>) -> Result<Option<cpal::Device>, cpal::Error> {
    if let Some(uid) = uid {
        // Inputs only: a uid that names a pair of speakers is not a microphone.
        let pinned = host.input_devices()?.find(|device| uid_of(device).as_deref() == Some(uid));
        if pinned.is_some() {
            return Ok(pinned);
        }
        logln!("mic: pinned {uid} not connected, using system default");
    }
    match default_input(host) {
        Some(device) => Ok(Some(device)),
        // No default looks the same whether there is no microphone or the
        // host has stopped answering. Listing tells the two apart.
        None => host.input_devices().map(|_| None),
    }
}

/// Asks through `slot`'s host. When the host cannot answer, a new one takes
/// its place and is asked once more; what that one says is final for this
/// call. `connect` builds the replacement (`cpal::default_host` outside tests).
fn ask_with_reconnect<H, T, E: std::fmt::Display>(
    slot: &RefCell<H>,
    connect: impl FnOnce() -> H,
    ask: impl Fn(&H) -> Result<T, E>,
) -> Result<T, E> {
    let first = ask(&slot.borrow());
    let error = match first {
        Ok(answer) => return Ok(answer),
        Err(error) => error,
    };
    logln!("audio: the sound system stopped answering ({error}), connecting again");
    slot.replace(connect());
    let fresh = slot.borrow();
    ask(&fresh)
}

/// A cpal host that is replaced when it stops answering. Creating a host is
/// cheap on every OS (on Linux it is one connection to the sound server, and
/// with no server running cpal falls back to ALSA).
struct Host(RefCell<cpal::Host>);

impl Host {
    fn new() -> Self {
        Self(RefCell::new(cpal::default_host()))
    }

    fn ask<T>(&self, ask: impl Fn(&cpal::Host) -> Result<T, cpal::Error>) -> Result<T, cpal::Error> {
        ask_with_reconnect(&self.0, cpal::default_host, ask)
    }

    /// The `devices` payload. Empty when even a fresh host cannot list.
    fn devices(&self) -> Vec<DeviceInfo> {
        self.ask(list_devices).unwrap_or_else(|error| {
            logln!("devices: could not list inputs ({error})");
            Vec::new()
        })
    }
}

/// Microphone capture through cpal. One per helper, used on the controller
/// thread only.
pub struct CpalAudio {
    host: Host,
}

impl CpalAudio {
    pub fn new() -> Self {
        Self { host: Host::new() }
    }
}

impl AudioCapture for CpalAudio {
    fn supported(&self) -> bool {
        true
    }

    fn devices(&self) -> Vec<DeviceInfo> {
        self.host.devices()
    }

    fn open(&mut self, uid: Option<&str>, sink: CaptureSink) -> Result<Box<dyn CaptureStream>, CaptureError> {
        let device = self.host.ask(|host| pick_device(host, uid)).unwrap_or_else(|error| {
            logln!("mic: could not look for a microphone ({error})");
            None
        });
        let Some(device) = device else {
            return Err(CaptureError::no_device());
        };
        let name = name_of(&device).or_else(|| uid_of(&device)).unwrap_or_else(|| "the microphone".to_string());
        CpalStream::open(&device, name, sink).map(|stream| Box::new(stream) as Box<dyn CaptureStream>)
    }
}

/// An open microphone: the cpal stream and the pump thread behind it.
struct CpalStream {
    name: String,
    stream: Option<cpal::Stream>,
    pump: Option<JoinHandle<()>>,
    /// Tells the pump to finish.
    stop: Arc<AtomicBool>,
    /// Set before the stream is torn down, so the errors a teardown can raise
    /// are not reported as a lost device.
    closing: Arc<AtomicBool>,
}

impl CpalStream {
    fn open(device: &cpal::Device, name: String, sink: CaptureSink) -> Result<Self, CaptureError> {
        // The device's own format, as it is right now. Never ask for 16 kHz:
        // on macOS cpal writes the requested rate to the hardware, which would
        // change the microphone for every other app as well.
        let supported = device.default_input_config().map_err(|error| {
            logln!("mic: {name} has no usable input format ({error})");
            CaptureError::open_failed(&name)
        })?;
        let format = supported.sample_format();
        let config = supported.config();
        let (rate, channels) = (config.sample_rate, usize::from(config.channels));
        if rate == 0 || channels == 0 || !convertible(format) {
            logln!("mic: {name} delivers {channels} ch {format} at {rate} Hz, which cannot be read");
            return Err(CaptureError::read_failed(&name));
        }

        let (mut ring, consumer) = RingBuffer::<f32>::new(rate as usize * RING_SECONDS);
        let stop = Arc::new(AtomicBool::new(false));
        let closing = Arc::new(AtomicBool::new(false));
        let overrun = Arc::new(AtomicUsize::new(0));
        let lost = sink.lost_handle();

        let pump = {
            let (stop, overrun) = (stop.clone(), overrun.clone());
            thread::Builder::new()
                .name("mic-pump".to_string())
                .spawn(move || pump(consumer, sink, rate, &stop, &overrun))
                .map_err(|error| {
                    logln!("mic: could not start the pump thread ({error})");
                    CaptureError::open_failed(&name)
                })?
        };
        let waker: Thread = pump.thread().clone();
        // From here on the pump is running: every early return goes through
        // `Drop`, which stops and joins it.
        let mut this = Self { name, stream: None, pump: Some(pump), stop, closing: closing.clone() };

        let on_data = move |data: &cpal::Data, _: &cpal::InputCallbackInfo| {
            let missed = write_data(data, channels, &mut ring);
            if missed > 0 {
                overrun.fetch_add(missed, Ordering::Relaxed);
            }
            waker.unpark();
        };
        let reported = AtomicBool::new(false);
        let on_error = move |error: cpal::Error| {
            if closing.load(Ordering::Relaxed) || !is_fatal(error.kind()) {
                return;
            }
            // One report per capture: the session drops the stream on the first.
            if !reported.swap(true, Ordering::Relaxed) {
                lost.lost(&error.to_string());
            }
        };

        let began = Instant::now();
        let stream = device.build_input_stream_raw(config, format, on_data, on_error, Some(OPEN_TIMEOUT)).map_err(|error| {
            logln!("mic: could not open {} ({error})", this.name);
            CaptureError::open_failed(&this.name)
        })?;
        this.stream = Some(stream);
        if let Some(Err(error)) = this.stream.as_ref().map(|stream| stream.play()) {
            logln!("mic: could not start {} ({error})", this.name);
            return Err(CaptureError::open_failed(&this.name));
        }
        logln!(
            "mic: opened {} at {rate} Hz, {channels} ch, {format} in {} ms",
            this.name,
            began.elapsed().as_millis()
        );
        Ok(this)
    }
}

impl CaptureStream for CpalStream {
    fn name(&self) -> &str {
        &self.name
    }
}

impl Drop for CpalStream {
    fn drop(&mut self) {
        // The device first: nothing else here may delay a Bluetooth headset
        // going back to its music profile.
        self.closing.store(true, Ordering::Relaxed);
        let began = Instant::now();
        if self.stream.take().is_some() {
            logln!("mic: released {} in {} ms", self.name, began.elapsed().as_millis());
        }
        self.stop.store(true, Ordering::Relaxed);
        if let Some(pump) = self.pump.take() {
            pump.thread().unpark();
            let _ = pump.join();
        }
    }
}

/// Sample formats [`write_data`] reads.
fn convertible(format: SampleFormat) -> bool {
    matches!(
        format,
        SampleFormat::F32
            | SampleFormat::F64
            | SampleFormat::I8
            | SampleFormat::I16
            | SampleFormat::I24
            | SampleFormat::I32
            | SampleFormat::U8
            | SampleFormat::U16
    )
}

/// The audio callback's whole job. Returns the frames that did not fit.
fn write_data(data: &cpal::Data, channels: usize, ring: &mut Producer<f32>) -> usize {
    macro_rules! mix {
        ($t:ty) => {
            match data.as_slice::<$t>() {
                Some(samples) => write_mono(samples, channels, ring, |s: $t| f32::from_sample_(s)),
                None => 0,
            }
        };
    }
    match data.sample_format() {
        SampleFormat::F32 => mix!(f32),
        SampleFormat::F64 => mix!(f64),
        SampleFormat::I8 => mix!(i8),
        SampleFormat::I16 => mix!(i16),
        SampleFormat::I24 => mix!(I24),
        SampleFormat::I32 => mix!(i32),
        SampleFormat::U8 => mix!(u8),
        SampleFormat::U16 => mix!(u16),
        _ => 0,
    }
}

/// Empties the ring into the sink until told to stop. What is still in the
/// ring at that point is dropped: the session closes a capture exactly when it
/// wants no more of its audio.
fn pump(mut ring: Consumer<f32>, mut sink: CaptureSink, rate: u32, stop: &AtomicBool, overrun: &AtomicUsize) {
    let block = block_frames(rate);
    let mut pending: Vec<f32> = Vec::with_capacity(block * 8);
    while !stop.load(Ordering::Relaxed) {
        let ready = ring.slots();
        if ready == 0 {
            thread::park_timeout(PUMP_IDLE);
            continue;
        }
        if let Ok(chunk) = ring.read_chunk(ready) {
            let (head, tail) = chunk.as_slices();
            pending.extend_from_slice(head);
            pending.extend_from_slice(tail);
            chunk.commit_all();
        }
        if pending.len() >= block {
            sink.push(&pending, 1, rate);
            pending.clear();
        } else {
            // Less than a block: wait for the next buffer rather than spin.
            thread::park_timeout(PUMP_IDLE);
        }
        let missed = overrun.swap(0, Ordering::Relaxed);
        if missed > 0 {
            logln!("mic: dropped {missed} frames, the helper fell behind the microphone");
        }
    }
}

// --------------------------------------------------------------- watcher

/// Hot-plug by looking: lists the inputs every two seconds and reports a
/// difference. For platforms without a native notification wired up yet.
#[allow(dead_code)] // macOS has CoreAudio listeners instead.
pub struct PollingWatcher {
    bus: Bus,
    started: bool,
}

#[allow(dead_code)]
impl PollingWatcher {
    pub fn new(bus: &Bus) -> Self {
        Self { bus: bus.clone(), started: false }
    }
}

impl DeviceWatcher for PollingWatcher {
    fn start(&mut self) {
        if std::mem::replace(&mut self.started, true) {
            return;
        }
        let bus = self.bus.clone();
        let spawned = thread::Builder::new().name("device-poll".to_string()).spawn(move || {
            // Its own host, which like the capture's is replaced when it dies:
            // a sound server that restarted must not leave this watching an
            // empty list for ever.
            let host = Host::new();
            let mut last = signature(&host.devices());
            loop {
                thread::sleep(POLL_INTERVAL);
                let now = signature(&host.devices());
                if now != last {
                    last = now;
                    bus.devices_changed();
                }
            }
        });
        if let Err(error) = spawned {
            logln!("devices: could not start the watcher ({error})");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drain(ring: &mut Consumer<f32>) -> Vec<f32> {
        let mut out = Vec::new();
        while let Ok(sample) = ring.pop() {
            out.push(sample);
        }
        out
    }

    #[test]
    fn mono_passes_through() {
        let (mut tx, mut rx) = RingBuffer::<f32>::new(16);
        assert_eq!(write_mono(&[0.1f32, -0.2, 0.3], 1, &mut tx, |s| s), 0);
        assert_eq!(drain(&mut rx), vec![0.1, -0.2, 0.3]);
    }

    #[test]
    fn stereo_is_averaged() {
        let (mut tx, mut rx) = RingBuffer::<f32>::new(16);
        assert_eq!(write_mono(&[1.0f32, 0.0, -0.5, -0.5, 0.2, 0.4], 2, &mut tx, |s| s), 0);
        let out = drain(&mut rx);
        assert_eq!(out.len(), 3);
        assert!((out[0] - 0.5).abs() < 1e-6 && (out[1] + 0.5).abs() < 1e-6 && (out[2] - 0.3).abs() < 1e-6);
    }

    #[test]
    fn a_wide_interface_gives_its_first_channel() {
        let (mut tx, mut rx) = RingBuffer::<f32>::new(16);
        let frames = [0.7f32, 0.0, 0.0, 0.0, -0.7, 0.9, 0.9, 0.9];
        assert_eq!(write_mono(&frames, 4, &mut tx, |s| s), 0);
        assert_eq!(drain(&mut rx), vec![0.7, -0.7]);
    }

    #[test]
    fn a_trailing_partial_frame_is_left_out() {
        let (mut tx, mut rx) = RingBuffer::<f32>::new(16);
        assert_eq!(write_mono(&[0.2f32, 0.4, 0.9], 2, &mut tx, |s| s), 0);
        assert_eq!(drain(&mut rx).len(), 1);
    }

    #[test]
    fn a_full_ring_drops_the_newest_frames_and_counts_them() {
        let (mut tx, mut rx) = RingBuffer::<f32>::new(4);
        assert_eq!(write_mono(&[1.0f32, 2.0, 3.0], 1, &mut tx, |s| s), 0);
        assert_eq!(write_mono(&[4.0f32, 5.0, 6.0], 1, &mut tx, |s| s), 2);
        assert_eq!(write_mono(&[7.0f32], 1, &mut tx, |s| s), 1);
        assert_eq!(drain(&mut rx), vec![1.0, 2.0, 3.0, 4.0]);
    }

    #[test]
    fn integer_samples_become_floats_in_range() {
        let (mut tx, mut rx) = RingBuffer::<f32>::new(16);
        write_mono(&[i16::MAX, 0, i16::MIN], 1, &mut tx, |s: i16| f32::from_sample_(s));
        let out = drain(&mut rx);
        assert!((out[0] - 1.0).abs() < 1e-3 && out[1] == 0.0 && (out[2] + 1.0).abs() < 1e-6, "{out:?}");

        write_mono(&[u8::MAX, 128, 0], 1, &mut tx, |s: u8| f32::from_sample_(s));
        let out = drain(&mut rx);
        assert!(out[0] > 0.98 && out[1].abs() < 1e-6 && (out[2] + 1.0).abs() < 1e-6, "{out:?}");

        let half = I24::new(1 << 22).expect("in range");
        write_mono(&[half], 1, &mut tx, |s: I24| f32::from_sample_(s));
        assert!((drain(&mut rx)[0] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn every_readable_format_is_one_the_callback_handles() {
        for format in [
            SampleFormat::F32,
            SampleFormat::F64,
            SampleFormat::I8,
            SampleFormat::I16,
            SampleFormat::I24,
            SampleFormat::I32,
            SampleFormat::U8,
            SampleFormat::U16,
        ] {
            assert!(convertible(format), "{format}");
        }
        assert!(!convertible(SampleFormat::U64));
    }

    #[test]
    fn blocks_are_ten_milliseconds() {
        assert_eq!(block_frames(48_000), 480);
        assert_eq!(block_frames(44_100), 441);
        assert_eq!(block_frames(16_000), 160);
        assert_eq!(block_frames(8_000), 80);
        assert_eq!(block_frames(50), 1);
    }

    #[test]
    fn glitches_do_not_end_a_capture_but_a_dead_device_does() {
        assert!(!is_fatal(ErrorKind::Xrun));
        assert!(!is_fatal(ErrorKind::RealtimeDenied));
        assert!(is_fatal(ErrorKind::DeviceNotAvailable));
        assert!(is_fatal(ErrorKind::StreamInvalidated));
        assert!(is_fatal(ErrorKind::DeviceChanged));
        assert!(is_fatal(ErrorKind::BackendError));
    }

    fn pair(uid: &str, name: &str) -> (String, String) {
        (uid.to_string(), name.to_string())
    }

    #[test]
    fn the_list_keeps_the_order_and_marks_one_default() {
        let list = device_list(
            vec![pair("BuiltInMicrophoneDevice", "MacBook Pro Microphone"), pair("AA-BB:input", "Headset")],
            Some("AA-BB:input"),
        );
        assert_eq!(list.len(), 2);
        assert_eq!((list[0].id, list[0].uid.as_str(), list[0].is_default), (0, "BuiltInMicrophoneDevice", false));
        assert_eq!((list[1].id, list[1].name.as_str(), list[1].is_default), (1, "Headset", true));
    }

    #[test]
    fn the_list_has_unique_uids_and_never_a_blank_name() {
        let list = device_list(vec![pair("a", "First"), pair("a", "Again"), pair("", "No uid"), pair("b", "  ")], Some("a"));
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].name, "First");
        assert_eq!((list[1].uid.as_str(), list[1].name.as_str(), list[1].id), ("b", "b", 1));
        assert_eq!(list.iter().filter(|d| d.is_default).count(), 1);
    }

    #[test]
    fn no_default_marks_nothing() {
        let list = device_list(vec![pair("a", "A")], None);
        assert!(!list[0].is_default);
        assert!(device_list(Vec::new(), Some("a")).is_empty());
    }

    #[test]
    fn the_signature_changes_with_the_list_the_names_and_the_default() {
        let base = device_list(vec![pair("a", "A"), pair("b", "B")], Some("a"));
        let same = device_list(vec![pair("a", "A"), pair("b", "B")], Some("a"));
        assert_eq!(signature(&base), signature(&same));
        assert_ne!(signature(&base), signature(&device_list(vec![pair("a", "A")], Some("a"))));
        assert_ne!(signature(&base), signature(&device_list(vec![pair("a", "A"), pair("b", "B")], Some("b"))));
        assert_ne!(signature(&base), signature(&device_list(vec![pair("a", "A"), pair("b", "Bee")], Some("a"))));
    }

    /// Stands in for a cpal host: `alive` is whether it still answers.
    struct FakeHost {
        alive: bool,
        serial: u32,
    }

    fn ask_fake(host: &FakeHost) -> Result<u32, String> {
        if host.alive { Ok(host.serial) } else { Err("PulseAudio disconnected".to_string()) }
    }

    #[test]
    fn a_host_that_answers_is_kept() {
        let slot = RefCell::new(FakeHost { alive: true, serial: 1 });
        let answer = ask_with_reconnect(&slot, || panic!("no reconnect while the host answers"), ask_fake);
        assert_eq!(answer, Ok(1));
        assert_eq!(slot.borrow().serial, 1);
    }

    #[test]
    fn a_dead_host_is_replaced_and_asked_again() {
        // The sound server restarted: the old connection fails for good.
        let slot = RefCell::new(FakeHost { alive: false, serial: 1 });
        let answer = ask_with_reconnect(&slot, || FakeHost { alive: true, serial: 2 }, ask_fake);
        assert_eq!(answer, Ok(2));
        // The replacement stays, so the next question costs no reconnect.
        let answer = ask_with_reconnect(&slot, || panic!("the new host answers"), ask_fake);
        assert_eq!(answer, Ok(2));
    }

    #[test]
    fn a_server_that_is_still_down_fails_once_and_recovers_later() {
        let slot = RefCell::new(FakeHost { alive: false, serial: 1 });
        let connects = std::cell::Cell::new(0);
        let down = || {
            connects.set(connects.get() + 1);
            FakeHost { alive: false, serial: 2 }
        };
        assert!(ask_with_reconnect(&slot, down, ask_fake).is_err());
        assert_eq!(connects.get(), 1); // one attempt per question, no loop
        // The server is back by the next question.
        let answer = ask_with_reconnect(&slot, || FakeHost { alive: true, serial: 3 }, ask_fake);
        assert_eq!(answer, Ok(3));
    }

    #[test]
    fn the_pump_hands_on_whole_blocks_and_stops_when_told() {
        use quill_core::bus::Msg;

        let (bus, rx) = Bus::new();
        let sink = CaptureSink::new(bus, 7);
        let (mut tx, consumer) = RingBuffer::<f32>::new(4096);
        let stop = Arc::new(AtomicBool::new(false));
        let overrun = Arc::new(AtomicUsize::new(0));
        let handle = {
            let (stop, overrun) = (stop.clone(), overrun.clone());
            thread::spawn(move || pump(consumer, sink, 16_000, &stop, &overrun))
        };
        // 100 samples is less than a block (160): nothing yet. 100 more: one message.
        write_mono(&[0.25f32; 100], 1, &mut tx, |s| s);
        handle.thread().unpark();
        thread::sleep(Duration::from_millis(60));
        assert!(rx.try_recv().is_err());
        write_mono(&[0.25f32; 100], 1, &mut tx, |s| s);
        handle.thread().unpark();
        match rx.recv_timeout(Duration::from_secs(2)) {
            Ok(Msg::Samples { capture: 7, samples }) => assert_eq!(samples, vec![0.25f32; 200]),
            other => panic!("unexpected {other:?}"),
        }
        stop.store(true, Ordering::Relaxed);
        handle.thread().unpark();
        handle.join().expect("pump exits");
    }
}

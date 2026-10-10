//! A small blocking client for the PulseAudio native protocol, for the two
//! things the helper asks the sound server besides audio: the output volume
//! (`duck.rs`) and "the device list changed" (`devices.rs`).
//!
//! The same socket is served by PulseAudio and by PipeWire (`pipewire-pulse`),
//! which between them cover every current desktop.
//!
//! Why the `pulseaudio` crate's protocol module and not `libpulse-binding` or
//! the `pactl` program:
//!
//! - it is already in the binary (cpal's PulseAudio host is built on it), and
//!   it is plain Rust, so the helper links no `libpulse.so` and still starts
//!   on a machine without it;
//! - `pactl` is a separate package that many PipeWire installs leave out, and
//!   parsing its output ties the helper to a locale and a version;
//! - the crate's own `Client` is asynchronous and has no timeouts. The volume
//!   is restored on every way out of the process, so a call here must never
//!   hang: this client is one socket with a read and a write deadline, used
//!   from one thread at a time, and frames messages itself so a reply it
//!   cannot parse costs that reply and not the connection's place in the
//!   stream.

use std::ffi::{CStr, CString};
use std::io::{Cursor, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::Duration;

use pulseaudio::protocol::{
    self, AuthParams, AuthReply, ChannelVolume, Command, CommandReply, GetSinkInfo, Prop, Props, ProtocolError, PulseError,
    ServerInfo, SetClientNameReply, SetDeviceVolumeParams, SinkInfo, SubscriptionEvent, SubscriptionEventFacility,
    SubscriptionEventType, SubscriptionMask, Volume, DESCRIPTOR_SIZE,
};

/// How long one request may take before the server counts as hung.
pub const REQUEST_TIMEOUT: Duration = Duration::from_millis(1500);
/// No message of this protocol that the helper asks for comes near this.
const MAX_MESSAGE: usize = 8 * 1024 * 1024;
/// How many messages that are not the awaited reply one request sits through.
const MAX_SKIPPED: usize = 256;
/// 100 % on PulseAudio's volume scale.
const VOLUME_NORM: f32 = 65536.0;

/// Where the server's socket is. `env` looks a variable up, `uid` is the
/// user's id and `exists` says whether a path is there, all passed in so this
/// can be tested.
///
/// The order PulseAudio's own client uses: `PULSE_SERVER` when it names a
/// local socket, the runtime directory PulseAudio was told to use, then the
/// user's runtime directory, which is where both servers listen by default.
pub fn socket_path(env: impl Fn(&str) -> Option<String>, uid: u32, exists: impl Fn(&PathBuf) -> bool) -> Option<PathBuf> {
    let set = |name: &str| env(name).filter(|value| !value.is_empty());
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(server) = set("PULSE_SERVER") {
        // "unix:/path", a bare "/path", or a list of servers of which the
        // first local one counts. "tcp:host" is another machine: not ours.
        for one in server.split_whitespace() {
            let one = one.rsplit('}').next().unwrap_or(one);
            if let Some(path) = one.strip_prefix("unix:") {
                candidates.push(PathBuf::from(path));
            } else if one.starts_with('/') {
                candidates.push(PathBuf::from(one));
            }
        }
    }
    if let Some(dir) = set("PULSE_RUNTIME_PATH") {
        candidates.push(PathBuf::from(dir).join("native"));
    }
    if let Some(dir) = set("XDG_RUNTIME_DIR") {
        candidates.push(PathBuf::from(dir).join("pulse").join("native"));
    }
    candidates.push(PathBuf::from(format!("/run/user/{uid}/pulse/native")));
    candidates.into_iter().find(|path| exists(path))
}

/// The socket of this user's sound server, if one is listening.
pub fn find_socket() -> Option<PathBuf> {
    // SAFETY: getuid takes nothing, cannot fail and touches no memory.
    let uid = unsafe { libc::getuid() };
    socket_path(|name| std::env::var(name).ok(), uid, |path| path.exists())
}

/// 0 to 1 (and above, for a sink the user has boosted) from a raw volume.
pub fn to_scalar(volume: Volume) -> f32 {
    volume.as_u32() as f32 / VOLUME_NORM
}

/// The raw volume for a 0 to 1 value. The scale is the one the desktop's
/// volume slider shows, so half of it is half the slider.
pub fn from_scalar(value: f32) -> Volume {
    let value = if value.is_finite() { value.max(0.0) } else { 0.0 };
    Volume::from_u32_clamped((value * VOLUME_NORM).round() as u32)
}

/// `volume` with channel `channel` set to `value`. `None` when the sink has
/// no such channel.
pub fn with_channel(volume: &ChannelVolume, channel: u32, value: f32) -> Option<ChannelVolume> {
    let channels = volume.channels();
    if channel as usize >= channels.len() {
        return None;
    }
    let mut changed = ChannelVolume::empty();
    for (index, &current) in channels.iter().enumerate() {
        changed.push(if index == channel as usize { from_scalar(value) } else { current });
    }
    Some(changed)
}

/// True for the events after which the list of microphones, the default
/// microphone or the set of outputs may be different: a source or a sink
/// came or went, a sound card came or went (a USB headset is one), or the
/// server's defaults moved. A volume or a mute changing is not one of them.
pub fn is_device_change(event: &SubscriptionEvent) -> bool {
    use SubscriptionEventFacility::{Card, Server, Sink, Source};
    let came_or_went = matches!(event.event_type, SubscriptionEventType::New | SubscriptionEventType::Removed);
    match event.event_facility {
        Source | Sink | Card => came_or_went,
        Server => true,
        _ => false,
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PulseFailure {
    /// The server answered, with an error (no such sink, say). The connection
    /// is fine.
    #[error("the sound server refused ({0:?})")]
    Refused(PulseError),
    /// Anything else. The connection is not to be used again.
    #[error("{0}")]
    Broken(String),
}

impl From<ProtocolError> for PulseFailure {
    fn from(error: ProtocolError) -> Self {
        match error {
            ProtocolError::ServerError(error) => PulseFailure::Refused(error),
            other => PulseFailure::Broken(other.to_string()),
        }
    }
}

impl From<std::io::Error> for PulseFailure {
    fn from(error: std::io::Error) -> Self {
        PulseFailure::Broken(error.to_string())
    }
}

/// One connection to the sound server.
pub struct Pulse {
    socket: UnixStream,
    version: u16,
    seq: u32,
}

impl Pulse {
    /// Connects to this user's server and introduces the helper. `timeout`
    /// bounds every read and write (`None`: wait for ever, for the watcher).
    pub fn connect(name: &CStr, timeout: Option<Duration>) -> Result<Self, PulseFailure> {
        let path = find_socket().ok_or_else(|| PulseFailure::Broken("no PulseAudio or PipeWire socket".to_string()))?;
        let socket = UnixStream::connect(path)?;
        // PipeWire ignores the cookie; PulseAudio wants the one in the user's
        // home, which only the user can read.
        let cookie = pulseaudio::cookie_path_from_env().and_then(|path| std::fs::read(path).ok()).unwrap_or_default();
        // The handshake always has a deadline, whatever the caller wants later.
        let mut pulse = Self::over(socket, Some(REQUEST_TIMEOUT))?;
        pulse.handshake(name, cookie)?;
        pulse.set_timeout(timeout)?;
        Ok(pulse)
    }

    /// A client over an already connected socket (tests use a socket pair).
    pub fn over(socket: UnixStream, timeout: Option<Duration>) -> Result<Self, PulseFailure> {
        let pulse = Self { socket, version: protocol::MAX_VERSION, seq: 0 };
        pulse.set_timeout(timeout)?;
        Ok(pulse)
    }

    fn set_timeout(&self, timeout: Option<Duration>) -> Result<(), PulseFailure> {
        self.socket.set_read_timeout(timeout)?;
        self.socket.set_write_timeout(timeout)?;
        Ok(())
    }

    pub fn handshake(&mut self, name: &CStr, cookie: Vec<u8>) -> Result<(), PulseFailure> {
        let auth = AuthParams { version: protocol::MAX_VERSION, supports_shm: false, supports_memfd: false, cookie };
        let reply: AuthReply = self.request(Command::Auth(auth))?;
        self.version = reply.version.min(protocol::MAX_VERSION);
        let mut props = Props::new();
        props.set(Prop::ApplicationName, name);
        let _: SetClientNameReply = self.request(Command::SetClientName(props))?;
        Ok(())
    }

    /// One whole message off the socket: its descriptor and its payload.
    fn read_message(&mut self) -> Result<Vec<u8>, PulseFailure> {
        let mut message = vec![0u8; DESCRIPTOR_SIZE];
        self.socket.read_exact(&mut message)?;
        let descriptor = protocol::read_descriptor(&mut Cursor::new(&message[..]))?;
        let length = descriptor.length as usize;
        if length > MAX_MESSAGE {
            return Err(PulseFailure::Broken(format!("a {length} byte message")));
        }
        message.resize(DESCRIPTOR_SIZE + length, 0);
        self.socket.read_exact(&mut message[DESCRIPTOR_SIZE..])?;
        Ok(message)
    }

    fn send(&mut self, command: &Command) -> Result<u32, PulseFailure> {
        let seq = self.seq;
        self.seq = self.seq.wrapping_add(1);
        let mut bytes = Vec::new();
        protocol::write_command_message(&mut bytes, seq, command, self.version)?;
        self.socket.write_all(&bytes)?;
        Ok(seq)
    }

    /// Sends `command` and waits for its reply. Anything else the server
    /// sends meanwhile (an event, a reply to something older) is skipped.
    fn request<R: CommandReply>(&mut self, command: Command) -> Result<R, PulseFailure> {
        let seq = self.send(&command)?;
        for _ in 0..MAX_SKIPPED {
            let message = self.read_message()?;
            match protocol::read_reply_message::<R>(&mut Cursor::new(&message[..]), self.version) {
                Ok((got, reply)) if got == seq => return Ok(reply),
                Ok(_) | Err(ProtocolError::UnexpectedCommand(_)) => continue,
                Err(error) => return Err(error.into()),
            }
        }
        Err(PulseFailure::Broken("no reply among the server's messages".to_string()))
    }

    /// Sends a command that is answered with a bare acknowledgement.
    fn command(&mut self, command: Command) -> Result<(), PulseFailure> {
        let seq = self.send(&command)?;
        for _ in 0..MAX_SKIPPED {
            let message = self.read_message()?;
            match protocol::read_ack_message(&mut Cursor::new(&message[..])) {
                Ok(got) if got == seq => return Ok(()),
                Ok(_) | Err(ProtocolError::Invalid(_)) => continue,
                Err(error) => return Err(error.into()),
            }
        }
        Err(PulseFailure::Broken("no reply among the server's messages".to_string()))
    }

    /// Closes the socket under the client, as a server that restarts does.
    #[cfg(test)]
    pub fn hang_up(&self) {
        let _ = self.socket.shutdown(std::net::Shutdown::Both);
    }

    pub fn server_info(&mut self) -> Result<ServerInfo, PulseFailure> {
        self.request(Command::GetServerInfo)
    }

    pub fn sink(&mut self, index: u32) -> Result<SinkInfo, PulseFailure> {
        self.request(Command::GetSinkInfo(GetSinkInfo { index: Some(index), name: None }))
    }

    pub fn sink_named(&mut self, name: &str) -> Result<SinkInfo, PulseFailure> {
        let name = CString::new(name).map_err(|_| PulseFailure::Broken("a sink name with a NUL in it".to_string()))?;
        self.request(Command::GetSinkInfo(GetSinkInfo { index: None, name: Some(name) }))
    }

    /// The sink sound is playing through now.
    pub fn default_sink(&mut self) -> Result<SinkInfo, PulseFailure> {
        let info = self.server_info()?;
        let name = info.default_sink_name.ok_or(PulseFailure::Refused(PulseError::NoEntity))?;
        self.request(Command::GetSinkInfo(GetSinkInfo { index: None, name: Some(name) }))
    }

    pub fn set_sink_volume(&mut self, index: u32, volume: ChannelVolume) -> Result<(), PulseFailure> {
        self.command(Command::SetSinkVolume(SetDeviceVolumeParams { device_index: Some(index), device_name: None, volume }))
    }

    /// Asks to be told when sources, sinks, cards or the server's defaults change.
    pub fn subscribe(&mut self) -> Result<(), PulseFailure> {
        let mask = SubscriptionMask::SOURCE | SubscriptionMask::SINK | SubscriptionMask::CARD | SubscriptionMask::SERVER;
        self.command(Command::Subscribe(mask))
    }

    /// Blocks until the server reports a change. Messages that are not
    /// subscription events are skipped. An error means the connection ended.
    pub fn next_event(&mut self) -> Result<SubscriptionEvent, PulseFailure> {
        loop {
            let message = self.read_message()?;
            if let Ok((_, Command::SubscribeEvent(event))) = protocol::read_command_message(&mut Cursor::new(&message[..]), self.version) {
                return Ok(event);
            }
        }
    }
}

/// Test support: a sound server on the other end of a socket pair.
#[cfg(test)]
pub mod testing {
    use std::collections::BTreeMap;
    use std::io::BufReader;
    use std::sync::{Arc, Mutex};

    use super::*;

    /// The sinks of a pretend machine, shared between the test and the server.
    #[derive(Default)]
    pub struct Rig {
        /// index to (name, per-channel raw volume).
        pub sinks: BTreeMap<u32, (String, Vec<u32>)>,
        pub default: Option<String>,
        /// How many requests have been answered.
        pub requests: usize,
        /// How many of them wrote a volume.
        pub writes: usize,
        /// Send this many unrelated events ahead of each reply.
        pub chatter: usize,
    }

    pub type SharedRig = Arc<Mutex<Rig>>;

    fn info(index: u32, name: &str, raw: &[u32]) -> SinkInfo {
        let mut cvolume = ChannelVolume::empty();
        for &value in raw {
            cvolume.push(Volume::from_u32_clamped(value));
        }
        SinkInfo { index, name: CString::new(name).unwrap(), cvolume, ..SinkInfo::default() }
    }

    fn event() -> Command {
        Command::SubscribeEvent(SubscriptionEvent {
            event_facility: SubscriptionEventFacility::SinkInput,
            event_type: SubscriptionEventType::Changed,
            index: Some(1),
        })
    }

    /// Serves one connection until the client hangs up. Speaks just enough of
    /// the protocol for `Pulse`, with the crate's own encoders.
    pub fn serve(socket: UnixStream, rig: SharedRig) {
        let mut writer = socket.try_clone().unwrap();
        let mut reader = BufReader::new(socket);
        let version = protocol::MAX_VERSION;
        while let Ok((seq, command)) = protocol::read_command_message(&mut reader, version) {
            let mut rig = rig.lock().unwrap();
            rig.requests += 1;
            for _ in 0..rig.chatter {
                protocol::write_command_message(&mut writer, u32::MAX, &event(), version).unwrap();
            }
            let refused = |writer: &mut UnixStream| protocol::write_error(writer, seq, &PulseError::NoEntity).unwrap();
            match command {
                Command::Auth(_) => {
                    let reply = AuthReply { version, use_memfd: false, use_shm: false };
                    protocol::write_reply_message(&mut writer, seq, &reply, version).unwrap();
                }
                Command::SetClientName(_) => {
                    protocol::write_reply_message(&mut writer, seq, &SetClientNameReply { client_id: 7 }, version).unwrap();
                }
                Command::GetServerInfo => {
                    let reply = ServerInfo {
                        default_sink_name: rig.default.as_ref().map(|name| CString::new(name.as_str()).unwrap()),
                        ..ServerInfo::default()
                    };
                    protocol::write_reply_message(&mut writer, seq, &reply, version).unwrap();
                }
                Command::GetSinkInfo(query) => {
                    let found = rig.sinks.iter().find(|(index, (name, _))| {
                        query.index == Some(**index) || query.name.as_ref().is_some_and(|n| n.to_str() == Ok(name.as_str()))
                    });
                    match found {
                        Some((index, (name, raw))) => {
                            protocol::write_reply_message(&mut writer, seq, &info(*index, name, raw), version).unwrap()
                        }
                        None => refused(&mut writer),
                    }
                }
                Command::SetSinkVolume(params) => {
                    let raw: Vec<u32> = params.volume.channels().iter().map(Volume::as_u32).collect();
                    match params.device_index.and_then(|index| rig.sinks.get_mut(&index)) {
                        Some(sink) => {
                            sink.1 = raw;
                            rig.writes += 1;
                            protocol::write_ack_message(&mut writer, seq).unwrap();
                        }
                        None => refused(&mut writer),
                    }
                }
                Command::Subscribe(_) => protocol::write_ack_message(&mut writer, seq).unwrap(),
                _ => refused(&mut writer),
            }
        }
    }

    /// A connected client and the rig behind its server.
    pub fn connected(rig: &SharedRig) -> Pulse {
        let (ours, theirs) = UnixStream::pair().unwrap();
        let rig = rig.clone();
        std::thread::spawn(move || serve(theirs, rig));
        let mut pulse = Pulse::over(ours, Some(Duration::from_secs(5))).unwrap();
        pulse.handshake(c"quill-test", Vec::new()).unwrap();
        pulse
    }

    pub fn rig(sinks: &[(u32, &str, &[u32])], default: Option<&str>) -> SharedRig {
        let mut rig = Rig { default: default.map(str::to_string), ..Rig::default() };
        for (index, name, raw) in sinks {
            rig.sinks.insert(*index, (name.to_string(), raw.to_vec()));
        }
        Arc::new(Mutex::new(rig))
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;

    use super::testing::{connected, rig};
    use super::*;

    fn lookup<'a>(vars: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |name| vars.iter().find(|(key, _)| *key == name).map(|(_, value)| value.to_string())
    }

    #[test]
    fn the_socket_is_looked_for_where_the_servers_listen() {
        let any = |_: &PathBuf| true;
        assert_eq!(
            socket_path(lookup(&[("XDG_RUNTIME_DIR", "/run/user/1000")]), 1000, any),
            Some(PathBuf::from("/run/user/1000/pulse/native"))
        );
        // No environment at all (started from a service): the usual place.
        assert_eq!(socket_path(lookup(&[]), 1234, any), Some(PathBuf::from("/run/user/1234/pulse/native")));
        assert_eq!(
            socket_path(lookup(&[("PULSE_RUNTIME_PATH", "/tmp/pulse-x"), ("XDG_RUNTIME_DIR", "/run/user/1000")]), 1000, any),
            Some(PathBuf::from("/tmp/pulse-x/native"))
        );
    }

    #[test]
    fn pulse_server_is_honoured_when_it_is_local() {
        let any = |_: &PathBuf| true;
        let at = |server: &str| socket_path(lookup(&[("PULSE_SERVER", server), ("XDG_RUNTIME_DIR", "/run/user/1000")]), 1000, any);
        assert_eq!(at("unix:/tmp/pulse.sock"), Some(PathBuf::from("/tmp/pulse.sock")));
        assert_eq!(at("/tmp/pulse.sock"), Some(PathBuf::from("/tmp/pulse.sock")));
        assert_eq!(at("{host}unix:/tmp/a tcp:other"), Some(PathBuf::from("/tmp/a")));
        // Another machine's server is not this machine's volume.
        assert_eq!(at("tcp:192.168.1.2:4713"), Some(PathBuf::from("/run/user/1000/pulse/native")));
        assert_eq!(at(""), Some(PathBuf::from("/run/user/1000/pulse/native")));
    }

    #[test]
    fn a_socket_that_is_not_there_is_passed_over() {
        let only_default = |path: &PathBuf| path == &PathBuf::from("/run/user/1000/pulse/native");
        assert_eq!(
            socket_path(lookup(&[("PULSE_SERVER", "unix:/gone"), ("XDG_RUNTIME_DIR", "/elsewhere")]), 1000, only_default),
            Some(PathBuf::from("/run/user/1000/pulse/native"))
        );
        assert_eq!(socket_path(lookup(&[("XDG_RUNTIME_DIR", "/run/user/1000")]), 1000, |_| false), None);
    }

    #[test]
    fn volumes_convert_both_ways_without_drift() {
        assert_eq!(to_scalar(Volume::NORM), 1.0);
        assert_eq!(to_scalar(Volume::MUTED), 0.0);
        assert_eq!(from_scalar(1.0), Volume::NORM);
        assert_eq!(from_scalar(0.5).as_u32(), 32768);
        // Every step of the slider survives the round trip, boosted ones too.
        for raw in [0u32, 1, 655, 9830, 32768, 43690, 65535, 65536, 98304] {
            let volume = Volume::from_u32_clamped(raw);
            assert_eq!(from_scalar(to_scalar(volume)), volume, "{raw}");
        }
        assert_eq!(to_scalar(Volume::from_u32_clamped(98304)), 1.5);
    }

    #[test]
    fn nonsense_volumes_become_silence_not_a_blast() {
        assert_eq!(from_scalar(f32::NAN), Volume::MUTED);
        assert_eq!(from_scalar(f32::INFINITY), Volume::MUTED);
        assert_eq!(from_scalar(-0.3), Volume::MUTED);
    }

    #[test]
    fn one_channel_is_changed_and_the_rest_kept() {
        let mut stereo = ChannelVolume::empty();
        stereo.push(Volume::from_u32_clamped(40000));
        stereo.push(Volume::from_u32_clamped(20000));
        let changed = with_channel(&stereo, 1, 0.5).unwrap();
        let raw: Vec<u32> = changed.channels().iter().map(Volume::as_u32).collect();
        assert_eq!(raw, vec![40000, 32768]);
        assert!(with_channel(&stereo, 2, 0.5).is_none());
    }

    #[test]
    fn only_comings_and_goings_count_as_a_device_change() {
        use SubscriptionEventFacility as F;
        use SubscriptionEventType as T;
        let event = |event_facility, event_type| SubscriptionEvent { event_facility, event_type, index: Some(3) };
        for (facility, kind) in [(F::Source, T::New), (F::Source, T::Removed), (F::Sink, T::New), (F::Sink, T::Removed), (F::Card, T::New)] {
            assert!(is_device_change(&event(facility, kind)), "{facility:?} {kind:?}");
        }
        // The default input or output moved.
        assert!(is_device_change(&event(F::Server, T::Changed)));
        // A volume slider moving, an app starting to play: not a device change.
        for (facility, kind) in [(F::Source, T::Changed), (F::Sink, T::Changed), (F::SinkInput, T::New), (F::Client, T::New), (F::Card, T::Changed)] {
            assert!(!is_device_change(&event(facility, kind)), "{facility:?} {kind:?}");
        }
    }

    #[test]
    fn the_default_sink_is_read_and_written() {
        let rig = rig(&[(4, "speakers", &[65536, 65536]), (9, "headset", &[30000, 30000])], Some("headset"));
        let mut pulse = connected(&rig);
        let sink = pulse.default_sink().unwrap();
        assert_eq!((sink.index, sink.name.to_str().unwrap()), (9, "headset"));
        assert_eq!(to_scalar(sink.cvolume.channels()[0]), 30000.0 / 65536.0);

        pulse.set_sink_volume(9, with_channel(&sink.cvolume, 0, 0.25).unwrap()).unwrap();
        assert_eq!(rig.lock().unwrap().sinks[&9].1, vec![16384, 30000]);
        assert_eq!(pulse.sink_named("speakers").unwrap().index, 4);
        assert_eq!(pulse.sink(4).unwrap().name.to_str().unwrap(), "speakers");
    }

    #[test]
    fn a_missing_sink_is_refused_and_the_connection_lives_on() {
        let rig = rig(&[(4, "speakers", &[65536])], None);
        let mut pulse = connected(&rig);
        assert!(matches!(pulse.sink_named("gone"), Err(PulseFailure::Refused(PulseError::NoEntity))));
        assert!(matches!(pulse.default_sink(), Err(PulseFailure::Refused(PulseError::NoEntity))));
        assert!(matches!(pulse.set_sink_volume(77, ChannelVolume::norm(2)), Err(PulseFailure::Refused(_))));
        assert_eq!(pulse.sink(4).unwrap().index, 4);
    }

    #[test]
    fn events_that_arrive_between_request_and_reply_are_skipped() {
        let rig = rig(&[(4, "speakers", &[65536, 65536])], Some("speakers"));
        let mut pulse = connected(&rig);
        rig.lock().unwrap().chatter = 3;
        assert_eq!(pulse.default_sink().unwrap().index, 4);
        pulse.set_sink_volume(4, ChannelVolume::norm(2)).unwrap();
        pulse.subscribe().unwrap();
        assert_eq!(pulse.sink(4).unwrap().index, 4);
    }

    #[test]
    fn subscription_events_are_handed_out_one_by_one() {
        let (ours, mut theirs) = UnixStream::pair().unwrap();
        let mut pulse = Pulse::over(ours, Some(Duration::from_secs(5))).unwrap();
        let version = protocol::MAX_VERSION;
        // An acknowledgement nobody is waiting for, then two events.
        protocol::write_ack_message(&mut theirs, 40).unwrap();
        for (facility, kind) in [
            (SubscriptionEventFacility::Source, SubscriptionEventType::New),
            (SubscriptionEventFacility::Server, SubscriptionEventType::Changed),
        ] {
            let event = SubscriptionEvent { event_facility: facility, event_type: kind, index: Some(2) };
            protocol::write_command_message(&mut theirs, u32::MAX, &Command::SubscribeEvent(event), version).unwrap();
        }
        assert_eq!(pulse.next_event().unwrap().event_facility, SubscriptionEventFacility::Source);
        assert_eq!(pulse.next_event().unwrap().event_facility, SubscriptionEventFacility::Server);
        // The server goes away: the watcher is told, it does not spin.
        drop(theirs);
        assert!(matches!(pulse.next_event(), Err(PulseFailure::Broken(_))));
    }

    #[test]
    fn a_server_that_hangs_up_or_talks_nonsense_is_broken_not_a_hang() {
        let (ours, mut theirs) = UnixStream::pair().unwrap();
        let mut pulse = Pulse::over(ours, Some(Duration::from_secs(5))).unwrap();
        // A descriptor that promises more than any real message carries.
        theirs.write_all(&[0xff; DESCRIPTOR_SIZE]).unwrap();
        assert!(matches!(pulse.server_info(), Err(PulseFailure::Broken(_))));

        let (ours, theirs) = UnixStream::pair().unwrap();
        let mut pulse = Pulse::over(ours, Some(Duration::from_secs(5))).unwrap();
        drop(theirs);
        assert!(matches!(pulse.server_info(), Err(PulseFailure::Broken(_))));
    }

    #[test]
    fn a_silent_server_runs_into_the_deadline() {
        let (ours, _theirs) = UnixStream::pair().unwrap();
        let mut pulse = Pulse::over(ours, Some(Duration::from_millis(60))).unwrap();
        let started = std::time::Instant::now();
        assert!(matches!(pulse.server_info(), Err(PulseFailure::Broken(_))));
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}

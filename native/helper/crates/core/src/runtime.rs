//! The threads around the session: the stdin reader, the controller loop, and
//! the one way out of the process (section 3.3). Every exit the helper
//! controls restores a ducked output volume first.

use std::io::BufRead;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, RecvTimeoutError};

use crate::bus::{Bus, Msg};
use crate::caps::Ducker;
use crate::command::{self, Command};
use crate::logln;
use crate::session::Session;

static QUIT: AtomicBool = AtomicBool::new(false);
static EXITING: AtomicBool = AtomicBool::new(false);
static DUCKER: OnceLock<Arc<dyn Ducker>> = OnceLock::new();

/// How long a `quit` or a closed stdin waits for the controller before the
/// reader thread ends the process itself. Main sends SIGTERM after 1500 ms.
const QUIT_GRACE: Duration = Duration::from_millis(750);
/// How long a volume restore may take before the exit goes ahead without it.
const RESTORE_GRACE: Duration = Duration::from_millis(1000);

/// Restores the output volume and ends the process. Safe from any thread; the
/// first caller wins and later ones wait for it.
pub fn exit(reason: &str, code: i32) -> ! {
    if EXITING.swap(true, Ordering::SeqCst) {
        loop {
            std::thread::park();
        }
    }
    // A restore stuck on a dead audio server must not keep the process alive.
    let _ = std::thread::Builder::new().name("exit-watchdog".to_string()).spawn(move || {
        std::thread::sleep(RESTORE_GRACE);
        end_process(code);
    });
    if let Some(ducker) = DUCKER.get() {
        ducker.restore();
    }
    logln!("exit: {reason}");
    crate::event::seal_stdout();
    end_process(code)
}

extern "C" {
    /// C's `_exit` (POSIX, and the Windows C runtime under the same name).
    fn _exit(code: std::ffi::c_int) -> !;
}

/// Ends the process now, without running C exit handlers or static
/// destructors. Nothing of ours needs them: every event is flushed as it is
/// written, the log is written line by line, and the volume is already back.
/// What they would run is library teardown, which is slow (whisper's GPU
/// backend takes 250 to 500 ms to take itself apart) and has been seen to
/// abort the process when a model is still in use on another thread. Main
/// respawns a helper 500 ms after one dies, so a slow exit would also leave
/// two helpers alive side by side.
fn end_process(code: i32) -> ! {
    // SAFETY: `_exit` takes any code and does not return.
    unsafe { _exit(code) }
}

/// SIGTERM, SIGINT and SIGHUP (Ctrl-C and console close on Windows) leave
/// through [`exit`] with code 0. A panic on any thread restores the volume,
/// goes to the log and to stderr, and ends the process with code 101, so main
/// sees a crash and respawns instead of waiting on a helper with a dead thread.
pub fn install_exit_paths() {
    let _ = ctrlc::set_handler(|| exit("signal", 0));
    std::panic::set_hook(Box::new(|info| {
        let text = info.to_string();
        logln!("panic: {text}");
        eprintln!("flow-stt panic: {text}");
        exit("panic", 101);
    }));
}

/// Reads commands until `quit` or end of input. `quit` acts the moment it is
/// read: it overtakes whatever is still queued for the controller.
pub fn spawn_stdin_reader(bus: Bus) {
    let reader = move || {
        let mut input = std::io::stdin().lock();
        let mut line = Vec::new();
        loop {
            line.clear();
            match input.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            if line.last() == Some(&b'\n') {
                line.pop();
            }
            // There is no length limit: an `insert` line carries a whole dictation.
            let Ok(text) = std::str::from_utf8(&line) else { continue };
            match command::parse(text) {
                Some(Command::Quit) => {
                    QUIT.store(true, Ordering::SeqCst);
                    bus.send(Msg::Command(Command::Quit));
                    std::thread::sleep(QUIT_GRACE);
                    exit("quit (controller busy)", 0);
                }
                Some(command) => bus.send(Msg::Command(command)),
                None => {
                    // The verb only: the argument may be the user's own words.
                    let verb: String = text.trim_start().chars().take_while(|c| !c.is_whitespace()).take(24).collect();
                    if !verb.is_empty() {
                        logln!("ignored line: {verb}");
                    }
                }
            }
        }
        bus.send(Msg::Eof);
        std::thread::sleep(QUIT_GRACE);
        exit("stdin closed (controller busy)", 0);
    };
    if std::thread::Builder::new().name("stdin".to_string()).spawn(reader).is_err() {
        exit("could not start the stdin reader", 1);
    }
}

/// The controller loop: boots the session, then feeds it messages and timer
/// ticks until the helper is told to go. Call it on the thread that built the
/// backends; it never returns.
pub fn run(mut session: Session, rx: Receiver<Msg>) -> ! {
    let _ = DUCKER.set(session.ducker());
    session.boot(Instant::now());
    loop {
        let msg = match session.next_deadline() {
            Some(deadline) => match rx.recv_deadline(deadline) {
                Ok(msg) => Some(msg),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => exit("bus closed", 0),
            },
            None => match rx.recv() {
                Ok(msg) => Some(msg),
                Err(_) => exit("bus closed", 0),
            },
        };
        if let Some(reason) = turn(&mut session, &rx, msg) {
            exit(reason, 0);
        }
    }
}

/// One turn of the controller: `first` (the message the wait ended on, if
/// any), then everything that was already queued behind it, then the timers.
/// Returns why the helper should exit, if it should.
///
/// The backlog goes before the timers because a timer is judged against the
/// wall clock while the messages that would cancel it carry the time they
/// happened at. When a message holds the controller up (opening a slow
/// microphone takes a second), the key edges of a double tap queue up behind
/// it. Judging the first tap's "no second tap came" deadline before reading
/// the second tap would call a double tap a stray tap and cancel the dictation.
/// `now` is read before the backlog is counted, so every key edge older than
/// `now` is among the messages handled before the timers see `now`. The count
/// is taken once: messages that arrive during the turn wait for the next one,
/// so a steady stream of audio cannot keep the timers from running.
fn turn(session: &mut Session, rx: &Receiver<Msg>, first: Option<Msg>) -> Option<&'static str> {
    if let Some(msg) = first {
        if let Some(reason) = deliver(session, msg) {
            return Some(reason);
        }
    }
    let now = Instant::now();
    for _ in 0..rx.len() {
        let Ok(msg) = rx.try_recv() else { break };
        if let Some(reason) = deliver(session, msg) {
            return Some(reason);
        }
    }
    session.tick(now);
    None
}

/// Hands one message to the session, or says why the helper should exit.
fn deliver(session: &mut Session, msg: Msg) -> Option<&'static str> {
    if QUIT.load(Ordering::SeqCst) {
        return Some("quit");
    }
    match msg {
        Msg::Eof => Some("stdin closed"),
        Msg::Command(Command::Quit) => Some("quit"),
        msg => {
            session.handle(msg, Instant::now());
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::event::{Event, EventSink};
    use crate::gesture::KeyEdge;

    #[derive(Default)]
    struct Collector(Mutex<Vec<String>>);

    impl EventSink for Collector {
        fn emit(&self, event: &Event) {
            self.0.lock().unwrap().push(serde_json::to_string(event).unwrap());
        }
    }

    struct Rig {
        session: Session,
        bus: Bus,
        rx: Receiver<Msg>,
        out: Arc<Collector>,
        /// A moment far enough back that every deadline in a test is already
        /// past on the wall clock, as it is after the controller was held up.
        t0: Instant,
    }

    impl Rig {
        fn new() -> Self {
            let (bus, rx) = Bus::new();
            let out = Arc::new(Collector::default());
            let session = Session::new(crate::unsupported::backends(), out.clone(), bus.clone(), "flow-stt test");
            let t0 = Instant::now().checked_sub(Duration::from_secs(2)).expect("the clock is at least two seconds old");
            Rig { session, bus, rx, out, t0 }
        }
        fn key(&self, edge: KeyEdge, ms: u64) {
            self.bus.key(edge, self.t0 + Duration::from_millis(ms));
        }
        /// What `run` does once its wait ends on a message.
        fn turn(&mut self) -> Option<&'static str> {
            let first = self.rx.try_recv().ok();
            turn(&mut self.session, &self.rx, first)
        }
        fn take(&self) -> Vec<String> {
            std::mem::take(&mut *self.out.0.lock().unwrap())
        }
    }

    const START: &str = r#"{"type":"hotkey","intent":"start","latched":false}"#;
    const START_LATCHED: &str = r#"{"type":"hotkey","intent":"start","latched":true}"#;
    const STOP: &str = r#"{"type":"hotkey","intent":"stop"}"#;
    const CANCEL: &str = r#"{"type":"hotkey","intent":"cancel"}"#;

    #[test]
    fn a_double_tap_read_late_latches_without_a_cancel() {
        let mut r = Rig::new();
        r.key(KeyEdge::Down, 0);
        assert_eq!(r.turn(), None);
        assert_eq!(r.take(), vec![START]);
        // The controller was busy (opening the microphone) while the rest of
        // the double tap happened. The first release's 350 ms ran out on the
        // wall clock long ago, but the second press is right behind it.
        r.key(KeyEdge::Up, 80);
        r.key(KeyEdge::Down, 200);
        r.key(KeyEdge::Up, 280);
        assert_eq!(r.turn(), None);
        assert_eq!(r.take(), vec![START_LATCHED]);
        assert!(r.rx.is_empty());
        // The one tap that ends hands-free is a stop, with no cancel after it.
        r.key(KeyEdge::Down, 1500);
        r.key(KeyEdge::Up, 1560);
        assert_eq!(r.turn(), None);
        assert_eq!(r.take(), vec![STOP]);
        assert_eq!(r.session.next_deadline(), None);
    }

    #[test]
    fn a_lone_tap_read_late_still_cancels() {
        let mut r = Rig::new();
        r.key(KeyEdge::Down, 0);
        r.key(KeyEdge::Up, 80);
        assert_eq!(r.turn(), None);
        assert_eq!(r.take(), vec![START, CANCEL]);
    }

    #[test]
    fn a_tap_waits_out_its_window_when_nothing_is_late() {
        let mut r = Rig::new();
        let now = Instant::now();
        r.bus.key(KeyEdge::Down, now);
        r.bus.key(KeyEdge::Up, now + Duration::from_millis(1));
        assert_eq!(r.turn(), None);
        assert_eq!(r.take(), vec![START]);
        assert!(r.session.next_deadline().is_some_and(|due| due > Instant::now()));
    }

    #[test]
    fn end_of_input_and_quit_stop_the_turn_where_they_are_read() {
        let mut r = Rig::new();
        r.key(KeyEdge::Down, 0);
        r.bus.send(Msg::Eof);
        r.key(KeyEdge::Up, 400);
        assert_eq!(r.turn(), Some("stdin closed"));
        assert_eq!(r.take(), vec![START]);

        let mut r = Rig::new();
        r.bus.send(Msg::Command(Command::Quit));
        assert_eq!(r.turn(), Some("quit"));
    }
}

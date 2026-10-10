//! flow-stt: Quill's native helper.
//!
//! Electron main spawns it with three pipes and drives it over the line
//! protocol in docs/HELPER-PROTOCOL.md: commands on stdin, one JSON event per
//! line on stdout. This file only wires threads together; the behaviour is in
//! `quill_core::session`, and what is OS specific is under `platform/`.

use std::sync::Arc;

use quill_core::bus::Bus;
use quill_core::event::StdoutSink;
use quill_core::runtime;
use quill_core::session::Session;

mod asr;
mod audio_shared;
mod platform;

/// Name and version, as reported in the capabilities handshake.
const HELPER: &str = concat!("flow-stt ", env!("CARGO_PKG_VERSION"));

fn main() {
    // For build scripts. Main never passes arguments.
    if std::env::args().nth(1).as_deref() == Some("--version") {
        println!("{HELPER}");
        return;
    }

    runtime::install_exit_paths();
    let (bus, rx) = Bus::new();
    // Main writes its settings straight after spawn, so reading starts before
    // anything else; the controller handles those lines once it has booted.
    runtime::spawn_stdin_reader(bus.clone());

    let controller = std::thread::Builder::new().name("controller".to_string()).spawn(move || {
        // Built here, not on the main thread: the audio and hotkey backends
        // stay on the thread that uses them.
        let backends = platform::backends(&bus);
        let session = Session::new(backends, Arc::new(StdoutSink), bus, HELPER);
        runtime::run(session, rx)
    });
    if controller.is_err() {
        runtime::exit("could not start the controller thread", 1);
    }
    platform::run_main_loop()
}

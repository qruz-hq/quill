//! What the main thread does for the life of the process.
//!
//! Nothing on Linux: the X11 key listener, the device watcher and the audio
//! stream each run on a thread of their own. The process ends through
//! `quill_core::runtime::exit`.

pub fn run() -> ! {
    loop {
        std::thread::park();
    }
}

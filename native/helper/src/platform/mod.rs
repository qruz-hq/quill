//! Picks the backends for the OS this binary is built for.
//!
//! Each OS folder has one file per capability, each exposing a `create`
//! function that returns the trait object the session drives. Until a backend
//! exists its file returns the stand-in from `quill_core::unsupported`.

use quill_core::bus::Bus;
use quill_core::caps::Backends;

#[cfg(target_os = "macos")]
#[path = "macos/mod.rs"]
mod imp;

#[cfg(windows)]
#[path = "windows/mod.rs"]
mod imp;

#[cfg(not(any(target_os = "macos", windows)))]
#[path = "linux/mod.rs"]
mod imp;

/// The Windows backend's OS-free logic (key table, hook decisions, paste
/// chord, volume controls, privacy switches), so its unit tests run on the
/// machine the helper is developed on. Tests only; never part of a build.
#[cfg(all(test, not(windows)))]
#[path = "windows/pure.rs"]
mod windows_pure;

/// Builds every backend. Call it on the controller thread: the audio and
/// hotkey backends are used there and need not be `Send`.
pub fn backends(bus: &Bus) -> Backends {
    Backends {
        audio: imp::audio::create(bus),
        watcher: imp::devices::create(bus),
        transcriber: crate::asr::create(),
        hotkey: imp::hotkey::create(bus),
        inserter: imp::insert::create(bus),
        ducker: imp::duck::create(),
        permissions: imp::permissions::create(),
        calendar: imp::calendar::create(),
    }
}

/// Parks the main thread the way this OS needs (a run loop on macOS).
pub fn run_main_loop() -> ! {
    imp::mainloop::run()
}

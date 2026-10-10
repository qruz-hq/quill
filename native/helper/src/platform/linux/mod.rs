//! Linux backends, one file per capability. See ../../../README.md for who
//! owns which file.
//!
//! Besides the capability files: `desktop.rs` works out whether the session
//! is X11 or Wayland, `x11.rs` and `keymap.rs` are what the hold key and the
//! paste chord share, and `pulse.rs` is the sound server client behind
//! ducking and hot-plug.
//!
//! What links against the system: ALSA only (through cpal). X11, Wayland's
//! clipboard and the sound server are spoken to over their sockets by Rust
//! crates, so a machine that lacks one of them still starts the helper and
//! gets a handshake that leaves the matching capability out.
//!
//! Type-checking this folder from a Mac. Nothing here builds for macOS, but
//! `cargo check` never links, and the one build script that looks for a
//! system library (`alsa-sys`) only needs pkg-config to say yes:
//!
//! ```text
//! rustup target add x86_64-unknown-linux-gnu
//! printf '#!/bin/sh\ncase "$*" in *--version*) echo 0.29.2;; *--modversion*) echo 1.2.10;; *) echo -lasound;; esac\n' > /tmp/pkg-config
//! chmod +x /tmp/pkg-config
//! PKG_CONFIG=/tmp/pkg-config PKG_CONFIG_ALLOW_CROSS=1 \
//!     cargo clippy --target x86_64-unknown-linux-gnu --all-targets
//! ```
//!
//! That proves types, not behaviour: the tests in this folder only run on
//! Linux (`cargo test`), and docs/HELPER-MANUAL-TESTS.md has the rest.

pub mod audio;
pub mod calendar;
pub mod devices;
pub mod duck;
pub mod hotkey;
pub mod insert;
pub mod mainloop;
pub mod permissions;

mod desktop;
mod keymap;
mod pulse;
mod x11;

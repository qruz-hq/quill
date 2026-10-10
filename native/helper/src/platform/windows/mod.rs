//! Windows backends, one file per capability. See ../../../README.md for who
//! owns which file, and README.md in this folder for what is particular to
//! Windows (the hold key table, elevated windows, the whisper build).

pub mod audio;
pub mod calendar;
pub mod devices;
pub mod duck;
pub mod hotkey;
pub mod insert;
pub mod mainloop;
pub mod permissions;

mod com;
mod input;

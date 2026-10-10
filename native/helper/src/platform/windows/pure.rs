//! The Windows backend's OS-free logic, compiled on other systems for its
//! unit tests only (`platform/mod.rs` pulls this in under `cfg(test)` when not
//! building for Windows). On Windows the same files are compiled where they
//! are used: `hotkey.rs`, `insert.rs`, `duck.rs` and `permissions.rs` each
//! declare their own.
//!
//! The modules are siblings here because `press.rs` reaches `keys.rs` through
//! `super`, exactly as it does under `hotkey` on Windows.

#![allow(dead_code)]

#[path = "hotkey/keys.rs"]
mod keys;
#[path = "hotkey/press.rs"]
mod press;

#[path = "insert/plan.rs"]
mod plan;

#[path = "duck/controls.rs"]
mod controls;

#[path = "permissions/consent.rs"]
mod consent;

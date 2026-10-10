//! Capability `calendar`: todos to the system calendar.
//!
//! Not on Linux: there is no system calendar store to write to (each desktop
//! has its own, behind its own account setup). The stand-in answers every
//! `cal` with `error: "unsupported"` and keeps the capability out of the
//! handshake, so the app hides its calendar settings.

use std::sync::Arc;

use quill_core::caps::Calendar;
use quill_core::unsupported::NoCalendar;

pub fn create() -> Arc<dyn Calendar> {
    Arc::new(NoCalendar)
}

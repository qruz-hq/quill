//! Capability `calendar`: todos to the system calendar.
//!
//! Windows plan: none: Windows has no system calendar store.
//! Not implemented yet: this returns the stand-in, which reports "unsupported"
//! and keeps the capability out of the handshake. Replace `create`.

use std::sync::Arc;

use quill_core::caps::Calendar;
use quill_core::unsupported::NoCalendar;

pub fn create() -> Arc<dyn Calendar> {
    Arc::new(NoCalendar)
}

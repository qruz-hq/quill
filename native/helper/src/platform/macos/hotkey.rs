//! Capability `hotkey`: the global hold key, reported as raw edges.
//!
//! An active CGEventTap on `flagsChanged` and `keyDown`, attached to the main
//! run loop (`mainloop.rs` runs it). The callback decides in a few hundred
//! nanoseconds whether to swallow the event and posts the edge to the session,
//! where the gestures live (`quill_core::gesture`). What it decides is the pure
//! code in `hotkey/press.rs`; this file is the OS shell around it.
//!
//! Threads: `install`, `set_key` and friends run on the controller thread, the
//! callback on the main thread. They share [`Shared`]: two atomics for the
//! settings and one mutex around the press state and the tap itself.

use std::ffi::c_void;
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Instant;

use core_foundation::base::{kCFAllocatorDefault, CFRelease};
use core_foundation::mach_port::{CFMachPortCreateRunLoopSource, CFMachPortInvalidate, CFMachPortRef};
use core_foundation::runloop::{
    kCFRunLoopCommonModes, CFRunLoopAddSource, CFRunLoopGetMain, CFRunLoopRemoveSource, CFRunLoopSourceRef, CFRunLoopWakeUp,
};
use quill_core::bus::Bus;
use quill_core::caps::{Hotkey, HotkeyError};
use quill_core::logln;

use super::permissions::accessibility_trusted;

mod press;

use press::Press;

// CGEventTypes.h. Plain integers here: the callback is handed whatever the
// system sends, including values that are not event types at all.
const EVENT_KEY_DOWN: u32 = 10;
const EVENT_FLAGS_CHANGED: u32 = 12;
const EVENT_TAP_DISABLED_BY_TIMEOUT: u32 = 0xFFFF_FFFE;
const EVENT_TAP_DISABLED_BY_USER_INPUT: u32 = 0xFFFF_FFFF;
/// kCGSessionEventTap: the user's login session, after the HID layer.
const TAP_SESSION: u32 = 1;
/// kCGHeadInsertEventTap: ahead of taps that are already there.
const TAP_HEAD_INSERT: u32 = 0;
/// kCGEventTapOptionDefault: an active tap, one that may drop events.
const TAP_ACTIVE: u32 = 0;
/// kCGKeyboardEventKeycode.
const FIELD_KEYCODE: u32 = 9;
/// kCGEventSourceStateCombinedSessionState.
const STATE_COMBINED_SESSION: i32 = 0;

type CGEventRef = *mut c_void;
type TapCallback = unsafe extern "C" fn(proxy: *mut c_void, kind: u32, event: CGEventRef, info: *mut c_void) -> CGEventRef;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventTapCreate(tap: u32, place: u32, options: u32, events: u64, callback: TapCallback, info: *mut c_void) -> CFMachPortRef;
    fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
    fn CGEventTapIsEnabled(tap: CFMachPortRef) -> bool;
    fn CGEventGetIntegerValueField(event: CGEventRef, field: u32) -> i64;
    fn CGEventGetFlags(event: CGEventRef) -> u64;
    fn CGEventSourceFlagsState(state: i32) -> u64;
}

/// `key` when the hold key is off.
const KEY_OFF: i64 = -1;

/// An installed tap: the mach port events arrive on and its run loop source.
/// Both are owned (+1 each) and released in `drop`.
struct Tap {
    port: CFMachPortRef,
    source: CFRunLoopSourceRef,
}

// SAFETY: CFMachPort and CFRunLoopSource are thread-safe Core Foundation
// objects, and every call made on them here (enable, is-enabled, invalidate,
// remove from a run loop, release) is documented as safe from any thread.
unsafe impl Send for Tap {}

impl Drop for Tap {
    fn drop(&mut self) {
        // SAFETY: both pointers came from Create functions in `install`, are
        // non-null, and this is their only owner, so each is released exactly
        // once. A callback that is running on the main thread right now is
        // unaffected: it is handed no pointer of ours (no user info), it only
        // reaches the port through `Shared::inner`, which no longer holds this
        // tap, and the run loop keeps its own reference to the source and
        // port for the length of the call.
        unsafe {
            CGEventTapEnable(self.port, false);
            CFRunLoopRemoveSource(CFRunLoopGetMain(), self.source, kCFRunLoopCommonModes);
            CFMachPortInvalidate(self.port);
            CFRelease(self.source.cast());
            CFRelease(self.port.cast());
        }
    }
}

#[derive(Default)]
struct Inner {
    press: Press,
    tap: Option<Tap>,
}

/// What the controller thread and the tap callback share. One per process:
/// the callback is a plain C function with no user info, so it finds this
/// through [`SHARED`] and nothing it reads can be freed under it.
struct Shared {
    bus: Bus,
    /// The hold key's keycode, or [`KEY_OFF`].
    key: AtomicI64,
    /// Keep a standalone release from the system (`fn-capture-on|off`).
    swallow: AtomicBool,
    /// The system turned the tap off and would not turn it back on.
    lost: AtomicBool,
    inner: Mutex<Inner>,
}

static SHARED: OnceLock<Shared> = OnceLock::new();

impl Shared {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        // Nothing in here can be left half done by a panic.
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn key(&self) -> Option<u32> {
        u32::try_from(self.key.load(Ordering::Relaxed)).ok()
    }

    /// The system disabled the tap (a slow callback, or secure input ended).
    /// Runs on the main thread, inside the callback.
    fn tap_disabled(&self, at: Instant) {
        let mut inner = self.lock();
        let Some(tap) = inner.tap.as_ref() else { return };
        // SAFETY: `tap.port` is alive: a tap is only dropped after it has been
        // taken out of `inner`, and we hold that lock.
        let enabled = unsafe {
            CGEventTapEnable(tap.port, true);
            CGEventTapIsEnabled(tap.port)
        };
        if enabled {
            // The release may have gone by while the tap was off. Without
            // this the next press would look like a repeat and be dropped.
            // SAFETY: reads the session's modifier state; no arguments of ours.
            let flags = unsafe { CGEventSourceFlagsState(STATE_COMBINED_SESSION) };
            let missed = inner.press.resync(flags, self.key());
            drop(inner);
            if let Some(edge) = missed {
                self.bus.key(edge, at);
            }
            logln!("hotkey: tap re-enabled after system disable");
            return;
        }
        // It will not come back (the grant was withdrawn). End the press in
        // progress and let the session's poll install a fresh tap.
        let ended = inner.press.resync(0, self.key());
        drop(inner);
        if let Some(edge) = ended {
            self.bus.key(edge, at);
        }
        self.lost.store(true, Ordering::Relaxed);
        let reason = if accessibility_trusted() { "tapCreate failed" } else { "accessibility" };
        logln!("hotkey: tap disabled by the system and could not be re-enabled ({reason})");
        self.bus.hotkey_status(false, Some(reason));
    }
}

/// The tap's callback. Must return quickly: the system disables a slow tap.
///
/// SAFETY (as a callback): called by the system on the run loop the source
/// was added to (the main thread) with an event that is valid for the length
/// of the call, or null with the two "tap disabled" notices. Returning the
/// event passes it on, returning null drops it; in both cases the system
/// keeps ownership, so nothing is retained or released here.
unsafe extern "C" fn on_event(_proxy: *mut c_void, kind: u32, event: CGEventRef, _info: *mut c_void) -> CGEventRef {
    let at = Instant::now();
    let Some(shared) = SHARED.get() else { return event };
    match kind {
        EVENT_TAP_DISABLED_BY_TIMEOUT | EVENT_TAP_DISABLED_BY_USER_INPUT => shared.tap_disabled(at),
        EVENT_KEY_DOWN => {
            // Any non-modifier key while the hold key is down makes the press
            // a combination. Reported once per press, so typing costs a lock
            // and nothing else.
            let edge = shared.lock().press.key_down();
            if let Some(edge) = edge {
                shared.bus.key(edge, at);
            }
        }
        EVENT_FLAGS_CHANGED if !event.is_null() => {
            // SAFETY: `event` is a live CGEvent for the length of this call.
            let (keycode, flags) = unsafe { (CGEventGetIntegerValueField(event, FIELD_KEYCODE), CGEventGetFlags(event)) };
            let verdict = shared.lock().press.flags_changed(keycode, flags, shared.key(), shared.swallow.load(Ordering::Relaxed));
            if let Some(edge) = verdict.edge {
                shared.bus.key(edge, at);
            }
            if verdict.swallow {
                // Consumed: macOS never sees the bare release.
                return ptr::null_mut();
            }
        }
        _ => {}
    }
    event
}

/// Creates a tap, attaches it to the main run loop and turns it on.
fn open_tap() -> Result<Tap, HotkeyError> {
    let events = (1u64 << EVENT_FLAGS_CHANGED) | (1u64 << EVENT_KEY_DOWN);
    // SAFETY: `on_event` has the signature CGEventTapCallBack and is a plain
    // function, so it outlives any tap; no user info is passed. The result
    // follows the Create rule: non-null means we own one reference.
    let port = unsafe { CGEventTapCreate(TAP_SESSION, TAP_HEAD_INSERT, TAP_ACTIVE, events, on_event, ptr::null_mut()) };
    if port.is_null() {
        // Right after a grant the tap can still be refused for a moment; the
        // session's poll keeps trying until it takes.
        return Err(HotkeyError { reason: "tapCreate failed".to_string(), retry: true });
    }
    // SAFETY: `port` is the live mach port created above. The source follows
    // the Create rule too. If there is none, the port is invalidated and
    // released here, so nothing leaks on the error path.
    let source = unsafe { CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0) };
    if source.is_null() {
        unsafe {
            CFMachPortInvalidate(port);
            CFRelease(port.cast());
        }
        return Err(HotkeyError { reason: "tapCreate failed".to_string(), retry: true });
    }
    // From here `Tap` owns both and releases them when dropped.
    let tap = Tap { port, source };
    // SAFETY: adding a source to another thread's run loop is thread-safe; the
    // run loop retains the source. The main loop may be asleep in mach_msg,
    // so it is woken to pick the new source up.
    unsafe {
        let main = CFRunLoopGetMain();
        CFRunLoopAddSource(main, tap.source, kCFRunLoopCommonModes);
        CGEventTapEnable(tap.port, true);
        CFRunLoopWakeUp(main);
    }
    Ok(tap)
}

struct EventTap {
    shared: &'static Shared,
}

impl Hotkey for EventTap {
    fn supported(&self) -> bool {
        true
    }

    fn swallows(&self) -> bool {
        true
    }

    fn hold_keys(&self) -> Vec<u32> {
        press::HOLD_KEYS.to_vec()
    }

    fn install(&mut self) -> Result<(), HotkeyError> {
        if self.installed() {
            return Ok(());
        }
        // A tap the system killed is torn down before its replacement goes in.
        let dead = self.shared.lock().tap.take();
        drop(dead);
        self.shared.lost.store(false, Ordering::Relaxed);
        // Never prompts: the app's onboarding asks, after explaining why.
        if !accessibility_trusted() {
            return Err(HotkeyError { reason: "accessibility".to_string(), retry: true });
        }
        let tap = open_tap()?;
        let mut inner = self.shared.lock();
        inner.press = Press::default();
        inner.tap = Some(tap);
        Ok(())
    }

    fn installed(&self) -> bool {
        !self.shared.lost.load(Ordering::Relaxed) && self.shared.lock().tap.is_some()
    }

    fn set_key(&mut self, key: Option<u32>) {
        self.shared.key.store(key.map_or(KEY_OFF, i64::from), Ordering::Relaxed);
        // A press of the old key is not a press of the new one.
        self.shared.lock().press = Press::default();
    }

    fn set_swallow(&mut self, on: bool) {
        self.shared.swallow.store(on, Ordering::Relaxed);
    }
}

impl Drop for EventTap {
    fn drop(&mut self) {
        let tap = self.shared.lock().tap.take();
        drop(tap);
    }
}

/// `bus` is how the tap callback reaches the session.
pub fn create(bus: &Bus) -> Box<dyn Hotkey> {
    let shared = SHARED.get_or_init(|| Shared {
        bus: bus.clone(),
        key: AtomicI64::new(i64::from(press::DEFAULT_KEY)),
        swallow: AtomicBool::new(true),
        lost: AtomicBool::new(false),
        inner: Mutex::new(Inner::default()),
    });
    Box::new(EventTap { shared })
}

#[cfg(test)]
mod tests {
    use super::*;

    // No test installs a tap: an active tap on the session would sit in front
    // of the keyboard of whoever runs the tests. What the callback decides is
    // covered in `press.rs`; the tap itself is in docs/HELPER-MANUAL-TESTS.md.

    #[test]
    fn the_backend_reports_what_it_offers_before_any_tap_exists() {
        let (bus, _rx) = Bus::new();
        let mut hotkey = create(&bus);
        assert!(hotkey.supported());
        assert!(hotkey.swallows());
        assert_eq!(hotkey.hold_keys(), vec![63, 54, 61, 62, 60, 57]);
        assert!(!hotkey.installed());

        let shared = SHARED.get().unwrap();
        assert_eq!(shared.key(), Some(63)); // fn until main says otherwise
        hotkey.set_key(Some(54));
        assert_eq!(shared.key(), Some(54));
        hotkey.set_key(None);
        assert_eq!(shared.key(), None);
        hotkey.set_swallow(false);
        assert!(!shared.swallow.load(Ordering::Relaxed));
    }
}

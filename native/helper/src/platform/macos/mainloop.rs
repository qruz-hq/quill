//! What the main thread does for the life of the process.
//!
//! macOS delivers event taps, CoreAudio listeners queued on the main dispatch
//! queue and AVFoundation notifications through the main run loop, so the main
//! thread runs it and everything else lives on other threads.

use std::ffi::c_void;
use std::time::Duration;

use core_foundation::date::CFAbsoluteTimeGetCurrent;
use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop, CFRunLoopTimer, CFRunLoopTimerRef};

extern "C" fn keep_alive(_timer: CFRunLoopTimerRef, _info: *mut c_void) {}

pub fn run() -> ! {
    // A run loop with nothing attached returns at once. One idle timer keeps
    // it alive until a backend adds its sources.
    let hour = 3600.0;
    let timer = CFRunLoopTimer::new(unsafe { CFAbsoluteTimeGetCurrent() } + hour, hour, 0, 0, keep_alive, std::ptr::null_mut());
    CFRunLoop::get_current().add_timer(&timer, unsafe { kCFRunLoopCommonModes });
    loop {
        CFRunLoop::run_current();
        // Only reached if something stopped the loop; go straight back in.
        std::thread::sleep(Duration::from_millis(50));
    }
}

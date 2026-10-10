//! Capability `hotkey`: the global hold key, reported as raw edges.
//!
//! A low-level keyboard hook (`WH_KEYBOARD_LL`) on a thread of its own that
//! does nothing but pump messages, which is how Windows delivers the hook's
//! calls. The procedure decides what happens to the event and posts the edge
//! to the session, where the gestures live (`quill_core::gesture`). What it
//! decides is the pure code in `hotkey/press.rs` and `hotkey/keys.rs`; this
//! file is the OS shell around it.
//!
//! No permission is needed. Three things Windows does not tell a hook about:
//!
//! - it removes a hook whose procedure was too slow, silently. The thread
//!   therefore puts a fresh hook in once a minute, while no press is going on;
//! - a window running as administrator keeps its keys to itself (UIPI): the
//!   hold key does nothing while such a window has the keyboard;
//! - the secure desktop (UAC prompt, lock screen) likewise.
//!
//! A release that went missing for one of those reasons is noticed by the
//! timer, which compares the press in progress with the keyboard's own state.
//!
//! Threads: `install`, `set_key` and friends run on the controller thread, the
//! hook procedure and the timer on the hook thread. They share [`Shared`].
//!
//! Compiles, but has not been run on Windows yet.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use quill_core::bus::Bus;
use quill_core::caps::{Hotkey, HotkeyError};
use quill_core::logln;
use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, KillTimer, PeekMessageW, PostThreadMessageW, SetTimer, SetWindowsHookExW,
    UnhookWindowsHookEx, HC_ACTION, HHOOK, KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSG, PM_NOREMOVE, WH_KEYBOARD_LL, WM_KEYDOWN,
    WM_KEYUP, WM_QUIT, WM_SYSKEYDOWN, WM_SYSKEYUP, WM_TIMER, WM_USER,
};

use super::input;

pub mod keys;
mod press;

use press::{Action, KeyEvent, Press};

/// `key` when the hold key is off. Not a virtual key.
const KEY_OFF: u32 = 0;
/// How often the hook thread checks a press against the keyboard's state.
const TICK_MS: u32 = 250;
/// Ticks between two fresh hooks: once a minute.
const REHOOK_TICKS: u32 = 240;
/// How long `install` waits for the hook thread to say how it went.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(2);
/// `hotkey-status.reason` when Windows refuses the hook.
const HOOK_FAILED: &str = "hook failed";

/// What the controller thread and the hook thread share. One per process: the
/// hook procedure is a plain function with no user data, so it finds this
/// through [`SHARED`].
struct Shared {
    bus: Bus,
    /// The hold key's virtual key, or [`KEY_OFF`].
    key: AtomicU32,
    /// Keep the key's own action from Windows (`fn-capture-on|off`).
    quiet: AtomicBool,
    installed: AtomicBool,
    /// The hook thread's id while it runs, for asking it to stop.
    thread: AtomicU32,
    press: Mutex<Press>,
}

static SHARED: OnceLock<Shared> = OnceLock::new();

impl Shared {
    fn lock(&self) -> MutexGuard<'_, Press> {
        // Nothing in here can be left half done by a panic.
        self.press.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn key(&self) -> Option<u32> {
        Some(self.key.load(Ordering::Relaxed)).filter(|&vk| vk != KEY_OFF)
    }

    /// Runs on the hook thread's timer: ends a press whose release never came.
    fn resync(&self) {
        let Some(vk) = self.key() else { return };
        let mut press = self.lock();
        if !press.can_resync() {
            return;
        }
        let edge = press.resync(input::is_down(vk));
        drop(press);
        if let Some(edge) = edge {
            logln!("hotkey: the release was not seen by the hook, ending the press");
            self.bus.key(edge, Instant::now());
        }
    }
}

/// The hook procedure. Must return quickly: Windows drops a slow hook.
///
/// SAFETY (as a callback): called by Windows on the thread that installed the
/// hook, from inside its `GetMessageW`. With `code == HC_ACTION`, `lparam`
/// points at a `KBDLLHOOKSTRUCT` that is valid for the length of the call.
unsafe extern "system" fn on_key(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        if let Some(shared) = SHARED.get() {
            let at = Instant::now();
            let down = match wparam.0 as u32 {
                WM_KEYDOWN | WM_SYSKEYDOWN => Some(true),
                WM_KEYUP | WM_SYSKEYUP => Some(false),
                _ => None,
            };
            // SAFETY: see above; the pointer is only read, and only here.
            let info = unsafe { (lparam.0 as *const KBDLLHOOKSTRUCT).as_ref() };
            if let (Some(down), Some(info)) = (down, info) {
                let event = KeyEvent {
                    vk: info.vkCode,
                    scan: info.scanCode,
                    down,
                    ours: info.flags.contains(LLKHF_INJECTED) && info.dwExtraInfo == keys::INJECTED_TAG,
                };
                // The lock is released before anything is sent: the mask key
                // comes straight back into this procedure.
                let verdict = shared.lock().on_key(event, shared.key(), shared.quiet.load(Ordering::Relaxed));
                if let Some(edge) = verdict.edge {
                    shared.bus.key(edge, at);
                }
                match verdict.action {
                    Action::Pass => {}
                    // Non-zero: the event stops here.
                    Action::Swallow => return LRESULT(1),
                    Action::MaskThenPass => {
                        // Windows has not seen the release yet, so the mask
                        // key lands while Alt or Win still counts as held.
                        let mask = keys::VK_MASK as u16;
                        input::send(&[input::key(mask, false, false), input::key(mask, true, false)]);
                    }
                }
            }
        }
    }
    // SAFETY: passes the event on exactly as it was received.
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

fn set_hook(module: Option<HINSTANCE>) -> windows::core::Result<HHOOK> {
    // SAFETY: `on_key` has the signature of a LowLevelKeyboardProc and is a
    // plain function, so it outlives any hook. Thread id 0 with this hook type
    // means every thread on the desktop; the calls arrive on this thread.
    unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(on_key), module, 0) }
}

fn unhook(hook: HHOOK) {
    // SAFETY: `hook` came from `set_hook` on this thread and is removed once.
    if let Err(error) = unsafe { UnhookWindowsHookEx(hook) } {
        // Windows had already dropped it (the slow-hook case).
        logln!("hotkey: the hook was already gone ({error})");
    }
}

/// The hook thread: installs the hook, tells `install` how it went, and pumps
/// messages until it is asked to stop or cannot put the hook back.
fn hook_thread(shared: &'static Shared, ready: mpsc::Sender<Result<(), String>>) {
    // SAFETY: a null name asks for the handle of this executable, which stays
    // loaded for the life of the process.
    let module: Option<HINSTANCE> = unsafe { GetModuleHandleW(None) }.ok().map(Into::into);
    let mut hook = match set_hook(module) {
        Ok(hook) => hook,
        Err(error) => {
            let _ = ready.send(Err(error.to_string()));
            return;
        }
    };
    let mut msg = MSG::default();
    // SAFETY: `msg` is a live local. Peeking creates this thread's message
    // queue, so a WM_QUIT posted right after `install` returns is not lost.
    // The timer has no window: its WM_TIMER arrives as a thread message.
    let timer = unsafe {
        let _ = PeekMessageW(&mut msg, None, WM_USER, WM_USER, PM_NOREMOVE);
        SetTimer(None, 0, TICK_MS, None)
    };
    // SAFETY: no arguments.
    shared.thread.store(unsafe { GetCurrentThreadId() }, Ordering::SeqCst);
    shared.installed.store(true, Ordering::SeqCst);
    let _ = ready.send(Ok(()));

    let mut ticks = 0u32;
    let mut lost: Option<String> = None;
    loop {
        // SAFETY: `msg` is a live local. The hook procedure runs inside this
        // call. 0 is WM_QUIT, -1 an error; both end the thread.
        let got = unsafe { GetMessageW(&mut msg, None, 0, 0) };
        if got.0 <= 0 {
            break;
        }
        if msg.message != WM_TIMER {
            continue;
        }
        shared.resync();
        ticks = ticks.wrapping_add(1);
        if ticks % REHOOK_TICKS == 0 && shared.lock().is_idle() {
            // Windows may have dropped the hook without a word. Both calls
            // are made here, between two messages, so no event is handled
            // twice and at most a key press in these microseconds is missed.
            unhook(hook);
            match set_hook(module) {
                Ok(fresh) => hook = fresh,
                Err(error) => {
                    lost = Some(error.to_string());
                    break;
                }
            }
        }
    }

    if timer != 0 {
        // SAFETY: the timer was created above on this thread.
        let _ = unsafe { KillTimer(None, timer) };
    }
    if lost.is_none() {
        unhook(hook);
    }
    shared.thread.store(0, Ordering::SeqCst);
    shared.installed.store(false, Ordering::SeqCst);
    *shared.lock() = Press::default();
    if let Some(error) = lost {
        // The session's poll installs a fresh one.
        logln!("hotkey: could not put the hook back ({error})");
        shared.bus.hotkey_status(false, Some(HOOK_FAILED));
    }
}

struct KeyboardHook {
    shared: &'static Shared,
}

impl Hotkey for KeyboardHook {
    fn supported(&self) -> bool {
        true
    }

    /// Alt and Win are kept from opening the menu bar and Start, Caps Lock
    /// from toggling. Ctrl and Shift have nothing to suppress.
    fn swallows(&self) -> bool {
        true
    }

    fn hold_keys(&self) -> Vec<u32> {
        keys::HOLD_KEYS.to_vec()
    }

    fn install(&mut self) -> Result<(), HotkeyError> {
        if self.installed() {
            return Ok(());
        }
        let failed = || HotkeyError { reason: HOOK_FAILED.to_string(), retry: true };
        let shared = self.shared;
        let (ready, went) = mpsc::channel();
        let spawned = std::thread::Builder::new().name("key-hook".to_string()).spawn(move || hook_thread(shared, ready));
        if let Err(error) = spawned {
            logln!("hotkey: could not start the hook thread ({error})");
            return Err(failed());
        }
        match went.recv_timeout(INSTALL_TIMEOUT) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => {
                logln!("hotkey: SetWindowsHookEx failed ({error})");
                Err(failed())
            }
            Err(_) => {
                logln!("hotkey: the hook thread did not answer");
                Err(failed())
            }
        }
    }

    fn installed(&self) -> bool {
        self.shared.installed.load(Ordering::SeqCst)
    }

    fn set_key(&mut self, key: Option<u32>) {
        self.shared.key.store(key.map_or(KEY_OFF, keys::vk_for), Ordering::Relaxed);
        // A press of the old key is not a press of the new one.
        *self.shared.lock() = Press::default();
    }

    fn set_swallow(&mut self, on: bool) {
        self.shared.quiet.store(on, Ordering::Relaxed);
    }

    fn note(&self) -> Option<String> {
        Some("no fn key on Windows; does not work while a window running as administrator has the keyboard".to_string())
    }
}

impl Drop for KeyboardHook {
    fn drop(&mut self) {
        let thread = self.shared.thread.load(Ordering::SeqCst);
        if thread != 0 {
            // SAFETY: posts a message to a thread id; a thread that has
            // already ended makes the call fail, which is fine.
            let _ = unsafe { PostThreadMessageW(thread, WM_QUIT, WPARAM(0), LPARAM(0)) };
        }
    }
}

/// `bus` is how the hook procedure reaches the session.
pub fn create(bus: &Bus) -> Box<dyn Hotkey> {
    let shared = SHARED.get_or_init(|| Shared {
        bus: bus.clone(),
        key: AtomicU32::new(keys::vk_for(keys::DEFAULT_KEY)),
        quiet: AtomicBool::new(true),
        installed: AtomicBool::new(false),
        thread: AtomicU32::new(0),
        press: Mutex::new(Press::default()),
    });
    Box::new(KeyboardHook { shared })
}

#[cfg(test)]
mod tests {
    use super::*;

    // No test installs a hook: it would sit in front of the keyboard of
    // whoever runs the tests. What the procedure decides is covered in
    // `press.rs` and `keys.rs`; the hook itself is in docs/HELPER-MANUAL-TESTS.md.

    #[test]
    fn the_backend_reports_what_it_offers_before_any_hook_exists() {
        let (bus, _rx) = Bus::new();
        let mut hotkey = create(&bus);
        assert!(hotkey.supported());
        assert_eq!(hotkey.hold_keys(), vec![62, 61, 60, 57]);
        assert!(!hotkey.installed());

        let shared = SHARED.get().unwrap();
        assert_eq!(shared.key(), Some(keys::VK_RCONTROL)); // until main says otherwise
        hotkey.set_key(Some(63)); // main's stored default, fn
        assert_eq!(shared.key(), Some(keys::VK_RCONTROL));
        hotkey.set_key(Some(57));
        assert_eq!(shared.key(), Some(keys::VK_CAPITAL));
        hotkey.set_key(None);
        assert_eq!(shared.key(), None);
        hotkey.set_swallow(false);
        assert!(!shared.quiet.load(Ordering::Relaxed));
    }
}

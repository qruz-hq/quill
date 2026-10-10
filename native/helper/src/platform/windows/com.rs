//! COM on whatever thread happens to need it.
//!
//! The volume and device calls arrive on the controller thread, on worker
//! threads and on the exit path. Each thread joins the multithreaded apartment
//! the first time it comes through here and leaves it when the thread ends.

use windows::Win32::Media::Audio::{IMMDeviceEnumerator, MMDeviceEnumerator};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED};

struct Apartment {
    /// False when the thread already had COM in another mode (cpal sets its
    /// own up on the threads it uses). COM is usable then too, and that
    /// initialisation is not ours to undo.
    ours: bool,
}

impl Drop for Apartment {
    fn drop(&mut self) {
        if self.ours {
            // SAFETY: balances the successful CoInitializeEx made on this thread.
            unsafe { CoUninitialize() };
        }
    }
}

thread_local! {
    static APARTMENT: Apartment = {
        // SAFETY: may be called on any thread; S_OK and S_FALSE both count as
        // an initialisation to balance, an error (RPC_E_CHANGED_MODE) does not.
        let result = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        Apartment { ours: result.is_ok() }
    };
}

/// Makes sure COM is initialised on the calling thread.
pub fn ensure() {
    APARTMENT.with(|_| {});
}

/// The audio endpoint enumerator. Cheap to create: it lives in this process.
pub fn device_enumerator() -> windows::core::Result<IMMDeviceEnumerator> {
    ensure();
    // SAFETY: COM is initialised on this thread; the class and interface ids
    // are the ones the bindings declare for each other.
    unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
}

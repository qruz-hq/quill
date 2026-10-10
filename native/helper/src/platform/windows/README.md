# Windows backends

Windows 10 and 11, x64. Everything here type-checks from macOS
(`cargo check --target x86_64-pc-windows-msvc`), and the logic that needs no Windows
API is unit tested on any machine (`cargo test`, the `windows_pure` tests). Nothing
has been run on Windows yet: `docs/HELPER-MANUAL-TESTS.md` has the checklist under
"Windows".

| Capability | File | How |
|---|---|---|
| `audio`, `level`, `spectrum`, `mic-test`, `cloud-audio`, `stream` | `audio.rs` | The shared cpal path (WASAPI, shared mode). Adds the privacy-setting wording to a failed open. |
| `devices` | `audio.rs`, `devices.rs` | `uid` is the endpoint id (`{0.0.1.00000000}.{guid}`), stable across replugging. Hot-plug and default changes through `IMMNotificationClient`; polling if that cannot be registered. |
| `hotkey`, `hotkey-swallow` | `hotkey.rs`, `hotkey/keys.rs`, `hotkey/press.rs` | `WH_KEYBOARD_LL` on a message-loop thread of its own, feeding the shared gesture machine. |
| `insert` | `insert.rs`, `insert/plan.rs`, `input.rs` | Clipboard, `SendInput` Ctrl+V (Shift+Insert in some terminals), restore. Typed as Unicode key events when the clipboard cannot be written. |
| `duck` | `duck.rs`, `duck/controls.rs`, `../duck_shared.rs` | `IAudioEndpointVolume` on the default render endpoint; the same state file and recovery as macOS. |
| permissions | `permissions.rs`, `permissions/consent.rs` | No Accessibility gate (`ax` is always trusted). The microphone privacy switches are read to word errors. |
| `calendar` | `calendar.rs` | Not offered: there is no system calendar store an unpackaged program can use. `cal` answers `unsupported`. |
| transcription | `../../asr/` | whisper.cpp in process, CPU. See "Whisper" below. |

`pure.rs` is not part of a Windows build. It lists the OS-free files so that
`platform/mod.rs` can compile them, for their tests only, on other systems.

## The hold key

There is no fn key on Windows (keyboards resolve it in firmware), so the default is
Right Ctrl.

`holdkey <n>` keeps its meaning from the contract: `n` is the macOS virtual keycode,
used as the name of a physical key on every OS. Main sends the same numbers on all
three platforms and never needs to know a Windows key code. The `capabilities`
handshake lists what Settings should offer.

| `holdkey` | Key | Windows key | In `holdKeys` | A lone press |
|---|---|---|---|---|
| 62 | Right Ctrl (default) | `VK_RCONTROL` 0xA3 | yes | does nothing in Windows: passes untouched |
| 61 | Right Alt | `VK_RMENU` 0xA5 | yes | would focus the menu bar: the release is masked |
| 60 | Right Shift | `VK_RSHIFT` 0xA1 | yes | passes untouched |
| 57 | Caps Lock | `VK_CAPITAL` 0x14 | yes | would toggle: both edges are swallowed, so it is a real hold key here (macOS: press to start, press to stop) |
| 54, 55 | Right, Left Win | 0x5C, 0x5B | accepted | would open Start: the release is masked |
| 59, 58, 56 | Left Ctrl, Alt, Shift | 0xA2, 0xA4, 0xA0 | accepted | as their right-hand twins |
| 105, 107, 113, 106, 64, 79, 80, 90 | F13 to F20 | 0x7C to 0x83 | accepted | passes untouched |
| 63 (fn), anything else | none | read as the default, Right Ctrl | | |

63 is what main has stored until the user picks a key, so on Windows it means "the
default key". "Accepted" keys work when sent but are not offered, like the left-hand
modifiers on macOS.

Proposed wording for section 4 and 11.1 of the contract (the contract file is shared,
so it is proposed here and not edited):

> `holdkey <keycode>`: the keycode names a physical key, using the macOS virtual
> keycode as the name on every platform (62 is Right Ctrl on a Mac, a PC and in X11).
> Each helper maps it to its own OS's code. A keycode with no key on this platform is
> read as that platform's default hold key (fn on macOS, Right Ctrl on Windows).
> `capabilities.holdKeys` lists the keycodes Settings should offer, default first.

If names are ever wanted on the wire, the natural set is `fn`, `right-ctrl`,
`right-alt`, `right-shift`, `right-meta`, `caps-lock`, `left-*`, `f13` to `f20`, each an
alias of the number above; it needs a change to `quill_core::command` and to main, and
gains nothing while main stores numbers.

Things to know:

- **Suppression.** "Masked" means the helper sends the unassigned key 0xE8 just before
  letting the release through, which makes Windows treat it as the end of a
  combination (the AutoHotkey "menu mask key" method). `fn-capture-off` turns both
  masking and swallowing off.
- **AltGr.** On layouts with AltGr, Windows announces Right Alt with a made-up Left
  Ctrl (scan code 0x21D). It is ignored. Right Alt as the hold key on such a layout
  starts a recording whenever AltGr is used to type a character; the character key
  then cancels it. Right Ctrl is the better choice there.
- **Right Shift held for 8 seconds** makes Windows offer Filter Keys. That is a Windows
  accessibility shortcut (Settings > Accessibility > Keyboard), not something the hook
  can stop without swallowing Shift.
- **Remappers.** Keys injected by other programs (PowerToys, AutoHotkey) count as real
  keys. Only this helper's own injected keys are ignored, by a tag in `dwExtraInfo`.
- **Windows running as administrator** keep their keyboard input from a normal process
  (UIPI). While one has focus the hold key does nothing. A press that started before
  the focus moved is ended by the helper itself: four times a second it compares its
  own idea of the key with `GetAsyncKeyState`, so a recording cannot hang on a release
  the hook never saw. The same goes
  for the UAC prompt and the lock screen. The way around is `uiAccess="true"` in the
  manifest, which needs a signed binary installed under Program Files.
- **Hook health.** Windows removes a low-level hook whose procedure was slow, without
  notice. The hook thread installs a fresh hook once a minute, between presses.
- **Antivirus.** An unsigned program with a global keyboard hook, clipboard access and
  `SendInput` looks like a keylogger to heuristics. Signing the helper is the fix.

## Typing

- Ctrl+V, or Shift+Insert when the window in front belongs to mintty (Git Bash, MSYS2,
  Cygwin), PuTTY, KiTTY, Alacritty, WezTerm, gVim or Emacs. Windows Terminal, the
  classic console, PowerShell and VS Code paste on Ctrl+V.
- Modifiers still held when the paste is due are released first (a held Win key would
  turn Ctrl+V into the sound output list).
- The dictation is marked to stay out of the clipboard history (Win+V) and cloud sync.
  The previous text is put back 350 ms later, unless something newer was copied by then.
  Only text is saved: a copied image or file list is not put back, as on macOS.
- **Elevated windows.** `SendInput` into a window running as administrator is dropped
  without an error. The helper checks the foreground process first and answers with an
  `error` ("... runs as administrator. The text is on the clipboard: press Ctrl+V"),
  leaving the dictation on the clipboard.
- If the clipboard cannot be written, the text is typed with `KEYEVENTF_UNICODE` events
  (layout independent; an active IME composition may swallow part of it).

## Ducking

- Master volume of the default render endpoint (role console), by scalar, so the value
  put back is exactly the one read. If the user has set a left/right balance, each
  channel is saved and restored by itself instead.
- State file: `%LOCALAPPDATA%\Quill\Logs\Quill-duck.json`, the same JSON as on macOS
  with the endpoint id as `uid`. A helper killed while ducked leaves it behind and the
  next launch restores from it; a device that is gone at that moment is restored when
  it returns.
- Known gap, shared with macOS: the duck happens before the microphone opens. A
  Bluetooth headset that switches to its hands-free profile when the microphone opens
  can move the default output to another endpoint after the duck. The restore still
  goes to the endpoint that was ducked.

## Microphone privacy

Windows has no prompt for a program like this one. Settings > Privacy & security >
Microphone has "Microphone access", "Let apps access your microphone" and "Let desktop
apps access your microphone"; with any of them off the microphone fails to open or
records silence. The helper reads the three switches from the registry (never writes)
and words the `start-failed`/mic test error and the silent-recording `final.error`
accordingly. Main can link to `ms-settings:privacy-microphone`.

## Whisper

- Now: `cargo build --release --features asr` builds whisper.cpp for the CPU into the
  helper (`whisper-rs` with no GPU feature on this target; the handshake's
  `notes.transcribe` says `cpu`). It needs, on the Windows build machine: Visual Studio
  Build Tools (MSVC and the Windows SDK), CMake, and LLVM with `LIBCLANG_PATH` set, for
  the bindings. `bun run helper:build` does the rest. This cannot be built or
  type-checked from macOS: the build script needs the MSVC headers.
- `--features asr-vulkan` is declared and builds the same thing with ggml's Vulkan
  backend (needs the Vulkan SDK). It is not the plan for shipping, because a Vulkan
  driver fault would take the whole helper down with it, hold key and all.
- The seam for a GPU worker is the `Transcriber` trait (`quill_core::caps`):
  `asr::create()` returns one, and nothing else in the helper knows where decoding
  happens. A later `src/asr/worker.rs` implements it by spawning a `quill-asr` child
  (built once with `vulkan`, or `cuda`, once plain) and speaking a private pipe
  protocol: `load`, `transcribe`, `detect`, `abort`. `asr::create()` then tries the GPU
  worker, falls back to the in-process CPU engine if the worker dies before `ready`,
  and remembers the choice. Set `VK_LOADER_LAYERS_DISABLE=~implicit~` for the worker so
  overlay layers (OBS, RivaTuner) are not loaded into it. Not built yet.

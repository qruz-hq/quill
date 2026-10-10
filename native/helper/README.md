# flow-stt, the Rust helper

Quill's native helper as one Rust codebase for macOS, Windows and Linux. It replaces
the Swift helper (`native/stt/main.swift`) and speaks the same stdin/stdout line
protocol, so the app can swap one binary for the other.

- Contract: `docs/HELPER-PROTOCOL.md` (authoritative; section numbers in code comments
  point there).
- Conformance suite: `tests/helper` (bun), run against any helper binary.
- Reference implementation: `native/stt/main.swift`.

Status, by platform:

- **macOS**: every capability is live (microphone through cpal, whisper in process
  with Metal, hold key, typing, ducking, permissions, calendar). The conformance
  suite passes, and the same command scripts give the same event streams as the
  Swift helper. Not yet proven by a test: the hold key, typing, audible ducking,
  hot-plug and partials on live speech (`docs/HELPER-MANUAL-TESTS.md`).
- **Windows**: compiles (`cargo check --target x86_64-pc-windows-msvc`), never run.
  Microphone, device list and whisper are the shared code; hold key, typing and
  ducking still answer "unsupported" and stay out of the handshake.
- **Linux**: not compiled from macOS (see below), never run. Same split as Windows.

## Build and test

```
cd native/helper
cargo build                      # debug, no whisper: fast
cargo test                       # unit tests + the binary driven as a child process
cargo check --target x86_64-pc-windows-msvc --no-default-features

bun run helper:build             # release with whisper -> resources/helper/flow-stt
bun run helper:build --no-asr    # same without whisper (no cmake needed)
bun run helper:test              # cargo test, helper:build, then tests/helper against it
```

- Plain `cargo` commands never build whisper.cpp. Local transcription is the cargo
  feature `asr` (`asr-vulkan` adds the Vulkan backend for Windows and Linux); it needs
  cmake, a C++ compiler and libclang. `helper:build` turns it on and, when cmake is not
  on PATH, uses the copy in `.build/cmake`.
- whisper.cpp is built from source at one pinned commit, the one the app's `whisper-cli`
  is built from (`vendor/whisper-rs-sys/PIN`). The source is not in this repository:
  `helper:build` fetches it into `vendor/whisper-rs-sys/whisper.cpp` on the first run
  (`scripts/whisper-src.ts`; from `.build/whisper.cpp` when that checkout has the
  commit, from GitHub otherwise). `vendor/whisper-rs-sys` replaces the published crate
  of that name, which carries whisper.cpp 1.8.3, through `[patch.crates-io]`. To move
  to a newer whisper.cpp, change `PIN`, rebuild `whisper-cli` from the same commit and
  compare transcripts again.
- The Windows check type-checks everything that needs no C toolchain. A Linux check
  needs the target installed (`rustup target add x86_64-unknown-linux-gnu`) and still
  cannot run from macOS, because `alsa-sys` and `libpulse-sys` look for system
  libraries through pkg-config: check Linux on Linux.
- On macOS `build.rs` embeds `Info.plist` (bundle id, microphone and calendar usage
  strings) in the binary, and `helper:build` signs it ad hoc with the bundle id
  `studio.saudad.quill.stt`.

Testing by hand: the helper reads stdin, so `printf 'duck off\nholdkey off\ndevices\n' |
target/debug/flow-stt` prints the boot lines and the device list and exits when stdin
closes. Send `duck off` and `holdkey off` first, pin a wired microphone
(`mic BuiltInMicrophoneDevice`) before any `start`, and set `HOME` to a scratch folder
so the log and the duck state file of the installed app are left alone.

## Layout

```
native/helper/
  Cargo.toml            workspace + the flow-stt package; ALL dependencies are declared here
  build.rs, Info.plist  macOS: plist embedded in the binary
  scripts/build.ts      helper:build
  scripts/whisper-src.ts  fetches the pinned whisper.cpp source
  vendor/whisper-rs-sys/  builds whisper.cpp at the commit in PIN (replaces the published crate)
  tests/process.rs      the binary as a child process (boot, handshake, junk, quit paths)
  src/
    main.rs             thread wiring only
    asr/                whisper (cargo feature "asr"), the same on every OS
    audio_shared.rs     capture code shared between OSes (cpal)
    platform/
      mod.rs            picks one OS folder with cfg(target_os)
      macos/  windows/  linux/
        audio.rs  devices.rs  hotkey.rs  insert.rs  duck.rs  permissions.rs  calendar.rs
        mainloop.rs     what the main thread does (CFRunLoop on macOS)
        mod.rs
  crates/core/          quill-core: no OS code, all unit tested
    src/command.rs      stdin line -> typed Command
    src/event.rs        typed Event -> one JSON line, written whole (StdoutSink)
    src/session.rs      the state machine (+ session_tests.rs, fake backends, fake clock)
    src/runtime.rs      stdin reader, controller loop, exit paths
    src/bus.rs          Msg and Bus, the one channel into the controller
    src/caps.rs         the capability traits and CaptureSink
    src/unsupported.rs  a stand-in for every trait
    src/gesture.rs      hold, tap, double tap, other key: pure state machine
    src/resample.rs     any rate and channel count -> 16 kHz mono
    src/level.rs  spectrum.rs  wav.rs  pcm.rs  text.rs  log.rs  paths.rs
```

## How it runs

| Thread | Does |
|---|---|
| main | `platform::run_main_loop()`: the CFRunLoop on macOS (event tap, CoreAudio and AVFoundation callbacks), parked elsewhere |
| stdin | reads lines, parses them, sends `Msg::Command`; `quit` overtakes the queue |
| controller | builds the backends, owns the `Session`, writes every event; the only place state lives |
| transcribe, partial, transcribe-file | one short-lived thread per whisper pass |
| insert, calendar | one worker each, jobs in arrival order |
| backend threads | whatever a backend needs (audio callback, key hook, COM); they only post to the `Bus` |

Rules that keep the contract true:

1. Only the controller writes events. A backend never prints: it posts to the `Bus`
   (`CaptureSink::push`, `bus.key`, `bus.devices_changed`, `bus.hotkey_status`), and a
   worker thread answers with `bus.emit(event)`. That is what orders `started` before
   the first `level`, and stops meter lines after a `final`.
2. Nothing blocks the controller except `AudioCapture::open` and dropping a
   `CaptureStream`. Dropping the stream must release the device before it returns.
3. `quill_core::runtime::exit` is the only way out. It restores the volume first
   (`Ducker::restore`), from whichever thread got there, so a `Ducker` locks its own
   state. A panic on any thread goes through it too and ends the process with code 101.
4. Logging is `quill_core::logln!`, to the log file. Never stdout, and not stderr either
   (main copies stderr into its own log). Do not log what the user dictated beyond what
   the Swift helper already logs.
5. All timing constants live in `session.rs`, `gesture.rs` and `caps.rs`; backends take
   them from there.

## Who owns what

One capability, one owner, across all three OS folders. Stay inside your files; the
shared ones are listed at the end.

| Capability (trait in `caps.rs`) | Files | Notes |
|---|---|---|
| Audio capture (`AudioCapture`, `CaptureStream`, `DeviceWatcher`) | `src/platform/*/audio.rs`, `src/platform/*/devices.rs`, `src/audio_shared.rs` | The shared cpal backend downmixes itself (stereo is averaged, more than two channels takes channel 0, so a multi-input interface does not bury the microphone under silent inputs) and hands one channel to `CaptureSink`. Deliver through `CaptureSink` (`push` resamples and downmixes; `push_mono_16k` when the OS already gives 16 kHz mono). Report a dead stream with `lost_handle().lost(..)`. `open(None)` and an unknown uid both mean the system default. `uid` must be stable across reconnects (`BuiltInMicrophoneDevice` on a Mac's own microphone: the test suite pins it). The watcher calls `bus.devices_changed()`; debouncing is the session's. |
| Transcription (`Transcriber`) | `src/asr/` | Behind feature `asr`. Called from several threads at once. Return raw segments, one per line; the session cleans the text and picks the language. Keep ggml's logging off stderr. |
| Hold key (`Hotkey`) | `src/platform/*/hotkey.rs`, `src/platform/macos/mainloop.rs` | Report raw edges with `bus.key(edge, Instant::now())` from the hook callback; gestures are `gesture.rs`. Decide swallowing inside the callback. `install` returns `HotkeyError { reason: "accessibility", retry: true }` when the grant is missing; the session polls every 2 s. `hold_keys()` feeds the handshake. |
| Typing (`TextInserter`) | `src/platform/*/insert.rs` | `paste` stages the text, waits `PASTE_DELAY`, posts the chord and returns the clipboard restore; the session sends `inserted` and runs the restore after `CLIPBOARD_RESTORE_DELAY`. |
| Ducking (`Ducker`) | `src/platform/*/duck.rs` | `Send + Sync`, called from the exit path. State file: `paths::duck_state_file()`, same JSON as the Swift helper. `restore` with nothing ducked must not touch the volume. |
| Permissions (`Permissions`) | `src/platform/*/permissions.rs` | Accessibility grant on macOS; the user-facing wording for a silent microphone. |
| Calendar (`Calendar`) | `src/platform/*/calendar.rs` | macOS only (EventKit). The stand-in already answers `error: "unsupported"` elsewhere. |

A capability may add files next to its own (`hotkey.rs` plus a `hotkey/` folder) without
touching anyone else's.

Shared, change only by asking in your report:

- `Cargo.toml` and `Cargo.lock`: every dependency is already declared (cpal, pinned
  to 0.18.2, with its PulseAudio host on Linux and ALSA as the fallback; rtrb,
  arboard, whisper-rs with its patched `whisper-rs-sys`; core-foundation, core-graphics and the objc2 family on macOS;
  the `windows` crate with its feature list; x11rb, evdev, libpulse-binding on Linux).
- `crates/core/**`: the traits, the session and the shared DSP.
- `src/main.rs`, `src/platform/mod.rs`, `src/platform/*/mod.rs`, `build.rs`, `Info.plist`.
- `docs/HELPER-PROTOCOL.md` and `tests/helper/**`.

A backend becomes live by changing the `create` function in its own file: it returns the
trait object, and `supported()` returning true puts the capability in the handshake.

## Deliberate differences from the Swift helper

All inside what the contract allows or asks of a new helper:

- Sends the `capabilities` handshake (section 11.2) as its second line.
- Commands apply strictly in the order written (the Swift helper applies some settings
  ahead of queued work); `quit` still acts at once.
- A partial is tied to its recording, so one that finishes late is dropped.
- The press that ends a latch sends one `stop`, not two.
- `stream` is read at `start`, including for the last chunk flush.
- `devices[].id` is whatever the backend chooses (main does not read it).
- With no `hotkey` capability no `hotkey-status` is sent.
- Malformed `engine` and `stream` arguments are ignored instead of read as `local`/`off`.
- The model stays loaded between passes (whisper runs in the helper, not as a
  `whisper-cli` child), so a pass costs its decode only and the helper's memory
  includes the model for as long as it runs.
- A language code whisper does not know gives an empty text, as with `whisper-cli`;
  an English-only model is told `en` for every code it does know.
- Whisper is the same library the Swift helper runs as `whisper-cli` (whisper.cpp
  1.9.3, the commit in `vendor/whisper-rs-sys/PIN`), with the same options (beam search
  with 5 beams, best of 5 on a temperature retry; greedy for partials) and the same
  samples (the recording as its 16-bit WAV holds it). Measured over 37 clips in two
  language settings: 35 word for word the same, 2 covered by the next point.
- Whisper returns one segment per 30 s of audio, and each is a line of its own here,
  so a `[BLANK_AUDIO]` segment is dropped and its neighbours kept. `whisper-cli`
  prints every segment on one line: 30 s of quiet followed by speech came out empty
  in the Swift helper, and speech followed by quiet ended in a literal `[BLANK_AUDIO]`.
- The WAV handed over in `audio` is named `quill-<uuid>.wav` with a lower-case uuid.
- A line that starts with a tab is trimmed like one that starts with a space (the
  Swift helper drops `<tab>stop 1` but takes `<tab>start`). Main sends neither.
- Every exit ends with `_exit`: nothing is left to library teardown, which took
  250 to 500 ms with whisper's GPU backend loaded.
- The log is at `%LOCALAPPDATA%\Quill\Logs` on Windows and `$XDG_STATE_HOME/quill` on
  Linux; on macOS it is the same `~/Library/Logs/Quill-stt.log`.

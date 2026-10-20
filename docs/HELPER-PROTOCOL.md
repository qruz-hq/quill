# Quill helper protocol

The contract between Electron main (`src/main/stt.ts`, call sites in `src/main/index.ts`)
and the native speech helper. The reference implementation is the Swift helper,
`native/stt/main.swift`, built to `resources/FlowSTT.app/Contents/MacOS/flow-stt`. A
replacement helper (the cross-platform Rust one) is correct when it behaves as written
here and passes `tests/helper` (see section 12).

Status: describes the code as of 2026-10-10 (branch `rust-helper`). Where this document
and the code disagree, the code wins and this file is the bug. Section 11 is a proposal
and is marked as such; everything else is current behaviour.

Words used below: "main" is the Electron main process, "the helper" is the child process,
"a recording" is the span from `start` to `stop`, `cancel`, `start-failed` or the helper's
exit.

## 1. Transport

| | |
|---|---|
| Process | Main spawns the helper with no arguments and three pipes. One helper per app; main respawns it when it dies. |
| stdin | UTF-8 text, one command per line, `\n` terminated (main never sends `\r`; a helper should drop one before the `\n` all the same). A command is a verb, optionally one space and an argument that runs to the end of the line, so an argument may contain spaces. Leading and trailing whitespace of the argument is not part of it. Verbs are lower case and case sensitive. There is no length limit: an `insert` line carries a whole dictation in base64 and can be tens of kilobytes. |
| stdout | One JSON object per line, UTF-8, `\n` terminated, each with a string `type`. A line break inside a string is escaped, never raw. Every line is flushed as it is written: main reads a pipe, and a helper that lets its runtime block-buffer stdout appears dead. Nothing else may be written to stdout, ever: main drops lines that do not parse, so stray text is lost, but a stray line that happens to parse is a bug. A write that fails because main is gone must not stop the helper from restoring the volume and exiting. |
| stderr | Free text. Main copies it to its log with a `stderr:` prefix and never shows it. Framework chatter and crash reports end up here. |
| Order | Commands take effect in the order they were written, with one exception: `quit` acts the moment it is read and does not wait for work queued by earlier commands. Events are written whole, one at a time, never interleaved. The answers to two different commands are not ordered relative to each other unless section 4.1 says so. (The Swift helper applies `model`, `lang`, `duck`, `holdkey`, `engine`, `stream` and answers `ax-check` and `cal` on its reader thread, ahead of a `start`, `stop`, `mic` or `devices` still queued for its main thread. A setting written immediately after `start` or `stop` can therefore already apply to it. Main never relies on either order; a new helper applies commands strictly in order.) |
| Unknown input | A line that is not a known command, an empty line, or a known verb with a malformed argument is ignored: no event, no exit, and a setting keeps its previous value. A verb that takes no argument is not recognised with one (`start now` is ignored). |
| Unknown output | Main ignores event types it does not know and fields it does not read, so a helper may add both. |
| Field order | Not significant. The Swift helper's key order varies between lines. |

Main never waits for `boot` before writing. On every spawn it writes its settings
(section 3.2) straight after `spawn()` returns, so a helper must accept commands that
were already in the pipe before it printed anything.

## 2. Commands (stdin)

"Sent by" names the method in `stt.ts`. Commands marked legacy are parsed by the Swift
helper but nothing sends them.

### 2.1 Recording

| Command | Sent by | Effect | Answer |
|---|---|---|---|
| `start` | `start()` | In this order: ends a running mic test, clears the sample buffer, opens the pinned microphone (or the system default), ducks the output if ducking is on, starts partials (or chunks when `stream on`), answers. Ignored, with no event, while a recording is running with its microphone open (section 5.2 has the one case where it replaces a recording instead). | `started`, once. Then `level` and `spectrum` while it records, plus `partial` or `chunk`. Later, possibly `start-failed` or `interrupted` (section 5.2). |
| `stop <id>` | `stop()` | Ends the recording, releases the microphone, restores the volume, keeps the audio in memory for `retry` (replacing what was kept), then runs the finishing pipeline (section 5.3). With nothing recording it answers at once and leaves the kept recording as it is. Does not end a mic test. | Exactly one answer carrying `id`: a `final`, or in cloud mode an `audio`. `transcribing` precedes it when a transcription or an upload is really starting. |
| `stop`, `retry` (no id) | (never; main always sends an id) | As with an id, using the empty id. | The answer carries `"id": ""`. |
| `cancel` | `cancel()` | Ends the recording, releases the microphone, restores the volume, throws away both the samples and the recording kept for `retry`. Safe with nothing recording (the kept recording is still dropped). Does not end a mic test. | `cancelled`, one per `cancel`, always. No `final`, `audio` or `transcribing`. |
| `retry <id>` | `retry()` | Runs the kept recording through the finishing pipeline again, with the settings (`engine`, `model`, `lang`) as they are now. In cloud mode that writes a new WAV. The kept recording stays kept, so `retry` can be repeated. While a recording is running it answers empty and leaves that recording alone. | Same as `stop <id>`. With nothing kept (never recorded, cancelled, the last recording was empty, or one is running now): `final` with empty `text`, no `error`, no `transcribing`. |
| `unlatch` | `unlatch()` | Clears the hold key's hands-free latch (section 6). No-op when not latched. | None. |

`<id>` is everything after the first space, trimmed (so it may contain spaces, except
in `transcribe-file`, where it ends at the next space). Main uses a decimal counter
(`"1"`, `"2"`, ...) for `stop` and `retry` and `c<digits>` for `cal`, but the helper
must treat it as an opaque string and echo it unchanged, as a JSON string, never as a
number. Several ids can be outstanding at once (a `stop` still transcribing while the
next recording is stopped, a `transcribe-file` fallback in flight); answers may arrive in
any order, which is why every answer carries its id.

### 2.2 Transcription fallback

| Command | Sent by | Effect | Answer |
|---|---|---|---|
| `transcribe-file <id> <path>` | `handleAudio()` after a failed cloud upload | Transcribes a WAV already on disk with the local model. `<id>` has no spaces; `<path>` is the rest of the line and may contain spaces. Runs off the command thread, so several can overlap and none of them holds up a `start`. The helper does not delete the file. A line with no path is ignored. | Always exactly one `final` with `id`, and no `transcribing`. With no model (no path set, or the path names no file): empty `text` and an `error` (section 9). A file that is missing, unreadable or not audio, or a whisper failure: empty `text`, no `error`. |

The file is one the helper wrote itself for an `audio` event: 16 kHz, mono, 16-bit PCM
WAV. Language detection is not run here; the first configured language is used.

### 2.3 Settings

All of these answer nothing except `mic`. Main sends the whole set on every spawn, and
any one of them again whenever the user changes that setting, including in the middle
of a recording.

When each is read: `model`, `lang` and `engine` when a transcription starts (`stop`,
`retry`, `transcribe-file`, each partial); `duck` and `stream` at `start` (a change in
the middle of a recording belongs to the next one; the Swift helper decides the last
chunk flush from the value at `stop`); `mic` when a microphone is next opened;
`holdkey` at once.

| Command | Sent by | Argument | Effect |
|---|---|---|---|
| `model <path>` | `setModel()` | Absolute path of a ggml whisper model, may contain spaces. Empty (`model ` with a trailing space) means no model installed. | Used from the next transcription. Not validated when set; a missing file is reported at transcription time, in the `final`. |
| `lang <codes>` | `setLanguage()` | Comma separated ISO 639-1 codes, or `auto`. Empty becomes `auto`. | One code: whisper is told it. Several: a detection pass runs first and its answer is used only if it is in the set; otherwise, and when detection fails, the first code. `auto` anywhere in the list: whisper chooses. Partials and `transcribe-file` skip detection and use the first entry as it stands. Default before any `lang`: `en`. |
| `duck off` or `duck <percent>` | `setDuck()` | `off`, or a number 0 to 100 (decimals allowed, clamped to that range): the percentage of the current output volume to drop to while recording. `0` mutes. Anything else is ignored. | Applies from the next `start`; a duck already in place is still undone by its `stop`. Defaults before any `duck`: on, 15. |
| `holdkey off` or `holdkey <keycode>` | `setHoldKey()` | A macOS virtual keycode (63 fn, 54/55 right/left command, 61/58 right/left option, 62/59 right/left control, 60/56 right/left shift, 57 caps lock), or `off`. Main sends `off` for 0. Not a number: ignored. | Chooses the hold-to-talk key and enables it, or disables it (`off`: no `hotkey` events, and the key is left entirely to the OS). The hook itself may stay installed. Default: 63, enabled. |
| `mic <uid>` or `mic default` | `setMic()` | A device `uid` from a `devices` event, or `default` (also: empty). | Pins the microphone from the next recording or mic test; one in progress keeps its device. An unknown or disconnected uid is kept as the pin, and recording falls back to the system default until it returns. Answers with a `devices` event whose `pinned` is the new value. |
| `engine local` or `engine cloud` | `setEngine()` | | `local`: the helper transcribes. `cloud`: the helper hands the WAV to main in an `audio` event. Default `local`. Main sends only these two (the Swift helper treats any other word as `local`). |
| `stream on` or `stream off` | `setStreaming()` | | `on`: `chunk` events during a recording and no local partials. `off`: local partials, no chunks. Independent of `engine`: `engine cloud` with `stream off` and a model installed still gives local partials. Default `off`. |
| `hold-ms <ms>` | (legacy, tuning) | Number | Hold threshold. |
| `doubletap-ms <ms>` | (legacy, tuning) | Number | Double-tap window. |

### 2.4 Devices and mic test

| Command | Sent by | Effect | Answer |
|---|---|---|---|
| `devices` | `refreshDevices()` | | `devices` |
| `mic-test` | `testMic(true)` | Ends any running test silently (no `ended` for it), then opens the pinned microphone (the system default when it is not connected) for 6 seconds without recording anything. While a recording is running it does nothing but answer. `stop`, `retry` and `cancel` do not end a test. | `mic-test` `started` with the device name, then `mic-test-level` and `spectrum`, then `mic-test` `ended` after 6 s, on `mic-test-stop`, on `start`, or when the device is lost. If the microphone cannot be opened: one `mic-test` `ended` with `error`. While recording: one `mic-test` `ended`, no `started`. |
| `mic-test-stop` | `testMic(false)` | Ends the test. | `mic-test` `ended` if a test was running, otherwise nothing. |

### 2.5 Typing, permissions, calendar, lifecycle

| Command | Sent by | Effect | Answer |
|---|---|---|---|
| `insert <base64>` | `insert()` | Base64 of the UTF-8 text (base64 keeps newlines out of the line protocol). Standard base64 with padding, no whitespace inside. Types the text into the focused app: saves the clipboard string, puts the text on the clipboard, posts the paste chord 60 ms later, restores the clipboard 350 ms after that. A clipboard that held no text is not restored (the dictation stays on it). Invalid base64, bytes that are not UTF-8, or empty text: ignored. Main only sends `insert` when its own Accessibility check passes; otherwise it puts the text on the clipboard itself. | `inserted` with the character count once the chord has been posted (not proof that the app took it), or `error` when Accessibility is missing (section 9). |
| `ax-check` | `checkAccessibility()` | Reads the Accessibility grant without prompting. When granted, installs the hold-key tap if it is not installed yet. | `ax`. Possibly `hotkey-status` afterwards. |
| `cal <json>` | `calendar()` | One JSON object with `id`, `op` and the op's arguments (section 8). Malformed JSON, or JSON without string `id` and `op`, is ignored. | One `cal` with the same `id`. |
| `quit` | `dispose()` | Restores the output volume and exits with code 0 immediately: a recording in progress is dropped (not answered, not kept), and answers still owed may or may not be written first. | None of its own. |
| `hotkey-install`, `hotkey-on`, `hotkey-off`, `fn-capture-on`, `fn-capture-off` | (legacy) | Install the tap; enable or disable gestures; swallow or pass the bare hold-key release. | None, except `hotkey-status` from an install. |

## 3. Lifecycle

### 3.1 Boot

1. Before anything else the helper undoes a volume duck left by a previous run that
   died (section 7).
2. It writes `{"type":"boot","pid":<pid>}`. This is always the first line. Main marks
   the helper ready on it.
3. Shortly after, unprompted, in no fixed order relative to each other or to the
   answers to main's first commands: one `hotkey-status` (tap installed, or not and why)
   and one `devices`. Its `pinned` is whatever is pinned by then, usually `""`.
4. It reads commands until `quit`, end of input, or a signal.

### 3.2 Settings re-send on spawn

`stt.onSpawn` runs after every spawn, the first one and every respawn, and writes, in
this order:

```
model <path>            (or "model " when none is installed)
lang <codes>
duck off | duck <percent>
holdkey off | holdkey <keycode>
mic <uid> | mic default
engine local | engine cloud
stream on | stream off
```

A helper therefore holds no settings of its own across runs and needs no settings file.
Its built-in defaults only matter for the instant before these lines are read.

### 3.3 Quit paths

Every exit the helper controls restores a ducked output volume first.

| Trigger | Helper | Exit |
|---|---|---|
| `quit` | Restore volume, exit | code 0 |
| stdin closed (main died or called `stdin.end()`) | Same | code 0 |
| SIGTERM, SIGINT, SIGHUP | Same, after logging the signal | code 0 |
| Uncaught exception | Restore volume, then the process dies | signal or non-zero |
| SIGKILL, power loss | Nothing runs. The duck state file lets the next boot restore the volume. | signal |

`dispose()` in main writes `quit`, closes stdin, and sends SIGTERM only if the helper is
still alive 1500 ms later. That exit is "expected" and is not reported.

A helper that cannot be spawned at all is handled as an exit too. Any other exit is a
crash to main: every outstanding `stop` and `retry` is rejected with
`HelperGone` (except ids whose audio main is already uploading), every outstanding `cal`
resolves `{error: "helper exited"}`, the recording in progress is abandoned with one
notice, and the helper is respawned after 500 ms. After more than 3 unexpected exits in
60 seconds main stops respawning until the next dictation asks for the helper.

## 4. Events (stdout)

Every event is one line. `?` marks an optional field.

| Type | Shape | When |
|---|---|---|
| `boot` | `{type, pid?: number}` | First line of every run, exactly once. `pid` is the helper's own process id; main does not read it. |
| `hotkey-status` | `{type, installed: true}` or `{type, installed: false, reason: string}` | After boot, and after each later install attempt that changes or re-reports the state. `reason` is `"accessibility"` (not granted; the helper polls every 2 s and installs when it appears) or `"tapCreate failed"` (granted but refused; retried on the same poll, so it can repeat). |
| `devices` | `{type, devices: [{id: number, uid: string, name: string, isDefault: boolean}], pinned: string}` | After boot; in answer to `devices` and `mic`; and by itself 250 ms after the device list or the default input changes (several changes inside that window give one event). `pinned` is the pinned uid or `""`. `uid` is stable across reconnects and unique in the list; `id` is not stable and main does not use it. At most one device has `isDefault`. |
| `started` | `{type}` | In answer to `start`, once per recording, after the first attempt to open the microphone has returned (successfully or not). It means "the recording exists", not "the microphone is open". |
| `level` | `{type, value: number}` | Once per captured buffer during a recording (about 90 per second in the Swift helper). `value` is 0 to 1: `clamp((20*log10(rms) + 55) / 55)`, so -55 dBFS and below is 0 and full scale is 1. |
| `spectrum` | `{type, bands: number[28]}` | During a recording and during a mic test, each time 512 new samples (32 ms) have arrived. 28 values, 0 to 1, low pitch to high (section 5.5). |
| `partial` | `{type, text: string}` | During a recording with `stream off` and a model, whatever `engine` is, from a helper that lists the `partials` capability (a build that decodes on the CPU does not: each partial re-decodes the whole recording and would keep every core busy while the key is held): the whole hypothesis so far, never a delta, never empty. First one no earlier than 1.5 s in; see section 5.4. Never after the recording has ended, and never for an earlier recording. (The Swift helper only checks that some recording is running when a decode returns, so a decode that outlives its recording can leak into the next one. A new helper ties each partial to its recording.) |
| `chunk` | `{type, b64: string}` | During a recording with `stream on`: standard base64 of 16 kHz mono PCM16 little-endian, everything captured since the previous chunk, every 200 ms when there is something new (never an empty chunk). One last chunk is flushed on `stop`, before the answer. In order, the chunks of a recording concatenate to exactly its audio: byte for byte the sample data of the WAV an `audio` event hands over for it. None on `cancel`. |
| `transcribing` | `{type}` | Once per `stop` or `retry` that reaches a real transcription (local) or a WAV hand-over (cloud). Not sent for the early outs (nothing recording, too short, silence, no model) nor for `transcribe-file`. |
| `audio` | `{type, id: string, path: string, seconds: number}` | Cloud mode's answer to `stop`/`retry`: an absolute path to a 16 kHz mono 16-bit PCM WAV (plain 44-byte header, format tag 1) in the temp folder, and its length (`samples / 16000`, not rounded). Main owns the file from here (it deletes it after a successful upload, or sends `transcribe-file`). The helper sends no `final` for this id unless asked through `transcribe-file`, which then reuses the id. |
| `final` | `{type, id: string, text: string, error?: string}` | The answer to `stop`, `retry` and `transcribe-file`. `id` is always present (`""` for a bare `stop`; main reads a missing id as `""`). `text` is trimmed plain text on one line, `""` when there is none. `error` only ever comes with an empty `text`. `error`, when present, is the helper's own reason for the empty text, written for the user (section 9). A failed transcription is a `final`, never an `error` event. |
| `cancelled` | `{type}` | In answer to `cancel`, always. |
| `start-failed` | `{type, message: string}` | A recording that answered `started` never got a microphone (section 5.2). The recording is over: nothing is recording, the volume is restored, no `final` follows. `message` is shown to the user. |
| `interrupted` | `{type}` | The microphone went away mid-recording, no other would open, and some audio was captured. Sent once. The helper is still "recording" (no microphone, volume still ducked) and waits: main answers by sending `unlatch` and `stop <id>` to finish with what there is; `cancel` drops it. |
| `mic-test` | `{type, state: "started", device: string}` or `{type, state: "ended", error?: string}` | Section 2.4. `device` is the device's display name. |
| `mic-test-level` | `{type, value: number}` | As `level`, during a mic test. A mic test never emits `level`, a recording never emits `mic-test-level`. |
| `inserted` | `{type, chars: number}` | The paste chord was posted for an `insert`. `chars` counts characters (grapheme clusters in the Swift helper), not bytes. |
| `ax` | `{type, trusted: boolean}` | In answer to `ax-check`. |
| `hotkey` | `{type, intent: "start", latched: boolean}` or `{type, intent: "stop"}` or `{type, intent: "cancel"}` | Section 6. Main reads a missing `latched` as false. |
| `cal` | `{type, id: string, ...result}` | Section 8. |
| `error` | `{type, message: string}` | Something the user should be told that belongs to no id. Main shows `message` as a dictation error. Today the only sender is `insert` without Accessibility. |

### 4.1 Ordering guarantees

1. `boot` is first.
2. For one recording: `started` precedes every `level`, `spectrum`, `partial` and
   `chunk` of it. In the Swift helper a few `level`/`spectrum` lines can be queued
   before `started` reaches the pipe, because the capture is running before `started`
   is written; a helper should avoid that, and consumers must tolerate it.
3. `stop`: all `chunk`s, then `transcribing` (if any), then the one `audio` or `final`.
   No `level`, `spectrum`, `partial` or `chunk` of that recording after its answer
   (a line already in flight within about 250 ms is tolerated by the tests for
   `level` and `spectrum` only). The same holds after `cancelled`, and for
   `mic-test-level` after a mic test's `ended`.
4. `cancel`: `cancelled`, and no `final`, `audio` or `transcribing` for that recording.
5. `start` during a mic test: `mic-test` `ended` precedes `started`.
6. Answers to different ids are unordered relative to each other. Answers to
   back-to-back early outs (`stop a`, `retry b` with nothing recording) come in the
   order sent.
7. Exactly one answer per `stop <id>`, `retry <id>`, `transcribe-file <id> ...` and
   `cal`, unless the helper exits first. Failing is not a reason to stay silent: main
   holds the bar in "transcribing" for 45 s on an id that never comes back.
8. `hotkey-status`, `devices` and (section 11.2) `capabilities` can arrive at any time
   without a command. A consumer, and a test, must not read one as the answer to
   something else. A `devices` answering `mic <uid>` is recognised by its `pinned`.

## 5. Audio

### 5.1 Capture

- Format handed to everything downstream: 16 kHz, mono, 32-bit float in -1 to 1. The
  Swift helper asks the capture session for this directly (`AVCaptureSession`, device
  chosen by unique id); another helper resamples and downmixes itself.
- The microphone is opened by `start` and closed by `stop`, `cancel`, `start-failed`.
  It is never held open between recordings: an open microphone keeps a Bluetooth
  headset in its call profile.
- A pinned device that is not connected falls back to the system default for that
  recording; the pin is kept.
- The device is fixed for the life of a capture. A `mic` command applies to the next.

### 5.2 Opening and losing the microphone

| Situation | Behaviour |
|---|---|
| First open fails in `start` | `started` is still sent. The helper retries every 250 ms, up to 6 more times (about 1.5 s, 7 attempts in all). |
| A retry succeeds | Recording carries on; nothing is reported. |
| All retries fail and no sample was captured | `start-failed` with `"Could not open the microphone. Check the input in Settings and try again."` The recording is over. |
| Device unplugged or capture error mid-recording | What was captured is kept. The same 250 ms x 6 retry runs on whatever device is there now (pinned if back, else default). |
| Those retries fail with samples already captured | `interrupted`. The helper stays in the recording until main sends `stop`. |
| `stop` or `cancel` arrives while the retries are running | The retries end. `stop` runs the pipeline on what was captured (nothing, after a failed first open: an empty `final`); no `start-failed` or `interrupted` follows. |
| `start` arrives while a recording has no microphone (the retries are still running, or it was `interrupted` and never stopped) | That recording is dropped without an event, its audio with it, the volume is restored, and a new recording starts: a second `started`. This is the only case where `start` is not ignored during a recording. |
| No input device at all | Open fails with "No microphone found. Connect one or pick another input in Settings."; this goes to the log and the retry path above, or into a mic test's `ended.error`. |

### 5.3 The finishing pipeline (`stop`, `retry`)

Steps run in order; the first that applies answers.

| # | Condition | Answer |
|---|---|---|
| 1 | Nothing is recording (`stop`), or nothing kept / a recording is running (`retry`) | `final` `""` |
| 2 | Peak sample below 0.0005 and longer than 0.5 s (digital silence: the OS hands silence, not an error, to a process without microphone permission) | `final` `""` with the microphone-permission error |
| 3 | 0.3 s or shorter | `final` `""` |
| 4 | `engine cloud` | `transcribing`, then `audio` (or `final` with an error if the WAV could not be written) |
| 5 | No model path, or the file does not exist | `final` `""` with the no-model error |
| 6 | Otherwise | `transcribing`, then `final` with the text (empty when whisper returned nothing or failed) |

Steps 2 and 3 in numbers: a silent recording of 0.5 s or less is not called silent, so
one between 0.3 s and 0.5 s goes on to step 4 or 5 like any other. Steps 1, 2, 3 and 5
are the early outs: no `transcribing`.

`stop` keeps the audio for `retry` before step 2, so a recording that failed at any step
can be retried. `cancel` drops it and the next `stop` that ends a recording replaces
it. It lives in memory only.

Float to 16-bit, for the WAV and for chunks alike: `trunc(clamp(x, -1, 1) * 32767)`,
little-endian.

Text rules for step 6 and for `transcribe-file`: whisper's output lines are trimmed,
empty lines and lines that start with `[` (such as `[BLANK_AUDIO]`) are dropped, the
rest are joined with single spaces, and the result is trimmed. No timestamps.

Whisper parameters in the reference helper, which runs the bundled `whisper-cli` once
per pass with the library folder on `DYLD_LIBRARY_PATH`:

| Pass | Arguments |
|---|---|
| Final (`stop`, `retry`), `transcribe-file` | `-m <model> -f <wav> -nt --no-prints -t 8 -l <code or auto>` (default beam search) |
| Partial | the same plus `-bo 1 -bs 1` (greedy) |
| Language detection | `-m <model> -f <wav> -dl -t 8`; the code is read from `auto-detected language: xx (p = 0.99)` in its output |

A non-zero exit or a failed spawn is an empty text, logged, not an `error`.

### 5.4 Partials and chunks

| | Partials | Chunks |
|---|---|---|
| On when | `stream off`, either engine | `stream on`, either engine |
| Interval | 1.5 s | 0.2 s |
| Content | Full transcript of everything so far, greedy decode | PCM16 since the last chunk |
| Conditions | At least 1.0 s captured; previous partial finished (never overlapping); a model is set; non-empty text; the recording is still running when the decode returns | Something was captured since the last one |
| Language | First configured code (or `auto`), no detection pass | n/a |

### 5.5 Level and spectrum

- `level`: RMS of each buffer in dBFS, floor 1e-7, mapped `(dB + 55) / 55` and clamped
  to 0..1.
- `spectrum`: frames of 512 samples (the newest 512 once at least 512 have arrived, then
  everything pending is dropped, so frames never overlap and one capture buffer gives at
  most one frame), periodic Hann window `w[n] = 0.5 * (1 - cos(2*pi*n / 512))`, real FFT,
  power spectrum `|X[k]|^2` for bins 0 to 255.
- 28 bands with edges spaced evenly by pitch from 90 Hz to 7600 Hz:
  `edge_i = round(90 * (7600/90)^(i/28) * 512 / 16000)` for i = 0 to 28, then each edge
  is pushed up to at least one more than the one before. The result, as bin numbers:
  `3 4 5 6 7 8 9 10 11 12 14 16 19 23 26 31 36 43 50 58 68 80 94 110 129 151 177 208 243`.
  Band `b` covers bins `edge_b` up to but not including `edge_(b+1)`.
- Each band is its loudest bin, in dB relative to a full-scale sine:
  `dB = 10 * log10(max(|X[k]|^2 / 128^2, 1e-12))` with an unscaled forward DFT (a sine of
  amplitude 1 at a bin centre peaks at 512/4 = 128 through this window; Accelerate's
  packed real FFT returns twice that, which is why the Swift code divides by 256^2).
  Mapped `(dB + 62) / 46` and clamped to 0..1: -62 dB is empty, -16 dB is full. Checked
  against a plain DFT: 1 kHz at amplitude 1.0 gives 0 dB, at 0.1 gives -20 dB.
- Only the hub window draws the spectrum; the bar draws `level`.

## 6. Hold key

The helper owns the global hold-to-talk key because it needs a system-wide key hook.
It turns raw key edges into three intents. Main reacts as follows.

| Event | Main does |
|---|---|
| `hotkey` `start`, `latched: false` | `startDictation(byHotkey)` then sends `start` |
| `hotkey` `start`, `latched: true` | Second tap of a double-tap. Starts a recording if none is running and marks it hands-free; sends `unlatch` if the recording could not be started. |
| `hotkey` `stop` | `stopDictation()`, which sends `unlatch` then `stop <id>` |
| `hotkey` `cancel` | Sends `cancel`, but only for a recording the hold key started |

The gesture machine. Only the configured key's press and release count, a repeated
edge in the same direction is dropped, and all times are monotonic. Every down first
drops a pending short-tap wait and is timed against the down before it. Then, for one
edge, the first matching row wins:

| Edge | State | Result |
|---|---|---|
| Down | Less than 350 ms since the previous down (whatever that one did) | Latch on. `start` `latched: true`. |
| Down | Latched | Latch off. `stop`. |
| Down | Otherwise | `start` `latched: false`. Remember this as the press that started. |
| Up | Another key went down during this press | Nothing. |
| Up | Latched | Nothing (hands-free ignores the release). |
| Up | 300 ms or longer since the press that started | `stop`. |
| Up | Less than 300 ms | Wait 350 ms from the release for a second down. If none comes and it is not latched: `cancel`. |
| Another (non-modifier) key goes down while the hold key is held | This press sent an unlatched `start` | `cancel`, at once, and the pending short-tap wait is dropped: it was a shortcut, not a dictation. |
| `unlatch` command | Latched | Latch off, silently. |

Constants: hold threshold 300 ms (`hold-ms`), double-tap window 350 ms (`doubletap-ms`).
On the main side, a recording shorter than 600 ms that produced no text is treated as a
stray press and reported nowhere.

Sequences that follow from the table and that main is built to take. A new helper may
send them too; it must not rely on main to do anything else with them:

| Sequence | Why | Main |
|---|---|---|
| `start` `latched: true` twice or more | A third quick tap is again within 350 ms of the one before. | Already recording: stays latched. |
| `stop` on the press that ends a latch, then `stop` again on its release | The release is measured from the press that started, long ago. Swift helper quirk; a new helper should send one. | The second `stop` finds nothing recording and is ignored. |
| `start` `latched: false` twice with no `cancel` between | A second tap more than 350 ms after the first down but inside the first tap's 350 ms wait drops the wait. | `start` while recording is ignored; the recording goes on and the second press decides it. |
| `stop`, then `start` `latched: true` | A press held between 300 and 350 ms, then pressed again at once. | Starts a new, latched recording. |
| `cancel` with nothing recording, or for a recording started another way | Main ended it first (Esc, the tray), or started it from its shortcut. | Ignored. |

The latch lives in the helper and the recording in main, so main sends `unlatch`
whenever a recording ends by any route but the hold key (before every `stop`, after
its own `cancel`, on `start-failed`, when a latched `start` could not start a
recording). A fresh helper starts unlatched.

Platform behaviour on macOS, not part of the wire contract: the tap needs the
Accessibility grant; the press is passed through so fn+key combinations work; a
standalone release is swallowed so macOS does not run its own fn action; a release after
a combination is passed through; the system can disable a slow tap and the helper
re-enables it.

## 7. Output ducking

- `start` lowers every volume control of the default output device to `level` times its
  current value (main volume when the device has one, else each channel 1 to 8), after
  the microphone has been opened (or has failed its first attempt) and before `started`.
  Skipped when ducking is off, when already ducked, or when the loudest control is at
  or below 0.001.
- `stop`, `cancel`, `start-failed`, and every quit path restore the saved values on the
  same device (found by uid), even if the default output moved meanwhile.
- If that device is gone at restore time (headphones dropped out), the saved state is
  kept as an orphan and applied when the device list next changes or at the next
  `start`.
- Everything not yet restored is mirrored to the duck state file (section 10). On boot
  the helper reads it and restores, so a helper that was killed while ducked cannot
  leave the user's volume down for longer than until the next launch.
- With `duck off` the helper never lowers the volume and never saves a state. Putting
  back what an earlier duck or an earlier run left behind is not switched off by it:
  the boot recovery runs before any `duck` line can have been read, and a `duck off`
  that arrives in the middle of a ducked recording does not cancel that recording's
  restore. With nothing to put back, `duck off` means the output volume is never read
  or written at all, which is what the conformance suite checks.

## 8. Calendar (`cal`)

Request: `cal {"id": "<opaque>", "op": "<op>", ...args}`. Answer: `{"type":"cal","id":"<same>", ...}`.
Every answer may instead carry `error: string`. `calendars`, `upsert` and `delete`
answer `error: "no access"` together with the current `status` whenever that status is
not `"granted"` (write-only access counts as no access: an event could not be found
again to update it). Main treats any `error` as a failed op and logs it.

| op | Arguments | Answer fields |
|---|---|---|
| `status` | | `status`: `"granted"`, `"writeOnly"`, `"denied"` or `"notDetermined"`. Never prompts. |
| `request` | | `status`, after the system prompt is answered. Main allows 120 s. |
| `calendars` | | `calendars: [{id, title, source, color: "#rrggbb" or "", isDefault}]`, writable calendars only |
| `upsert` | `title`, `date` (`YYYY-MM-DD`), `time` (`HH:MM` local time, or `""` for all-day), `minutes` (integer, default 30), `notes` (`""` for none), `calendarId` (`""` or unknown: the default calendar), `eventId` (`""` to create) | `eventId`, `calendarId`. Errors `"bad date"`, `"bad time"` (both checked before anything is saved), or the system's message. An `eventId` that no longer exists creates a new event and returns the new id. An existing event keeps its calendar unless `calendarId` names another. No alarm is set. |
| `delete` | `eventId` | `gone: true` (also when it no longer exists) |
| anything else | | `error: "unknown op <op>"` |

Main's own results, never sent by the helper: `{error: "timed out"}` after 15 s (120 s
for `request`) and `{error: "helper exited"}`.

## 9. Strings main depends on

Most helper messages are shown to the user verbatim, so they are part of the contract
as copy. The ones main's logic branches on:

| Where | Value | Main's use |
|---|---|---|
| `final.error` | Matches `/microphone/i` | In practice mode the error is classed as a microphone problem (`'mic'`) and the permissions screen is offered; otherwise `'other'`. |
| `final.error` | Any non-empty string | Shown instead of main's generic "Nothing came back" message, and stored with the failed dictation in the history. Only read when `text` is empty. |
| `start-failed.message` | Any string | Shown as a microphone error (`'mic'`), whatever it says. |
| `cal` `error` | Truthy | The op failed. `"no access"`, `"timed out"` and `"helper exited"` are not told apart. |
| `hotkey-status.reason` | Exactly `"accessibility"` | Refreshes the permissions UI instead of reporting a failed hold key. Any other reason is reported once. |
| `cal` `status` | `"granted"`, `"writeOnly"`, `"denied"`, `"notDetermined"` | Calendar settings state. |
| `mic-test.state` | `"started"`, `"ended"` | Settings meter. |
| `hotkey.intent` | `"start"`, `"stop"`, `"cancel"` | Section 6. |

The reference helper's user-facing messages. A new helper keeps them, adapting the
macOS-specific wording per platform, with two words that must survive because code
matches on them: "microphone" in the silent-recording error (main, above, and the
conformance suite) and "model" in both no-model errors (the conformance suite). Main
shows at most the first line and 160 characters of any message.

| Event | Message |
|---|---|
| `final.error` | `No audio from the microphone. Allow Quill under Privacy & Security > Microphone.` |
| `final.error` | `No speech model installed. Pick one in Settings.` |
| `final.error` | `Could not save the recording for upload.` |
| `final.error` (`transcribe-file`) | `Cloud transcription failed and no speech model is installed to fall back on.` |
| `start-failed.message` | `Could not open the microphone. Check the input in Settings and try again.` |
| `mic-test.error` | `No microphone found. Connect one or pick another input in Settings.` / `Could not open <device>. Pick another input in Settings.` / `Could not read audio from <device>.` |
| `error.message` | `Quill needs Accessibility to type for you. Allow it from the Quill window; no relaunch needed.` |

## 10. Timing constants, files

| Constant | Value | Where |
|---|---|---|
| Hold threshold | 300 ms | helper |
| Double-tap window | 350 ms | helper |
| Partial interval / minimum audio | 1.5 s / 1.0 s | helper |
| Chunk interval | 200 ms | helper |
| Mic test duration | 6 s | helper |
| Mic open retry | 250 ms apart, 6 retries after the first attempt | helper |
| Device-change debounce | 250 ms | helper |
| Too short to transcribe | 0.3 s or less | helper |
| Silence check | peak < 0.0005 and longer than 0.5 s | helper |
| Paste delay / clipboard restore | 60 ms / 350 ms after the paste | helper |
| Accessibility poll while the tap is missing | 2 s | helper |
| Wait for a `final` | 45 s, then that id resolves empty | main |
| Wait for a `cal` | 15 s (120 s for `request`) | main |
| Quit grace before SIGTERM | 1500 ms | main |
| Respawn delay / crash limit | 500 ms / more than 3 in 60 s | main |
| Stray press | under 600 ms with no text | main |
| Whisper threads | 8 | helper |
| Spectrum frame / bands / range | 512 samples / 28 / 90 Hz to 7600 Hz | helper |
| Level floor, spectrum floor and range | -55 dBFS; -62 dB, 46 dB | helper |

| File | Written by | Notes |
|---|---|---|
| `~/Library/Logs/Quill-stt.log` | helper | Append only, never rotated. `[ISO-8601 UTC] text` per line. The only place to see what the helper did when the app was launched from Finder. Contains transcripts (`whisper: "..."`). |
| `~/Library/Logs/Quill-duck.json` | helper | Present only while something is ducked or orphaned. A JSON array of `{uid, volumes}`; Swift writes `volumes` (a map of channel element to 0..1) as a flat array `[element, value, element, value, ...]`. Older builds wrote one bare object, which is still read. Deleted when nothing is left to restore. |
| `<tmp>/flow-<uuid>.wav` | helper | Scratch WAV for a local transcription or a partial. Deleted by the helper. |
| `<tmp>/quill-<uuid>.wav` | helper, then main | The recording handed over in `audio`. Never deleted by the helper. |

The helper has no settings file and reads none. Whisper is found beside the helper:
`../Resources/whisper/whisper-cli` in the packaged app, `resources/whisper/whisper-cli`
in development.

Both files in `~/Library/Logs` are shared by every helper process of the same user, so a
second helper started while the first is ducked will "recover" the first one's duck at
its boot. The test harness avoids this by giving the helper a throwaway home folder.

## 11. Capabilities

### 11.1 Capability table (current, Swift helper)

"macOS-only by nature" means the capability rests on something only macOS has, so
another platform can at best offer a different feature under the same name. "Portable"
means each platform has an equivalent API and the wire contract is unchanged.

| Capability id | What | Commands | Events | macOS-only by nature? |
|---|---|---|---|---|
| `audio` | Record the microphone at 16 kHz mono | `start`, `stop`, `cancel`, `retry` | `started`, `final`, `cancelled`, `start-failed`, `interrupted` | No. Portable (WASAPI, PulseAudio/PipeWire/ALSA). The Bluetooth call-profile concern exists everywhere. |
| `devices` | List, pin, hot-plug | `devices`, `mic` | `devices` | No. Portable; `uid` becomes the platform's stable endpoint id, `id` loses meaning. |
| `level` | Loudness meter | | `level` | No. Pure arithmetic. |
| `spectrum` | 28-band meter | | `spectrum` | No. Needs an FFT library in place of Accelerate. |
| `mic-test` | Short level check | `mic-test`, `mic-test-stop` | `mic-test`, `mic-test-level` | No. |
| `transcribe` | Local whisper transcription | `model`, `stop`, `retry` | `transcribing`, `final` | No. whisper.cpp runs everywhere; only the GPU backend differs (Metal, Vulkan, CPU). |
| `partials` | Interim text while speaking | `stream off` | `partial` | No. Speed depends on the backend; a slow machine may simply send none. |
| `language-detect` | Pick among several languages | `lang` | | No. |
| `transcribe-file` | Local fallback for a WAV | `transcribe-file` | `final` | No. |
| `cloud-audio` | Hand the WAV to main | `engine cloud` | `audio` | No. |
| `stream` | Live PCM chunks | `stream on` | `chunk` | No. |
| `hotkey` | Global hold key with hold, double-tap latch, cancel | `holdkey`, `unlatch`, `hold-ms`, `doubletap-ms` | `hotkey`, `hotkey-status` | Partly. The gesture machine is portable. The fn key (keycode 63) is macOS-only: Windows and Linux never see it. Keycodes are macOS virtual keycodes. Wayland gives an unprivileged process no global key events at all. |
| `hotkey-swallow` | Suppress the bare key's own OS action | (implicit) | | Yes in its present meaning (stopping the fn/globe action). Other platforms have different things to suppress or nothing. |
| `insert` | Type into the focused app | `insert` | `inserted`, `error` | No, but the paste chord (Cmd+V vs Ctrl+V, Ctrl+Shift+V in terminals), the clipboard API and the limits (elevated windows on Windows, Wayland) differ. |
| `accessibility` | Permission gate for typing and the hold key | `ax-check` | `ax`, `hotkey-status.reason = "accessibility"` | Yes. The Accessibility grant (TCC) is a macOS concept. Elsewhere `ax` should answer `trusted: true` unless a real equivalent gate exists (Linux input group for evdev). |
| `duck` | Lower output volume while recording, crash recovery | `duck` | | No. Portable (endpoint volume on Windows, default sink on PulseAudio/PipeWire); the per-channel detail is CoreAudio's. |
| `calendar` | Todos to the system calendar | `cal` | `cal` | Yes. EventKit and Calendar.app. No system calendar store exists on Windows or Linux. |
| `mic-permission-hint` | "Digital silence means no permission" (pipeline step 2) | | `final.error` | Mostly. macOS hands silence to an unpermitted process. Windows fails the open instead; Linux has no such gate. The check is harmless elsewhere but the message must change. |

### 11.2 Proposal: `capabilities` handshake

Status: proposed, not implemented by the Swift helper or read by main. It adds one
event and changes no existing message, so an old main with a new helper and a new main
with an old helper both keep working.

**Event.** Written once, directly after `boot` and before any other line:

```json
{"type":"capabilities","protocol":1,"platform":"macos","helper":"quill-helper 0.2.0",
 "capabilities":["audio","devices","level","spectrum","mic-test","transcribe","partials",
                 "language-detect","transcribe-file","cloud-audio","stream","hotkey",
                 "hotkey-swallow","insert","accessibility","duck","calendar"],
 "holdKeys":[63,54,61,62,60,57],
 "notes":{}}
```

| Field | Type | Meaning |
|---|---|---|
| `platform` | `"macos"`, `"windows"`, `"linux"` | What the helper was built for, so the UI can word things (Cmd vs Ctrl, "Privacy & Security"). |
| `capabilities` | string[] | Ids from the table in 11.1 that work in this build, on this machine, in this session. Absent id means: hide the feature. Unknown ids are ignored by main. |
| `protocol` | number, optional | 1 for this document. Bumped only for a breaking change. |
| `helper` | string, optional | Name and version, for the log. |
| `holdKeys` | number[], optional | Keycodes `holdkey` accepts here, so Settings lists only keys that exist (no fn outside macOS). Absent means the macOS set. |
| `notes` | object, optional | Free-form per-capability detail for the log or a tooltip, for example `{"hotkey":"wayland: needs the input group"}`. |

**Rules.**

1. `boot` stays first and unchanged; the first `capabilities` is the second line, or
   there is none at all.
2. A helper that sends no `capabilities` within the first events is the Swift helper:
   main assumes `platform: "macos"` and the full list above.
3. The list describes what the helper can do, not what is currently permitted. A
   missing Accessibility grant is still reported through `hotkey-status` and `ax`;
   `hotkey` stays in the list.
4. If a capability changes while running (a Wayland portal appears, a device class goes
   away) the helper may send `capabilities` again; the newest one replaces the previous.
5. A helper that lists `hotkey` sends `hotkey-status` at boot as today. One that does
   not list it may leave `hotkey-status` out.
6. Commands for an absent capability stay safe to send, because main sends its settings
   before it has read anything: settings commands are accepted and ignored, `cal`
   answers `{"type":"cal","id":...,"error":"unsupported"}`, `insert` answers `error`
   with a message for the user, `ax-check` answers `trusted: true` where there is no
   such gate.

**What main and the UI do with it** (when implemented): `stt.ts` stores the last
`capabilities` and exposes `has(id)`; main forwards it to the renderer over one IPC
channel. Examples: no `calendar` hides the calendar sync settings and skips `CalendarSync`;
no `duck` hides the volume option; no `hotkey` hides the hold-key picker and points the
user at the Electron global shortcut; `holdKeys` filters the picker; no `accessibility`
drops that row from the permissions screen.

The conformance suite already checks the event when it is present (its place after
`boot`, the types of every field), requires it when `HELPER_EXPECT_CAPS=1`, and accepts
`error` answers from `cal`, so a helper without a calendar passes.

## 12. Conformance

```
bun run stt:build                                    # the Swift reference helper
bun test tests/helper                                # against the reference helper
HELPER_BIN=/path/to/helper bun test tests/helper     # against any other helper
```

| Variable | Effect |
|---|---|
| `HELPER_BIN` | Helper under test. Default: the Swift helper in `resources/FlowSTT.app`. |
| `HELPER_ARGS` | Extra argv, space separated. |
| `HELPER_NO_MIC=1` | Skip every test that opens a microphone (CI). |
| `HELPER_MIC` | Device uid pinned before any test records. Default `BuiltInMicrophoneDevice` on macOS; no default elsewhere, so microphone tests skip until it is given. If that device is not connected the microphone tests skip instead of falling back to the system default. |
| `HELPER_MODEL` | Whisper model for the speech tests. Default: `ggml-tiny.en.bin` in Quill's models folder. Missing model: those tests skip. |
| `HELPER_SLOW=1` | Also run the 6 second mic-test timeout. |
| `HELPER_EXPECT_CAPS=1` | Require the `capabilities` handshake. |
| `HELPER_REAL_HOME=1` | Do not give the helper a throwaway home folder. |

What the suite does to stay out of the user's way: `duck off` and `holdkey off` are the
first two lines every helper reads, written before it has printed `boot` (which is also
how main talks to it); every recording and mic test runs on the pinned `HELPER_MIC`;
no `duck <number>`, `holdkey <code>`, `insert` with text, or calendar write is ever
sent; and each helper gets a throwaway home folder so that its log and duck state do
not mix with the running app's. The hold key, typing, audible ducking, hot-plug and real
speech are in `docs/HELPER-MANUAL-TESTS.md`.

What it checks, by group:

| Group | Checks |
|---|---|
| boot | `boot` first and once; commands written before `boot` are honoured; `devices` and `hotkey-status` arrive unprompted, in either order; `capabilities` when sent; the log grows |
| devices | `devices`; `mic <uid>`, an unknown uid, a uid with spaces and `mic default`, each echoed in `pinned` |
| no recording | `stop`/`retry` with and without an id answer one empty `final`, in order, ids echoed untouched, no `transcribing`; `cancel` answers `cancelled` every time |
| silence | `unlatch`, every settings command including malformed ones, unknown and junk lines, and `mic-test-stop` with no test produce no event |
| queries | `ax-check`; `cal` status, unknown op, `calendars`, deleting an event that does not exist, an `upsert` with a bad date |
| quit | `quit`, stdin closing, SIGTERM, `quit` while recording and `quit` with answers owed all exit 0 with nothing but JSON on stdout |
| transcribe-file | the spoken fixture, a path with spaces, two overlapping ids, a missing file (empty `final`), no model and a model path with no file (the reason in the `final`) |
| microphone | `started`, `level`, 28-band `spectrum`, `cancelled`; a second `start` ignored; `retry` during a recording; the early outs carry no `transcribing`; local `stop` and `retry`; cloud hand-over of a 16 kHz mono WAV, `transcribe-file` on it, `retry` handing the same audio over again; chunks equal to the WAV sample for sample; none after `cancel` or with `stream off` |
| mic test | `started` with the device name, levels, `ended`; a second `mic-test` restarts quietly; `cancel` and `stop` leave it running; `start` takes the microphone; `mic-test` during a recording; the 6 s timeout (slow) |

Three things to know when a run surprises you:

- The suite treats `hotkey-status`, extra `devices` and `capabilities` as unsolicited
  (section 4.1, rule 8) and never counts them as an answer.
- Where the process has no microphone permission the recordings are digital silence.
  The cloud and streaming tests then shorten the recording until it falls between 0.3 s
  and 0.5 s, the window in which section 5.3 hands a silent recording over like any
  other, so the `audio` path is still exercised.
- A helper that passes has not been shown to type, duck, or hear a key.

The speech fixture is made at test time with `say -o` and `afconvert` (16 kHz mono
WAV of "The quick brown fox jumps over the lazy dog."); without those tools the speech
tests skip.

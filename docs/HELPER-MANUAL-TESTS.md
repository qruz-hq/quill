# Helper manual tests

What `tests/helper` cannot check by itself: anything that needs a finger on the hold
key, a focused text field in another app, an audible volume change, a device being
plugged in, or a system permission prompt. Run this list against a new helper build on
each platform before it replaces the current one. The wire contract these checks refer
to is `docs/HELPER-PROTOCOL.md`.

Do the automated suite first (`bun test tests/helper`); this list assumes it passes.

## Setup

- Run the app with the helper under test, or drive the helper by hand from a terminal:
  type commands on stdin, read events on stdout, and watch the log
  (`~/Library/Logs/Quill-stt.log` on macOS).
- Have a text editor open with an empty document for the typing checks.
- Play quiet music for the ducking checks and note the volume before each one.
- If a Bluetooth headset is connected, pin the built-in microphone (`mic <uid>`) unless
  the check says otherwise, so the headset is not thrown into its call profile.
- Tick each box per platform. "n/a" is a valid answer where the capability is not in
  the helper's `capabilities` list.

## 1. Hold key: gestures

Expected events are the `hotkey` lines on stdout. Defaults: hold threshold 300 ms,
double-tap window 350 ms.

| # | Do | Expect | mac | win | linux |
|---|---|---|---|---|---|
| 1.1 | Hold the key for about a second, release | `start` `latched:false` on press, `stop` on release | [ ] | [ ] | [ ] |
| 1.2 | Tap once, quickly (under 300 ms) | `start` `latched:false`, then `cancel` about 350 ms after the release. No `stop`. | [ ] | [ ] | [ ] |
| 1.3 | Double-tap | `start` `latched:false`, then `start` `latched:true`. No `cancel`, nothing on either release. | [ ] | [ ] | [ ] |
| 1.4 | While latched, tap once | `stop` on the press. On the release: nothing from a new helper; the Swift reference helper sends a second `stop` there, which main ignores. Either way the app stops once. | [ ] | [ ] | [ ] |
| 1.5 | While latched, send `unlatch`, then hold and release | The hold behaves as 1.1 (`start` then `stop`), not as 1.4 | [ ] | [ ] | [ ] |
| 1.6 | Hold the key, press another key (a letter or an arrow), release both | `start` `latched:false`, then `cancel` the moment the other key goes down. Nothing on release. | [ ] | [ ] | [ ] |
| 1.7 | Hold exactly at the edge: releases at about 250 ms and about 350 ms | 250 ms gives `cancel` (after the window), 350 ms gives `stop` | [ ] | [ ] | [ ] |
| 1.8 | Tap, wait half a second, tap | Two separate `start`/`cancel` pairs, no latch | [ ] | [ ] | [ ] |
| 1.9 | Send `holdkey off`, press the key in every way above | No `hotkey` events at all, and the key keeps its normal OS behaviour | [ ] | [ ] | [ ] |
| 1.10 | Send `holdkey <other key>` (each key in the platform's list) and repeat 1.1 | Only the chosen key triggers; left and right variants of a modifier are told apart | [ ] | [ ] | [ ] |
| 1.11 | Triple-tap quickly | `start` `latched:false`, then `start` `latched:true` twice. One recording, still latched. | [ ] | [ ] | [ ] |
| 1.12 | Tap, then tap again about 450 ms after the first press (after the double-tap window, before the first tap's `cancel`) | A second `start` `latched:false` and no `cancel` for the first tap; the second press alone decides the recording (`cancel` if short, `stop` if held) | [ ] | [ ] | [ ] |
| 1.13 | With the app running: 1.1 to 1.6 end to end | The bar shows recording, hands-free, cancel and transcript as the events imply; a quick tap leaves no error card and no history row | [ ] | [ ] | [ ] |

## 2. Hold key: what the rest of the system sees

| # | Do | Expect | mac | win | linux |
|---|---|---|---|---|---|
| 2.1 | Tap the hold key alone | The OS does not run the key's own action (macOS: no input-source switch, no emoji picker, no Dictation prompt) | [ ] | [ ] | [ ] |
| 2.2 | Use the key in its normal combinations (macOS: fn+arrows, fn+F-keys, fn+delete; modifiers: normal shortcuts) | They work exactly as without the helper | [ ] | [ ] | [ ] |
| 2.3 | Type normally for a minute with the helper running | No lost, repeated or delayed keys | [ ] | [ ] | [ ] |
| 2.4 | Put the system under load (a build), then hold the key | The gesture still registers; on macOS the log may show "tap re-enabled" and it keeps working | [ ] | [ ] | [ ] |
| 2.5 | Focus a password field (macOS secure input, for example a `sudo` prompt in Terminal), hold the key | Either it works or `hotkey-status` reports why; it must not die silently | [ ] | [ ] | [ ] |
| 2.6 | Quit the helper | The key returns to its normal behaviour at once, no stuck modifier | [ ] | [ ] | [ ] |
| 2.7 | Two helpers running at once (the app plus a test run) | Known hazard: both act on the key. Confirm the test instance with `holdkey off` does nothing. | [ ] | [ ] | [ ] |

## 3. Permissions

| # | Do | Expect | mac | win | linux |
|---|---|---|---|---|---|
| 3.1 | Start with no Accessibility grant | `hotkey-status` `installed:false` `reason:"accessibility"`. No system prompt at launch. | [ ] | n/a | [ ] |
| 3.2 | Grant it while the helper runs | Within about 2 s (at once after `ax-check`): `hotkey-status` `installed:true`. No relaunch. | [ ] | n/a | [ ] |
| 3.3 | `ax-check` with and without the grant | `ax` `trusted` matches the system setting | [ ] | [ ] | [ ] |
| 3.4 | `insert` without the grant | One `error` with the Accessibility message, nothing typed, clipboard untouched | [ ] | n/a | [ ] |
| 3.5 | Record with microphone permission denied | The recording ends in `final` with the microphone error (or `start-failed` where the OS refuses the open), never a hang | [ ] | [ ] | [ ] |
| 3.6 | First ever recording, permission not yet decided | The OS prompt appears under the app's name; after Allow, the next recording has audio | [ ] | [ ] | [ ] |
| 3.7 | `cal {"id":"1","op":"request"}` | System calendar prompt; answer carries the resulting `status` | [ ] | n/a | n/a |

## 4. Typing into other apps (`insert`)

Send `insert <base64 of the text>`; expect `inserted` with the character count.

| # | Do | Expect | mac | win | linux |
|---|---|---|---|---|---|
| 4.1 | Plain sentence into a native editor | Text appears once at the cursor | [ ] | [ ] | [ ] |
| 4.2 | Text with a newline, a tab, an emoji, accented and CJK characters | Arrives intact; `chars` counts characters, not bytes | [ ] | [ ] | [ ] |
| 4.3 | Copy something first, insert, wait a second, paste by hand | The original clipboard text is back | [ ] | [ ] | [ ] |
| 4.4 | Copy an image or a file first, insert, paste by hand | Note the result: the reference helper only restores plain text | [ ] | [ ] | [ ] |
| 4.5 | A non-QWERTY layout (Dvorak, AZERTY) | Text is pasted, not a stray character typed | [ ] | [ ] | [ ] |
| 4.6 | Targets: browser text field, Electron app (Slack, VS Code), terminal | Works, or the limit is written down (terminals on Linux need a different paste chord) | [ ] | [ ] | [ ] |
| 4.7 | Target running elevated (Windows: an administrator window) | A clear `error` or `inserted` with a reason, not silence | n/a | [ ] | n/a |
| 4.8 | Two inserts 100 ms apart | Both texts arrive, in order, and the clipboard ends up as it began | [ ] | [ ] | [ ] |
| 4.9 | A clipboard manager is running | The transcript does not pile up in its history (or the limit is written down) | [ ] | [ ] | [ ] |
| 4.10 | End to end: dictate into the editor with the hold key | The transcript lands in the editor, focus never leaves it | [ ] | [ ] | [ ] |

## 5. Output ducking

Start each check from a known volume with music playing. `duck 15` unless stated.

| # | Do | Expect | mac | win | linux |
|---|---|---|---|---|---|
| 5.1 | `start`, wait, `stop 1` | Volume drops to about 15% of its value on `start`, returns exactly on `stop` | [ ] | [ ] | [ ] |
| 5.2 | `start`, `cancel` | Same, restored on `cancel` | [ ] | [ ] | [ ] |
| 5.3 | `duck 0` | Silent while recording, restored after | [ ] | [ ] | [ ] |
| 5.4 | `duck off` | Volume never moves (also covered by the automated suite) | [ ] | [ ] | [ ] |
| 5.5 | Output muted, or volume at zero | Nothing changes, nothing is "restored" to a wrong value | [ ] | [ ] | [ ] |
| 5.6 | Bluetooth or USB headphones as output | Both ears duck and both come back | [ ] | [ ] | [ ] |
| 5.7 | `start`, then `quit` | Restored before exit | [ ] | [ ] | [ ] |
| 5.8 | `start`, then close stdin; `start`, then SIGTERM | Restored before exit both times | [ ] | [ ] | [ ] |
| 5.9 | `start`, then `kill -9` the helper; start a new helper | Volume stays down after the kill and is restored when the new helper boots; the state file is gone afterwards | [ ] | [ ] | [ ] |
| 5.10 | `start`, disconnect the headphones, `stop 1`, reconnect them | The headphones come back at their original volume, not the ducked one | [ ] | [ ] | [ ] |
| 5.11 | `start`, change the volume by hand, `stop 1` | Note the result: the reference helper restores the value from before the duck | [ ] | [ ] | [ ] |
| 5.12 | Output switches while ducked (headset changes profile, another device becomes default) | The original device gets its volume back; the new one is untouched | [ ] | [ ] | [ ] |

## 6. Devices and hot-plug

| # | Do | Expect | mac | win | linux |
|---|---|---|---|---|---|
| 6.1 | Plug in a USB microphone, then unplug it | One `devices` event each time (not a burst), with and without the device | [ ] | [ ] | [ ] |
| 6.2 | Change the system default input | `devices` with `isDefault` moved | [ ] | [ ] | [ ] |
| 6.3 | Pin the USB microphone, record, check the log | The recording used it, not the default | [ ] | [ ] | [ ] |
| 6.4 | Pin it, unplug it, record | Recording falls back to the default; `pinned` still names the USB device; plugging it back makes the next recording use it | [ ] | [ ] | [ ] |
| 6.5 | Unplug the microphone in the middle of a recording | Recording continues on another device, and `stop` returns the audio from both parts; with no other device: `interrupted`, then `stop` returns what was captured | [ ] | [ ] | [ ] |
| 6.6 | No input device at all, `start` | `started`, then `start-failed` about 1.5 s later; volume restored; a later `start` with a device works | [ ] | [ ] | [ ] |
| 6.7 | Bluetooth headset as the default input, nothing pinned, `start` then `stop` | Recording works even though the first open lands mid profile switch; the headset returns to its music profile within seconds of `stop` | [ ] | [ ] | [ ] |
| 6.8 | Bluetooth headset as output only, built-in microphone pinned, record | The headset stays in its music profile throughout | [ ] | [ ] | [ ] |
| 6.9 | `mic-test` on each listed device | `started` names the device; the level moves when you speak; it ends by itself after 6 s | [ ] | [ ] | [ ] |
| 6.10 | Sleep and wake the machine, then record | Works without restarting the helper | [ ] | [ ] | [ ] |

## 7. Real speech

The automated suite transcribes a synthetic WAV and records room noise. These need a
voice.

| # | Do | Expect | mac | win | linux |
|---|---|---|---|---|---|
| 7.1 | Dictate two sentences, local engine | `partial` lines appear from about 1.5 s on, each the whole text so far; `transcribing`, then a `final` with the sentences | [ ] | [ ] | [ ] |
| 7.2 | `retry <id>` after 7.1 | The same text again | [ ] | [ ] | [ ] |
| 7.3 | `lang en,fr`, dictate once in each | Each comes back in its own language (check the log for the detected code) | [ ] | [ ] | [ ] |
| 7.4 | `lang auto`, dictate | Text in the spoken language | [ ] | [ ] | [ ] |
| 7.5 | Hold the key and say nothing for 3 s | Empty `final`, or one with only harmless text; never a bracketed tag such as `[BLANK_AUDIO]` | [ ] | [ ] | [ ] |
| 7.6 | Each installed model size | A `final` arrives inside main's 45 s limit for a 30 s recording | [ ] | [ ] | [ ] |
| 7.7 | Cloud engine with streaming, with the app | Words appear while speaking; the final text is delivered once | [ ] | [ ] | [ ] |
| 7.8 | Cloud engine, network off, with the app | The notice says it fell back, and the local model's text arrives (`transcribe-file`) | [ ] | [ ] | [ ] |
| 7.9 | Start a second dictation while the first is still transcribing | Both texts arrive, each in the right place | [ ] | [ ] | [ ] |
| 7.10 | A five minute recording | Memory stays bounded, the `final` arrives, partials do not fall further and further behind | [ ] | [ ] | [ ] |

## 8. Calendar (macOS only)

Use a throwaway calendar.

| # | Do | Expect | mac |
|---|---|---|---|
| 8.1 | `calendars` | Lists writable calendars with colours; exactly one `isDefault` | [ ] |
| 8.2 | `upsert` with a date and a time | Event appears at that time for `minutes`; answer has an `eventId` | [ ] |
| 8.3 | `upsert` again with that `eventId` and a new title | The same event changes; no duplicate | [ ] |
| 8.4 | `upsert` with an empty `time` | All-day event | [ ] |
| 8.5 | `delete`, then `delete` again | `gone:true` both times | [ ] |
| 8.6 | Any op with calendar access denied | `error:"no access"` with the `status` | [ ] |

## 9. Lifecycle with the app

| # | Do | Expect | mac | win | linux |
|---|---|---|---|---|---|
| 9.1 | Kill the helper while idle | The app respawns it within a second; settings are re-sent (the log shows model, languages, mic, engine); the hold key works again | [ ] | [ ] | [ ] |
| 9.2 | Kill the helper mid-recording | One notice, the bar returns to idle, volume restored at the respawn | [ ] | [ ] | [ ] |
| 9.3 | Kill the helper while transcribing | One notice, no hang until the 45 s timeout | [ ] | [ ] | [ ] |
| 9.4 | Quit the app while recording | Helper exits, volume restored, no orphan process | [ ] | [ ] | [ ] |
| 9.5 | Force-quit the app | Helper sees stdin close and exits by itself | [ ] | [ ] | [ ] |
| 9.6 | Log out or shut down while recording | Volume is back at the next login at the latest | [ ] | [ ] | [ ] |
| 9.7 | Packaged build, launched from the file manager | Permission prompts name Quill; the helper finds whisper and writes its log | [ ] | [ ] | [ ] |

## Windows

What only a real Windows machine can show. Nothing in the Windows backends has been
run yet, so start at W1 and stop at the first surprise. Build on the machine itself
(`bun run helper:build`, needs Visual Studio Build Tools, CMake and LLVM with
`LIBCLANG_PATH`), drive the helper from PowerShell by typing commands into it, and
watch `%LOCALAPPDATA%\Quill\Logs\Quill-stt.log`. Background and the key table:
`native/helper/src/platform/windows/README.md`. Sections 1 to 7 and 9 above apply as
well; this list is what they do not cover.

### W1. Build and boot

| # | Do | Expect | win 10 | win 11 |
|---|---|---|---|---|
| W1.1 | `cargo test` in `native/helper` | All tests pass, including `the_default_output_is_found_again_by_its_id` and the registry read | [ ] | [ ] |
| W1.2 | `bun run helper:build`, then `bun test tests/helper` with `HELPER_BIN` set to the `.exe` | Builds with whisper; the conformance suite passes | [ ] | [ ] |
| W1.3 | Start the helper, type `holdkey off`, `duck off` | First line `boot`, second `capabilities` with `platform:"windows"`, `holdKeys:[62,61,60,57]`, `hotkey`, `hotkey-swallow`, `insert`, `duck`, no `accessibility`, no `calendar`, `notes.transcribe:"cpu"`; then `hotkey-status installed:true` and `devices` | [ ] | [ ] |
| W1.4 | `ax-check` | `{"type":"ax","trusted":true}` | [ ] | [ ] |
| W1.5 | `quit`, then again: close the console window, Ctrl+C, kill from Task Manager while recording with ducking on | Exits within a second each time; after the Task Manager kill the next start puts the volume back | [ ] | [ ] |

### W2. Microphone and devices

| # | Do | Expect | win 10 | win 11 |
|---|---|---|---|---|
| W2.1 | `devices` | Every enabled input once, `uid` like `{0.0.1.00000000}.{...}`, one `isDefault` | [ ] | [ ] |
| W2.2 | Unplug and replug a USB microphone | A `devices` event within half a second each way; the `uid` is the same as before | [ ] | [ ] |
| W2.3 | Change the default input in Settings > System > Sound | A `devices` event with the new default | [ ] | [ ] |
| W2.4 | Disable an input in Sound settings, enable it again | It leaves and returns in `devices` | [ ] | [ ] |
| W2.5 | Pin a microphone (`mic <uid>`), reboot, `devices` | Same `uid`, still pinned | [ ] | [ ] |
| W2.6 | Record 3 s on a 48 kHz stereo device, a 44.1 kHz device and a 16 kHz Bluetooth headset | `level` and `spectrum` move with the voice; the `final` has the words | [ ] | [ ] |
| W2.7 | Unplug the microphone mid-recording | The recording carries on with the default input or ends in a clear error; no hang | [ ] | [ ] |
| W2.8 | Settings > Privacy & security > Microphone: turn off "Let desktop apps access your microphone", then `start 1` and `mic-test` | `start-failed` or a `final.error` that says Windows is blocking the microphone and names the setting | [ ] | [ ] |
| W2.9 | The same with "Microphone access" off, and with everything back on | Same message; with everything on, a normal recording | [ ] | [ ] |
| W2.10 | Record with a Bluetooth headset as both input and output | The headset leaves its hands-free profile within a few seconds of `stop` (music sounds full again) | [ ] | [ ] |

### W3. Hold key

Default key: Right Ctrl. Run section 1 (gestures) with it first.

| # | Do | Expect | win 10 | win 11 |
|---|---|---|---|---|
| W3.1 | Hold Right Ctrl 1 s, release | `hotkey start` on the press, `stop` on the release; Left Ctrl gives nothing | [ ] | [ ] |
| W3.2 | Right Ctrl + C in an editor | Copies as usual; `start` then `cancel` | [ ] | [ ] |
| W3.3 | `holdkey 63` (main's stored default) | Right Ctrl is the hold key | [ ] | [ ] |
| W3.4 | `holdkey 61`, tap and hold Right Alt in Notepad and in File Explorer | Gestures work; the menu bar is not focused after a lone press; Alt+Tab and Alt+F4 with Right Alt still work | [ ] | [ ] |
| W3.5 | `holdkey 61` on a layout with AltGr (German, Portuguese), type `@` and `€` | The characters are typed; at most a `start` then `cancel`; no Left Ctrl gets stuck | [ ] | [ ] |
| W3.6 | `holdkey 59` (Left Ctrl) on an AltGr layout, press AltGr | No `hotkey` event | [ ] | [ ] |
| W3.7 | `holdkey 57`, hold Caps Lock, release | Gestures work as a hold; the Caps Lock light and state never change | [ ] | [ ] |
| W3.8 | `holdkey 54`, tap Right Win; then Win+E with it | Start does not open on the lone tap; Win+E still opens Explorer | [ ] | [ ] |
| W3.9 | `fn-capture-off` with Right Alt and Caps Lock | The menu bar is focused and Caps Lock toggles again; gestures still reported | [ ] | [ ] |
| W3.10 | `holdkey 60`, hold Right Shift 10 s | Recording runs; note whether Windows offers Filter Keys (expected, documented) | [ ] | [ ] |
| W3.11 | `holdkey off` | No `hotkey` events; every key behaves normally | [ ] | [ ] |
| W3.12 | Hold Right Ctrl, click into Task Manager or an elevated terminal, release | A `stop` (or `cancel`) arrives no later than about a quarter second after the key is released (it may already arrive when the focus moves); the recording does not hang | [ ] | [ ] |
| W3.13 | With an elevated window focused, press Right Ctrl | Nothing (documented limit); works again once a normal window has focus | [ ] | [ ] |
| W3.14 | Hold Right Ctrl, press Win+L, unlock | The press was ended; the next press starts a new recording | [ ] | [ ] |
| W3.15 | Leave the helper running for an hour with the machine under load (a build), then press the key | Still works; the log has no "could not put the hook back" | [ ] | [ ] |
| W3.16 | Sleep the machine and wake it; switch user and back; connect over Remote Desktop | The hold key works afterwards, at the latest a minute later | [ ] | [ ] |
| W3.17 | Type fast in an editor for a minute with the helper running | No dropped or delayed keys; no `hotkey` events | [ ] | [ ] |
| W3.18 | PowerToys Keyboard Manager: remap Caps Lock to Right Ctrl, hold Caps Lock | Works as the hold key | [ ] | [ ] |
| W3.19 | Dictate, so that the helper pastes, while still holding Right Ctrl (latch, then tap) | The paste's own Ctrl+V does not produce a `cancel` | [ ] | [ ] |
| W3.20 | A full-screen game and a virtual machine window in front | Note what happens (raw input may bypass the hook); the helper must not hang | [ ] | [ ] |

### W4. Typing into other apps

Run section 4 first. Copy a known word before each row to check the restore.

| # | Do | Expect | win 10 | win 11 |
|---|---|---|---|---|
| W4.1 | `insert` into Notepad, Word, a browser text field, VS Code, Slack or Teams | Text appears once, `inserted` follows, the old clipboard text is back within half a second | [ ] | [ ] |
| W4.2 | `insert` text with accents, emoji and a line break | Arrives whole | [ ] | [ ] |
| W4.3 | Open Win+V after an insert | The dictation is not in the history; the old text is listed once | [ ] | [ ] |
| W4.4 | `insert`, and copy something else within 300 ms | The newer copy stays on the clipboard | [ ] | [ ] |
| W4.5 | `insert` with an image on the clipboard | Text is pasted; the dictation stays on the clipboard (images are not restored, as on macOS) | [ ] | [ ] |
| W4.6 | `insert` into Windows Terminal, cmd, PowerShell, the VS Code terminal | Pasted with Ctrl+V | [ ] | [ ] |
| W4.7 | `insert` into Git Bash (mintty), PuTTY, Alacritty, WezTerm, gVim, Emacs | Pasted (Shift+Insert); no `^V` or stray character | [ ] | [ ] |
| W4.8 | `insert` into a WSL shell in Windows Terminal and in the classic console | Pasted; note if the classic console in legacy mode does not | [ ] | [ ] |
| W4.9 | `insert` while holding Shift, then Alt, then Win, then Right Ctrl | Plain paste each time; no other shortcut fires; no modifier is stuck afterwards | [ ] | [ ] |
| W4.10 | `insert` with Task Manager or an elevated terminal in front | An `error` saying the window runs as administrator and the text is on the clipboard; Ctrl+V by hand pastes it; no `inserted` | [ ] | [ ] |
| W4.11 | Run the helper itself elevated and repeat W4.10 | Pasted normally | [ ] | [ ] |
| W4.12 | `insert` with a clipboard manager running (Ditto) and with another program holding the clipboard open | Still pasted, or typed key by key; never the old clipboard text | [ ] | [ ] |
| W4.13 | `insert` into a password field and into a Remote Desktop window | Note what happens | [ ] | [ ] |
| W4.14 | `insert` with a Japanese or Chinese IME active | Pasted text is not eaten by the composition | [ ] | [ ] |
| W4.15 | `insert` with no window focused (click the desktop) | `inserted`, nothing typed, nothing breaks | [ ] | [ ] |

### W5. Ducking

Run section 5 first.

| # | Do | Expect | win 10 | win 11 |
|---|---|---|---|---|
| W5.1 | `duck 0.15`, play music, `start 1`, `stop 1` | The volume slider drops to 15% of its value and returns to exactly the old value; no volume flyout appears | [ ] | [ ] |
| W5.2 | Set a left/right balance (Sound > device properties), repeat with `duck 0` | The balance is the same afterwards | [ ] | [ ] |
| W5.3 | Kill the helper from Task Manager while ducked, start it again | `Quill-duck.json` exists in `%LOCALAPPDATA%\Quill\Logs` after the kill; the volume is back and the file gone after the start | [ ] | [ ] |
| W5.4 | Unplug USB or Bluetooth headphones while ducked, `stop`, plug them back in | The speakers are untouched; the headphones come back at their old volume | [ ] | [ ] |
| W5.5 | Change the default output while ducked, then `stop` | The device that was ducked is restored; the new default is untouched | [ ] | [ ] |
| W5.6 | An HDMI or S/PDIF output with no volume control as default | No error, nothing ducked | [ ] | [ ] |
| W5.7 | Output muted, or at 0 | Left alone | [ ] | [ ] |
| W5.8 | Bluetooth headset as input and output, ducking on | Note which endpoint is ducked when the headset switches to hands-free, and that everything is back after `stop` | [ ] | [ ] |
| W5.9 | `duck off`, record | The volume is never read or written (no "ducked" line in the log) | [ ] | [ ] |

### W6. Transcription (CPU)

| # | Do | Expect | win 10 | win 11 |
|---|---|---|---|---|
| W6.1 | `model <path to ggml-tiny.en.bin>`, record a sentence | A correct `final`; note the time from `stop` to `final` | [ ] | [ ] |
| W6.2 | A model path with spaces and non-ASCII characters (a user name with an accent) | Loads | [ ] | [ ] |
| W6.3 | `transcribe-file` with the fixture WAV | The same text as on macOS | [ ] | [ ] |
| W6.4 | Base and small models, 10 s recording, on a 4-core laptop | `final` well inside main's 45 s limit; partials arrive or are simply absent, never late text after the `final` | [ ] | [ ] |
| W6.5 | A machine without AVX2 | Note whether the helper starts and transcribes or crashes on the first pass | [ ] | [ ] |
| W6.6 | 30 recordings in a row | Memory in Task Manager stays flat after the first few | [ ] | [ ] |

### W7. Packaging and the rest of the system

| # | Do | Expect | win 10 | win 11 |
|---|---|---|---|---|
| W7.1 | Installed build, started from the Start menu | No console window flashes; the helper runs as a child of Quill and exits with it | [ ] | [ ] |
| W7.2 | Windows Defender (and one third-party antivirus) with the unsigned helper | Note any warning about the keyboard hook; re-test once the binary is signed | [ ] | [ ] |
| W7.3 | A standard (non-administrator) user account | Everything above works without elevation | [ ] | [ ] |
| W7.4 | A user name with spaces or non-ASCII characters | The log and the duck state file are written under `%LOCALAPPDATA%\Quill\Logs` | [ ] | [ ] |

## linux

Nothing in the Linux backends has run on a Linux machine yet: they were type-checked
from macOS (`cargo check --target x86_64-unknown-linux-gnu`) and their logic unit
tested there. So this list starts with the build. Run it once on an X11 session and
once on a Wayland session; sections 1 to 7 and 9 above apply too, with the "linux"
column, on X11.

Reference machines: Ubuntu 24.04 (GNOME, choose "Ubuntu on Xorg" at the login screen
for X11), Fedora KDE (Plasma, Wayland by default, "Plasma (X11)" where installed), and
one wlroots compositor (Sway) for the Wayland clipboard path.

The log is `~/.local/state/quill/Quill-stt.log` (or under `$XDG_STATE_HOME`), the duck
state file `Quill-duck.json` next to it. Driving the helper by hand:
`target/debug/flow-stt` in a terminal, commands on stdin.

### L1. Build and boot

| # | Do | Expect | x11 | wayland |
|---|---|---|---|---|
| L1.1 | `sudo apt install build-essential pkg-config libasound2-dev` (Fedora: `alsa-lib-devel`), then `cd native/helper && cargo build` | Builds. ALSA's headers are the only system package the build without whisper needs; nothing asks for libpulse, libX11, libxcb or libwayland | [ ] | [ ] |
| L1.2 | `cargo test` | Every test passes, among them the ones under `platform::linux` (key mapping, paste chords, terminal detection, the sound server client against a pretend server, duck recovery) | [ ] | [ ] |
| L1.3 | `cargo clippy --all-targets` | No warning in `src/platform/linux` | [ ] | [ ] |
| L1.4 | `ldd target/debug/flow-stt` | libasound, libc, libm, libgcc and nothing else of note (no libpulse, no libX11, no libwayland) | [ ] | [ ] |
| L1.5 | Add `cmake clang libclang-dev g++`, then `bun run helper:build` | The release binary with whisper (CPU) is built into `resources/helper/flow-stt` | [ ] | [ ] |
| L1.6 | `printf 'duck off\nholdkey off\ndevices\n' \| target/debug/flow-stt` | `boot`, then `capabilities` with `"platform":"linux"`, then `hotkey-status` (X11 only) and `devices`; exits when stdin closes | [ ] | [ ] |
| L1.7 | Read the `capabilities` line on X11 | Lists `audio`, `devices`, `level`, `spectrum`, `mic-test`, `cloud-audio`, `stream`, `hotkey`, `insert`, `duck` (and the transcription ids in a whisper build). No `hotkey-swallow`, `accessibility`, `calendar` or `mic-permission-hint`. `holdKeys` is `[62,61,60,54]`. `notes.hotkey` starts with `x11:` | [ ] | n/a |
| L1.8 | Read the `capabilities` line on Wayland | No `hotkey` and no `insert`; `holdKeys` is empty or absent; `notes.hotkey` and `notes.insert` both start with `wayland:` and say what to do instead. No `hotkey-status` line is required | n/a | [ ] |
| L1.9 | Start it with neither `DISPLAY` nor `WAYLAND_DISPLAY` (`env -u DISPLAY -u WAYLAND_DISPLAY ...`, or over ssh) | Boots, records and transcribes; no `hotkey`, no `insert`; the notes say "no display" | [ ] | [ ] |
| L1.10 | `HELPER_BIN=resources/helper/flow-stt HELPER_EXPECT_CAPS=1 bun test tests/helper` | Note every failure. The suite was written against a Mac (it pins `BuiltInMicrophoneDevice`, which falls back to the default input here); failures that are about macOS, not about the contract, need the suite changed, not the helper | [ ] | [ ] |
| L1.11 | `ax-check`; `cal {"id":"1","op":"status"}` | `{"type":"ax","trusted":true}`; a `cal` with `"error":"unsupported"` | [ ] | [ ] |

### L2. Microphone and devices

| # | Do | Expect | pipewire | pulseaudio | alsa only |
|---|---|---|---|---|---|
| L2.1 | `devices` | Each microphone once, with the name the sound settings show; no "Monitor of ..." entries; exactly one `isDefault` | [ ] | [ ] | [ ] |
| L2.2 | Note a USB microphone's `uid`, unplug it, plug it into another port, reboot, `devices` | The `uid` is the same every time on the sound server (on plain ALSA it may change: note what it is) | [ ] | [ ] | [ ] |
| L2.3 | `mic <uid>`, `start 1`, speak, `stop 1` | `started`, `level` and `spectrum` lines, `transcribing`, a `final` with the words | [ ] | [ ] | [ ] |
| L2.4 | Plug a USB microphone in, then pull it out | One `devices` event each time, within about half a second, with the list as it now is. The log says "watching the sound server" at boot (on plain ALSA: "polling the list instead", and the event may take two seconds) | [ ] | [ ] | [ ] |
| L2.5 | Change the default input in the sound settings | One `devices` event with `isDefault` moved | [ ] | [ ] | [ ] |
| L2.6 | Move the input volume slider up and down, start and stop music | No `devices` events | [ ] | [ ] | n/a |
| L2.7 | `systemctl --user restart pipewire pipewire-pulse` (or `pulseaudio -k`) while idle, then plug a microphone | The log says the subscription ended and that it is polling; the plug is still reported, within two seconds | [ ] | [ ] | n/a |
| L2.8 | Pull the microphone out in the middle of a recording | `interrupted` or a recording that carries on from the default input, as section 5.2 of the protocol says; never a hang | [ ] | [ ] | [ ] |
| L2.9 | Bluetooth headset as the pinned microphone, `start`, `stop` | The headset goes to its hands-free profile for the recording and returns to high quality audio within a few seconds of `stop` | [ ] | [ ] | n/a |
| L2.10 | `mic-test`, speak, `mic-test-stop` | `mic-test` `started` with the device's name, `mic-test-level` lines, `ended` | [ ] | [ ] | [ ] |
| L2.11 | Record with another app holding the microphone (a call in the browser) | Both get audio | [ ] | [ ] | n/a |

### L3. Hold key (X11)

Sections 1 and 2 above, with these additions. The default key is right control. On
Wayland the whole section is n/a: check L1.8 instead.

| # | Do | Expect | gnome x11 | kde x11 | other wm |
|---|---|---|---|---|---|
| L3.1 | Boot with no `holdkey` line; hold right control for a second | `hotkey-status` `installed:true` at boot; `start` on press, `stop` on release | [ ] | [ ] | [ ] |
| L3.2 | `holdkey 63` (main's default, fn), hold right control | Works as L3.1: a key that does not exist here is read as right control | [ ] | [ ] | [ ] |
| L3.3 | `holdkey 62`, `61`, `60`, `54` in turn; hold right control, right alt, right shift, right super | Only the chosen key triggers. The left-hand twin of each never does | [ ] | [ ] | [ ] |
| L3.4 | The same with the focus in a terminal, a browser, an Electron app, a full-screen video and a game | Triggers everywhere: raw events do not depend on the focused window | [ ] | [ ] | [ ] |
| L3.5 | Hold right control, type a letter, release | `start`, then `cancel` when the letter goes down | [ ] | [ ] | [ ] |
| L3.6 | Hold right control, press left shift or left alt, release both | `start`, then `stop` (or `cancel` if short): a second modifier is not "another key" | [ ] | [ ] | [ ] |
| L3.7 | Use right control in a real shortcut (right control + C in an editor) | The copy happens (nothing is swallowed) and the helper sends `start` then `cancel` | [ ] | [ ] | [ ] |
| L3.8 | Keep right control held for five seconds | One `start`, one `stop`: auto-repeat adds nothing | [ ] | [ ] | [ ] |
| L3.9 | A German or French layout (`setxkbmap de`), `holdkey 61`, hold right alt (AltGr) | Triggers. AltGr + a key to type a symbol sends `start` then `cancel`, and the symbol is typed | [ ] | [ ] | [ ] |
| L3.10 | `setxkbmap -option ctrl:swap_rwin_rctl` while the helper runs, `holdkey 62` | The key that now acts as right control triggers, with no restart; `setxkbmap -option` puts it back | [ ] | [ ] | [ ] |
| L3.11 | Switch between two layouts (us, ru) with the helper running | The hold key keeps working in both | [ ] | [ ] | [ ] |
| L3.12 | A second keyboard (USB or Bluetooth), plugged in after boot | Its right control triggers too | [ ] | [ ] | [ ] |
| L3.13 | `xdotool key Control_R` from a terminal | A `start` and, 350 ms later, a `cancel`: another program's synthetic keys count | [ ] | [ ] | [ ] |
| L3.14 | Hold right control while a dictation is being pasted (start a second one as the first lands) | The second recording is not cancelled by the paste's own `v` | [ ] | [ ] | [ ] |
| L3.15 | The screen is locked, or a password prompt has grabbed the keyboard | Note what happens. No dictation should start behind the lock screen; if `hotkey start` appears there, main must refuse it while locked | [ ] | [ ] | [ ] |
| L3.16 | With the helper running, type normally for a minute, watch `top` | The helper's CPU stays near zero | [ ] | [ ] | [ ] |
| L3.17 | A remote desktop session (xrdp, x11vnc, Chrome Remote Desktop) | Note whether right control from the remote keyboard triggers | [ ] | [ ] | [ ] |

### L4. Typing into other apps (X11)

Send `insert <text>` with the focus in the app named. The clipboard should hold what
it held before, about half a second later.

| # | Do | Expect | gnome x11 | kde x11 |
|---|---|---|---|---|
| L4.1 | gedit or Kate, Firefox, Chrome, LibreOffice, VS Code (editor), Slack or another Electron app | The text appears once, at the cursor; `inserted` with the right `chars` | [ ] | [ ] |
| L4.2 | GNOME Terminal, Konsole, Alacritty, kitty, WezTerm, foot (XWayland does not count), Tilix, xfce4-terminal | Pasted with Ctrl+Shift+V: the text appears at the prompt, no `^V` | [ ] | [ ] |
| L4.3 | xterm, urxvt, Emacs, gVim (insert mode) | Pasted with Shift+Insert: the text appears. In xterm and urxvt the PRIMARY selection is restored afterwards too | [ ] | [ ] |
| L4.4 | A terminal that is not in the list (note its `WM_CLASS` from `xprop WM_CLASS`) | Gets Ctrl+V, which it shows as `^V`: add its class to `insert/chord.rs` | [ ] | [ ] |
| L4.5 | VS Code's integrated terminal | Known gap: the window's class is the editor's, so it gets Ctrl+V. Note what it does | [ ] | [ ] |
| L4.6 | Text with accents, an emoji, a CJK phrase, two lines | Arrives intact, both lines | [ ] | [ ] |
| L4.7 | Copy some text, `insert other`, wait a second, paste by hand | The hand paste gives the text copied first | [ ] | [ ] |
| L4.8 | Copy an image (a screenshot), `insert text`, paste by hand into an image editor | Known limit, same as on macOS: only text is saved and restored, so the image is gone. Confirm nothing worse happens | [ ] | [ ] |
| L4.9 | Empty clipboard (fresh login), `insert text`, paste by hand | The dictation is pasted again: with nothing to restore it stays on the clipboard | [ ] | [ ] |
| L4.10 | `insert` while holding left shift, then while holding left alt, then right alt | The text is pasted, not "pasted without formatting" and not a menu shortcut; the held key works normally once released and pressed again | [ ] | [ ] |
| L4.11 | A Dvorak layout (`setxkbmap dvorak`), and Russian with Latin second (`setxkbmap ru,us`) with Russian active | Pasted in both | [ ] | [ ] |
| L4.12 | Two `insert` lines sent together | Both texts arrive, in order, and the clipboard ends up as it was before the first | [ ] | [ ] |
| L4.13 | A clipboard manager running (GNOME's extension, Klipper, CopyQ) | Note whether the dictation shows up in its history, and that the restore still wins | [ ] | [ ] |
| L4.14 | The flow bar visible while inserting | The focus stays in the target app and the text lands there | [ ] | [ ] |
| L4.15 | A very long text (2000 characters) | Arrives whole | [ ] | [ ] |
| L4.16 | Quit the app right after an insert, paste by hand | Note what is on the clipboard: on X11 the owner's exit can empty it when no clipboard manager runs | [ ] | [ ] |
| L4.17 | Typing fallback: cannot be forced from outside. If the log ever says "clipboard unavailable, typing instead", note the app and whether every character arrived | n/a | [ ] | [ ] |

### L5. Wayland: the reduced mode

| # | Do | Expect | gnome | kde | sway |
|---|---|---|---|---|---|
| L5.1 | Hold right control anywhere | No `hotkey` events, whatever has the focus (also with an XWayland window focused) | [ ] | [ ] | [ ] |
| L5.2 | `holdkey 62`, `hotkey-install`, `fn-capture-on` | Accepted and ignored; no `hotkey-status installed:true` ever | [ ] | [ ] | [ ] |
| L5.3 | `insert hello` with a native Wayland app focused | Nothing is typed. An `error` whose message says the text is on the clipboard and to press Ctrl+V; no `inserted` | [ ] | [ ] | [ ] |
| L5.4 | Then press Ctrl+V in a native Wayland app (gedit, Kate, foot) | `hello` is pasted | [ ] | [ ] | [ ] |
| L5.5 | The same paste into an XWayland app | `hello` is pasted | [ ] | [ ] | [ ] |
| L5.6 | The same with XWayland not running (Sway with `xwayland disable`) | Pasted on compositors with the data-control protocol; on one without it, an `error` saying the text could not be copied | n/a | [ ] | [ ] |
| L5.7 | In the app: the toggle shortcut starts and stops a dictation, and the result is on the clipboard | Works end to end, and the UI explains (from the missing `hotkey` and `insert` ids and the notes) why there is no hold key and why the user pastes | [ ] | [ ] | [ ] |
| L5.8 | Recording, devices, ducking (L2, L6) | The same as on X11: none of it depends on the display server | [ ] | [ ] | [ ] |

### L6. Ducking

Section 5 above applies. Watch the volume with `pactl get-sink-volume @DEFAULT_SINK@`
or the desktop's slider.

| # | Do | Expect | pipewire | pulseaudio |
|---|---|---|---|---|
| L6.1 | Volume at 60 %, `duck 0.15`, play music, `start 1`, `stop 1` | The slider drops to 9 % for the recording and returns to exactly 60 % | [ ] | [ ] |
| L6.2 | Left at 80 %, right at 40 % (`pactl set-sink-volume @DEFAULT_SINK@ 80% 40%`), duck and restore | 12 % and 6 % while ducked; 80 % and 40 % afterwards | [ ] | [ ] |
| L6.3 | `kill -9` the helper while ducked, start it again | `Quill-duck.json` is in `~/.local/state/quill` after the kill; after the start the volume is back and the file is gone | [ ] | [ ] |
| L6.4 | Disconnect Bluetooth or USB headphones while ducked, `stop`, reconnect them | The speakers are untouched; the headphones come back at their old volume (after the `devices` event, or at the next `start`) | [ ] | [ ] |
| L6.5 | Change the default output while ducked, then `stop` | The sink that was ducked is restored; the new default is untouched | [ ] | [ ] |
| L6.6 | Volume boosted to 130 % ("over-amplification"), duck and restore | Back to 130 %. After a `kill -9` while ducked, the next start brings it back to 100 %, not 130 % (known limit of the state file) | [ ] | [ ] |
| L6.7 | Output muted, or at 0 % | Left alone (a muted sink above 0 % is lowered and restored, still muted) | [ ] | [ ] |
| L6.8 | `duck off`, record | No "ducked" line in the log, the volume never moves | [ ] | [ ] |
| L6.9 | `systemctl --user restart pipewire pipewire-pulse` between two recordings | The second recording ducks and restores as the first did | [ ] | [ ] |
| L6.10 | Restart the sound server while ducked, then `stop` | Note the volume afterwards (the server may have reset it itself); the state file is gone once the sink is back and restored | [ ] | [ ] |
| L6.11 | `kill -STOP` the sound server's process, `stop` a ducked recording, quit the app | The helper still exits within a few seconds (each request gives up after 1.5 s); `kill -CONT`, start the app: the volume is restored from the state file | [ ] | [ ] |
| L6.12 | An HDMI output, and a Bluetooth headset that switches to hands-free when recording | No error; note which sink is ducked and that everything is back after `stop` | [ ] | [ ] |
| L6.13 | A machine with neither server (`systemctl --user stop` both, or a minimal ALSA install) | No `duck` in `capabilities`; the log says why; recording still works | n/a | n/a |

### L7. Transcription (CPU)

| # | Do | Expect | x64 |
|---|---|---|---|
| L7.1 | `model <path to ggml-tiny.en.bin>`, record a sentence | A correct `final`; note the time from `stop` to `final` | [ ] |
| L7.2 | `transcribe-file` with the fixture WAV | The same text as on macOS | [ ] |
| L7.3 | Base and small models, a 10 s recording, on a 4-core laptop | `final` well inside main's 45 s limit; partials arrive or are simply absent, never late text after the `final` | [ ] |
| L7.4 | The `capabilities` notes | `notes.transcribe` says `cpu` | [ ] |
| L7.5 | 30 recordings in a row, watching `top` | Memory stays flat after the first few | [ ] |
| L7.6 | A machine without AVX2 | Note whether the helper starts and transcribes or dies on the first pass | [ ] |
| L7.7 | `cargo build --release --features asr-vulkan` with the Vulkan SDK installed | Note whether it builds and whether a `final` comes back faster; not shipped yet | [ ] |

### L8. Lifecycle and packaging

| # | Do | Expect | x11 | wayland |
|---|---|---|---|---|
| L8.1 | `quit`, closing stdin, and `kill -TERM`, each while ducked and recording | The helper exits within a second and the volume is back each time | [ ] | [ ] |
| L8.2 | Log out of the desktop with the app running | No helper process is left behind (`pgrep flow-stt` from a console) | [ ] | [ ] |
| L8.3 | Restart the X server's window manager (`kwin_x11 --replace`, Alt+F2 `r` on GNOME X11) | The hold key and typing keep working | [ ] | n/a |
| L8.4 | The packaged app (AppImage, deb) on a clean install of each reference distribution | The helper starts (no missing shared library), and L1.7 or L1.8 holds | [ ] | [ ] |
| L8.5 | A Flatpak or Snap build, if one is made | Note what the sandbox takes away: the X11 socket, the PulseAudio socket and the state directory are each needed | [ ] | [ ] |
| L8.6 | A user name with spaces or non-ASCII characters | The log and the duck state file are written under `~/.local/state/quill` | [ ] | [ ] |

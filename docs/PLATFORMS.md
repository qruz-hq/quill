# Platforms

What Quill's Electron side does differently on macOS, Windows and Linux, and why.
The code is `src/main/platform.ts` (everything keyed on the OS) and
`src/main/capabilities.ts` (everything keyed on what the native helper can do).
The helper's side is `native/helper/README.md` and `docs/HELPER-PROTOCOL.md`.

## Two sources of truth

1. `process.platform`, for things Electron itself does differently: window chrome,
   permissions, the tray, login items, default shortcuts.
2. The helper's `capabilities` handshake (protocol section 11.2), for things the
   helper does: hold key, typing, ducking, calendar. Main keeps the last one
   (`stt.capabilities`, `stt.has(id)`) and gives it to every window:

```ts
window.flow.platform()        // synchronous
// { os: 'macos' | 'windows' | 'linux',
//   capabilities: string[],            ids from protocol section 11.1
//   holdKeys: number[],                keycodes the hold key can be set to; [] = no hold key
//   notes: Record<string, string>,
//   helper: { kind: 'swift' | 'rust', forced: boolean, choices: ('swift' | 'rust')[], name?: string },
//   windowControls: 'left' | 'right',
//   transformModifier: 'Alt' | 'Alt+Shift' }
window.flow.has('calendar')   // shorthand
window.flow.onPlatform(cb)    // the helper booted, restarted or was switched
```

Until a helper has reported, main assumes the full macOS list on macOS (the Swift
helper never reports) and, on Windows and Linux, only the capabilities that are the
same code everywhere (recording, devices, meters, transcription). So a control for
the hold key or ducking is never shown and then taken away.

What a page should do with it:

| When | Hide or change |
|---|---|
| no `calendar` | calendar sync settings |
| no `hotkey` (`holdKeys` empty) | the hold key picker; point at the global shortcut |
| `63` not in `holdKeys` | the fn option |
| no `duck` | the volume ducking setting |
| no `accessibility` | the Accessibility step and banner (`perms.status().ax` is always true there) |
| no `insert` | wording that says Quill types for you: text is copied instead |
| `windowControls: 'right'` | keep the title bar's right end clear, see below |
| `helper.choices.length > 1` | the Swift or Rust switch (`settings.helper`), disabled when `helper.forced` |

## Which helper runs

| OS | Helper |
|---|---|
| macOS | Swift by default. `settings.helper = 'rust'`, or `QUILL_HELPER=rust` in the environment, runs the Rust one. `QUILL_HELPER` wins over the setting. Both are in the app: `Contents/MacOS/flow-stt` (Swift) and `Contents/MacOS/flow-stt-rs` (Rust). If the chosen one is missing, the other runs and the log says so. |
| Windows, Linux | Rust, always: `resources/helper/flow-stt[.exe]`. |

Changing `settings.helper` swaps the helper at once: a recording in progress is
cancelled, a dictation being transcribed finishes first, then the old helper quits and
the other one starts with every setting sent again.

## What differs, by area

| Area | macOS | Windows | Linux |
|---|---|---|---|
| Microphone permission | TCC grant, asked on first use | The system switch for desktop apps (granted or denied, never asked). "Open settings" goes to `ms-settings:privacy-microphone` | No gate: always granted |
| Accessibility | TCC grant, needed to type and for the hold key | None: always trusted | None: always trusted |
| Calendar privacy page | System Settings | No-op | No-op |
| Hub window | Hidden inset title bar, traffic lights at 20, 22 | No frame; native caption buttons drawn over the page's title bar (56 high, theme colours) | Same as Windows |
| Flow Bar, Scratchpad, Todos | Transparent, frameless, system shadow | Transparent, frameless, no system shadow, no edge resizing | Transparent when a compositor runs (see below) |
| On every desktop | Yes, and over full-screen apps | Not available: stays on the desktop it opened on | Yes |
| Flow Bar click-through | Mouse moves forwarded to the page | Same | No forwarding: main watches the pointer at 30 Hz and opens the window when it reaches the bar |
| Tray | Template image in the menu bar | App icon; click opens the hub | App icon when the desktop has a tray; none on stock GNOME |
| App menu | Default | None | None |
| Second launch | Activates the running app | Shows the running app's hub | Same as Windows |
| Default shortcuts | ⌃⌥D, ⌥S, ⌥M, transforms ⌥1..9 | Alt+Shift+D, Alt+Shift+S, Alt+Shift+M, transforms Alt+Shift+1..9 | Same as Windows |
| Hold key | fn and the right-hand modifiers | Whatever the helper lists in `holdKeys`; never fn | Same as Windows |
| Frontmost app name in history | Yes (`lsappinfo`) | No | No |
| Open at login | Login item | Login item (registry Run key) | `~/.config/autostart/quill.desktop` |
| Reduce Motion, live | Notification | Re-read every 5 s | Re-read every 5 s |
| Log file | `~/Library/Logs/Quill-app.log` | `%APPDATA%\Quill\logs\Quill-app.log` | `~/.config/Quill/logs/Quill-app.log` |
| Local whisper | Metal | CPU | CPU |

Why the shortcuts differ: a global Alt+letter on Windows and Linux takes that key
away from every app's menus, and Ctrl+Alt is the same as AltGr on many keyboards
(Ctrl+Alt+2 is how a Portuguese or German keyboard types @), so a global
Ctrl+Alt+digit would stop those characters from being typed anywhere.

### The hub title bar on Windows and Linux

The page already draws a 56 px title bar and makes it draggable. Main adds the
system's own minimise, maximise and close buttons on top of its right end (Window
Controls Overlay). The page must keep its own content out from under them. CSS gets
the free area as `env(titlebar-area-x)`, `env(titlebar-area-width)`; the buttons
occupy everything to the right of `titlebar-area-x + titlebar-area-width`. The
invisible traffic-light placeholder on the left is only wanted when
`platform().windowControls === 'left'`.

## Linux caveats

- **X11 only, on purpose.** Quill starts with `--ozone-platform=x11`, so on a Wayland
  session it runs through XWayland. A native Wayland window cannot be placed at a
  screen position, cannot stay above other apps, and is not told where the pointer is
  outside its own surface. The Flow Bar needs all three, and the todo edge needs the
  last. `QUILL_OZONE=wayland` overrides this for experiments.
- **Global shortcuts on Wayland.** Through XWayland, a global shortcut only fires
  while an X11 app has the keyboard. Under GNOME or KDE on Wayland the dictation
  shortcut therefore does not work from native Wayland apps. The fix is the helper's
  hold key (it reads the keyboard itself), which is the helper's work, not main's.
- **Transparency needs a compositor.** GNOME, KDE, and most others always have one.
  A bare window manager without one (i3 without picom, for example) draws the Flow
  Bar's transparent area black. `QUILL_OPAQUE=1` gives the floating windows a solid
  background instead. Some NVIDIA driver setups also need `--disable-gpu` for
  transparent windows.
- **No mouse forwarding.** Electron cannot forward mouse moves through a click-through
  window on Linux. Main polls the pointer against the bar's shape instead, so the bar
  reacts to the pointer up to 33 ms later than elsewhere.
- **Tray.** Needs a StatusNotifier host (KDE, XFCE, Cinnamon have one; GNOME needs the
  AppIndicator extension). Without it there is no tray icon; starting Quill again
  shows the hub, but there is then no menu to quit from: Quill runs until the session
  ends or the process is stopped (`pkill quill`).
- **The edge panel** uses the global pointer position, which XWayland only reports
  while the pointer is over an X11 window. On a Wayland session the left-edge dwell is
  unreliable; on X11 it works.

## Packaging

Each OS is built on that OS (`bun run helper:build`, then `bun run dist`); nothing is
cross-compiled. CI does all three (`.github/workflows/ci.yml`), and the release
workflow attaches all three to one draft release.

| OS | Installers | Native helper in the package |
|---|---|---|
| macOS (arm64) | dmg, zip | `Contents/MacOS/flow-stt` (Swift) with `Resources/whisper` (whisper-cli and dylibs), and `Contents/MacOS/flow-stt-rs` (Rust, whisper linked in) |
| Windows (x64) | NSIS, per user, one click | `resources/helper/flow-stt.exe`: whisper and the C runtime linked in, no DLLs |
| Linux (x64) | AppImage, deb | `resources/helper/flow-stt`: whisper linked in; needs `libasound.so.2` and `libpulse.so.0` from the system (the deb depends on `libasound2`, `libpulse0`) |

Not signed: the Windows installer (SmartScreen warns) unless `WIN_CSC_LINK` and
`WIN_CSC_KEY_PASSWORD` are set as repository secrets.

/*
 * Everything in main that differs between macOS, Windows and Linux, in one
 * place. index.ts asks here instead of calling a macOS-only API, so each OS
 * gets either an equivalent or a clean no-op, and the list of differences can
 * be read top to bottom.
 *
 * Driven by process.platform. What the native helper can do (hold key,
 * typing, ducking, calendar) is the other half and comes from its
 * capabilities handshake, see capabilities.ts.
 *
 * Linux notes (docs/PLATFORMS.md has the long form):
 *  - The app runs through X11 (XWayland on a Wayland session). A native
 *    Wayland window cannot be placed at a screen position, kept above other
 *    apps, or told where the pointer is, and the Flow Bar and the todo edge
 *    need all three.
 *  - Transparent windows need a compositing window manager. Without one the
 *    Flow Bar is a black box: QUILL_OPAQUE=1 gives it a solid background.
 *  - setIgnoreMouseEvents has no `forward` option, so main opens the Flow Bar
 *    to the mouse itself (pollBarCursor in index.ts).
 */
import { app, shell, systemPreferences, nativeImage, nativeTheme, type BrowserWindow, type BrowserWindowConstructorOptions, type NativeImage } from 'electron'
import { execFile } from 'child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { hostOS, type HostOS } from './capabilities'

export const os: HostOS = hostOS()
export const isMac = os === 'macos'
export const isWindows = os === 'windows'
export const isLinux = os === 'linux'

/* ---- Before the app is ready ---- */

/** Command-line switches that have to be in place before Chromium starts. Call at module load. */
export function configureApp(): void {
  if (!isLinux) return
  // X11 (or XWayland) unless the user asks for something else: see the notes above.
  if (!app.commandLine.hasSwitch('ozone-platform')) {
    app.commandLine.appendSwitch('ozone-platform', process.env.QUILL_OZONE || 'x11')
  }
}

/** Linux escape hatch for desktops with no compositor: windows get a solid background. */
export const opaqueWindows = isLinux && process.env.QUILL_OPAQUE === '1'

/* ---- Files ---- */

/** A Finder-launched app has no visible stdout, so timings go to a file. */
export function logFile(): string {
  // macOS keeps the path it has always had (the helper logs next to it).
  if (isMac) return join(homedir(), 'Library/Logs/Quill-app.log')
  // Windows: %APPDATA%\Quill\logs. Linux: ~/.config/Quill/logs.
  const dir = app.getPath('logs')
  try { mkdirSync(dir, { recursive: true }) } catch { /* the append just fails */ }
  return join(dir, 'Quill-app.log')
}

/**
 * A file under resources/: next to the app when packaged (extraResources),
 * in the repository in development.
 */
export function resource(...parts: string[]): string {
  const candidates = [
    join(process.resourcesPath, ...parts),
    join(app.getAppPath(), 'resources', ...parts),
    join(process.cwd(), 'resources', ...parts)
  ]
  return candidates.find((p) => existsSync(p)) ?? candidates[0]
}

/** The app icon as a file, for the tray and Linux windows. Not used on macOS. */
function appIconPath(): string {
  const packaged = resource('icons', 'icon.png')
  if (existsSync(packaged)) return packaged
  return join(app.getAppPath(), 'build', 'icon.png')
}

/* ---- Permissions ---- */

export type MicAccess = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'

/**
 * macOS: the TCC grant. Windows: the system-wide "let desktop apps use the
 * microphone" switch, which is only ever granted or denied. Linux: there is
 * no such gate, so always granted.
 */
export function micAccess(): MicAccess {
  if (isLinux) return 'granted'
  try { return systemPreferences.getMediaAccessStatus('microphone') as MicAccess } catch { return 'unknown' }
}

/** Shows the system prompt where there is one (macOS). Resolves with whether the microphone can be used. */
export async function askMicAccess(): Promise<boolean> {
  if (isMac) return systemPreferences.askForMediaAccess('microphone')
  const mic = micAccess()
  return mic === 'granted' || mic === 'unknown'
}

/**
 * The macOS Accessibility grant, which typing and the hold key need. Windows
 * and Linux have no such grant: always true. `prompt` shows the system dialog.
 */
export function accessibilityTrusted(prompt = false): boolean {
  if (!isMac) return true
  return systemPreferences.isTrustedAccessibilityClient(prompt)
}

const MAC_PANES = {
  mic: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  ax: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  calendar: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars'
}

/**
 * Opens the system's page for one permission. Windows has a page for the
 * microphone only; Linux has none (a no-op there).
 */
export function openPrivacySettings(which: 'mic' | 'ax' | 'calendar'): void {
  if (isMac) { void shell.openExternal(MAC_PANES[which]); return }
  if (isWindows && which === 'mic') void shell.openExternal('ms-settings:privacy-microphone')
}

/* ---- Motion ---- */

/**
 * The system's Reduce Motion (macOS) or "Show animations" off (Windows).
 * `shouldRenderRichAnimation` false (remote sessions) counts as reduce too.
 * Linux reports through the same call when the desktop exposes it.
 */
export function reduceMotion(): boolean {
  try {
    const a = systemPreferences.getAnimationSettings()
    return a.prefersReducedMotion || !a.shouldRenderRichAnimation
  } catch { return false }
}

/**
 * Calls back when Reduce Motion may have changed. macOS has a notification;
 * Windows and Linux have none that Electron passes on, so they are read again
 * every few seconds (one cheap call).
 */
export function watchReduceMotion(changed: () => void): void {
  if (isMac) {
    systemPreferences.subscribeWorkspaceNotification('NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification', changed)
    return
  }
  setInterval(changed, 5000).unref()
}

/* ---- Windows ---- */

/** $bg and $fg per theme (styles/tokens.css), so a window never flashes the other theme. */
export const themeBg = (): string => (nativeTheme.shouldUseDarkColors ? '#09090C' : '#EFEDE7')
const themeFg = (): string => (nativeTheme.shouldUseDarkColors ? '#F5F3EE' : '#0D0D11')

/** Height of the hub's own title bar ("Title Bar" in design.pen). */
const HUB_TITLE_BAR = 56

/**
 * Where the hub's window buttons are: 'left' is the macOS traffic lights,
 * 'right' is the Windows and Linux caption buttons. On the right they are
 * drawn by the system over the page (Window Controls Overlay), so the page
 * keeps its own content out of env(titlebar-area-*).
 */
export const windowControls: 'left' | 'right' = isMac ? 'left' : 'right'

/** Title bar and chrome of the hub. The page draws the bar and makes it draggable; this adds the buttons. */
export function hubChrome(): BrowserWindowConstructorOptions {
  if (isMac) {
    return {
      titleBarStyle: 'hiddenInset',
      // "Traffic Lights" in the hub Title Bar: x 20, 12px lights centred in the 56 bar.
      trafficLightPosition: { x: 20, y: 22 }
    }
  }
  // No native frame, but native minimise, maximise and close buttons on the
  // right, as tall as the page's title bar and in its colours. Keeps Windows
  // snap layouts and the Linux window manager's own behaviour.
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: themeBg(), symbolColor: themeFg(), height: HUB_TITLE_BAR },
    ...(isLinux ? { icon: appIconPath() } : {})
  }
}

/** Keeps the hub's background, and its caption buttons off macOS, in step with the theme. */
export function applyHubTheme(win: BrowserWindow): void {
  win.setBackgroundColor(themeBg())
  if (isMac) return
  try { win.setTitleBarOverlay({ color: themeBg(), symbolColor: themeFg(), height: HUB_TITLE_BAR }) } catch { /* window has no overlay */ }
}

/**
 * Options shared by the frameless floating windows (Flow Bar, Scratchpad,
 * Todos). Transparent everywhere it works:
 *  - macOS: as designed, shadow drawn by the system when asked for.
 *  - Windows: transparent frameless windows work under DWM (always on since
 *    Windows 8). They cannot be resized by dragging an edge, and the system
 *    draws no shadow for them.
 *  - Linux: needs a compositor; QUILL_OPAQUE=1 turns transparency off.
 */
export function floatingChrome(opts: { shadow: boolean }): BrowserWindowConstructorOptions {
  const base: BrowserWindowConstructorOptions = { frame: false, skipTaskbar: true, alwaysOnTop: true }
  if (opaqueWindows) return { ...base, transparent: false, backgroundColor: themeBg(), icon: appIconPath() }
  return {
    ...base,
    transparent: true,
    hasShadow: isMac ? opts.shadow : false,
    ...(isLinux ? { icon: appIconPath() } : {})
  }
}

/**
 * Keeps a floating window on every desktop, and over full-screen apps where
 * the OS allows it. Windows has no API for other virtual desktops: a no-op
 * there (the window stays on the desktop it was opened on).
 */
export function showOnAllWorkspaces(win: BrowserWindow): void {
  if (isMac) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  else if (isLinux) win.setVisibleOnAllWorkspaces(true)
}

/**
 * Whether a window that ignores the mouse still tells its page where the
 * pointer is (setIgnoreMouseEvents' `forward`). macOS and Windows: yes.
 * Linux: no, so main watches the pointer for the Flow Bar instead.
 */
export const forwardsMouse = !isLinux

/** Makes a window click-through, with pointer moves still forwarded where the OS can. */
export function ignoreMouse(win: BrowserWindow, ignore: boolean): void {
  if (!ignore) win.setIgnoreMouseEvents(false)
  else if (forwardsMouse) win.setIgnoreMouseEvents(true, { forward: true })
  else win.setIgnoreMouseEvents(true)
}

/* ---- Tray ---- */

/**
 * macOS: a template image, tinted by the menu bar. Windows and Linux have no
 * template images (a black glyph disappears on a dark taskbar), so they get
 * the app icon, scaled down.
 */
export function trayImage(): NativeImage {
  if (isMac) {
    const img = nativeImage.createFromPath(resource('icons', 'trayTemplate.png'))
    img.setTemplateImage(true)
    return img
  }
  const icon = nativeImage.createFromPath(appIconPath())
  if (icon.isEmpty()) return icon
  return icon.resize({ width: isWindows ? 32 : 24, height: isWindows ? 32 : 24, quality: 'best' })
}

/* ---- Keyboard ---- */

/**
 * Default global shortcuts. macOS keeps the ones it has always had. On
 * Windows and Linux a global Alt+letter would take over every app's menu
 * mnemonics, and Ctrl+Alt is AltGr on many keyboards (Ctrl+Alt+2 types @),
 * so everything moves to Alt+Shift.
 */
export const defaultShortcuts = isMac
  ? { toggleShortcut: 'Control+Alt+D', padShortcut: 'Alt+S', noteShortcut: 'Alt+M' }
  : { toggleShortcut: 'Alt+Shift+D', padShortcut: 'Alt+Shift+S', noteShortcut: 'Alt+Shift+M' }

/** Modifiers of the nine transform shortcuts: Alt+1..9 on macOS, Alt+Shift+1..9 elsewhere. */
export const transformModifier = isMac ? 'Alt' : 'Alt+Shift'

const MAC_SYMBOLS: Record<string, string> = { Control: '⌃', Alt: '⌥', Shift: '⇧', Command: '⌘' }
const PC_NAMES: Record<string, string> = { Control: 'Ctrl', CommandOrControl: 'Ctrl', Command: 'Ctrl', Super: isWindows ? 'Win' : 'Super' }

/** An accelerator the way this OS writes it: ⌃⌥D on macOS, Ctrl+Alt+D elsewhere. */
export function accelLabel(accel: string): string {
  const parts = accel.split('+')
  return isMac ? parts.map((p) => MAC_SYMBOLS[p] ?? p).join('') : parts.map((p) => PC_NAMES[p] ?? p).join('+')
}

/** The paste chord, for "Copied, press ... to paste". */
export const pasteLabel = isMac ? '⌘V' : 'Ctrl+V'

/* ---- Frontmost app ---- */

/**
 * Name of the frontmost app, for the hub's recent list. macOS only:
 * lsappinfo needs no permission (unlike asking System Events). Windows and
 * Linux resolve undefined, so a dictation there carries no app badge.
 */
export function frontmostApp(): Promise<string | undefined> {
  if (!isMac) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    execFile('/usr/bin/lsappinfo', ['front'], { timeout: 800 }, (err, asn) => {
      if (err || !asn.trim()) return resolve(undefined)
      execFile('/usr/bin/lsappinfo', ['info', '-only', 'name', asn.trim()], { timeout: 800 }, (e, out) => {
        const name = e ? undefined : /="([^"]+)"/.exec(out)?.[1]
        resolve(name && name !== app.getName() && name !== 'Electron' ? name : undefined)
      })
    })
  })
}

/* ---- Open at login ---- */

/** XDG autostart entry; Electron's login item API does nothing on Linux. */
const autostartFile = (): string =>
  join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'autostart', 'quill.desktop')

/**
 * macOS and Windows: the system's login items (the Run key on Windows).
 * Linux: an XDG autostart file, which every major desktop reads. An AppImage
 * is started through its own path, since the mounted executable moves.
 */
export function setOpenAtLogin(open: boolean): void {
  if (!isLinux) {
    app.setLoginItemSettings({ openAtLogin: open, openAsHidden: true })
    return
  }
  const file = autostartFile()
  try {
    if (!open) { rmSync(file, { force: true }); return }
    const exec = process.env.APPIMAGE || process.execPath
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Quill',
      `Exec="${exec.replace(/(["\\`$])/g, '\\$1')}"`,
      'X-GNOME-Autostart-enabled=true',
      'Terminal=false',
      ''
    ].join('\n'))
  } catch { /* non-fatal: the setting just does not take */ }
}

export function opensAtLogin(): boolean {
  if (isLinux) return existsSync(autostartFile())
  return app.getLoginItemSettings().openAtLogin
}

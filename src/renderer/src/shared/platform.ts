/*
 * What this OS and its native helper can do, as the pages see it, and the
 * words that go with each OS: key names, "this Mac", "System Settings".
 *
 * The facts come from main through window.flow.platform() (src/main/platform.ts
 * and capabilities.ts). Everything below the store is a pure function of that
 * value, so a page never asks "is this a Mac" itself.
 *
 * macOS output is the app as designed: every Mac string here is the literal
 * the page used before the other two systems existed.
 */
import { useSyncExternalStore } from 'react'

export type Platform = FlowPlatformInfo
export type OS = FlowHostOS

/* ---- store ---- */

/** A page with no preload (the Motion Lab, a test) renders as the Mac app. */
const FALLBACK: Platform = {
  os: 'macos',
  capabilities: [
    'audio', 'devices', 'level', 'spectrum', 'mic-test', 'transcribe', 'partials', 'language-detect',
    'transcribe-file', 'cloud-audio', 'stream', 'hotkey', 'hotkey-swallow', 'insert', 'accessibility',
    'duck', 'calendar', 'mic-permission-hint'
  ],
  holdKeys: [63, 54, 61, 62, 60, 57],
  notes: {},
  helper: { kind: 'swift', forced: false, choices: [] },
  windowControls: 'left',
  transformModifier: 'Alt'
}

type Bridge = { platform?: () => Platform | null; onPlatform?: (cb: (p: Platform) => void) => () => void }
const bridge = (): Bridge | undefined =>
  (typeof window === 'undefined' ? undefined : (window as unknown as { flow?: Bridge }).flow)

/* The bridge hands over a fresh copy on every call, so the value is kept here:
   a snapshot has to be the same object until it really changes. */
let current: Platform | null = null
let wired = false
const subs = new Set<() => void>()

function read(): Platform {
  try { return bridge()?.platform?.() ?? FALLBACK } catch { return FALLBACK }
}
function wire(): void {
  if (wired) return
  wired = true
  try {
    bridge()?.onPlatform?.((p) => {
      current = p
      mark(p)
      subs.forEach((s) => s())
    })
  } catch { /* no bridge: the value never changes */ }
}

/** The platform as last reported. Synchronous; safe at module load. */
export function getPlatform(): Platform {
  if (!current) { current = read(); mark(current); wire() }
  return current
}

const subscribe = (cb: () => void): (() => void) => {
  getPlatform()
  subs.add(cb)
  return () => { subs.delete(cb) }
}

/** The platform, re-rendering when the helper reports again (boot, respawn, a switch of helper). */
export function usePlatform(): Platform {
  return useSyncExternalStore(subscribe, getPlatform, getPlatform)
}

/** html[data-os], html[data-window-controls]: what the stylesheets key on. */
function mark(p: Platform): void {
  if (typeof document === 'undefined') return
  const el = document.documentElement
  el.dataset.os = p.os
  el.dataset.windowControls = p.windowControls
}

/* ---- facts ---- */

export const isMac = (p: Platform): boolean => p.os === 'macos'
export const has = (p: Platform, capability: string): boolean => p.capabilities.includes(capability)

/**
 * A Wayland session: the helper says so in its notes ("wayland: ..."), which
 * is where it explains that it can neither watch keys nor type there.
 */
export const isWayland = (p: Platform): boolean =>
  p.os === 'linux' && Object.values(p.notes).some((n) => /^\s*wayland\b/i.test(n))

/** What Whisper decodes on here, for the About pane ("Metal", "CPU"). */
export function decoder(p: Platform): string {
  const note = (p.notes.transcribe ?? '').trim().toLowerCase()
  if (/metal/.test(note)) return 'Metal'
  if (/vulkan/.test(note)) return 'Vulkan'
  if (/cuda/.test(note)) return 'CUDA'
  if (/cpu/.test(note)) return 'CPU'
  return isMac(p) ? 'Metal' : 'CPU'
}

/* ---- keys ---- */

const MAC_KEYS: Record<string, string> = {
  Control: 'ctrl', Ctrl: 'ctrl', Alt: '⌥', Option: '⌥', Shift: '⇧',
  Command: '⌘', Cmd: '⌘', CommandOrControl: '⌘', CmdOrCtrl: '⌘', Meta: '⌘', Super: '⌘'
}
const pcKeys = (os: OS): Record<string, string> => {
  const win = os === 'windows' ? 'Win' : 'Super'
  return {
    Control: 'Ctrl', Ctrl: 'Ctrl', CommandOrControl: 'Ctrl', CmdOrCtrl: 'Ctrl',
    Alt: 'Alt', Option: 'Alt', AltGr: 'AltGr', Shift: 'Shift',
    Command: win, Cmd: win, Meta: win, Super: win
  }
}

/** "Control+Alt+D": ["ctrl", "⌥", "D"] on a Mac, ["Ctrl", "Alt", "D"] elsewhere. One entry per keycap. */
export function accelKeys(accel: string | undefined, os: OS): string[] {
  if (!accel) return []
  const names = os === 'macos' ? MAC_KEYS : pcKeys(os)
  return accel.split('+').map((k) => names[k] ?? k)
}

/** The same for running text: "ctrl ⌥ D" on a Mac, "Ctrl+Alt+D" elsewhere. */
export function accelText(accel: string | undefined, os: OS): string {
  return accelKeys(accel, os).join(os === 'macos' ? ' ' : '+')
}

/** The modifier that means "the system key" in a recorded shortcut (Electron accelerator name). */
export const metaAccelerator = (os: OS): string => (os === 'macos' ? 'Command' : 'Super')

/** Paste and undo, as one keycap and as text. */
export function chord(key: 'V' | 'Z', os: OS): { cap: string; text: string } {
  return os === 'macos' ? { cap: `⌘ ${key}`, text: `⌘${key}` } : { cap: `Ctrl+${key}`, text: `Ctrl+${key}` }
}

/** The transform modifier ("Alt" or "Alt+Shift") in this OS's words. */
export function transformKeys(p: Platform): { caps: string[]; prefix: string } {
  if (isMac(p)) return { caps: ['⌥ option'], prefix: '⌥' }
  const caps = accelKeys(p.transformModifier || 'Alt+Shift', p.os)
  return { caps, prefix: `${caps.join('+')}+` }
}
/** A transform slot's shortcut: "⌥3" on a Mac, "Alt+Shift+3" elsewhere. `spaced` is the keycap form ("⌥ 3"). */
export function transformSlot(p: Platform, slot: number, spaced = false): string {
  const { prefix } = transformKeys(p)
  return isMac(p) ? `${prefix}${spaced ? ' ' : ''}${slot}` : `${prefix}${slot}`
}

/* ---- the hold key ---- */

export type HoldKey = {
  /** macOS virtual keycode: the name of a physical key on every OS. 0 is Off. */
  code: number
  /** In the picker. */
  label: string
  /** On a keycap in onboarding ("fn", "⌘", "Right Ctrl"). */
  key: string
  /** In a headline or a hint ("fn", "Right ⌘", "Right Ctrl"). */
  name: string
  /** Under the picker. */
  note: string
}

const OFF: HoldKey = { code: 0, label: 'Off', key: '', name: '', note: 'Use only the hotkeys.' }

const MAC_HOLD: HoldKey[] = [
  { code: 63, label: 'fn (Globe)', key: 'fn',   name: 'fn',        note: 'The globe key. Its normal action is suppressed while Quill runs.' },
  { code: 54, label: 'Right ⌘',    key: '⌘',    name: 'Right ⌘',   note: 'Left Command is untouched.' },
  { code: 61, label: 'Right ⌥',    key: '⌥',    name: 'Right ⌥',   note: 'Left Option is untouched.' },
  { code: 62, label: 'Right ⌃',    key: 'ctrl', name: 'Right ⌃',   note: 'Left Control is untouched.' },
  { code: 60, label: 'Right ⇧',    key: '⇧',    name: 'Right ⇧',   note: 'Left Shift is untouched.' },
  { code: 57, label: 'Caps Lock',  key: '⇪',    name: 'Caps Lock', note: 'Caps Lock stops toggling case while held.' }
]

function pcHold(os: OS): HoldKey[] {
  const win = os === 'windows' ? 'Win' : 'Super'
  const k = (code: number, name: string, note: string): HoldKey => ({ code, label: name, key: name, name, note })
  return [
    k(62, 'Right Ctrl', 'Left Ctrl is untouched.'),
    k(61, 'Right Alt', 'Left Alt is untouched. On a keyboard with AltGr, pick another key.'),
    k(60, 'Right Shift', 'Left Shift is untouched.'),
    k(57, 'Caps Lock', 'Caps Lock stops toggling case while Quill runs.'),
    k(54, `Right ${win}`, `Left ${win} is untouched.`),
    k(55, `Left ${win}`, `Its normal action is suppressed while Quill runs.`),
    k(59, 'Left Ctrl', 'Right Ctrl is untouched.'),
    k(58, 'Left Alt', 'Right Alt is untouched.'),
    k(56, 'Left Shift', 'Right Shift is untouched.')
  ]
}

const holdTable = (os: OS): HoldKey[] => (os === 'macos' ? MAC_HOLD : pcHold(os))

/** The keys the picker offers here, in the helper's order (its default first), then Off. Empty: no hold key at all. */
export function holdKeyOptions(p: Platform): HoldKey[] {
  if (!has(p, 'hotkey') || !p.holdKeys.length) return []
  const table = holdTable(p.os)
  // On a Mac the picker keeps its designed order; elsewhere the helper's default leads.
  const codes = isMac(p) ? MAC_HOLD.map((h) => h.code).filter((c) => p.holdKeys.includes(c)) : p.holdKeys
  const keys = codes.map((code) => table.find((h) => h.code === code)
    ?? { code, label: `Key ${code}`, key: `Key ${code}`, name: `key ${code}`, note: 'Hold it to dictate.' })
  return [...keys, OFF]
}

/**
 * The key the helper is really listening for, mirroring effectiveHoldKey in
 * main: the saved one when it exists here, otherwise the first one that does
 * (fn does not exist off a Mac), and none when it is Off or there is no hold key.
 */
export function holdKeyFor(saved: number | undefined, p: Platform): HoldKey | undefined {
  const wanted = saved ?? 63
  if (wanted <= 0 || !has(p, 'hotkey')) return undefined
  const options = holdKeyOptions(p).filter((h) => h.code !== 0)
  return options.find((h) => h.code === wanted) ?? options.find((h) => h.code === p.holdKeys[0]) ?? options[0]
}

/* ---- words ---- */

export type Words = {
  /** "this Mac" */
  device: string
  /** "On this Mac" */
  onDevice: string
  /** "macOS" */
  system: string
  /** "Follows macOS" */
  follows: string
  /** "macOS default" */
  systemDefault: string
  /** "Follows the input chosen in System Settings." */
  inputFollows: string
  /** "Open System Settings" */
  openSettings: string
  /** "Privacy & Security › Microphone" */
  micPath: string
  /** "Waiting for macOS…" */
  waiting: string
}

const WORDS: Record<OS, Words> = {
  macos: {
    device: 'this Mac', onDevice: 'On this Mac', system: 'macOS', follows: 'Follows macOS',
    systemDefault: 'macOS default', inputFollows: 'Follows the input chosen in System Settings.',
    openSettings: 'Open System Settings', micPath: 'Privacy & Security › Microphone', waiting: 'Waiting for macOS…'
  },
  windows: {
    device: 'this PC', onDevice: 'On this PC', system: 'Windows', follows: 'Follows Windows',
    systemDefault: 'Windows default', inputFollows: 'Follows the input chosen in Windows Settings.',
    openSettings: 'Open Windows Settings', micPath: 'Privacy & security › Microphone', waiting: 'Waiting for Windows…'
  },
  linux: {
    device: 'this computer', onDevice: 'On this computer', system: 'the system', follows: 'Follows the system',
    systemDefault: 'System default', inputFollows: 'Follows the input chosen in your system’s sound settings.',
    openSettings: 'Open settings', micPath: 'your system’s sound settings', waiting: 'Waiting…'
  }
}

export const words = (os: OS): Words => WORDS[os]

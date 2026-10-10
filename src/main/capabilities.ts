/*
 * What the native helper can do on this machine, and which helper to run.
 * No Electron imports: everything here is a pure decision, so it can be run
 * and tested without an app.
 *
 * The contract is docs/HELPER-PROTOCOL.md section 11.
 */

/** The helper's own names for the three systems (the `platform` field of its handshake). */
export type HostOS = 'macos' | 'windows' | 'linux'

/** swift: native/stt/main.swift, macOS only. rust: native/helper, every OS. */
export type HelperKind = 'swift' | 'rust'

export type Capabilities = {
  platform: HostOS
  /** Capability ids from section 11.1 that work in this build, on this machine. */
  capabilities: string[]
  /** Keycodes `holdkey` accepts here. Empty when there is no hold key at all. */
  holdKeys: number[]
  /** Name and version, for the log. */
  helper?: string
  /** Free-form detail per capability, for the log or a tooltip. */
  notes: Record<string, string>
  /** False while this is main's assumption, true once the helper said it. */
  reported: boolean
}

export function hostOS(platform: NodeJS.Platform = process.platform): HostOS {
  if (platform === 'darwin') return 'macos'
  if (platform === 'win32') return 'windows'
  return 'linux'
}

/** Everything the Swift helper does. It sends no handshake (section 11.2 rule 2). */
const MACOS_FULL = [
  'audio', 'devices', 'level', 'spectrum', 'mic-test', 'transcribe', 'partials',
  'language-detect', 'transcribe-file', 'cloud-audio', 'stream', 'hotkey',
  'hotkey-swallow', 'insert', 'accessibility', 'duck', 'calendar', 'mic-permission-hint'
]
const MACOS_HOLD_KEYS = [63, 54, 61, 62, 60, 57]

/**
 * The part of the list that is the same code on every OS. What main assumes
 * of a Windows or Linux helper until its handshake arrives: nothing that
 * needs an OS backend (hold key, typing, ducking, calendar), so no control
 * for those appears and then vanishes.
 */
const PORTABLE = [
  'audio', 'devices', 'level', 'spectrum', 'mic-test', 'transcribe', 'partials',
  'language-detect', 'transcribe-file', 'cloud-audio', 'stream'
]

/** What to believe before (or without) a handshake. */
export function assumed(os: HostOS): Capabilities {
  return os === 'macos'
    ? { platform: os, capabilities: [...MACOS_FULL], holdKeys: [...MACOS_HOLD_KEYS], notes: {}, reported: false }
    : { platform: os, capabilities: [...PORTABLE], holdKeys: [], notes: {}, reported: false }
}

/**
 * Reads a `capabilities` event. Anything malformed falls back to the
 * assumption for that field, never to a crash: the line comes from another
 * process.
 */
export function parseCapabilities(msg: Record<string, unknown>, os: HostOS): Capabilities {
  const base = assumed(os)
  const strings = (v: unknown): string[] | null =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null
  const platform = msg.platform === 'macos' || msg.platform === 'windows' || msg.platform === 'linux'
    ? msg.platform
    : os
  const capabilities = strings(msg.capabilities) ?? base.capabilities
  // "Absent means the macOS set" (section 11.2), which only makes sense on macOS.
  const holdKeys = Array.isArray(msg.holdKeys)
    ? msg.holdKeys.filter((k): k is number => typeof k === 'number' && Number.isFinite(k))
    : platform === 'macos' ? [...MACOS_HOLD_KEYS] : []
  const notes: Record<string, string> = {}
  if (msg.notes && typeof msg.notes === 'object') {
    for (const [k, v] of Object.entries(msg.notes as Record<string, unknown>)) {
      if (typeof v === 'string') notes[k] = v
    }
  }
  return {
    platform,
    capabilities,
    holdKeys: capabilities.includes('hotkey') ? holdKeys : [],
    helper: typeof msg.helper === 'string' ? msg.helper : undefined,
    notes,
    reported: true
  }
}

/**
 * The hold key to send the helper: the user's choice when this helper accepts
 * it, otherwise the first key it does accept (fn does not exist off a Mac),
 * and 0 (off) when there is no hold key here or the user turned it off.
 */
export function effectiveHoldKey(wanted: number, caps: Capabilities): number {
  if (wanted <= 0 || !caps.capabilities.includes('hotkey')) return 0
  if (caps.holdKeys.includes(wanted)) return wanted
  return caps.holdKeys[0] ?? 0
}

export type HelperChoice = {
  kind: HelperKind
  /** QUILL_HELPER decided, so the setting is not in effect. */
  forced: boolean
  /** The helpers that exist on this OS, for a switch in Settings. */
  choices: HelperKind[]
}

/**
 * Which helper to run. macOS has both and stays on the Swift one until the
 * setting (or QUILL_HELPER=rust|swift) says otherwise. Windows and Linux have
 * only the Rust helper, whatever is asked.
 */
export function chooseHelper(
  setting: unknown,
  env: string | undefined = process.env.QUILL_HELPER,
  platform: NodeJS.Platform = process.platform
): HelperChoice {
  if (platform !== 'darwin') return { kind: 'rust', forced: false, choices: ['rust'] }
  const choices: HelperKind[] = ['swift', 'rust']
  const asked = (env ?? '').trim().toLowerCase()
  if (asked === 'rust' || asked === 'swift') return { kind: asked, forced: true, choices }
  return { kind: setting === 'rust' ? 'rust' : 'swift', forced: false, choices }
}

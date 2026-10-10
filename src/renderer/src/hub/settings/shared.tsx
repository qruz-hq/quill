import type { ReactNode } from 'react'
import { Icon, type IconName } from '../../shared/icons'
import { Keycap } from '../../shared/ui'
import { BlurWords } from '../../shared/motion'

export type Pane = 'shortcuts' | 'general' | 'dictation' | 'languages' | 'models' | 'ai' | 'about'

export type Prefs = {
  model: string; languages: string[]
  duckEnabled: boolean; duckLevel: number
  aiEnabled: boolean; aiModel: string; aiMinWords: number; aiDeadlineMs: number; aiFixMishearings: boolean
  sttEngine: 'local' | 'cloud'; sttProvider: 'openai' | 'elevenlabs'; sttModel: string
  sttStreaming: boolean; sttNoVerbatim: boolean
  launchAtLogin: boolean; todoEdge: boolean; calSync: boolean; calId: string
  holdKey: number; micUid: string; toggleShortcut: string; padShortcut: string; noteShortcut: string
}

export type Update = (patch: Partial<Prefs>) => Promise<void>
export type PaneProps = { prefs: Prefs | null; update: Update }

export type Accent = 'violet' | 'tangerine' | 'lime' | 'cyan' | 'pink'

/** Rail order, icon and accent per pane (Settings frames, "Tile / Panes" K2IWg). */
export const PANES: { key: Pane; label: string; icon: IconName; accent: Accent; caption: string }[] = [
  { key: 'shortcuts', label: 'Shortcuts',     icon: 'keyboard',   accent: 'tangerine', caption: 'Global hotkeys. They work in any app.' },
  { key: 'general',   label: 'General',       icon: 'power',      accent: 'lime',      caption: 'Launch at login and the todo edge.' },
  { key: 'dictation', label: 'Dictation',     icon: 'microphone', accent: 'violet',    caption: 'Which mic, how loud, and where text goes.' },
  { key: 'languages', label: 'Languages',     icon: 'globe',      accent: 'cyan',      caption: 'Pick every language you dictate in.' },
  { key: 'models',    label: 'Speech models', icon: 'chip',       accent: 'pink',      caption: 'On this Mac, or in the cloud.' },
  { key: 'ai',        label: 'AI cleanup',    icon: 'sparkle',    accent: 'tangerine', caption: 'Punctuation and casing, never new words.' },
  { key: 'about',     label: 'About',         icon: 'info',       accent: 'violet',    caption: 'What’s running, and which version.' }
]

/** "Tile / Pane header": accent tile, mono crumb + 20 icon on top, 40 headline + caption below. */
export function PaneHeader({ pane }: { pane: Pane }): React.JSX.Element {
  const p = PANES.find((x) => x.key === pane)!
  return (
    <header className={`set-head set-accent--${p.accent}`}>
      <div className="set-head__top">
        <span className="set-head__label">SETTINGS · {p.label.toUpperCase()}</span>
        <Icon name={p.icon} size={20} />
      </div>
      <div className="set-head__bottom">
        {/* Plays once per pane: on entering Settings and on every pane switch. */}
        <BlurWords as="h2" variant="titleUnit" initial text={p.label} className="set-head__headline" />
        <span className="set-head__caption">{p.caption}</span>
      </div>
    </header>
  )
}

/** Mono tile label ("TRANSCRIPTION", "LOCAL MODELS"). */
export function MonoLabel({ children, className }: { children: ReactNode; className?: string }): React.JSX.Element {
  return <span className={['set-mono', className].filter(Boolean).join(' ')}>{children}</span>
}

/* ---- accelerators ---- */

const SYM: Record<string, string> = { Control: 'ctrl', Alt: '⌥', Shift: '⇧', Command: '⌘' }
/** "Control+Alt+D" -> ["ctrl", "⌥", "D"], one entry per keycap. */
export function accelKeys(accel: string): string[] {
  return accel ? accel.split('+').map((p) => SYM[p] ?? p) : []
}
/** "Control+Alt+D" -> "ctrl ⌥ D" for running text. */
export function pretty(accel: string): string {
  return accelKeys(accel).join(' ')
}

export function Keycaps({ accel, className }: { accel: string; className?: string }): React.JSX.Element {
  return (
    <>
      {accelKeys(accel).map((k, i) => <Keycap key={i} className={className}>{k}</Keycap>)}
    </>
  )
}

/** Hold-to-talk keys the helper understands (macOS keycodes). */
export const HOLD_KEYS: { code: number; label: string; key: string; note: string }[] = [
  { code: 63, label: 'fn (Globe)', key: 'fn',   note: 'The globe key. Its normal action is suppressed while Quill runs.' },
  { code: 54, label: 'Right ⌘',    key: '⌘',    note: 'Left Command is untouched.' },
  { code: 61, label: 'Right ⌥',    key: '⌥',    note: 'Left Option is untouched.' },
  { code: 62, label: 'Right ⌃',    key: 'ctrl', note: 'Left Control is untouched.' },
  { code: 60, label: 'Right ⇧',    key: '⇧',    note: 'Left Shift is untouched.' },
  { code: 57, label: 'Caps Lock',  key: '⇪',    note: 'Caps Lock stops toggling case while held.' },
  { code: 0,  label: 'Off',        key: '',     note: 'Use only the hotkeys.' }
]

export type ModelRow = {
  id: string; label: string; bytes: number; wer: string; note: string
  multilingual?: boolean; quantised?: boolean; installed: boolean
  /** A download of this model is running in main right now. */
  downloading?: boolean
}

export function fmtBytes(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`
}

/* "Stream while you speak": what a cloud model does with audio sent as you
   talk. These mirror main (OPENAI_LIVE_MODELS / OPENAI_PREUPLOAD_MODELS in
   src/main/stream-openai.ts; ElevenLabs always streams through
   scribe_v2_realtime). Correct them here when main changes. */

/** Words appear while you are still speaking. */
export const LIVE_MODELS: readonly string[] = [
  'scribe_v2', 'scribe_v1',
  'gpt-live-transcribe', 'gpt-realtime-whisper'
]
/** The audio is uploaded as you talk, but the text only comes after the release. */
export const PREUPLOAD_MODELS: readonly string[] = ['gpt-4o-transcribe', 'gpt-4o-mini-transcribe']
/** What main uploads a recording as when a live OpenAI model is not streamed (the batch endpoint rejects those). */
export const LIVE_BATCH_FALLBACK = 'gpt-4o-mini-transcribe'

export type StreamKind = 'live' | 'early' | 'none'
export const streamKind = (model: string): StreamKind =>
  LIVE_MODELS.includes(model) ? 'live' : PREUPLOAD_MODELS.includes(model) ? 'early' : 'none'

export const PROVIDER_NAME = { openai: 'OpenAI', elevenlabs: 'ElevenLabs' } as const

export const STT_MODELS: Record<'openai' | 'elevenlabs', { value: string; label: string }[]> = {
  elevenlabs: [
    { value: 'scribe_v2', label: 'Scribe v2 · $0.22/hr' },
    { value: 'scribe_v1', label: 'Scribe v1' }
  ],
  openai: [
    { value: 'gpt-live-transcribe', label: 'gpt-live-transcribe · live words' },
    { value: 'gpt-4o-mini-transcribe', label: 'gpt-4o-mini-transcribe · $0.18/hr' },
    { value: 'gpt-4o-transcribe', label: 'gpt-4o-transcribe · $0.36/hr' },
    { value: 'whisper-1', label: 'whisper-1 · $0.36/hr' }
  ]
}

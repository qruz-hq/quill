/**
 * Flow Bar state (docs/MOTION.md §6.3 "IPC-driven state"): dictation:state,
 * dictation:stage, errors, notices and hover reduce into ONE value, so a burst
 * of IPC messages lands as one retarget. The interruption matrix (§4.1.12) is
 * the transition table of `step`.
 */

export type Phase = 'idle' | 'recording' | 'busy' | 'done' | 'error'
export type Stage = 'transcribing' | 'polishing'
export type View = 'sliver' | 'capsule' | 'recording' | 'busy' | 'done' | 'error'
export type CardKind = 'partial' | 'error'
/** How the last surface left: picks the exit choreography of the card and the shape. */
export type ExitKind = 'done' | 'copied' | 'cancel' | 'dismiss' | 'retarget'

export interface BarError {
  title: string
  meta?: string
  body?: string
  retry?: boolean
  changeModel?: boolean
}

export interface BarState {
  phase: Phase
  stage: Stage
  /** Hover intent result. Only rendered (as the capsule) while idle. */
  hover: boolean
  /** One per recording: keys the dot, the waveform and the stream. */
  run: number
  startedAt: number | null
  stoppedAt: number | null
  doneAt: number | null
  /** Full running text of this dictation. */
  partial: string
  /** Keep the card up with no text yet (retry of the same audio, §4.1.9 Error to Busy). */
  keepCard: boolean
  /** Done: the card has been sent into the pill (t = 80). */
  sent: boolean
  /** Recording started with the Dictate button mounted: the dot hands off from it. */
  fromCapsule: boolean
  error: BarError | null
  errorSeq: number
  /** Notice pill (idle only). */
  notice: FlowNotice | null
  noticeSeq: number
  /** Notice during a dictation: shown as the Partial card's head label. */
  headNotice: FlowNotice | null
  exit: ExitKind | null
  /** Identity of the current card; a new one mounts fresh while the old one exits. */
  cardId: number
  /** The card that most recently left, and how. */
  leave: { id: number; kind: ExitKind } | null
  /** View before the latest view change (the shape's spring depends on it). */
  from: View
  /**
   * Onboarding "Try it" is active: the bar is the recording pill only. No
   * partial card, no done check, no error card and no notice.
   */
  practice: boolean
}

export type BarAction =
  | { type: 'state'; value: 'recording' | 'idle'; now: number }
  | { type: 'stage'; value: Stage | 'idle'; now: number }
  | { type: 'partial'; text: string }
  | { type: 'error'; message: string; now: number }
  | { type: 'notice'; notice: FlowNotice }
  | { type: 'copied' }
  | { type: 'hover'; hover: boolean }
  | { type: 'send' }
  | { type: 'done-end' }
  | { type: 'dismiss-error' }
  | { type: 'dismiss-notice' }
  | { type: 'practice'; on: boolean }

export const initialState: BarState = {
  phase: 'idle', stage: 'transcribing', hover: false, run: 0,
  startedAt: null, stoppedAt: null, doneAt: null,
  partial: '', keepCard: false, sent: false, fromCapsule: false,
  error: null, errorSeq: 0, notice: null, noticeSeq: 0, headNotice: null,
  exit: null, cardId: 0, leave: null, from: 'sliver', practice: false
}

export function viewOf(s: BarState): View {
  return s.phase === 'idle' ? (s.hover ? 'capsule' : 'sliver') : s.phase
}

export function cardOf(s: BarState): CardKind | null {
  if (s.practice) return null
  if (s.phase === 'error') return 'error'
  const live = s.phase === 'recording' || s.phase === 'busy' || (s.phase === 'done' && !s.sent)
  return live && (s.partial.trim() !== '' || s.headNotice !== null || s.keepCard) ? 'partial' : null
}

function step(s: BarState, a: BarAction): BarState {
  switch (a.type) {
    case 'state':
      if (a.value === 'recording') {
        return {
          ...s, phase: 'recording', stage: 'transcribing', run: s.run + 1,
          startedAt: a.now, stoppedAt: null, doneAt: null,
          partial: '', keepCard: false, sent: false,
          fromCapsule: s.phase === 'idle' && s.hover,
          error: null, notice: null, headNotice: null, exit: 'retarget'
        }
      }
      // Stop or cancel: the stage message that follows says which.
      return s.phase === 'recording' && s.stoppedAt === null ? { ...s, stoppedAt: a.now } : s

    case 'stage':
      if (a.value !== 'idle') {
        if (s.phase === 'busy' && s.stage === a.value) return s
        const retry = s.phase === 'error'
        return {
          ...s, phase: 'busy', stage: a.value,
          startedAt: s.startedAt ?? a.now, stoppedAt: s.stoppedAt ?? a.now, doneAt: null,
          partial: retry ? '' : s.partial, keepCard: s.keepCard || retry, sent: false,
          error: null, notice: null, exit: null
        }
      }
      // Idle straight from recording is a cancel (Esc); from busy it is done.
      if (s.phase === 'recording') {
        return { ...s, phase: 'idle', exit: 'cancel', headNotice: null, keepCard: false }
      }
      // Practice: the compact busy pill collapses straight to the sliver, no check.
      if (s.phase === 'busy' && s.practice) return { ...s, phase: 'idle', exit: 'done', headNotice: null, keepCard: false }
      if (s.phase === 'busy') return { ...s, phase: 'done', doneAt: a.now, sent: false, exit: null }
      return s

    case 'partial':
      if (s.practice) return s
      return s.partial === a.text ? s : { ...s, partial: a.text }

    case 'error':
      // Main sends none in practice; ignore one defensively.
      if (s.practice) return s
      return {
        ...s, phase: 'error', error: parseError(a.message), errorSeq: s.errorSeq + 1,
        stoppedAt: s.stoppedAt ?? (s.startedAt === null ? null : a.now),
        notice: null, headNotice: null, keepCard: false, exit: null
      }

    case 'notice':
      if (s.practice) return s
      // An error outranks a notice; the notice is not re-shown.
      if (s.phase === 'error') return s
      // During a dictation the notice lives in the card head (short form only).
      if (s.phase === 'recording' || s.phase === 'busy') {
        return a.notice.short ? { ...s, headNotice: a.notice } : s
      }
      return { ...s, notice: a.notice, noticeSeq: s.noticeSeq + 1 }

    case 'copied':
      // Copy fallback: nothing was pasted, so no check. Collapse now.
      return s.phase === 'done'
        ? { ...s, phase: 'idle', sent: true, exit: 'copied', headNotice: null, keepCard: false }
        : s

    case 'hover':
      return s.hover === a.hover ? s : { ...s, hover: a.hover }

    case 'send':
      return s.phase === 'done' && !s.sent ? { ...s, sent: true, exit: 'done' } : s

    case 'done-end':
      return s.phase === 'done'
        ? { ...s, phase: 'idle', sent: true, exit: 'done', headNotice: null, keepCard: false }
        : s

    case 'dismiss-error':
      return s.phase === 'error' ? { ...s, phase: 'idle', exit: 'dismiss' } : s

    case 'practice':
      if (s.practice === a.on) return s
      // Turning on clears what practice never shows; an error card closes.
      return a.on
        ? {
            ...s, practice: true, partial: '', notice: null, headNotice: null, keepCard: false, error: null,
            ...(s.phase === 'error' ? { phase: 'idle' as const, exit: 'dismiss' as const } : {}),
            ...(s.phase === 'done' ? { phase: 'idle' as const, sent: true, exit: 'done' as const } : {})
          }
        : { ...s, practice: false }

    case 'dismiss-notice':
      return s.notice ? { ...s, notice: null } : s
  }
}

export function reducer(prev: BarState, action: BarAction): BarState {
  let next = step(prev, action)
  if (next === prev) return prev
  const a = cardOf(prev)
  const b = cardOf(next)
  const same = a !== null && b !== null && prev.run === next.run
  if (a !== null && !same) next = { ...next, leave: { id: prev.cardId, kind: next.exit ?? 'retarget' } }
  if (b !== null && !same) next = { ...next, cardId: prev.cardId + 1 }
  const from = viewOf(prev)
  if (from !== viewOf(next)) next = { ...next, from }
  return next
}

/**
 * Main reports a failure on dictation:error as one sentence-ish string. Known
 * failures get the design's title / meta / message split (Bar Error PWeE1).
 */
export function parseError(msg: string): BarError {
  const empty = /^Nothing came back from (.+?)\. /.exec(msg)
  if (empty) {
    return {
      title: 'Nothing came back',
      meta: `Speech model · ${empty[1]}`,
      body: 'The model returned no text for that recording. If it keeps happening, switch to another speech model.',
      retry: true,
      changeModel: true
    }
  }
  if (/^Nothing was heard/.test(msg)) {
    return { title: 'Nothing was heard', body: 'Is the microphone allowed?', retry: true }
  }
  // "Title. Rest", or the older form with a long dash (written as an escape).
  const m = /^(.+?)(?:\s+\u2014\s+|\.\s+)([\s\S]+)$/.exec(msg)
  if (!m) return { title: msg.replace(/\.$/, '') }
  const body = m[2].trim()
  return { title: m[1], body: body.charAt(0).toUpperCase() + body.slice(1) }
}

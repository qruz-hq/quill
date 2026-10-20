import { app, shell, BrowserWindow, ipcMain, screen, clipboard, globalShortcut, Tray, Menu, nativeImage, nativeTheme } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, appendFileSync } from 'fs'
import { userInfo } from 'os'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { SttEngine, HelperGone, type Final, type HotkeyIntent } from './stt'
import { ModelStore, type ModelId, RETIRED } from './models'
import { NoteStore } from './notes'
import { SnippetStore } from './snippets'
import { TransformStore, type TransformApplied } from './transforms'
import { DictationStore } from './dictations'
import { Cleanup } from './cleanup'
import { transcribeCloud, discard, audioSizeMB, type Provider } from './transcribe'
import { RealtimeStream, type LiveStream } from './stream'
import { OpenAIRealtimeStream, openaiStreams, openaiBatchModel } from './stream-openai'
import { TodoStore, type Todo, type TodoPatch } from './todos'
import { EdgeDwell } from './edge'
import { CalendarSync } from './calendar'
import { Secrets } from './secrets'
import { checkForUpdate, promptIfNewer } from './updates'
import * as platform from './platform'
import { chooseHelper, effectiveHoldKey, type Capabilities, type HelperKind, type HostOS } from './capabilities'

// Chromium switches (Linux: X11) have to be set before the app is ready.
platform.configureApp()

/*
 * One Quill per session on Windows and Linux. Closing the hub leaves the app
 * in the tray, and a desktop without a tray (stock GNOME) has no other way
 * back to it than starting Quill again: the second start hands over to the
 * first, which shows its hub. macOS does this by itself through 'activate'.
 */
const secondInstance = !platform.isMac && !app.requestSingleInstanceLock()
if (secondInstance) app.quit()

/* Screenshot calibration: captures were 1372px wide on a 1728pt display (0.794x).
   All sizes below are logical points, converted from the measured originals. */
// Hub frames in design.pen are 1100 × 720.
const HUB = { width: 1100, height: 720, minWidth: 1000, minHeight: 720 }
// Scratchpad frame in design.pen (vytSm) is 720 × 480.
const PAD = { width: 720, height: 480 }
const TODOS = { width: 360, height: 520 }
/** Todos grows to this height while its date picker is open, so the picker is never clipped. */
const TODOS_PICKER_HEIGHT = 640
/*
 * Flow Bar: ONE fixed transparent window, never resized (docs/MOTION.md §4.1.1).
 * Size reconciled from three sources:
 *   - spec 400 × 260 (widest state: card 304 + gap 8 + pill 44 + inset 8 = 364,
 *     plus 2 × 16 shadow bleed ≈ 396, rounded to 400);
 *   - the previous BAR_OPEN 392 × 260 (364 + the card's 28 px drop-shadow blur);
 *   - the design's 380 × 260 Desktop frame (no shadow bleed).
 * 400 wins: it is the only one that fits the widest state AND the card shadow
 * (card x 36 minus 28 blur = 8 px left margin), and it is the coordinate system
 * every FLOWBAR geometry token in shared/motion/tokens.ts is written in.
 * Height 260 holds the tallest state (error card 166 / capsule 158 plus
 * spring.morph overshoot and shadow) and the language menu (clamped 16..244).
 */
const BAR = { width: 400, height: 260 }

let hubWindow: BrowserWindow | null = null
let barWindow: BrowserWindow | null = null
let padWindow: BrowserWindow | null = null
let todosWindow: BrowserWindow | null = null
let lastTranscript = ''
let tray: Tray | null = null
let recording = false
let voiceNoteMode = false
let recordingStartedAt = 0
/**
 * Dictations between stop (or retry) and delivery; non-zero blocks a retry.
 * A count, not a flag: a new recording may start and stop while the previous
 * one is still being polished, and the first to finish must not clear it.
 */
let processing = 0
/**
 * What a recording was when it stopped, carried through to delivery so a new
 * recording that starts meanwhile cannot change it. The last one is kept so
 * dictation:retry re-runs it the same way.
 */
type Run = {
  voiceNote: boolean
  durationMs: number
  app: Promise<string | undefined>
  /** The live upload this recording fed, until its commit (or the run's end) closes it. */
  stream: LiveStream | null
  /** A practice run: the text goes to the hub's tile and nowhere else. */
  practice: boolean
}
let lastRun: Run | null = null
/** Hands-free: the hold key was double-tapped, so the recording runs until the next tap. */
let latched = false
/*
 * Practice (the onboarding "Try it" tile): a dictation records and transcribes
 * as usual, but its text goes to the hub on dictation:practice-result and
 * nowhere else. No paste, no clipboard, no cleanup, no snippets, no history.
 * Only the hub turns it on, and it goes off by itself when the hub closes,
 * reloads or navigates, so it can never stay stuck on.
 */
let practice = false
/** The recording in progress began in practice; it stays a practice run even if practice ends first. */
let recordingPractice = false
export type PracticeResult = { text: string } | { empty: true } | { error: string; kind: 'mic' | 'other' }

function setPractice(on: boolean): void {
  if (practice === on) return
  practice = on
  log(`[flow] practice ${on ? 'on' : 'off'}`)
  broadcast('dictation:practice', on)
}

/**
 * Every dictation error goes through here. In practice it goes to the tile
 * (the Flow Bar must not raise its error card over onboarding); otherwise to
 * dictation:error. `inPractice` is the run's own flag when there is one.
 */
function dictationError(message: string, kind: 'mic' | 'other' = 'other', inPractice?: boolean): void {
  const toTile = inPractice ?? (recording ? recordingPractice : practice)
  if (!toTile) { broadcast('dictation:error', message); return }
  const error = userError(message)
  if (error) broadcast('dictation:practice-result', { error, kind } satisfies PracticeResult)
}

/** The recording in progress was started by the hold key, so the helper may cancel it. */
let recordingByHotkey = false
/** A recording shorter than this that transcribes to nothing was a stray press, not a miss. */
const STRAY_MS = 600
/** Set on before-quit: windows close at once, no exit handshake. */
let quitting = false
/** HOLD.closeTimeout: a window closes anyway if its renderer's exit has not answered. */
const CLOSE_TIMEOUT_MS = 300

function setLatched(v: boolean): void {
  if (latched === v) return
  latched = v
  broadcast('dictation:latched', v)
}

/* ---- Flow Bar click-through state (docs/MOTION.md §4.1.1) ---- */
/** Main's mirror of setIgnoreMouseEvents. */
let barIgnoring = true
/** Last bar:hit from the renderer. */
let barHit = false
/** The pointer is over the error card, so Esc should dismiss it. */
let barEscWanted = false
/** Shape rect in window coordinates, published by the renderer on every settle. */
let barShape: { x: number; y: number; width: number; height: number } | null = null

/* ---- Live partials (dictation:partial), throttled to 1 per 100 ms ---- */
const PARTIAL_MS = 100
let partialPending: string | null = null
let partialTimer: ReturnType<typeof setTimeout> | null = null
let partialLastAt = 0
/** How many partials the windows were sent for the current recording, for the log. */
let partialsSent = 0

function flushPartial(): void {
  if (partialTimer) { clearTimeout(partialTimer); partialTimer = null }
  if (partialPending === null) return
  partialLastAt = Date.now()
  broadcast('dictation:partial', partialPending)
  partialsSent++
  partialPending = null
}

/** Queues the full running text; the latest one always gets sent (trailing edge). */
function queuePartial(text: string): void {
  if (!recording && !processing) return
  partialPending = text
  const wait = PARTIAL_MS - (Date.now() - partialLastAt)
  if (wait <= 0) flushPartial()
  else if (!partialTimer) partialTimer = setTimeout(flushPartial, wait)
}

function resetPartials(): void {
  if (partialTimer) { clearTimeout(partialTimer); partialTimer = null }
  partialPending = null
  partialLastAt = 0
  partialsSent = 0
}

/* ---- Notices (dictation:notice): neutral, self-dismissing, never errors ---- */
export type NoticeKind = 'copied' | 'key-fallback' | 'cloud-fallback' | 'transform-applied' | 'cleanup-failed'
export type Notice = {
  kind: NoticeKind
  /** Full sentence for the notice pill and the status region. */
  text: string
  /** Uppercase short form for the Partial card head during a dictation. */
  short?: string
  /** Transform name, for kind 'transform-applied'. */
  name?: string
  /** Extra detail (e.g. the cloud error), never shown in the pill. */
  detail?: string
  /** Suggested hold in ms: HOLD.notice 4000, HOLD.transformNotice 1600. */
  holdMs: number
}
function notice(n: Notice): void {
  broadcast('dictation:notice', n)
}

/** A Finder-launched app has no visible stdout, so timings go to a file. */
let logPath: string | null = null
function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try { appendFileSync((logPath ??= platform.logFile()), line) } catch { /* non-fatal */ }
  console.log(msg)
}
// Uncaught exceptions keep Electron's own dialog; a rejection would otherwise
// only reach a console nobody sees in a packaged app.
process.on('unhandledRejection', (reason) => log(`[crash] unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`))

type Settings = { model: ModelId; languages: string[]; duckEnabled: boolean; duckLevel: number; aiEnabled: boolean; aiModel: string; aiMinWords: number; aiDeadlineMs: number; aiFixMishearings: boolean; sttEngine: 'local' | 'cloud'; sttProvider: Provider; sttModel: string; sttStreaming: boolean; sttNoVerbatim: boolean; launchAtLogin: boolean; todoEdge: boolean; calSync: boolean; calId: string; holdKey: number; micUid: string; toggleShortcut: string; padShortcut: string; noteShortcut: string; skippedVersion: string; onboarded: boolean; helper: HelperKind }
const SETTINGS_PATH = (): string => join(app.getPath('userData'), 'settings.json')
// `helper`: which native helper runs on macOS ('swift' until the Rust one has
// been tried; QUILL_HELPER overrides it). Windows and Linux always run 'rust'.
// The shortcut defaults differ per OS, see platform.defaultShortcuts.
// New installs start on the multilingual Small model, compressed (190 MB); it is
// downloaded during setup. Existing installs keep whatever they chose. Windows
// and Linux decode on the CPU, where Small keeps every core busy for seconds
// per dictation, so they start on Base (English, compressed, 60 MB) instead.
const DEFAULTS: Settings = { model: platform.isMac ? 'small-q5_1' : 'base.en-q5_1', languages: ['en'], duckEnabled: true, duckLevel: 15, aiEnabled: true, aiModel: 'gpt-4o-mini', aiMinWords: 5, aiDeadlineMs: 2500, aiFixMishearings: false, sttEngine: 'local', sttProvider: 'openai', sttModel: 'gpt-4o-mini-transcribe', sttStreaming: false, sttNoVerbatim: true, launchAtLogin: false, todoEdge: true, calSync: false, calId: '', holdKey: 63, micUid: '', ...platform.defaultShortcuts, skippedVersion: '', onboarded: false, helper: 'swift' }

function loadSettings(): Settings {
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_PATH(), 'utf8'))
    // Older builds stored a single `language` string.
    if (typeof raw.language === 'string' && !raw.languages) {
      raw.languages = [raw.language]
      delete raw.language
    }
    return { ...DEFAULTS, ...raw }
  } catch { return { ...DEFAULTS } }
}
function saveSettings(s: Settings): void {
  try { writeFileSync(SETTINGS_PATH(), JSON.stringify(s, null, 2)) } catch { /* non-fatal */ }
}
let settings = DEFAULTS

/** Single owner of dictation state, so the Flow Bar, the hotkey and the tray
 *  can all drive it without fighting each other. */
async function startVoiceNote(): Promise<void> {
  if (recording) return
  voiceNoteMode = true
  await startDictation()
}

/**
 * Live upload for the current dictation, when ElevenLabs streaming is on.
 * Null whenever we are on the batch path, which is every other configuration.
 */
let activeStream: LiveStream | null = null
/** The stream stt.chunkHandler currently feeds. */
let chunkOwner: LiveStream | null = null
/** Streams that are finished with, so one whose connect resolves late is closed, not left open. */
const endedStreams = new WeakSet<LiveStream>()

/** Closes a stream for good and lets go of everything that pointed at it. Safe to repeat. */
function dropStream(s: LiveStream | null): void {
  if (!s) return
  endedStreams.add(s)
  if (chunkOwner === s) { stt.chunkHandler = null; chunkOwner = null }
  if (activeStream === s) activeStream = null
  s.close()
}

/**
 * Streaming needs the cloud engine, the provider's key, and for OpenAI a
 * model its realtime session accepts (whisper-1 stays on the batch upload).
 */
function streamingWanted(): boolean {
  if (!settings.sttStreaming || settings.sttEngine !== 'cloud') return false
  if (settings.sttProvider === 'elevenlabs') return !!elevenKey.get()
  return !!cleanup.rawKey() && openaiStreams(settings.sttModel)
}

/** The live stream for the selected provider, already connecting. Resolves false when it could not open. */
function openStream(): { stream: LiveStream; opened: Promise<boolean> } {
  const common = { languages: settings.languages, noVerbatim: settings.sttNoVerbatim }
  if (settings.sttProvider === 'elevenlabs') {
    const stream = new RealtimeStream()
    return { stream, opened: stream.open({ ...common, key: elevenKey.get()!, model: 'scribe_v2_realtime' }) }
  }
  const stream = new OpenAIRealtimeStream()
  // `low`: words about as early as the model can give them, without the
  // accuracy cost of `minimal`. Ignored by the models that are not live.
  return { stream, opened: stream.open({ ...common, key: cleanup.rawKey()!, model: settings.sttModel, delay: 'low' }) }
}

/*
 * Permissions. The helper is a child process, so TCC charges its microphone
 * and Accessibility use to Quill itself; asking from here asks for both.
 */
type Perms = { mic: platform.MicAccess; ax: boolean }
let axSeen = false

/** Off macOS there is no Accessibility grant (`ax` is always true) and the microphone is at most a system switch. */
function permissions(): Perms {
  const mic = platform.micAccess()
  const ax = platform.accessibilityTrusted()
  // Granted mid-session: have the helper install the hold key now, so the
  // grant works without a relaunch.
  if (ax && !axSeen) stt.checkAccessibility()
  axSeen = ax
  return { mic, ax }
}

/**
 * Brings the hub forward, reopening it if the user closed it, the bar and
 * todos windows keep the app alive, so 'activate' alone never brings it back.
 * Resolves once the renderer can receive messages.
 */
function showHub(): Promise<BrowserWindow> {
  if (hubWindow && !hubWindow.isDestroyed()) {
    const wasVisible = hubWindow.isVisible()
    hubWindow.show()
    hubWindow.focus()
    if (!wasVisible) sendShown(hubWindow, false)
    return Promise.resolve(hubWindow)
  }
  const win = (hubWindow = createHub())
  return new Promise((resolve) => win.webContents.once('did-finish-load', () => resolve(win)))
}

/**
 * Brings the hub forward on the permissions screen. A freshly opened hub may
 * not be listening yet when it loads, so the request is also left pending for
 * the renderer to collect on mount.
 */
let permsPending = false
/** Settings pane a new hub should open on (hub:open-settings before it was listening). */
let settingsPending: string | null = null
function showPermissions(): void {
  permsPending = true
  void showHub().then((win) => { if (!win.isDestroyed()) win.webContents.send('perms:show', null) })
}

const accelLabel = platform.accelLabel

let askingMic = false

/**
 * Recording without the microphone grant captures silence and then blames the
 * model, so check first. Undecided asks; refused says where to fix it.
 * (Undecided only exists on macOS.)
 */
async function micReady(): Promise<boolean> {
  const mic = platform.micAccess()
  if (mic === 'granted' || mic === 'unknown') return true
  if (mic === 'not-determined') {
    if (askingMic) return false
    askingMic = true
    const ok = await platform.askMicAccess().finally(() => { askingMic = false })
    // The key was released while the dialog was up, so this press is spent;
    // the next one records.
    broadcast('perms:changed', permissions())
    if (ok) return false
  }
  dictationError('Quill can’t use the microphone. Allow it in the Quill window, then try again.', 'mic')
  // In practice the hub is already up on onboarding, which shows the grant itself.
  if (!practice) showPermissions()
  return false
}

/**
 * Typing into another app needs a helper that can type here, and on macOS
 * the Accessibility grant. Without either the text goes on the clipboard
 * instead, so a dictation is never lost to a missing grant or backend.
 */
function deliver(text: string): void {
  const canType = stt.has('insert')
  if (canType && platform.accessibilityTrusted()) {
    stt.insert(text)
    return
  }
  clipboard.writeText(text)
  notice({
    kind: 'copied',
    text: `Copied, press ${platform.pasteLabel} to paste`,
    detail: canType
      ? 'Allow Accessibility and Quill types it for you.'
      : 'Quill cannot type into other apps on this system yet.',
    holdMs: 4000
  })
}

/** Name of the frontmost app, for the hub's recent list (macOS only, see platform.frontmostApp). */
let dictationApp: Promise<string | undefined> = Promise.resolve(undefined)
const frontmostApp = platform.frontmostApp

async function startDictation(byHotkey = false): Promise<void> {
  if (recording) return
  dictationApp = frontmostApp()
  if (!(await micReady())) { voiceNoteMode = false; return }
  if (recording) return
  recording = true
  recordingPractice = practice
  // Practice never makes a voice note.
  if (recordingPractice) voiceNoteMode = false
  recordingByHotkey = byHotkey
  recordingStartedAt = Date.now()
  resetPartials()
  broadcast('dictation:partial', '')
  broadcast('dictation:state', 'recording')
  syncEscape()
  stt.start()

  // Opened after start(), not before: the handshake costs a few hundred ms and
  // the user is already talking. Chunks captured meanwhile buffer in the stream
  // and flush once it opens.
  if (streamingWanted()) {
    const { stream: s, opened } = openStream()
    activeStream = s
    chunkOwner = s
    stt.chunkHandler = (b64) => s.push(b64)
    // Streaming partials, either provider: the full running text every time.
    s.onText = (t) => { if (!endedStreams.has(s)) queuePartial(t) }
    const ok = await opened
    if (!ok) {
      log(`[stream] connect failed (${s.error}), batch upload will handle it`)
      dropStream(s)
    } else if (endedStreams.has(s)) {
      // Its recording was cancelled or finished while it was still
      // connecting: nothing will ever commit it, so it must not stay open.
      s.close()
    }
  }
}

async function stopDictation(): Promise<void> {
  if (!recording) return
  recording = false
  setLatched(false)
  stt.unlatch()
  processing++
  syncEscape()
  broadcast('dictation:state', 'idle')
  broadcast('dictation:stage', 'transcribing')
  const tStop = Date.now()
  // The stream leaves with its run: a recording that starts while this one
  // is still being transcribed gets its own and cannot take this one's.
  const run: Run = {
    voiceNote: voiceNoteMode && !recordingPractice,
    durationMs: Math.max(0, tStop - recordingStartedAt),
    app: dictationApp,
    stream: activeStream,
    practice: recordingPractice
  }
  activeStream = null
  voiceNoteMode = false
  // A practice run is never the bar's "Try again".
  lastRun = run.practice ? null : run
  try {
    const final = await stt.stop(run)
    await finishDictation(final, tStop, run)
  } catch (err) {
    failDictation(err, run)
  } finally {
    processing--
    // Still open when the audio never reached the commit (too short, a local
    // transcription, an error): close it here or it stays connected.
    dropStream(run.stream)
    run.stream = null
  }
}

/** Something threw after the recording stopped: say so and never leave the bar busy. */
function failDictation(err: unknown, run: Run): void {
  log(`[flow] dictation failed: ${(err as Error)?.message ?? err}`)
  if (err instanceof HelperGone) {
    // The audio went with the helper, so there is nothing left to re-run.
    lastRun = null
    announceHelperGone(run.practice)
  } else {
    dictationError('That dictation could not be finished. Try again.', 'other', run.practice)
  }
  broadcast('dictation:stage', 'idle')
}

/** The one message for a helper that died mid-dictation, however many things were waiting on it. */
const HELPER_GONE = 'The microphone stopped unexpectedly. Try again.'
let helperGoneAnnounced = false
function announceHelperGone(inPractice?: boolean): void {
  if (helperGoneAnnounced) return
  helperGoneAnnounced = true
  setTimeout(() => { helperGoneAnnounced = false }, 1000)
  dictationError(HELPER_GONE, 'mic', inPractice)
}

/**
 * The `helper` setting changed (macOS): swap the running helper for the other
 * one. A recording in progress is dropped first, since its audio lives in the
 * helper that is about to quit; one being transcribed is waited for. No-op
 * when QUILL_HELPER decides, or when the wanted helper is already running.
 */
function switchHelper(): void {
  const choice = helperChoice()
  if (choice.kind === stt.helperKind) return
  // A dictation still being transcribed lives in the old helper: let it finish.
  if (processing) { setTimeout(switchHelper, 500); return }
  if (recording) cancelDictation()
  // Nothing kept in the old helper can be retried in the new one.
  lastRun = null
  log(`[flow] switching to the ${choice.kind} helper`)
  stt.setHelperKind(choice.kind)
  broadcast('platform:changed', platformInfo())
}

/** Unexpected helper exits, to stop respawning one that dies as soon as it starts. */
let helperCrashes: number[] = []

/**
 * What the windows may show for an error: the first line only, capped. A
 * backstop, so that nothing long or multi-line (a stack trace, a raw API
 * body) can ever fill the Flow Bar's error card.
 */
const ERROR_MAX = 160
function userError(msg: unknown): string {
  const line = String(msg ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? ''
  const text = line.replace(/\s+/g, ' ')
  return text.length > ERROR_MAX ? `${text.slice(0, ERROR_MAX - 1).trimEnd()}…` : text
}

/**
 * A recording ended with nothing to transcribe (cancelled, the microphone
 * would not open, the helper died). Every window goes back to idle.
 */
function abortRecording(): void {
  recording = false
  setLatched(false)
  voiceNoteMode = false
  // Nothing of this recording is kept, so "Try again" starts a new one.
  lastRun = null
  // The helper may still think it is latched; the next press must record.
  stt.unlatch()
  // Drop the live socket too, or it stays open and the next dictation starts
  // a second stream alongside it.
  dropStream(activeStream)
  resetPartials()
  syncEscape()
  broadcast('dictation:state', 'idle')
  broadcast('dictation:stage', 'idle')
}

/**
 * Esc during recording. A no-op otherwise: the helper's cancel also drops the
 * recording kept for "Try again", and the stream of a dictation that is being
 * transcribed is still needed for its commit.
 */
function cancelDictation(): void {
  if (!recording) return
  stt.cancel()
  abortRecording()
}

/**
 * The Flow Bar error's "Try again": re-runs the last recording (kept in the
 * helper's memory) through transcription, cleanup and delivery. No-op while
 * recording or while another dictation is still being processed.
 */
async function retryDictation(): Promise<boolean> {
  if (recording || processing || !lastRun) return false
  processing++
  const run = lastRun
  resetPartials()
  broadcast('dictation:stage', 'transcribing')
  const t0 = Date.now()
  try {
    const final = await stt.retry(run)
    await finishDictation(final, t0, run)
  } catch (err) {
    failDictation(err, run)
  } finally {
    processing--
  }
  return true
}

/** Everything after the transcript arrives: cleanup, snippets, history, delivery. */
async function finishDictation(final: Final, tStop: number, run: Run): Promise<void> {
  const raw = final.text
  const { durationMs } = run
  const tTranscribed = Date.now()
  flushPartial()

  if (!raw.trim()) {
    // A brush of the hold key (a quick tap, fn with another key) is not a
    // dictation that failed: no error card and no row in the history.
    if (durationMs < STRAY_MS) {
      if (lastRun === run) lastRun = null
      broadcast('dictation:stage', 'idle')
      log(`[timing] ${durationMs}ms recording with nothing in it, ignored`)
      return
    }
    if (run.practice) {
      broadcast('dictation:stage', 'idle')
      log(`[timing] practice | EMPTY transcript${final.error ? ` (${final.error})` : ''}`)
      if (final.error) dictationError(final.error, /microphone/i.test(final.error) ? 'mic' : 'other', true)
      else broadcast('dictation:practice-result', { empty: true } satisfies PracticeResult)
      return
    }
    // The helper's own reason (no model, a silent microphone) beats the guess.
    broadcast(
      'dictation:error',
      final.error ??
        (settings.sttEngine === 'local'
          ? `Nothing came back from ${settings.model}. If this keeps happening, try a different speech model.`
          : 'Nothing was heard. Is the microphone allowed?')
    )
    // A silent recording used to return before this, leaving the bar spinning for good.
    broadcast('dictation:stage', 'idle')
    log(`[timing] transcribe ${tTranscribed - tStop}ms | EMPTY transcript${final.error ? ` (${final.error})` : ''}`)
    // Kept in the history (not counted in insights) so the miss is visible.
    const failed = dictations.add('', durationMs, { failed: final.error ?? 'No speech detected.', app: await run.app })
    broadcast('dictations:added', failed)
    return
  }

  // Practice ends here: the words go to the tile, and nothing else happens to
  // them. No cleanup, no snippets, no history, no paste, no clipboard.
  if (run.practice) {
    broadcast('dictation:stage', 'idle')
    log(`[timing] practice | transcribe ${tTranscribed - tStop}ms | ${raw.trim().split(/\s+/).length} words | ${partialsSent} live updates`)
    broadcast('dictation:practice-result', { text: raw.trim() } satisfies PracticeResult)
    return
  }

  // Spoken shortcuts expand before anything is typed.
  // Optional cloud cleanup. Any failure returns the raw text, so a bad key or
  // a dead connection can never cost you a dictation.
  // Short dictations gain nothing from cleanup (whisper already punctuates
  // them) but still cost a full API round trip, measured at 1-2s. Skipping
  // them is the only lever that actually removes latency, since the wait is
  // OpenAI's, not ours.
  const wordCount = raw.trim().split(/\s+/).filter(Boolean).length
  const tooShort = settings.aiMinWords > 0 && wordCount < settings.aiMinWords
  const willClean = !tooShort && settings.aiEnabled && cleanup.hasKey()
  if (willClean) broadcast('dictation:stage', 'polishing')
  const { text: polished, note } = tooShort
    ? { text: raw, note: `skipped (${wordCount} words)` }
    : await cleanup.run(raw, {
        enabled: settings.aiEnabled,
        model: settings.aiModel,
        deadlineMs: settings.aiDeadlineMs,
        fixMishearings: settings.aiFixMishearings
      })
  const tCleaned = Date.now()
  if (note.startsWith('failed') || note.startsWith('empty')) {
    broadcast('cleanup:error', note)
    notice({ kind: 'cleanup-failed', text: 'Cleanup failed, raw text inserted', short: 'RAW TEXT', detail: note, holdMs: 4000 })
  }

  const { text, used, ids } = snippets.apply(polished)
  if (ids.length) {
    snippets.recordUse(ids)
    broadcast('snippets:changed', snippets.list())
  }
  lastTranscript = text

  // Where the wait actually goes, so slowness can be attributed rather than guessed.
  broadcast('dictation:stage', 'idle')
  cleanup.warm()
  log(
    `[timing] transcribe ${tTranscribed - tStop}ms` +
    ` | cleanup ${tCleaned - tTranscribed}ms (${note})` +
    ` | total ${Date.now() - tStop}ms` +
    ` | ${raw.trim().split(/\s+/).length} words` +
    (used.length ? ` | snippets: ${used.join(', ')}` : '')
  )

  // Persist every dictation so history and insights survive a restart.
  const entry = dictations.add(text, durationMs, { app: await run.app })
  broadcast('dictations:added', entry)

  if (run.voiceNote) {
    const note = notes.create()
    notes.update(note.id, { body: `<div>${escapeHtml(text)}</div>` })
    broadcast('notes:changed', notes.list())
    openScratchpad()
    return
  }
  deliver(text)
}

/**
 * Global Esc, registered ONLY while recording (cancel) or while the pointer is
 * over the Flow Bar's error card (dismiss), so Esc is never stolen from the
 * app the user is typing into (docs/MOTION.md §4.1.9, §4.1.11).
 */
let escRegistered = false
function syncEscape(): void {
  const want = recording || (barHit && barEscWanted)
  if (want === escRegistered) return
  if (want) {
    try {
      escRegistered = globalShortcut.register('Escape', () => {
        if (recording) cancelDictation()
        else if (barWindow && !barWindow.isDestroyed()) barWindow.webContents.send('bar:escape', null)
      })
    } catch { escRegistered = false }
  } else {
    globalShortcut.unregister('Escape')
    escRegistered = false
  }
}

/** Applies a pending ignore state to the bar window, only when it changes. */
function setBarIgnore(ignore: boolean): void {
  if (!barWindow || barWindow.isDestroyed()) return
  barIgnoring = ignore
  platform.ignoreMouse(barWindow, ignore)
}

/**
 * Main-process backstop for the click-through window (§4.1.1 step 6), 30 Hz.
 * - Ignoring, but the cursor sits on the published shape and the renderer has
 *   not claimed it for a few ticks: forwarding has silently stopped (display
 *   sleep, Space change), so re-assert ignore + forward.
 * - Not ignoring, but the cursor is outside the window: the renderer missed
 *   mouseleave, so go back to click-through.
 *
 * Linux has no forwarding at all (platform.forwardsMouse), so there this is
 * not a backstop but the way in: when the cursor reaches the published shape
 * main opens the window to the mouse, the renderer's own hit test takes over
 * from the first mouse move, and bar:hit false hands the window back. The
 * way in is up to one tick (33 ms) later than on the other systems.
 */
let barPollTicks = 0
function pollBarCursor(): void {
  const w = barWindow
  if (!w || w.isDestroyed() || !w.isVisible()) return
  const p = screen.getCursorScreenPoint()
  const b = w.getBounds()
  const inWindow = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height
  const r = barShape
  const onShape = !!r && inWindow &&
    p.x >= b.x + r.x && p.x < b.x + r.x + r.width && p.y >= b.y + r.y && p.y < b.y + r.y + r.height
  if (!barIgnoring) {
    barPollTicks = 0
    // Linux: main opened the window and the renderer never claimed the
    // pointer (it left the shape without a mouse move reaching the page).
    if (!platform.forwardsMouse && inWindow && !barHit && !onShape) { setBarIgnore(true); return }
    if (!inWindow) {
      barHit = false
      barEscWanted = false
      setBarIgnore(true)
      syncEscape()
      // The renderer still believes it holds the pointer and would not send
      // its next `true`: have it forget what it last sent.
      w.webContents.send('bar:hit-reset', null)
    }
    return
  }
  if (!onShape) { barPollTicks = 0; return }
  if (!platform.forwardsMouse) { setBarIgnore(false); return }
  // ~200 ms on the shape with no bar:hit true: forwarding is dead, re-assert it.
  if (++barPollTicks === 6) {
    platform.ignoreMouse(w, true)
    log('[bar] click-through forwarding re-asserted')
  }
}

/** Points the helper at the selected model, or reports that none is installed. */
/**
 * Rebinds every global accelerator from settings. Unregistering first matters:
 * globalShortcut.register silently fails if the combo is already taken, so a
 * settings change would otherwise appear to work and do nothing.
 */
function applyShortcuts(): { ok: string[]; failed: string[] } {
  globalShortcut.unregisterAll()
  const ok: string[] = []
  const failed: string[] = []
  const bind = (accel: string, fn: () => void): void => {
    if (!accel) return
    try {
      globalShortcut.register(accel, fn) ? ok.push(accel) : failed.push(accel)
    } catch { failed.push(accel) }
  }
  bind(settings.toggleShortcut, () => void (recording ? stopDictation() : startDictation()))
  bind(settings.padShortcut, () => openScratchpad())
  bind(settings.noteShortcut, () => void (recording ? stopDictation() : startVoiceNote()))
  // ⌥1..⌥9 (Alt+Shift+1..9 on Windows and Linux) apply transforms to the last dictation.
  for (let n = 1; n <= 9; n++) {
    bind(`${platform.transformModifier}+${n}`, () => {
      const t = transforms.bySlot(n)
      if (!t || !lastTranscript) return
      const out = transforms.apply(t, lastTranscript)
      lastTranscript = out
      const applied: TransformApplied | null = transforms.recordUse(t.id)
      if (applied) {
        broadcast('transforms:applied', applied)
        broadcast('transforms:changed', transforms.list())
      }
      notice({ kind: 'transform-applied', text: `Applied · ${t.name}`, name: t.name, holdMs: 1600 })
      deliver(out)
    })
  }
  // unregisterAll above also dropped a live Esc; put it back if it is still wanted.
  escRegistered = false
  syncEscape()
  log(`[flow] shortcuts bound: ${ok.join(', ')}${failed.length ? ` | FAILED: ${failed.join(', ')}` : ''}`)
  return { ok, failed }
}

/** Tells the helper how far to drop output volume while recording. Off where it cannot duck. */
function applyDuck(): void {
  stt.setDuck(settings.duckEnabled && stt.has('duck') ? settings.duckLevel : null)
}

/**
 * The hold key the helper is told: the user's, or the nearest one this
 * helper has (fn only exists on a Mac), or off when it has no hold key.
 */
function applyHoldKey(): void {
  stt.setHoldKey(effectiveHoldKey(settings.holdKey, stt.capabilities))
}

/** Calendar sync only runs where the helper has a calendar (macOS). */
function applyCalendar(): void {
  cal.configure(settings.calSync && stt.has('calendar'), settings.calId)
}

/** Which helper should run: QUILL_HELPER, then the setting; always Rust off macOS. */
const helperChoice = (): ReturnType<typeof chooseHelper> => chooseHelper(settings.helper)

/*
 * window.flow.platform(): what the renderer needs to hide or reword what does
 * not apply here (calendar sync, the fn key, ducking, the Accessibility step).
 */
export type PlatformInfo = {
  os: HostOS
  /** Capability ids of the running helper (docs/HELPER-PROTOCOL.md section 11.1). */
  capabilities: string[]
  /** Keycodes the hold key can be set to here. Empty: there is no hold key. */
  holdKeys: number[]
  /** Free-form detail per capability, e.g. { transcribe: 'metal' }. */
  notes: Record<string, string>
  helper: {
    /** The helper that is running. */
    kind: HelperKind
    /** QUILL_HELPER is set, so the `helper` setting is not in effect. */
    forced: boolean
    /** The helpers this OS has. One entry: nothing to switch. */
    choices: HelperKind[]
    /** Name and version, when the helper reported one. */
    name?: string
  }
  /** Side of the hub title bar the system draws its window buttons on. */
  windowControls: 'left' | 'right'
  /** Modifiers of the transform shortcuts: 'Alt' (macOS) or 'Alt+Shift'. */
  transformModifier: string
}
function platformInfo(): PlatformInfo {
  const caps: Capabilities = stt.capabilities
  const choice = helperChoice()
  return {
    os: platform.os,
    capabilities: caps.capabilities,
    holdKeys: caps.holdKeys,
    notes: caps.notes,
    helper: { kind: stt.helperKind, forced: choice.forced, choices: choice.choices, name: caps.helper },
    windowControls: platform.windowControls,
    transformModifier: platform.transformModifier
  }
}
// Synchronous for the preload, like win:is-shown: registered at load so it always answers.
ipcMain.on('platform:get', (e) => { e.returnValue = platformInfo() })

function applyModel(): void {
  if (!models.isInstalled(settings.model)) {
    broadcast('models:missing', settings.model)
    stt.setModel('')
    return
  }
  stt.setModel(models.pathFor(settings.model))
}

function buildTray(): void {
  const img = platform.trayImage()
  try {
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img)
  } catch (err) {
    // Linux without a status notifier host: no tray. Starting Quill again shows the hub.
    log(`[flow] no tray: ${(err as Error).message}`)
    return
  }
  tray.setToolTip('Quill')
  // Windows and Linux: a click opens the hub (macOS opens the menu, as menu bar items do).
  if (!platform.isMac) tray.on('click', () => void showHub())
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Quill', click: () => void showHub() },
    { type: 'separator' },
    { label: 'Start Dictation', accelerator: settings.toggleShortcut || undefined, click: () => void startDictation() },
    { label: 'New Voice Note', accelerator: settings.noteShortcut || undefined, click: () => void startVoiceNote() },
    { label: 'Stop Dictation', click: () => void stopDictation() },
    { type: 'separator' },
    { label: 'Check for Updates…', click: () => void promptIfNewer(process.env.FLOW_UPDATE_REPO ?? 'qruz-hq/quill', { force: true }) },
    { type: 'separator' },
    { label: 'Paste last transcript', click: () => { if (lastTranscript) clipboard.writeText(lastTranscript) } },
    { type: 'separator' },
    { label: 'Quit Quill', accelerator: 'CommandOrControl+Q', click: () => app.quit() }
  ]))
}
const stt = new SttEngine()
const models = new ModelStore()
const notes = new NoteStore()
const todos = new TodoStore()
const cal = new CalendarSync(stt, todos, (l) => log(l))
const snippets = new SnippetStore()
const transforms = new TransformStore()
const dictations = new DictationStore()
const cleanup = new Cleanup()
const elevenKey = new Secrets('elevenlabs', 'ELEVENLABS_API_KEY')

/* ---- Motion plumbing (docs/MOTION.md §5, §3.6, §6.5) ---- */

/**
 * The system's Reduce Motion, read fresh at every window creation (see
 * platform.reduceMotion). Reduce = NO animation at all.
 */
const reduceMotion = platform.reduceMotion

/**
 * Shared webPreferences. `--reduce-motion=1` lets the preload set
 * html[data-reduce-motion] before any CSS animation can start.
 */
function webPrefs(extra: Electron.WebPreferences = {}, args: string[] = []): Electron.WebPreferences {
  return {
    preload: join(__dirname, '../preload/index.js'),
    sandbox: false,
    ...extra,
    additionalArguments: [...(reduceMotion() ? ['--reduce-motion=1'] : []), ...args]
  }
}

/** Windows that have been told (or have asked and learned) that they are on screen. */
const shownWindows = new WeakSet<BrowserWindow>()

/** First-show entrances gate on this (useWindowShown). `first` is false on re-shows. */
function sendShown(win: BrowserWindow | null, first: boolean): void {
  if (!win || win.isDestroyed()) return
  shownWindows.add(win)
  win.webContents.send('win:shown', { first })
}

/*
 * The preload asks this synchronously before any page script runs, so a page
 * that subscribes to win:shown late (or was reloaded while on screen, or is
 * the Flow Bar, which is visible from creation) still knows it is shown.
 * Registered here, not in whenReady: sendSync must always get an answer.
 */
ipcMain.on('win:is-shown', (e) => {
  let shown: { first: boolean } | null = null
  try {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win && !win.isDestroyed() && win.isVisible()) {
      shown = { first: !shownWindows.has(win) }
      shownWindows.add(win)
    }
  } catch { /* answer null */ }
  e.returnValue = shown
})

/** The hub's first-launch entrance plays once per launch, even if the hub is recreated. */
let hubFirstShowDone = false

/** $bg per theme, so the hub never flashes the other theme before paint. */
const hubBg = platform.themeBg

function createHub(): BrowserWindow {
  const win = new BrowserWindow({
    ...HUB,
    show: false,
    // Traffic lights on macOS, caption buttons over the page's own title bar elsewhere.
    ...platform.hubChrome(),
    // $bg, so the window never flashes another colour before the page paints.
    // Kept in sync with nativeTheme 'updated' (see app.whenReady).
    backgroundColor: hubBg(),
    webPreferences: webPrefs({}, hubFirstShowDone ? ['--first-show-done=1'] : [])
  })

  win.on('ready-to-show', () => {
    win.show()
    sendShown(win, !hubFirstShowDone)
    hubFirstShowDone = true
  })
  win.on('closed', () => {
    if (hubWindow !== win) return
    hubWindow = null
    setPractice(false)
  })
  // Practice belongs to the page that asked for it. A reload, a navigation or
  // a dead renderer means that page is gone, so practice goes with it.
  win.webContents.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace && hubWindow === win) setPractice(false)
  })
  win.webContents.on('render-process-gone', () => { if (hubWindow === win) setPractice(false) })
  win.webContents.setWindowOpenHandler((d) => {
    shell.openExternal(d.url)
    return { action: 'deny' }
  })

  loadRoute(win, 'hub')
  return win
}

/** Right-aligned to the primary work area, vertically centred. Content anchors right-centre. */
function barBounds(): Electron.Rectangle {
  const { workArea } = screen.getPrimaryDisplay()
  const { width, height } = BAR
  return {
    width,
    height,
    x: workArea.x + workArea.width - width,
    y: workArea.y + Math.round((workArea.height - height) / 2)
  }
}

function createFlowBar(): BrowserWindow {
  const win = new BrowserWindow({
    ...barBounds(),
    ...platform.floatingChrome({ shadow: false }),
    resizable: false,
    movable: false,
    focusable: false,          // never steal focus from the app being dictated into
    acceptFirstMouse: true,
    // rAF and animations must run while the app is unfocused (the bar's normal case).
    webPreferences: webPrefs({ backgroundThrottling: false })
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  platform.showOnAllWorkspaces(win)
  // Click-through outside the shape: mouse moves are still forwarded to the
  // renderer, which hit-tests [data-hit] and answers on bar:hit. (Linux
  // cannot forward: pollBarCursor does the way in there.)
  barIgnoring = true
  barHit = false
  platform.ignoreMouse(win, true)
  // The bar is on screen from creation, so it is "shown" as soon as its page
  // can hear it. A reload gets a re-show.
  let loadedOnce = false
  win.webContents.on('did-finish-load', () => {
    if (win.isVisible()) sendShown(win, !loadedOnce)
    loadedOnce = true
  })
  // The backstop lives and dies with the window, so nothing ticks at 30 Hz
  // once the bar is gone.
  const poll = setInterval(pollBarCursor, 1000 / 30)
  win.on('closed', () => {
    clearInterval(poll)
    if (barWindow !== win) return
    barWindow = null
    // Nothing can claim the pointer any more: let go of Esc if the error card held it.
    barHit = false
    barEscWanted = false
    barShape = null
    barPollTicks = 0
    syncEscape()
  })

  loadRoute(win, 'flowbar')
  return win
}

/** The floating Scratchpad: a small always-available notepad, like the real app's. */
function openScratchpad(): void {
  if (padWindow && !padWindow.isDestroyed()) {
    // Asked for again while it plays its exit: let it close, then open afresh.
    if (padCloseTimer) { padReopen = true; return }
    const wasVisible = padWindow.isVisible()
    padWindow.show(); padWindow.focus()
    if (!wasVisible) sendShown(padWindow, false)
    return
  }
  const { workArea } = screen.getPrimaryDisplay()
  padWindow = new BrowserWindow({
    ...PAD,
    x: workArea.x + workArea.width - PAD.width - 70,
    y: workArea.y + Math.round((workArea.height - PAD.height) / 2),
    show: false,
    ...platform.floatingChrome({ shadow: true }),
    resizable: true,
    minWidth: 460,
    minHeight: 320,
    webPreferences: webPrefs({ backgroundThrottling: false })
  })
  const pad = padWindow
  platform.showOnAllWorkspaces(pad)
  pad.once('ready-to-show', () => { pad.show(); pad.focus(); sendShown(pad, true) })
  // Every close (the button, ⌘W, the last tab, a native close) goes through
  // the renderer's exit first. App quit closes at once.
  pad.on('close', (e) => {
    if (quitting || padCloseApproved || padWindow !== pad) return
    e.preventDefault()
    requestPadClose()
  })
  pad.on('closed', () => {
    if (padWindow !== pad) return
    padWindow = null
    padCloseApproved = false
    if (padCloseTimer) { clearTimeout(padCloseTimer); padCloseTimer = null }
    if (padReopen) { padReopen = false; openScratchpad() }
  })
  loadRoute(pad, 'scratchpad')
}

/*
 * Scratchpad close handshake (docs/MOTION.md §4.9, §6.5 #5): main sends
 * pad:will-close {seq}, the renderer plays its exit and answers
 * pad:closed {seq}, and main closes the window. The timeout closes it anyway,
 * so a hung renderer can never keep it open. A preload with no subscriber
 * answers at once, so the close is immediate until the renderer adopts it.
 */
let padCloseSeq = 0
let padCloseTimer: ReturnType<typeof setTimeout> | null = null
/** The next `close` event is the real one. */
let padCloseApproved = false
/** openScratchpad arrived during the exit. */
let padReopen = false

function closePadNow(): void {
  if (padCloseTimer) { clearTimeout(padCloseTimer); padCloseTimer = null }
  const w = padWindow
  if (!w || w.isDestroyed()) return
  padCloseApproved = true
  w.close()
}

function requestPadClose(): void {
  const w = padWindow
  if (!w || w.isDestroyed() || padCloseTimer) return
  // Never reached the screen: there is nothing to animate.
  if (!w.isVisible()) { closePadNow(); return }
  const seq = ++padCloseSeq
  padCloseTimer = setTimeout(() => { if (seq === padCloseSeq) closePadNow() }, CLOSE_TIMEOUT_MS)
  w.webContents.send('pad:will-close', { seq })
}

/** `seq` from a handshake answer, sent as {seq} or as the bare number. */
const seqOf = (p: unknown): number =>
  typeof p === 'number' ? p : Number((p as { seq?: unknown } | null)?.seq)

/**
 * Opens beside the left edge with the cursor already inside it. Shown without
 * focus: resting on the edge should not yank the keyboard away from whatever
 * you were typing in, a click on the composer takes focus when you want it.
 */
function openTodos(cursor?: { x: number; y: number }): void {
  if (todosWindow && !todosWindow.isDestroyed()) {
    // Asked for again while it plays its exit: call the exit off.
    if (cancelTodosClose()) return
    const wasVisible = todosWindow.isVisible()
    todosWindow.showInactive()
    if (!wasVisible) sendShown(todosWindow, false)
    return
  }
  const display = cursor ? screen.getDisplayNearestPoint(cursor) : screen.getPrimaryDisplay()
  const { workArea } = display
  const cy = cursor?.y ?? workArea.y + workArea.height / 2
  const y = Math.max(workArea.y + 8, Math.min(cy - 60, workArea.y + workArea.height - TODOS.height - 8))
  todosWindow = new BrowserWindow({
    ...TODOS,
    x: workArea.x + 8,
    y: Math.round(y),
    show: false,
    ...platform.floatingChrome({ shadow: true }),
    resizable: false,
    webPreferences: webPrefs({ backgroundThrottling: false })
  })
  const tw = todosWindow
  todosBaseY = Math.round(y)
  platform.showOnAllWorkspaces(tw)
  tw.once('ready-to-show', () => { tw.showInactive(); sendShown(tw, true) })
  tw.on('closed', () => {
    if (todosWindow !== tw) return
    todosWindow = null
    if (todosCloseTimer) { clearTimeout(todosCloseTimer); todosCloseTimer = null }
    edge.attach(null)
  })
  edge.attach(tw)
  loadRoute(tw, 'todos')
}

/** y the Todos window opened at, restored when the date picker closes. */
let todosBaseY = 0

/**
 * The date picker needs 640 of height. Grow downward; if the work area has no
 * room below, shift up just enough. Closing restores the original box.
 */
function setTodosPicker(open: boolean): void {
  const w = todosWindow
  if (!w || w.isDestroyed()) return
  const b = w.getBounds()
  const { workArea } = screen.getDisplayMatching(b)
  if (open) {
    const h = TODOS_PICKER_HEIGHT
    const y = Math.max(workArea.y + 8, Math.min(b.y, workArea.y + workArea.height - h - 8))
    if (b.height !== h || b.y !== y) w.setBounds({ x: b.x, y, width: b.width, height: h }, false)
  } else if (b.height !== TODOS.height) {
    // The cursor is usually in the part that is about to disappear. The edge
    // watcher keeps treating the tall box as inside until the cursor moves
    // out of it, so closing the picker never closes an unpinned panel.
    edge.holdBounds(b)
    w.setBounds({ x: b.x, y: todosBaseY, width: b.width, height: TODOS.height }, false)
  }
}

/*
 * Todos close handshake (docs/MOTION.md §4.12, §6.5 #4): main sends
 * todos:will-close {seq}, the renderer plays its exit and answers
 * todos:closed {seq}, and main closes the window if that seq is still the
 * current one. The timeout closes it anyway. If the cursor comes back during
 * the exit, main sends todos:cancel-close {seq} and bumps the seq, so the
 * answer to the cancelled exit is stale and ignored. A preload with no
 * subscriber answers at once, so the close is immediate until the renderer
 * adopts it.
 */
let todosCloseSeq = 0
let todosCloseTimer: ReturnType<typeof setTimeout> | null = null

function closeTodosNow(): void {
  if (todosCloseTimer) { clearTimeout(todosCloseTimer); todosCloseTimer = null }
  if (todosWindow && !todosWindow.isDestroyed()) todosWindow.close()
}

function closeTodos(): void {
  const w = todosWindow
  if (!w || w.isDestroyed() || todosCloseTimer) return
  if (quitting || !w.isVisible()) { closeTodosNow(); return }
  const seq = ++todosCloseSeq
  todosCloseTimer = setTimeout(() => { if (seq === todosCloseSeq) closeTodosNow() }, CLOSE_TIMEOUT_MS)
  edge.beginClose()
  w.webContents.send('todos:will-close', { seq })
}

/** Calls a running exit off. False when none was running. */
function cancelTodosClose(): boolean {
  if (!todosCloseTimer) return false
  clearTimeout(todosCloseTimer)
  todosCloseTimer = null
  const seq = todosCloseSeq++
  edge.endClose()
  if (todosWindow && !todosWindow.isDestroyed()) todosWindow.webContents.send('todos:cancel-close', { seq })
  return true
}

const edge = new EdgeDwell({
  open: (cursor) => openTodos(cursor),
  close: () => closeTodos(),
  reenter: () => { cancelTodosClose() },
  log: (l) => log(l)
})

function loadRoute(win: BrowserWindow, route: 'hub' | 'flowbar' | 'scratchpad' | 'todos'): void {
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    console.log(`[${route}:${level}] ${message}  (${source}:${line})`)
  })
  win.webContents.on('preload-error', (_e, path, err) => {
    console.error(`[${route}] PRELOAD ERROR ${path}:`, err.message)
  })
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/${route}.html`)
  } else {
    win.loadFile(join(__dirname, `../renderer/${route}.html`))
  }
}

app.whenReady().then(() => {
  if (secondInstance) return
  app.on('second-instance', () => void showHub())
  electronApp.setAppUserModelId('studio.saudad.quill')
  // Windows and Linux: no menu bar. The hub is frameless, so the default menu
  // would only show up as a strip when Alt is pressed. macOS keeps its app menu.
  if (!platform.isMac) Menu.setApplicationMenu(null)
  app.on('browser-window-created', (_, w) => {
    optimizer.watchWindowShortcuts(w)
    w.webContents.on('render-process-gone', (_e, d) => log(`[crash] ${w.webContents.getURL().split('/').pop()} renderer gone: ${d.reason} (exit code ${d.exitCode})`))
    w.on('unresponsive', () => log(`[crash] ${w.webContents.getURL().split('/').pop()} window not responding`))
  })
  // The GPU, network and utility processes: a crash there blanks windows or
  // ends the app with nothing in the log otherwise.
  app.on('child-process-gone', (_e, d) => log(`[crash] ${d.type}${d.name ? ` (${d.name})` : ''} process gone: ${d.reason} (exit code ${d.exitCode})`))

  hubWindow = createHub()
  barWindow = createFlowBar()

  /* ---- Flow Bar: fixed window, click-through outside the shape (§4.1.1) ---- */
  // `escape`: the pointer is over the error card, so Esc should dismiss it.
  ipcMain.on('bar:hit', (_e, hit: boolean, opts?: { escape?: boolean }) => {
    barHit = !!hit
    barEscWanted = barHit && !!opts?.escape
    if (barIgnoring === !barHit) { syncEscape(); return }
    setBarIgnore(!barHit)
    syncEscape()
  })
  ipcMain.on('bar:shape-rect', (_e, r: { x: number; y: number; width: number; height: number } | null) => {
    barShape = r && [r.x, r.y, r.width, r.height].every(Number.isFinite) ? r : null
  })
  // Display or work-area change: reposition instantly; DOM springs continue in window coordinates.
  const placeBar = (): void => { if (barWindow && !barWindow.isDestroyed()) barWindow.setBounds(barBounds(), false) }
  screen.on('display-metrics-changed', placeBar)
  screen.on('display-added', placeBar)
  screen.on('display-removed', placeBar)

  /* ---- Reduce Motion, live (§5 detection 3) ---- */
  let lastReduced = reduceMotion()
  ipcMain.handle('motion:reduced', () => reduceMotion())
  try {
    platform.watchReduceMotion(() => {
      const v = reduceMotion()
      if (v === lastReduced) return
      lastReduced = v
      broadcast('motion:reduced', v)
    })
  } catch (err) { log(`[motion] reduce-motion watch unavailable: ${(err as Error).message}`) }

  /* ---- Hub background follows the theme (no light flash in dark) ---- */
  nativeTheme.on('updated', () => {
    if (hubWindow && !hubWindow.isDestroyed()) platform.applyHubTheme(hubWindow)
  })

  /* ---- Global shortcut ---- */
  // Bare `fn` cannot be bound through globalShortcut; it needs a native event
  // tap. This is the bindable stand-in until that lands.
  applyShortcuts()

  /* ---- Dictation ---- */
  ipcMain.handle('dictation:start', async () => startDictation())
  ipcMain.handle('dictation:stop', async () => stopDictation())
  ipcMain.handle('dictation:cancel', async () => cancelDictation())
  ipcMain.handle('dictation:retry', async () => retryDictation())
  ipcMain.handle('dictation:latched', () => latched)
  // Only the hub may turn practice on; anything may turn it off.
  ipcMain.on('dictation:set-practice', (e, on: boolean) => {
    if (on && (!hubWindow || hubWindow.isDestroyed() || e.sender !== hubWindow.webContents)) return
    setPractice(!!on)
  })
  ipcMain.handle('dictation:practice', () => practice)

  // Local whisper partials carry the whole hypothesis so far, like the stream's.
  stt.on('partial', (text: string) => queuePartial(text))
  stt.on('transcribing', () => broadcast('dictation:stage', 'transcribing'))
  stt.on('level', (level) => broadcast('dictation:level', level))
  stt.on('error', (msg: string) => dictationError(msg))
  stt.on('devices', (list) => broadcast('mic:devices', list))
  stt.on('mic-test-level', (level) => broadcast('mic:test-level', level))
  // Low to high pitch, while dictating or testing. Only the hub draws it.
  stt.on('spectrum', (bands) => { if (hubWindow && !hubWindow.isDestroyed()) hubWindow.webContents.send('mic:spectrum', bands) })
  stt.on('mic-test', (t) => broadcast('mic:test', t))
  // The mic went away mid-recording and nothing else would open: end the
  // dictation with what was captured, as if the key had been released.
  stt.on('interrupted', () => {
    log('[stt] microphone lost mid-recording, finishing early')
    void stopDictation()
  })
  stt.on('inserted', (chars) => console.log('[flow] inserted', chars, 'chars'))
  stt.on('hotkey', (intent: HotkeyIntent, isLatched: boolean) => {
    if (intent === 'stop') { void stopDictation(); return }
    // The press turned out not to be a dictation (a quick tap, fn with
    // another key). Only a recording the hold key started is its to drop.
    if (intent === 'cancel') { if (recordingByHotkey) cancelDictation(); return }
    if (!isLatched) { void startDictation(true); return }
    // Second tap of a double-tap: the first one already started the recording.
    // If nothing is recording after all, the helper must not stay latched.
    void startDictation(true).then(() => { if (recording) setLatched(true); else stt.unlatch() })
  })
  // The microphone never opened, so this recording is over before it began.
  stt.on('start-failed', (message: string) => {
    log(`[stt] recording did not start: ${message}`)
    dictationError(message, 'mic')
    if (recording) abortRecording()
  })
  // stderr and process notes: for the log, never for the windows.
  stt.on('log', (line: string) => log(`[stt] ${line}`))
  // The helper is gone. Nothing it was recording or transcribing will come
  // back, and the hold key lives in it, so it is started again without
  // waiting for the next dictation.
  stt.on('exited', (e: { expected: boolean; busy: boolean; why: string }) => {
    if (quitting || e.expected) return
    log(`[stt] helper ${e.why}${e.busy ? ' while busy' : ''}`)
    // A level test cannot outlive it either.
    broadcast('mic:test', { state: 'ended' })
    if (recording) {
      announceHelperGone()
      abortRecording()
    } else if (e.busy) {
      // A stop or retry was waiting: its rejection reports through
      // failDictation, which shares the one announcement.
      lastRun = null
    }
    // Respawn (onSpawn re-sends every setting), unless it keeps dying at once.
    // After that the next dictation still tries, through ensureProcess.
    const now = Date.now()
    helperCrashes = helperCrashes.filter((t) => now - t < 60_000)
    helperCrashes.push(now)
    if (helperCrashes.length > 3) { log('[stt] helper keeps exiting, not restarting it for now'); return }
    setTimeout(() => { if (!quitting) stt.warmup() }, 500)
  })
  // A missing grant is the onboarding screen's and the hub banner's to show,
  // not an error at launch. A refused tap is retried by the helper, so it is
  // reported once rather than on every attempt.
  let tapFailReported = false
  stt.on('hotkey-status', (ok: boolean, reason?: string) => {
    log(`[flow] hold key installed: ${ok}${reason ? ` (${reason})` : ''}`)
    if (ok) { tapFailReported = false; return }
    if (reason === 'accessibility') { broadcast('perms:changed', permissions()); return }
    if (tapFailReported) return
    tapFailReported = true
    dictationError(`The hold key could not start yet; Quill keeps trying. ${accelLabel(settings.toggleShortcut)} works meanwhile.`)
  })

  settings = loadSettings()
  axSeen = platform.accessibilityTrusted()
  // Before the first spawn. QUILL_HELPER=rust|swift beats the setting.
  stt.setHelperKind(helperChoice().kind)
  log(`[flow] ${platform.os}, helper: ${helperChoice().kind}${helperChoice().forced ? ' (QUILL_HELPER)' : ''}`)

  // What the helper can do arrives just after its boot (the Swift helper
  // sends nothing and keeps the macOS assumption). Settings that depend on
  // it were sent on the assumption, so they go again when it differs.
  stt.on('capabilities', (caps: Capabilities) => {
    log(`[stt] ${caps.helper ?? 'helper'} on ${caps.platform}: ${caps.capabilities.join(' ')}` +
        `${caps.holdKeys.length ? ` | hold keys ${caps.holdKeys.join(',')}` : ''}` +
        `${Object.keys(caps.notes).length ? ` | ${JSON.stringify(caps.notes)}` : ''}`)
    applyHoldKey()
    applyDuck()
    applyCalendar()
    broadcast('platform:changed', platformInfo())
  })

  // Set this to your repo to enable update checks. Empty disables them.
  const UPDATE_REPO = process.env.FLOW_UPDATE_REPO ?? 'qruz-hq/quill'
  if (UPDATE_REPO) {
    const ask = (force = false): Promise<unknown> =>
      promptIfNewer(UPDATE_REPO, {
        skippedVersion: settings.skippedVersion,
        onSkip: (v) => { settings = { ...settings, skippedVersion: v }; saveSettings(settings) },
        force
      })

    // A moment after launch, so it does not fight the window appearing.
    setTimeout(() => void ask(), 4000)
    setInterval(() => void ask(), 6 * 60 * 60 * 1000)

    ipcMain.handle('updates:check', () => checkForUpdate(UPDATE_REPO))
    // "Check now" from Settings always asks, even for a skipped version.
    ipcMain.handle('updates:prompt', () => ask(true))
  } else {
    ipcMain.handle('updates:check', () => ({ current: app.getVersion(), newer: false }))
    ipcMain.handle('updates:prompt', () => ({ current: app.getVersion(), newer: false }))
  }
  // A retired model left selected transcribes nothing and gives no clue why,
  // so clear the file and move the setting to its replacement.
  const retired = models.sweepRetired()
  if (retired.removed.length) {
    log(`[models] removed retired ${retired.removed.join(', ')} (${(retired.bytes / 1e6).toFixed(0)}MB)`)
  }
  if (RETIRED[settings.model]) {
    const to = RETIRED[settings.model] as Settings['model']
    log(`[models] ${settings.model} is retired, switching to ${to}`)
    settings = { ...settings, model: to }
    saveSettings(settings)
  }
  const swept = models.sweepPartials()
  if (swept.removed.length) {
    log(`[flow] cleared ${swept.removed.length} interrupted download(s), ${(swept.bytes / 1e6).toFixed(0)} MB`)
  }
  cleanup.warm()   // open the TLS connection before the first dictation
  buildTray()
  // Every helper, the first and any respawn after a crash, gets the full
  // configuration, or a restarted one would quietly run on defaults.
  stt.onSpawn = () => {
    applyModel()
    stt.setLanguage(settings.languages)
    applyDuck()
    applyHoldKey()
    stt.setMic(settings.micUid)
    stt.setEngine(settings.sttEngine)
    stt.setStreaming(streamingWanted())
    // A respawn starts from the assumed capabilities again.
    broadcast('platform:changed', platformInfo())
  }
  // Start the helper now so the fn event tap is live before first use.
  stt.warmup()
  platform.setOpenAtLogin(settings.launchAtLogin)
  edge.setEnabled(settings.todoEdge)
  edge.start()
  applyCalendar()
  log(`[flow] open at login: want=${settings.launchAtLogin} os=${platform.opensAtLogin()}`)

  // Cloud transcription: upload the recording, fall back to local on failure so
  // a dropped connection never costs a dictation.
  stt.audioHandler = async (path, seconds, tag) => {
    // Streaming path: the audio is already uploaded, so this is just the commit.
    // The stream is the one this recording fed, never another recording's.
    const run = tag as Run | undefined
    // A practice run shows nothing but its pill: no fallback notices either.
    const tell = (n: Notice): void => { if (!run?.practice) notice(n) }
    const s = run?.stream ?? null
    if (s && !endedStreams.has(s)) {
      if (chunkOwner === s) { stt.chunkHandler = null; chunkOwner = null }
      const tCommit = Date.now()
      const streamed = await s.finish()
      log(`[stream] commit ${Date.now() - tCommit}ms for ${seconds.toFixed(1)}s` +
          `${streamed ? '' : ` EMPTY${s.error ? ` (${s.error})` : ''}`}`)
      if (streamed) {
        discard(path)
        return streamed
      }
      // Nothing came back, fall through to the batch upload, which still has
      // the WAV, so a dead socket costs latency rather than the dictation. No
      // error is surfaced: the retry is silent and usually succeeds, and an
      // empty commit most often just means nothing was said.
    }

    const provider = settings.sttProvider
    const key = provider === 'elevenlabs' ? elevenKey.get() : cleanup.rawKey()
    if (!key) {
      log(`[stt] cloud selected but no ${provider} key, falling back to local`)
      tell({
        kind: 'key-fallback',
        text: `No ${provider === 'elevenlabs' ? 'ElevenLabs' : 'OpenAI'} key, using the local model`,
        short: 'LOCAL MODEL',
        holdMs: 4000
      })
      return null
    }
    // The batch endpoint has no live models: a failed stream of one is redone
    // with the model that stands in for it.
    const model = provider === 'openai' ? openaiBatchModel(settings.sttModel) : settings.sttModel
    const r = await transcribeCloud(path, key, model, settings.languages, provider, settings.sttNoVerbatim)
    log(`[stt] ${provider}/${model}: ${r.ms}ms for ${seconds.toFixed(1)}s ` +
        `(${audioSizeMB(path).toFixed(1)}MB)${r.error ? ` FAILED: ${r.error}` : ''}`)
    if (r.error) {
      tell({
        kind: 'cloud-fallback',
        text: 'Cloud transcription failed, using the local model',
        short: 'CLOUD FAILED · LOCAL',
        detail: r.error,
        holdMs: 4000
      })
      return null                      // helper retries locally, keeps the file
    }
    discard(path)
    return r.text
  }

  models.on('progress', (p) => broadcast('models:progress', p))
  models.on('done', (d: { id: ModelId }) => {
    // The selected model just arrived: point the helper at it now, so the
    // next dictation works without a restart or a settings change.
    if (d.id === settings.model) applyModel()
    broadcast('models:done', d)
    broadcast('models:list', models.list())
  })
  // Sent by the store, once per download, whoever asked for it and whether or
  // not that window is still open.
  models.on('failed', (e: { id: ModelId; message: string }) => {
    broadcast('models:error', e)
    broadcast('models:list', models.list())
  })
  models.on('cancelled', (d) => broadcast('models:cancelled', d))

  /* ---- Scratchpad ---- */
  ipcMain.on('pad:open', () => openScratchpad())
  ipcMain.handle('voicenote:start', async () => startVoiceNote())
  ipcMain.on('pad:close', () => requestPadClose())
  ipcMain.on('pad:closed', (_e, p: unknown) => { if (padCloseTimer && seqOf(p) === padCloseSeq) closePadNow() })
  ipcMain.on('pad:expand', () => {
    if (!padWindow) return
    padWindow.isMaximized() ? padWindow.unmaximize() : padWindow.maximize()
  })
  ipcMain.handle('notes:list', () => notes.list())
  ipcMain.handle('notes:create', () => notes.create())
  ipcMain.handle('notes:update', (_e, id: string, patch: { title?: string; body?: string }) => {
    const n = notes.update(id, patch)
    broadcast('notes:changed', notes.list())
    return n
  })
  ipcMain.handle('notes:remove', (_e, id: string) => {
    notes.remove(id)
    broadcast('notes:changed', notes.list())
    return notes.list()
  })

  /* ---- Todos ---- */
  const todosChanged = (): void => broadcast('todos:changed', todos.list())
  // The calendar follows the todo; the todo never waits for the calendar.
  const syncLater = (t: Todo | null | undefined): void => {
    if (!t) return
    void cal.sync(t).then(todosChanged)
  }
  ipcMain.handle('todos:list', () => todos.list())
  ipcMain.handle('todos:add', (_e, input: { title: string; description?: string; due?: string | null; time?: string | null }) => {
    const t = todos.add(input)
    todosChanged()
    syncLater(t)
    return t
  })
  ipcMain.handle('todos:update', (_e, id: string, patch: TodoPatch) => {
    const t = todos.update(id, patch)
    todosChanged()
    syncLater(t)
    return t
  })
  ipcMain.handle('todos:remove', (_e, id: string) => {
    const t = todos.list().find((x) => x.id === id)
    todos.remove(id)
    todosChanged()
    if (t?.eventId && stt.has('calendar')) void cal.removeEvent(t.eventId, t.title)
  })
  ipcMain.handle('todos:reorder', (_e, ids: string[]) => { todos.reorder(ids); todosChanged() })
  ipcMain.handle('todos:clearDone', () => {
    const gone = todos.clearDone()
    todosChanged()
    if (stt.has('calendar')) for (const t of gone) if (t.eventId) void cal.removeEvent(t.eventId, t.title)
    return gone.length
  })

  /* ---- Calendar ---- */
  // Without the `calendar` capability (Windows, Linux) these answer as an
  // unknown, empty calendar without asking the helper.
  ipcMain.handle('cal:status', () => (stt.has('calendar') ? cal.status() : 'unknown'))
  ipcMain.handle('cal:request', () => (stt.has('calendar') ? cal.requestAccess() : 'unknown'))
  ipcMain.handle('cal:calendars', () => (stt.has('calendar') ? cal.calendars() : []))
  ipcMain.handle('cal:backfill', async () => {
    if (!stt.has('calendar')) return 0
    const n = await cal.backfill(); todosChanged(); return n
  })
  ipcMain.on('cal:openSettings', () => platform.openPrivacySettings('calendar'))
  ipcMain.handle('todos:projects', () => todos.projects())
  ipcMain.handle('todos:collapsed', () => todos.collapsedProjects())
  ipcMain.handle('todos:collapse', (_e, project: string, v: boolean) => {
    todos.setCollapsed(project, v)
    return todos.collapsedProjects()
  })
  ipcMain.on('todos:open', () => openTodos())
  ipcMain.on('todos:picker', (_e, open: boolean) => setTodosPicker(!!open))
  ipcMain.on('todos:close', () => closeTodos())
  ipcMain.on('todos:closed', (_e, p: unknown) => { if (todosCloseTimer && seqOf(p) === todosCloseSeq) closeTodosNow() })
  ipcMain.handle('todos:pin', (_e, v: boolean) => { edge.setPinned(v); return edge.isPinned })
  ipcMain.handle('todos:pinned', () => edge.isPinned)

  /* ---- Cloud cleanup ---- */
  ipcMain.handle('cleanup:status', () => ({
    hasKey: cleanup.hasKey(),
    masked: cleanup.maskedKey()
  }))
  ipcMain.handle('cleanup:setKey', (_e, key: string) => {
    try {
      cleanup.setKey(key)
      // The same key gates OpenAI streaming.
      stt.setStreaming(streamingWanted())
      return { ok: true, masked: cleanup.maskedKey() }
    } catch (err) { return { ok: false, message: (err as Error).message } }
  })
  ipcMain.handle('cleanup:clearKey', () => {
    cleanup.clearKey()
    stt.setStreaming(streamingWanted())
    return { hasKey: false }
  })
  ipcMain.handle('cleanup:verify', (_e, model: string) => cleanup.verify(model))
  ipcMain.handle('cleanup:models', () => cleanup.listModels())

  /* ---- ElevenLabs key ---- */
  ipcMain.handle('eleven:status', () => ({ hasKey: elevenKey.has(), masked: elevenKey.masked() }))
  ipcMain.handle('eleven:setKey', (_e, k: string) => {
    try {
      elevenKey.set(k)
      // The key gates streaming, and the helper only ships chunks when told to.
      stt.setStreaming(streamingWanted())
      return { ok: true, masked: elevenKey.masked() }
    } catch (err) { return { ok: false, message: (err as Error).message } }
  })
  ipcMain.handle('eleven:clearKey', () => {
    elevenKey.clear()
    stt.setStreaming(streamingWanted())
    return { hasKey: false }
  })

  // Just the local OS user, there is no account system in this app.
  ipcMain.handle('system:user', () => {
    const raw = userInfo().username || ''
    return { name: raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : '' }
  })

  /* ---- Dictation history + insights ---- */
  ipcMain.handle('dictations:list', () => dictations.list())
  ipcMain.handle('dictations:insights', () => dictations.insights())
  ipcMain.handle('dictations:remove', (_e, id: string) => { dictations.remove(id); return dictations.list() })
  ipcMain.handle('dictations:flag', (_e, id: string, flagged: boolean) => { dictations.update(id, { flagged }); return dictations.list() })
  // Audio is not kept, so a retry re-runs AI cleanup and snippets on the saved text.
  ipcMain.handle('dictations:retry', async (_e, id: string) => {
    const d = dictations.get(id)
    if (d && !d.failed && d.text.trim()) {
      const { text: polished, note } = await cleanup.run(d.text, {
        enabled: settings.aiEnabled,
        model: settings.aiModel,
        deadlineMs: settings.aiDeadlineMs,
        fixMishearings: settings.aiFixMishearings
      })
      if (note.startsWith('failed') || note.startsWith('empty')) broadcast('cleanup:error', note)
      const { text } = snippets.apply(polished)
      if (text !== d.text) { dictations.update(id, { text }); lastTranscript = text }
    }
    return dictations.list()
  })

  /* ---- Snippets ---- */
  ipcMain.handle('snippets:list', () => snippets.list())
  ipcMain.handle('snippets:save', (_e, patch) => { snippets.save(patch); return snippets.list() })
  ipcMain.handle('transforms:last', () => transforms.lastApplied())
  ipcMain.handle('snippets:remove', (_e, id: string) => { snippets.remove(id); return snippets.list() })

  /* ---- Transforms ---- */
  ipcMain.handle('transforms:list', () => transforms.list())
  ipcMain.handle('transforms:save', (_e, patch) => { transforms.save(patch); return transforms.list() })
  ipcMain.handle('transforms:remove', (_e, id: string) => { transforms.remove(id); return transforms.list() })
  ipcMain.handle('transforms:preview', (_e, id: string, sample: string) => {
    const t = transforms.list().find((x) => x.id === id)
    return t ? transforms.apply(t, sample) : sample
  })


  ipcMain.handle('models:list', () => models.list())
  ipcMain.handle('models:download', async (_e, id: ModelId) => {
    await models.download(id)
    return models.list()
  })
  ipcMain.handle('models:cancel', (_e, id: ModelId) => { models.cancel(id); return models.list() })
  ipcMain.handle('models:remove', (_e, id: ModelId) => {
    models.remove(id)
    // Fall back to any model still on disk so dictation keeps working.
    if (settings.model === id) {
      const next = models.list().find((m) => m.installed)
      // Nothing else on disk: go back to the default, which setup offers to
      // download, not to a model the user never chose.
      settings = { ...settings, model: (next?.id ?? DEFAULTS.model) as ModelId }
      saveSettings(settings)
      applyModel()
    }
    return models.list()
  })

  /* ---- Permissions ---- */
  ipcMain.handle('perms:status', () => permissions())
  ipcMain.handle('perms:pending', () => { const p = permsPending; permsPending = false; return p })
  ipcMain.handle('perms:requestMic', async () => {
    // Only prompts while undecided (macOS); once refused, only the system's settings can change it.
    if (platform.micAccess() === 'not-determined') {
      await platform.askMicAccess()
    } else {
      platform.openPrivacySettings('mic')
    }
    return permissions()
  })
  ipcMain.handle('perms:requestAx', () => {
    // The system dialog has its own "Open System Settings" button, but only
    // shows while Quill is not yet in the list; after that the screen opens
    // the pane itself through perms:open.
    platform.accessibilityTrusted(true)
    return permissions()
  })
  ipcMain.on('perms:open', (_e, which: 'mic' | 'ax') => {
    platform.openPrivacySettings(which)
  })

  ipcMain.handle('mic:devices', () => { stt.refreshDevices(); return stt.devices })
  // A short, on-demand level check. Never left open: an open mic keeps a
  // Bluetooth headset in its call profile.
  ipcMain.on('mic:test', (_e, on: boolean) => {
    if (!on) { stt.testMic(false); return }
    const mic = platform.micAccess()
    if (recording || (mic !== 'granted' && mic !== 'unknown')) {
      broadcast('mic:test', { state: 'ended' })
      if (!recording) showPermissions()
      return
    }
    stt.testMic(true)
  })

  ipcMain.handle('settings:get', () => settings)
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
    settings = { ...settings, ...patch }
    saveSettings(settings)
    if (patch.model !== undefined) applyModel()
    if (patch.languages !== undefined) stt.setLanguage(patch.languages)
    if (patch.duckEnabled !== undefined || patch.duckLevel !== undefined) applyDuck()
    if (patch.holdKey !== undefined) applyHoldKey()
    if (patch.micUid !== undefined) stt.setMic(patch.micUid)
    if (patch.launchAtLogin !== undefined) platform.setOpenAtLogin(patch.launchAtLogin)
    if (patch.todoEdge !== undefined) edge.setEnabled(patch.todoEdge)
    if (patch.calSync !== undefined || patch.calId !== undefined) applyCalendar()
    if (patch.helper !== undefined) switchHelper()
    if (patch.sttEngine !== undefined) stt.setEngine(patch.sttEngine)
    // Provider, key and engine all gate streaming, so re-evaluate on any change.
    stt.setStreaming(streamingWanted())
    if (patch.toggleShortcut !== undefined || patch.padShortcut !== undefined || patch.noteShortcut !== undefined) {
      const r = applyShortcuts()
      if (r.failed.length) broadcast('shortcuts:failed', r.failed)
    }
    return settings
  })

  ipcMain.handle('platform:info', () => platformInfo())

  ipcMain.on('hub:show', () => void showHub())

  // Flow Bar "Change model" and friends: bring the hub up on a Settings pane.
  // A freshly created hub collects it on mount through hub:pending-settings.
  ipcMain.on('hub:open-settings', (_e, pane?: string) => {
    const existing = !!hubWindow && !hubWindow.isDestroyed()
    settingsPending = existing ? null : (pane ?? 'dictation')
    void showHub().then((win) => { if (!win.isDestroyed()) win.webContents.send('hub:open-settings', pane ?? 'dictation') })
  })
  ipcMain.handle('hub:pending-settings', () => { const p = settingsPending; settingsPending = null; return p })

  app.on('activate', () => {
    void showHub()
  })
})

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string))
}

function broadcast(channel: string, payload: unknown): void {
  if (channel === 'dictation:error') {
    payload = userError(payload)
    if (!payload) return
  }
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('before-quit', () => {
  quitting = true
  stt.dispose()
})

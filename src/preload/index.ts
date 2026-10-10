import { contextBridge, ipcRenderer } from 'electron'

type Prefs = {
  model: string; languages: string[]
  duckEnabled: boolean; duckLevel: number
  aiEnabled: boolean; aiModel: string; aiMinWords: number; aiDeadlineMs: number; aiFixMishearings: boolean
  sttEngine: 'local' | 'cloud'; sttProvider: 'openai' | 'elevenlabs'; sttModel: string
  sttStreaming: boolean; sttNoVerbatim: boolean
  launchAtLogin: boolean; todoEdge: boolean; calSync: boolean; calId: string
  holdKey: number; micUid: string; toggleShortcut: string; padShortcut: string; noteShortcut: string
  onboarded: boolean
  /**
   * Which native helper runs on macOS: 'swift' (the default) or 'rust'. Takes
   * effect at once. Ignored on Windows and Linux (always 'rust') and while
   * platform().helper.forced is true.
   */
  helper: HelperKind
}
export type HostOS = 'macos' | 'windows' | 'linux'
export type HelperKind = 'swift' | 'rust'
/**
 * Capability ids of the native helper (docs/HELPER-PROTOCOL.md section 11.1).
 * The ones a page is likely to ask about: 'hotkey' (the hold key), 'insert'
 * (typing into other apps), 'accessibility' (the macOS grant and its
 * onboarding step), 'duck' (lowering the volume while recording), 'calendar'
 * (calendar sync), 'transcribe' (local whisper), 'partials'.
 */
export type Capability = string
/** platform(). What this OS and its helper can do, so pages can hide or reword the rest. */
export type PlatformInfo = {
  os: HostOS
  capabilities: Capability[]
  /**
   * Keycodes the hold key can be set to here (macOS virtual keycodes on every
   * OS; 63, fn, only on a Mac). Empty: there is no hold key, only the shortcuts.
   */
  holdKeys: number[]
  /** Free-form detail per capability, e.g. { transcribe: 'metal' }. */
  notes: Record<string, string>
  helper: {
    /** The helper that is running. */
    kind: HelperKind
    /** QUILL_HELPER is set, so the `helper` setting is not in effect. */
    forced: boolean
    /** The helpers this OS has. A single entry means there is nothing to switch. */
    choices: HelperKind[]
    /** Name and version, when the helper reported one. */
    name?: string
  }
  /**
   * Side of the hub title bar the system draws its window buttons on: 'left'
   * is the macOS traffic lights; 'right' is the Windows and Linux caption
   * buttons, drawn over the page, so keep content out of
   * env(titlebar-area-x) + env(titlebar-area-width) .. 100vw.
   */
  windowControls: 'left' | 'right'
  /** Modifiers of the nine transform shortcuts: 'Alt' on macOS, 'Alt+Shift' elsewhere. */
  transformModifier: string
}
type InputDevice = { id: number; uid: string; name: string; isDefault: boolean }
export type MicAccess = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'
export type Perms = { mic: MicAccess; ax: boolean }
export type NoticeKind = 'copied' | 'key-fallback' | 'cloud-fallback' | 'transform-applied' | 'cleanup-failed'
/** dictation:notice. Neutral and self-dismissing; never an error. */
export type Notice = {
  kind: NoticeKind
  /** Full sentence for the notice pill and the status region. */
  text: string
  /** Uppercase short form for the Partial card head during a dictation. */
  short?: string
  /** Transform name, for kind 'transform-applied'. */
  name?: string
  /** Extra detail (e.g. the cloud error); not for the pill. */
  detail?: string
  /** Suggested hold: 4000 (HOLD.notice) or 1600 (HOLD.transformNotice). */
  holdMs: number
}
export type TransformApplied = { id: string; name: string; slot: number; at: number; uses: number }
export type ShapeRect = { x: number; y: number; width: number; height: number }
/**
 * dictation:practice-result. What a practice dictation ended with: the words,
 * nothing heard, or why it failed ('mic' for a microphone or permission problem).
 */
export type PracticeResult = { text: string } | { empty: true } | { error: string; kind: 'mic' | 'other' }
/** A close handshake message. Answer `closed(seq)` with the same seq. */
export type CloseRequest = { seq: number }
/** win:shown. `first` is true only on the window's first show. */
export type WinShown = { first: boolean }
export type SettingsPane = 'shortcuts' | 'general' | 'dictation' | 'languages' | 'models' | 'ai' | 'about'

/* ---- Reduce Motion, before first paint (docs/MOTION.md §5 detection 2) ---- */
const reduceAtLaunch = process.argv.includes('--reduce-motion=1')
const firstShowDone = process.argv.includes('--first-show-done=1')
if (reduceAtLaunch) {
  // Set as early as possible so no CSS animation can start. Module scripts run
  // after readyState turns 'interactive', so that is the latest safe moment.
  const mark = (): boolean => {
    const el = document.documentElement
    if (!el) return false
    el.setAttribute('data-reduce-motion', '')
    return true
  }
  if (!mark()) {
    const onState = (): void => { if (mark()) document.removeEventListener('readystatechange', onState) }
    document.addEventListener('readystatechange', onState)
    document.addEventListener('DOMContentLoaded', () => mark(), { once: true })
  }
}

/*
 * Whether this window is on screen. Asked synchronously here, before any page
 * script runs, then kept current by win:shown, so a page that subscribes late
 * (or was reloaded while visible) can still tell. See win.shown().
 */
let shownState: WinShown | null = null
try { shownState = (ipcRenderer.sendSync('win:is-shown') as WinShown | null) ?? null } catch { /* not shown yet */ }
ipcRenderer.on('win:shown', (_e, p: WinShown) => { shownState = p })

/*
 * What this OS and its helper can do. Read synchronously before any page
 * script runs, then kept current: the helper reports its capabilities a
 * moment after it boots, and again after a respawn or a switch of helper.
 */
const PLATFORM_FALLBACK: PlatformInfo = {
  os: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
  capabilities: [],
  holdKeys: [],
  notes: {},
  helper: { kind: process.platform === 'darwin' ? 'swift' : 'rust', forced: false, choices: [] },
  windowControls: process.platform === 'darwin' ? 'left' : 'right',
  transformModifier: process.platform === 'darwin' ? 'Alt' : 'Alt+Shift'
}
let platformState: PlatformInfo = PLATFORM_FALLBACK
try { platformState = (ipcRenderer.sendSync('platform:get') as PlatformInfo | null) ?? PLATFORM_FALLBACK } catch { /* keep the fallback */ }
ipcRenderer.on('platform:changed', (_e, p: PlatformInfo) => { platformState = p })

/**
 * A close handshake as seen from the page: main announces the close, the page
 * plays its exit and answers. With no subscriber the preload answers at once,
 * so a window whose page has not adopted the handshake closes as before.
 */
function closeGate(willClose: string, closed: string): (cb: (e: CloseRequest) => void) => () => void {
  const subs = new Set<(e: CloseRequest) => void>()
  ipcRenderer.on(willClose, (_e, p: CloseRequest) => {
    if (!subs.size) { ipcRenderer.send(closed, p); return }
    for (const cb of [...subs]) cb(p)
  })
  return (cb) => {
    subs.add(cb)
    return () => { subs.delete(cb) }
  }
}
const onPadWillClose = closeGate('pad:will-close', 'pad:closed')
const onTodosWillClose = closeGate('todos:will-close', 'todos:closed')

const api = {
  /**
   * Synchronous: the OS and what the native helper can do on it, as last
   * reported. Use it to hide what does not apply (calendar sync without
   * 'calendar', the hold key picker without 'hotkey', fn when 63 is not in
   * holdKeys, ducking without 'duck', the Accessibility step without
   * 'accessibility'). Subscribe to onPlatform for changes.
   */
  platform: (): PlatformInfo => platformState,
  /** has('calendar') is platform().capabilities.includes('calendar'). */
  has: (capability: Capability): boolean => platformState.capabilities.includes(capability),
  /** The capabilities changed: the helper finished booting, restarted, or was switched. */
  onPlatform: (cb: (p: PlatformInfo) => void) => sub('platform:changed', cb),
  bar: {
    /**
     * Click-through hit test result (useBarHitTest). true makes the window take
     * the mouse; false goes back to ignore + forward. `escape: true` while the
     * pointer is over the error card registers a global Esc that arrives on onEscape.
     */
    setHit: (hit: boolean, opts?: { escape?: boolean }) => ipcRenderer.send('bar:hit', hit, opts),
    /** Shape rect in window coordinates, sent on every state settle (main's 30 Hz backstop). */
    setShapeRect: (r: ShapeRect | null) => ipcRenderer.send('bar:shape-rect', r),
    /** Global Esc while the pointer is over the error card: dismiss it. */
    onEscape: (cb: () => void) => sub('bar:escape', cb),
    /**
     * Main's backstop forced the window back to click-through (the pointer
     * left without a mouseleave). Forget the last value sent through setHit,
     * so the next `true` is sent again instead of being deduped away.
     */
    onHitReset: (cb: () => void) => sub('bar:hit-reset', cb)
  },
  motion: {
    /** Main's Reduce Motion at window creation (also mirrored on html[data-reduce-motion]). */
    reducedAtLaunch: reduceAtLaunch,
    /** Fresh read of the system's Reduce Motion from main. */
    reduced: (): Promise<boolean> => ipcRenderer.invoke('motion:reduced'),
    /** Live changes from main (a notification on macOS, re-read every few seconds elsewhere). */
    onReduced: (cb: (reduced: boolean) => void) => sub('motion:reduced', cb)
  },
  win: {
    /** True when this hub was recreated after its first-launch entrance already played. */
    firstShowDone,
    /** After show()/showInactive(). `first` is true only on the window's first show. */
    onShown: (cb: (e: WinShown) => void) => sub('win:shown', cb),
    /**
     * Synchronous: the last win:shown this window got, or null while it has not
     * reached the screen. Read it before subscribing to onShown; a window that
     * was already shown (the Flow Bar, a reload) never gets the event again.
     */
    shown: (): WinShown | null => shownState
  },
  shortcuts: {
    onFailed: (cb: (a: string[]) => void) => sub('shortcuts:failed', cb)
  },
  updates: {
    check: (): Promise<{ current: string; latest?: string; url?: string; newer: boolean }> =>
      ipcRenderer.invoke('updates:check'),
    prompt: () => ipcRenderer.invoke('updates:prompt')
  },
  system: {
    user: (): Promise<{ name: string }> => ipcRenderer.invoke('system:user')
  },
  hub: {
    show: () => ipcRenderer.send('hub:show'),
    /** Brings the hub up on a Settings pane (Flow Bar "Change model" → 'models'). */
    openSettings: (pane?: SettingsPane) => ipcRenderer.send('hub:open-settings', pane),
    onOpenSettings: (cb: (pane: SettingsPane) => void) => sub('hub:open-settings', cb),
    /** A pane requested before this hub was listening; collect once on mount. */
    pendingSettings: (): Promise<SettingsPane | null> => ipcRenderer.invoke('hub:pending-settings')
  },
  pad: {
    open: () => ipcRenderer.send('pad:open'),
    close: () => ipcRenderer.send('pad:close'),
    expand: () => ipcRenderer.send('pad:expand'),
    /**
     * Main is about to close the window (close button, ⌘W, last tab, native
     * close). Play the exit, then call closed(e.seq). Main closes anyway after
     * 300 ms. Under Reduce Motion, answer at once.
     */
    onWillClose: onPadWillClose,
    closed: (seq: number) => ipcRenderer.send('pad:closed', { seq })
  },
  notes: {
    list: () => ipcRenderer.invoke('notes:list'),
    create: () => ipcRenderer.invoke('notes:create'),
    update: (id: string, patch: { title?: string; body?: string }) =>
      ipcRenderer.invoke('notes:update', id, patch),
    remove: (id: string) => ipcRenderer.invoke('notes:remove', id),
    onChanged: (cb: (n: unknown[]) => void) => sub('notes:changed', cb)
  },
  todos: {
    list: () => ipcRenderer.invoke('todos:list'),
    add: (input: { title: string; description?: string; due?: string | null; time?: string | null }) =>
      ipcRenderer.invoke('todos:add', input),
    update: (id: string, patch: { title?: string; description?: string; due?: string | null; time?: string | null; done?: boolean }) =>
      ipcRenderer.invoke('todos:update', id, patch),
    remove: (id: string) => ipcRenderer.invoke('todos:remove', id),
    reorder: (ids: string[]) => ipcRenderer.invoke('todos:reorder', ids),
    clearDone: (): Promise<number> => ipcRenderer.invoke('todos:clearDone'),
    projects: (): Promise<{ name: string; count: number }[]> => ipcRenderer.invoke('todos:projects'),
    collapsed: (): Promise<string[]> => ipcRenderer.invoke('todos:collapsed'),
    collapse: (project: string, v: boolean): Promise<string[]> => ipcRenderer.invoke('todos:collapse', project, v),
    open: () => ipcRenderer.send('todos:open'),
    close: () => ipcRenderer.send('todos:close'),
    pin: (v: boolean): Promise<boolean> => ipcRenderer.invoke('todos:pin', v),
    pinned: (): Promise<boolean> => ipcRenderer.invoke('todos:pinned'),
    /** Grows the window to 640 high while the date picker is open; false restores 520. */
    setPickerOpen: (open: boolean) => ipcRenderer.send('todos:picker', open),
    /**
     * Main is about to close the panel (the pointer left, or close()). Play the
     * exit, then call closed(e.seq). Main closes anyway after 300 ms. Under
     * Reduce Motion, answer at once.
     */
    onWillClose: onTodosWillClose,
    closed: (seq: number) => ipcRenderer.send('todos:closed', { seq }),
    /**
     * The pointer came back during the exit (e.seq is the exit being called
     * off): retarget to open and do not answer closed for it.
     */
    onCancelClose: (cb: (e: CloseRequest) => void) => sub('todos:cancel-close', cb),
    onChanged: (cb: (t: unknown[]) => void) => sub('todos:changed', cb)
  },
  calendar: {
    status: (): Promise<'granted' | 'writeOnly' | 'denied' | 'notDetermined' | 'unknown'> => ipcRenderer.invoke('cal:status'),
    request: (): Promise<'granted' | 'writeOnly' | 'denied' | 'notDetermined' | 'unknown'> => ipcRenderer.invoke('cal:request'),
    calendars: (): Promise<{ id: string; title: string; source: string; color: string; isDefault: boolean }[]> =>
      ipcRenderer.invoke('cal:calendars'),
    backfill: (): Promise<number> => ipcRenderer.invoke('cal:backfill'),
    openSettings: () => ipcRenderer.send('cal:openSettings')
  },
  eleven: {
    status: (): Promise<{ hasKey: boolean; masked: string | null }> => ipcRenderer.invoke('eleven:status'),
    setKey: (k: string) => ipcRenderer.invoke('eleven:setKey', k),
    clearKey: () => ipcRenderer.invoke('eleven:clearKey')
  },
  cleanup: {
    status: (): Promise<{ hasKey: boolean; masked: string | null }> => ipcRenderer.invoke('cleanup:status'),
    setKey: (key: string) => ipcRenderer.invoke('cleanup:setKey', key),
    clearKey: () => ipcRenderer.invoke('cleanup:clearKey'),
    verify: (model: string): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke('cleanup:verify', model),
    models: (): Promise<{ models: string[]; error?: string }> => ipcRenderer.invoke('cleanup:models'),
    onError: (cb: (note: string) => void) => sub('cleanup:error', cb)
  },
  dictations: {
    list: () => ipcRenderer.invoke('dictations:list'),
    insights: () => ipcRenderer.invoke('dictations:insights'),
    remove: (id: string) => ipcRenderer.invoke('dictations:remove', id),
    flag: (id: string, flagged: boolean) => ipcRenderer.invoke('dictations:flag', id, flagged),
    /** Re-runs AI cleanup and snippets on the saved text (audio is not kept). */
    retry: (id: string) => ipcRenderer.invoke('dictations:retry', id),
    onAdded: (cb: (d: unknown) => void) => sub('dictations:added', cb)
  },
  snippets: {
    list: () => ipcRenderer.invoke('snippets:list'),
    save: (patch: unknown) => ipcRenderer.invoke('snippets:save', patch),
    remove: (id: string) => ipcRenderer.invoke('snippets:remove', id),
    /** Fresh list after real use (each snippet carries `uses` and `lastUsedAt`). */
    onChanged: (cb: (list: unknown[]) => void) => sub('snippets:changed', cb)
  },
  transforms: {
    list: () => ipcRenderer.invoke('transforms:list'),
    save: (patch: unknown) => ipcRenderer.invoke('transforms:save', patch),
    remove: (id: string) => ipcRenderer.invoke('transforms:remove', id),
    preview: (id: string, sample: string) => ipcRenderer.invoke('transforms:preview', id, sample),
    /** The most recently applied transform, or null if none ever was. */
    last: (): Promise<TransformApplied | null> => ipcRenderer.invoke('transforms:last'),
    /** Fired each time ⌥<n> applies a transform (real use, not previews). */
    onApplied: (cb: (t: TransformApplied) => void) => sub('transforms:applied', cb),
    /** Fresh list after use (each transform carries `uses` and `lastUsedAt`). */
    onChanged: (cb: (list: unknown[]) => void) => sub('transforms:changed', cb)
  },
  models: {
    list: () => ipcRenderer.invoke('models:list'),
    download: (id: string) => ipcRenderer.invoke('models:download', id),
    cancel: (id: string) => ipcRenderer.invoke('models:cancel', id),
    remove: (id: string) => ipcRenderer.invoke('models:remove', id),
    onProgress: (cb: (p: { id: string; received: number; total: number }) => void) =>
      sub('models:progress', cb),
    onDone: (cb: (d: { id: string }) => void) => sub('models:done', cb),
    /** A download was cancelled (models.cancel); its partial file is gone. */
    onCancelled: (cb: (d: { id: string }) => void) => sub('models:cancelled', cb),
    /** The selected model is not on disk, so local dictation cannot run until one is installed. */
    onMissing: (cb: (id: string) => void) => sub('models:missing', cb),
    onList: (cb: (l: unknown[]) => void) => sub('models:list', cb),
    onError: (cb: (e: { id: string; message: string }) => void) => sub('models:error', cb)
  },
  perms: {
    status: (): Promise<Perms> => ipcRenderer.invoke('perms:status'),
    pending: (): Promise<boolean> => ipcRenderer.invoke('perms:pending'),
    /** Prompts while undecided; once refused, opens System Settings instead. */
    requestMic: (): Promise<Perms> => ipcRenderer.invoke('perms:requestMic'),
    requestAx: (): Promise<Perms> => ipcRenderer.invoke('perms:requestAx'),
    open: (which: 'mic' | 'ax') => ipcRenderer.send('perms:open', which),
    onChanged: (cb: (p: Perms) => void) => sub('perms:changed', cb),
    /** Main wants the permissions screen up, e.g. dictation was refused the mic. */
    onShow: (cb: () => void) => sub('perms:show', cb)
  },
  mic: {
    /** Cached list now; a fresh one follows through onDevices. */
    devices: (): Promise<InputDevice[]> => ipcRenderer.invoke('mic:devices'),
    onDevices: (cb: (d: InputDevice[]) => void) => sub('mic:devices', cb),
    /** Opens the mic for a few seconds to show its level; it ends by itself. */
    test: (on: boolean) => ipcRenderer.send('mic:test', on),
    onTest: (cb: (t: { state: 'started' | 'ended'; device?: string; error?: string }) => void) => sub('mic:test', cb),
    onTestLevel: (cb: (v: number) => void) => sub('mic:test-level', cb),
    /** 28 bands from low to high pitch, 0 to 1 each, while the mic is open. */
    onSpectrum: (cb: (bands: number[]) => void) => sub('mic:spectrum', cb)
  },
  settings: {
    get: (): Promise<Prefs> => ipcRenderer.invoke('settings:get'),
    set: (patch: Partial<Prefs>): Promise<Prefs> =>
      ipcRenderer.invoke('settings:set', patch)
  },
  dictation: {
    start: () => ipcRenderer.invoke('dictation:start'),
    stop: (): Promise<string> => ipcRenderer.invoke('dictation:stop'),
    cancel: () => ipcRenderer.invoke('dictation:cancel'),
    /** Re-runs the last recording (Flow Bar error "Try again"). Resolves false if nothing to retry. */
    retry: (): Promise<boolean> => ipcRenderer.invoke('dictation:retry'),
    startVoiceNote: () => ipcRenderer.invoke('voicenote:start'),
    /**
     * Full running text (not a delta), local whisper or ElevenLabs streaming,
     * at most every 100 ms. '' when a new recording starts.
     */
    onPartial: (cb: (t: string) => void) => sub('dictation:partial', cb),
    /** Neutral notices (copied, key/cloud fallback, transform applied, cleanup failed). Errors stay on onError. */
    onNotice: (cb: (n: Notice) => void) => sub('dictation:notice', cb),
    onLevel: (cb: (v: number) => void) => sub('dictation:level', cb),
    onError: (cb: (m: string) => void) => sub('dictation:error', cb),
    onState: (cb: (s: 'recording' | 'idle') => void) => sub('dictation:state', cb),
    onStage: (cb: (s: 'transcribing' | 'polishing' | 'idle') => void) => sub('dictation:stage', cb),
    /**
     * Hands-free: true when a double-tap of the hold key latches the recording
     * open (the next tap stops it), false when that recording ends, however
     * it ends. A recording that was never latched sends nothing.
     */
    onLatched: (cb: (latched: boolean) => void) => sub('dictation:latched', cb),
    /**
     * Practice (the onboarding "Try it" tile): dictations record and transcribe
     * as usual but are never pasted, copied, cleaned up or saved; the result
     * arrives on onPracticeResult. Only the hub can turn it on. Main turns it
     * off when the hub closes, reloads or navigates.
     */
    setPractice: (on: boolean): void => ipcRenderer.send('dictation:set-practice', on),
    practice: (): Promise<boolean> => ipcRenderer.invoke('dictation:practice'),
    onPractice: (cb: (on: boolean) => void) => sub('dictation:practice', cb),
    /** One per finished practice dictation. Stray or very short presses send nothing. */
    onPracticeResult: (cb: (r: PracticeResult) => void) => sub('dictation:practice-result', cb),
    /** Whether the current recording is latched, for a window that mounts mid-recording. */
    latched: (): Promise<boolean> => ipcRenderer.invoke('dictation:latched')
  }
}

function sub<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('flow', api)
export type FlowApi = typeof api

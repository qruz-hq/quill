import { app, shell, BrowserWindow, ipcMain, screen, clipboard, globalShortcut, Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, appendFileSync } from 'fs'
import { userInfo, homedir } from 'os'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { SttEngine } from './stt'
import { ModelStore, type ModelId } from './models'
import { NoteStore } from './notes'
import { SnippetStore } from './snippets'
import { TransformStore } from './transforms'
import { DictationStore } from './dictations'
import { Cleanup } from './cleanup'
import { checkForUpdate, notifyIfNewer } from './updates'

/* Screenshot calibration: captures were 1372px wide on a 1728pt display (0.794x).
   All sizes below are logical points, converted from the measured originals. */
const HUB = { width: 1350, height: 850, minWidth: 1000, minHeight: 640 }
/* The bar window is only ever as large as what it draws, so the transparent
   area never has to swallow or forward clicks. */
const PAD = { width: 620, height: 460 }
const BAR_IDLE = { width: 16, height: 90 }
const BAR_OPEN = { width: 340, height: 260 }
type BarMode = 'idle' | 'expanded' | 'recording'

let hubWindow: BrowserWindow | null = null
let barWindow: BrowserWindow | null = null
let padWindow: BrowserWindow | null = null
let lastTranscript = ''
let tray: Tray | null = null
let recording = false
let voiceNoteMode = false
let recordingStartedAt = 0

/** A Finder-launched app has no visible stdout, so timings go to a file. */
const LOG = join(homedir(), 'Library/Logs/Quill-app.log')
function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try { appendFileSync(LOG, line) } catch { /* non-fatal */ }
  console.log(msg)
}

type Settings = { model: ModelId; languages: string[]; duckEnabled: boolean; duckLevel: number; aiEnabled: boolean; aiModel: string; aiMinWords: number; aiDeadlineMs: number; aiFixMishearings: boolean; holdKey: number; toggleShortcut: string; padShortcut: string; noteShortcut: string }
const SETTINGS_PATH = (): string => join(app.getPath('userData'), 'settings.json')
const DEFAULTS: Settings = { model: 'base.en', languages: ['en'], duckEnabled: true, duckLevel: 15, aiEnabled: true, aiModel: 'gpt-4o-mini', aiMinWords: 5, aiDeadlineMs: 2500, aiFixMishearings: false, holdKey: 63, toggleShortcut: 'Control+Alt+D', padShortcut: 'Alt+S', noteShortcut: 'Alt+M' }

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

async function startDictation(): Promise<void> {
  if (recording) return
  recording = true
  recordingStartedAt = Date.now()
  broadcast('dictation:state', 'recording')
  stt.start()
}

async function stopDictation(): Promise<void> {
  if (!recording) return
  recording = false
  broadcast('dictation:state', 'idle')
  broadcast('dictation:stage', 'transcribing')
  const tStop = Date.now()
  const raw = await stt.stop()
  const tTranscribed = Date.now()
  if (!raw) { voiceNoteMode = false; return }

  // Spoken shortcuts expand before anything is typed.
  // Optional cloud cleanup. Any failure returns the raw text, so a bad key or
  // a dead connection can never cost you a dictation.
  // Short dictations gain nothing from cleanup — whisper already punctuates
  // them — but still cost a full API round trip, measured at 1–2s. Skipping
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
  if (note.startsWith('failed') || note.startsWith('empty')) broadcast('cleanup:error', note)

  const { text, used } = snippets.apply(polished)
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
  const entry = dictations.add(text, Math.max(0, Date.now() - recordingStartedAt))
  broadcast('dictations:added', entry)

  if (voiceNoteMode) {
    voiceNoteMode = false
    const note = notes.create()
    notes.update(note.id, { body: `<div>${escapeHtml(text)}</div>` })
    broadcast('notes:changed', notes.list())
    openScratchpad()
    return
  }
  stt.insert(text)
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
  // ⌥1..⌥9 apply transforms to the last dictation.
  for (let n = 1; n <= 9; n++) {
    bind(`Alt+${n}`, () => {
      const t = transforms.bySlot(n)
      if (!t || !lastTranscript) return
      const out = transforms.apply(t, lastTranscript)
      lastTranscript = out
      stt.insert(out)
    })
  }
  log(`[flow] shortcuts bound: ${ok.join(', ')}${failed.length ? ` | FAILED: ${failed.join(', ')}` : ''}`)
  return { ok, failed }
}

/** Tells the helper how far to drop output volume while recording. */
function applyDuck(): void {
  stt.setDuck(settings.duckEnabled ? settings.duckLevel : null)
}

function applyModel(): void {
  if (!models.isInstalled(settings.model)) {
    broadcast('models:missing', settings.model)
    stt.setModel('')
    return
  }
  stt.setModel(models.pathFor(settings.model))
}

function buildTray(): void {
  const img = nativeImage.createFromPath(
    join(process.resourcesPath, 'icons', 'trayTemplate.png')
  )
  img.setTemplateImage(true)
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img)
  tray.setToolTip('Quill')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Quill', click: () => { hubWindow?.show(); hubWindow?.focus() } },
    { type: 'separator' },
    { label: 'Start Dictation', accelerator: 'Ctrl+Alt+D', click: () => void startDictation() },
    { label: 'New Voice Note', accelerator: 'Alt+M', click: () => void startVoiceNote() },
    { label: 'Stop Dictation', click: () => void stopDictation() },
    { type: 'separator' },
    { label: 'Paste last transcript', click: () => { if (lastTranscript) clipboard.writeText(lastTranscript) } },
    { type: 'separator' },
    { label: 'Quit Quill', accelerator: 'Command+Q', click: () => app.quit() }
  ]))
}
const stt = new SttEngine()
const models = new ModelStore()
const notes = new NoteStore()
const snippets = new SnippetStore()
const transforms = new TransformStore()
const dictations = new DictationStore()
const cleanup = new Cleanup()

function createHub(): BrowserWindow {
  const win = new BrowserWindow({
    ...HUB,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 22 },
    backgroundColor: '#f7f6f2',
    vibrancy: 'sidebar',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  win.on('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler((d) => {
    shell.openExternal(d.url)
    return { action: 'deny' }
  })

  loadRoute(win, 'hub')
  return win
}

function barBounds(mode: BarMode): Electron.Rectangle {
  const { workArea } = screen.getPrimaryDisplay()
  const { width, height } = mode === 'idle' ? BAR_IDLE : BAR_OPEN
  return {
    width,
    height,
    x: workArea.x + workArea.width - width,
    y: workArea.y + Math.round((workArea.height - height) / 2)
  }
}

function createFlowBar(): BrowserWindow {
  const win = new BrowserWindow({
    ...barBounds('idle'),
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    focusable: false,          // never steal focus from the app being dictated into
    alwaysOnTop: true,
    acceptFirstMouse: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  loadRoute(win, 'flowbar')
  return win
}

/** The floating Scratchpad: a small always-available notepad, like the real app's. */
function openScratchpad(): void {
  if (padWindow && !padWindow.isDestroyed()) {
    padWindow.show(); padWindow.focus(); return
  }
  const { workArea } = screen.getPrimaryDisplay()
  padWindow = new BrowserWindow({
    ...PAD,
    x: workArea.x + workArea.width - PAD.width - 70,
    y: workArea.y + Math.round((workArea.height - PAD.height) / 2),
    frame: false,
    transparent: true,
    hasShadow: true,
    resizable: true,
    minWidth: 460,
    minHeight: 320,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  padWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  padWindow.on('closed', () => { padWindow = null })
  loadRoute(padWindow, 'scratchpad')
}

function loadRoute(win: BrowserWindow, route: 'hub' | 'flowbar' | 'scratchpad'): void {
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
  electronApp.setAppUserModelId('studio.saudad.quill')
  app.on('browser-window-created', (_, w) => optimizer.watchWindowShortcuts(w))

  hubWindow = createHub()
  barWindow = createFlowBar()

  /* ---- Flow Bar sizing ---- */
  ipcMain.on('bar:mode', (_e, mode: BarMode) => {
    if (!barWindow || barWindow.isDestroyed()) return
    barWindow.setBounds(barBounds(mode), false)
  })

  /* ---- Global shortcut ---- */
  // Bare `fn` cannot be bound through globalShortcut; it needs a native event
  // tap. This is the bindable stand-in until that lands.
  applyShortcuts()

  /* ---- Dictation ---- */
  ipcMain.handle('dictation:start', async () => startDictation())
  ipcMain.handle('dictation:stop', async () => stopDictation())
  ipcMain.handle('dictation:cancel', async () => stt.cancel())

  stt.on('partial', (text) => broadcast('dictation:partial', text))
  stt.on('transcribing', () => broadcast('dictation:stage', 'transcribing'))
  stt.on('level', (level) => broadcast('dictation:level', level))
  stt.on('final', (text) => broadcast('dictation:final', text))
  stt.on('error', (msg) => broadcast('dictation:error', msg))
  stt.on('inserted', (chars) => console.log('[flow] inserted', chars, 'chars'))
  stt.on('hotkey', (intent: 'start' | 'stop') => {
    void (intent === 'start' ? startDictation() : stopDictation())
  })
  stt.on('hotkey-status', (ok: boolean) => {
    console.log('[flow] fn hotkey installed:', ok)
    if (!ok) broadcast('dictation:error', 'Enable Accessibility for the fn hotkey, then relaunch')
  })

  settings = loadSettings()

  // Set this to your repo to enable update checks. Empty disables them.
  const UPDATE_REPO = process.env.FLOW_UPDATE_REPO ?? 'qruz-hq/quill'
  if (UPDATE_REPO) {
    notifyIfNewer(UPDATE_REPO)
    setInterval(() => notifyIfNewer(UPDATE_REPO), 6 * 60 * 60 * 1000)
    ipcMain.handle('updates:check', () => checkForUpdate(UPDATE_REPO))
  } else {
    ipcMain.handle('updates:check', () => ({ current: app.getVersion(), newer: false }))
  }
  const swept = models.sweepPartials()
  if (swept.removed.length) {
    log(`[flow] cleared ${swept.removed.length} interrupted download(s), ${(swept.bytes / 1e6).toFixed(0)} MB`)
  }
  cleanup.warm()   // open the TLS connection before the first dictation
  buildTray()
  // Start the helper now so the fn event tap is live before first use.
  stt.warmup()
  applyModel()
  stt.setLanguage(settings.languages)
  applyDuck()
  stt.setHoldKey(settings.holdKey)

  models.on('progress', (p) => broadcast('models:progress', p))
  models.on('done', (d) => { broadcast('models:done', d); broadcast('models:list', models.list()) })
  models.on('cancelled', (d) => broadcast('models:cancelled', d))

  /* ---- Scratchpad ---- */
  ipcMain.on('pad:open', () => openScratchpad())
  ipcMain.handle('voicenote:start', async () => startVoiceNote())
  ipcMain.on('pad:close', () => padWindow?.close())
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

  /* ---- Cloud cleanup ---- */
  ipcMain.handle('cleanup:status', () => ({
    hasKey: cleanup.hasKey(),
    masked: cleanup.maskedKey()
  }))
  ipcMain.handle('cleanup:setKey', (_e, key: string) => {
    try { cleanup.setKey(key); return { ok: true, masked: cleanup.maskedKey() } }
    catch (err) { return { ok: false, message: (err as Error).message } }
  })
  ipcMain.handle('cleanup:clearKey', () => { cleanup.clearKey(); return { hasKey: false } })
  ipcMain.handle('cleanup:verify', (_e, model: string) => cleanup.verify(model))
  ipcMain.handle('cleanup:models', () => cleanup.listModels())

  // Just the local OS user — there is no account system in this app.
  ipcMain.handle('system:user', () => {
    const raw = userInfo().username || ''
    return { name: raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : '' }
  })

  /* ---- Dictation history + insights ---- */
  ipcMain.handle('dictations:list', () => dictations.list())
  ipcMain.handle('dictations:insights', () => dictations.insights())
  ipcMain.handle('dictations:remove', (_e, id: string) => { dictations.remove(id); return dictations.list() })

  /* ---- Snippets ---- */
  ipcMain.handle('snippets:list', () => snippets.list())
  ipcMain.handle('snippets:save', (_e, patch) => { snippets.save(patch); return snippets.list() })
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
    try { await models.download(id) } catch (err) {
      broadcast('models:error', { id, message: (err as Error).message })
      throw err
    }
    return models.list()
  })
  ipcMain.handle('models:cancel', (_e, id: ModelId) => { models.cancel(id); return models.list() })
  ipcMain.handle('models:remove', (_e, id: ModelId) => {
    models.remove(id)
    // Fall back to any model still on disk so dictation keeps working.
    if (settings.model === id) {
      const next = models.list().find((m) => m.installed)
      settings = { ...settings, model: (next?.id ?? 'base.en') as ModelId }
      saveSettings(settings)
      applyModel()
    }
    return models.list()
  })

  ipcMain.handle('settings:get', () => settings)
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
    settings = { ...settings, ...patch }
    saveSettings(settings)
    if (patch.model !== undefined) applyModel()
    if (patch.languages !== undefined) stt.setLanguage(patch.languages)
    if (patch.duckEnabled !== undefined || patch.duckLevel !== undefined) applyDuck()
    if (patch.holdKey !== undefined) stt.setHoldKey(patch.holdKey)
    if (patch.toggleShortcut !== undefined || patch.padShortcut !== undefined || patch.noteShortcut !== undefined) {
      const r = applyShortcuts()
      if (r.failed.length) broadcast('shortcuts:failed', r.failed)
    }
    return settings
  })

  // Re-paste the most recent transcript.
  ipcMain.on('hub:paste-last', () => { if (lastTranscript) clipboard.writeText(lastTranscript) })

  ipcMain.on('hub:show', () => {
    hubWindow?.show()
    hubWindow?.focus()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) hubWindow = createHub()
    else hubWindow?.show()
  })
})

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string))
}

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('before-quit', () => stt.dispose())

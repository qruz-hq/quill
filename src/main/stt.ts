import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { EventEmitter } from 'events'
import { app } from 'electron'
import { join, dirname } from 'path'
import { existsSync } from 'fs'

type Msg =
  | { type: 'boot' | 'started' | 'cancelled' | 'transcribing' }
  | { type: 'start-failed'; message: string }
  | { type: 'inserted'; chars: number }
  | { type: 'ax'; trusted: boolean }
  | { type: 'hotkey'; intent: HotkeyIntent; latched?: boolean }
  | { type: 'hotkey-status'; installed: boolean; reason?: string }
  | { type: 'audio'; id?: string; path: string; seconds: number }
  | { type: 'chunk'; b64: string }
  | { type: 'cal'; id: string; [k: string]: unknown }
  | { type: 'partial'; text: string }
  | { type: 'final'; id?: string; text: string; error?: string }
  | { type: 'level'; value: number }
  | { type: 'mic-test-level'; value: number }
  | { type: 'spectrum'; bands: number[] }
  | { type: 'mic-test'; state: 'started' | 'ended'; device?: string; error?: string }
  | { type: 'error'; message: string }
  | { type: 'devices'; devices: InputDevice[]; pinned?: string }
  | { type: 'interrupted' }

/** start: the hold key went down. stop: transcribe. cancel: it was never a dictation (a quick tap, fn+key). */
export type HotkeyIntent = 'start' | 'stop' | 'cancel'

/** What a stop or a retry comes back with. `error` is the helper's own reason for an empty text. */
export type Final = { text: string; error?: string }

/** The helper died before it could answer a stop or a retry. */
export class HelperGone extends Error {
  constructor() {
    super('speech helper exited')
    this.name = 'HelperGone'
  }
}

/** A CoreAudio input device. `uid` survives reconnects; `id` does not. */
export type InputDevice = { id: number; uid: string; name: string; isDefault: boolean }

/**
 * Speech-to-text over the bundled `flow-stt` Swift helper (on-device
 * SFSpeechRecognizer). Engine-agnostic on purpose: swap `binaryPath` for a
 * cloud-backed sidecar and the rest of the app is unchanged.
 */
export class SttEngine extends EventEmitter {
  /**
   * Set in cloud mode. Receives the recorded WAV and resolves with the
   * transcript, or null to fall back to transcribing locally.
   */
  audioHandler: ((path: string, seconds: number, tag: unknown) => Promise<string | null>) | null = null
  /** Streaming mode: raw PCM16 arriving while the user is still speaking. */
  chunkHandler: ((b64: string) => void) | null = null
  /** In-flight `cal` requests, keyed by id. */
  private pendingCal = new Map<string, (r: Record<string, unknown>) => void>()

  private proc: ChildProcessWithoutNullStreams | null = null
  private buffer = ''
  /**
   * Every stop and retry waiting for its transcript, by the id it was sent
   * with. The helper echoes the id on `final` and `audio`, so dictations that
   * overlap, or finish out of order, each get their own result. `tag` is the
   * caller's own context, handed back to audioHandler.
   */
  private waiting = new Map<string, { settle: (r: Final | null) => void; tag: unknown }>()
  private nextId = 1
  /** Ids whose audio the app is uploading; the helper is not needed to finish those. */
  private uploads = new Set<string>()
  /** Helpers this side asked to quit, so their exit is not reported as a crash. */
  private dismissed = new WeakSet<ChildProcessWithoutNullStreams>()
  private ready = false
  /**
   * True from `start` until stop, cancel or retry. The helper keeps trying to
   * open the microphone after it answers `started`, and reports a mic that
   * never opened as an `error` with nothing recording any more.
   */
  private capturing = false
  /** Last list the helper reported, so Settings can render without a round trip. */
  devices: InputDevice[] = []
  /**
   * Runs after every spawn, including a respawn after a crash, so the new
   * helper gets the user's settings rather than its built-in defaults.
   */
  onSpawn: (() => void) | null = null

  /** True once the helper has announced itself. */
  get isReady(): boolean {
    return this.ready
  }

  private get binaryPath(): string {
    // Packaged: a plain executable beside the main binary in Contents/MacOS,
    // so TCC treats the parent app as the permission subject (one grant, under
    // a name the user recognises). Dev: the standalone bundle.
    const packaged = join(dirname(process.execPath), 'flow-stt')
    const devBundle = join('FlowSTT.app', 'Contents', 'MacOS', 'flow-stt')
    const candidates = [
      packaged,
      join(app.getAppPath(), 'resources', devBundle),
      join(process.cwd(), 'resources', devBundle)
    ]
    const found = candidates.find((p) => existsSync(p))
    if (!found) {
      console.error('[stt] helper not found. Looked in:', candidates)
      return candidates[0]
    }
    return found
  }

  private ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.proc && !this.proc.killed) return this.proc

    const bin = this.binaryPath
    console.log('[stt] spawning', bin)
    const proc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    // A failed spawn emits 'error'; without this listener Node throws.
    proc.on('error', (err) => this.gone(proc, `spawn failed: ${err.message}`))
    // Writing to a helper that has just died raises EPIPE here; its exit is
    // what gets handled, so this only has to not throw.
    proc.stdin.on('error', (err) => this.emit('log', `stdin: ${err.message}`))
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => this.consume(chunk))
    // stderr is for the log only. It carries crash reports and framework
    // chatter, never anything written for the user.
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (d: string) => { if (d.trim()) this.emit('log', `stderr: ${d.trim()}`) })
    proc.on('exit', (code, signal) => this.gone(proc, `exited (code ${code}, signal ${signal})`))

    this.proc = proc
    this.onSpawn?.()
    return proc
  }

  /**
   * A helper process is gone (exit, crash, failed spawn). Runs once per
   * process. Only the current helper's state is touched: a replacement may
   * already be running by the time an old one reports its exit.
   */
  private gone(proc: ChildProcessWithoutNullStreams, why: string): void {
    if (this.buried.has(proc)) return
    this.buried.add(proc)
    const expected = this.dismissed.has(proc)
    console.log('[stt] helper', why)
    if (this.proc !== proc && this.proc !== null) return
    this.proc = null
    this.ready = false
    this.buffer = ''
    const busy = this.capturing || this.waiting.size > 0
    this.capturing = false
    // Nothing it was working on will come back: fail the waits now rather
    // than leaving them to their timeouts. A cloud upload is the exception,
    // the app already has that audio and can still finish without the helper.
    for (const id of [...this.waiting.keys()]) if (!this.uploads.has(id)) this.settle(id, null)
    for (const reply of this.pendingCal.values()) reply({ error: 'helper exited' })
    this.pendingCal.clear()
    this.emit('exited', { expected, busy, why })
  }
  private buried = new WeakSet<ChildProcessWithoutNullStreams>()

  /** Answers the stop or retry sent with this id, once. */
  private settle(id: string, r: Final | null): void {
    const w = this.waiting.get(id)
    if (!w) return
    this.waiting.delete(id)
    w.settle(r)
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      let msg: Msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      console.log('[stt] <-', line)
      this.handle(msg)
    }
  }

  private handle(msg: Msg): void {
    switch (msg.type) {
      case 'boot':
        this.ready = true
        break
      case 'start-failed':
        // The microphone never opened, so nothing is recording.
        this.capturing = false
        this.emit('start-failed', msg.message)
        break
      case 'transcribing':
        this.emit('transcribing')
        break
      case 'partial':
        this.emit('partial', msg.text)
        break
      case 'level':
        this.emit('level', msg.value)
        break
      case 'mic-test-level':
        this.emit('mic-test-level', msg.value)
        break
      case 'spectrum':
        this.emit('spectrum', msg.bands)
        break
      case 'mic-test':
        this.emit('mic-test', { state: msg.state, device: msg.device, error: msg.error })
        break
      case 'audio':
        void this.handleAudio(msg.id ?? '', msg.path, msg.seconds)
        break
      case 'chunk':
        this.chunkHandler?.(msg.b64)
        break
      case 'cal': {
        const { type: _t, id, ...rest } = msg
        this.pendingCal.get(id)?.(rest)
        this.pendingCal.delete(id)
        break
      }
      case 'final':
        this.settle(msg.id ?? '', { text: msg.text, error: msg.error })
        break
      case 'inserted':
        this.emit('inserted', msg.chars)
        break
      case 'ax':
        this.emit('ax', msg.trusted)
        break
      case 'hotkey':
        this.emit('hotkey', msg.intent, msg.latched === true)
        break
      case 'hotkey-status':
        this.emit('hotkey-status', msg.installed, msg.reason)
        break
      case 'error':
        this.emit('error', msg.message)
        break
      case 'devices':
        this.devices = msg.devices
        this.emit('devices', msg.devices)
        break
      case 'interrupted':
        this.emit('interrupted')
        break
    }
  }

  /** Boots the helper early so its fn event tap is installed before first use. */
  warmup(): void {
    this.ensureProcess()
  }

  /** Cloud path: upload, and if that fails ask the helper to do it locally. */
  private async handleAudio(id: string, path: string, seconds: number): Promise<void> {
    if (!this.audioHandler) { this.settle(id, { text: '' }); return }
    this.uploads.add(id)
    let text: string | null = null
    try { text = await this.audioHandler(path, seconds, this.waiting.get(id)?.tag) } catch { /* treated as a failed upload */ }
    this.uploads.delete(id)
    if (text !== null) { this.settle(id, { text }); return }
    // Fallback, the helper still has the file and will send the `final` itself.
    if (this.proc) { this.proc.stdin.write(`transcribe-file ${id} ${path}\n`); return }
    // The helper died during the upload, so there is no local fallback left.
    this.settle(id, null)
  }

  /** 'local' transcribes in the helper; 'cloud' hands the audio to audioHandler. */
  setEngine(mode: 'local' | 'cloud'): void {
    this.ensureProcess().stdin.write(`engine ${mode}\n`)
  }

  /**
   * Calendar ops go through the helper because EventKit is native-only.
   * One JSON line out, one `cal` line back with the same id.
   */
  calendar(op: string, args: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<Record<string, unknown>> {
    const id = `c${Date.now()}${Math.floor(Math.random() * 1e6)}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingCal.delete(id)
        resolve({ error: 'timed out' })
      }, timeoutMs)
      this.pendingCal.set(id, (r) => { clearTimeout(timer); resolve(r) })
      this.ensureProcess().stdin.write(`cal ${JSON.stringify({ id, op, ...args })}\n`)
    })
  }

  /** Streaming ships PCM during capture instead of only a WAV at the end. */
  setStreaming(on: boolean): void {
    this.ensureProcess().stdin.write(`stream ${on ? 'on' : 'off'}\n`)
  }

  start(): void {
    const proc = this.ensureProcess()
    this.capturing = true
    proc.stdin.write('start\n')
  }

  /**
   * Ends the recording and resolves with its transcript. `tag` comes back to
   * audioHandler with this recording's audio. Rejects with HelperGone when the
   * helper dies before answering.
   */
  stop(tag?: unknown): Promise<Final> {
    this.capturing = false
    return this.awaitFinal('stop', tag)
  }

  cancel(): void {
    this.capturing = false
    this.proc?.stdin.write('cancel\n')
  }

  /**
   * Re-runs the last finished recording (kept in the helper's memory only).
   * Resolves like stop(), with an empty text when nothing was kept.
   */
  retry(tag?: unknown): Promise<Final> {
    return this.awaitFinal('retry', tag)
  }

  private awaitFinal(command: 'stop' | 'retry', tag: unknown): Promise<Final> {
    if (!this.proc) return Promise.resolve({ text: '' })
    const id = String(this.nextId++)
    return new Promise((resolve, reject) => {
      // A helper that never answers: give up on this one only.
      const timer = setTimeout(() => this.settle(id, { text: '' }), 45_000)
      this.waiting.set(id, {
        tag,
        settle: (r) => {
          clearTimeout(timer)
          if (r === null) reject(new HelperGone())
          else resolve(r)
        }
      })
      this.proc!.stdin.write(`${command} ${id}\n`)
    })
  }

  /** Clears the helper's hands-free latch when a latched recording ends some other way than a tap. */
  unlatch(): void {
    this.proc?.stdin.write('unlatch\n')
  }

  /** Types text into whatever app currently has keyboard focus. */
  insert(text: string): void {
    if (!text.trim() || !this.proc) return
    this.proc.stdin.write(`insert ${Buffer.from(text, 'utf8').toString('base64')}\n`)
  }

  /** Empty path means "no model installed"; the helper will say so on start. */
  setModel(path: string): void {
    this.ensureProcess().stdin.write(`model ${path}\n`)
  }

  /** One or more ISO codes, or ['auto'] to let whisper pick from all 99. */
  setLanguage(codes: string[]): void {
    this.ensureProcess().stdin.write(`lang ${codes.join(',')}\n`)
  }

  /** Percentage of original volume to duck to, or null to leave audio alone. */
  setDuck(level: number | null): void {
    this.ensureProcess().stdin.write(`duck ${level === null ? 'off' : level}\n`)
  }

  /** macOS keycode of the hold-to-talk key, or 0 to disable it. */
  setHoldKey(keycode: number): void {
    this.ensureProcess().stdin.write(`holdkey ${keycode > 0 ? keycode : 'off'}\n`)
  }

  /** Pins the microphone by CoreAudio UID; empty follows the system default. */
  setMic(uid: string): void {
    this.ensureProcess().stdin.write(`mic ${uid || 'default'}\n`)
  }

  /** Opens the mic for a few seconds to show its level; ends by itself. */
  testMic(on: boolean): void {
    this.ensureProcess().stdin.write(on ? 'mic-test\n' : 'mic-test-stop\n')
  }

  /** Asks for a fresh device list; it arrives as a 'devices' event. */
  refreshDevices(): void {
    this.ensureProcess().stdin.write('devices\n')
  }

  /** Re-checks Accessibility and, when it is there, installs the hold-key tap. */
  checkAccessibility(): void {
    this.proc?.stdin.write('ax-check\n')
  }

  dispose(): void {
    const proc = this.proc
    if (!proc) return
    this.dismissed.add(proc)
    this.proc = null
    // `quit` lets it put the output volume back before it goes; closing stdin
    // says the same thing if the line is lost. The signal is only for a
    // helper that is stuck, and it restores the volume on that path too.
    proc.stdin.write('quit\n')
    proc.stdin.end()
    const timer = setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill() }, 1500)
    timer.unref()
    proc.once('exit', () => clearTimeout(timer))
  }
}

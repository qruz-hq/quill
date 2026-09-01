import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { EventEmitter } from 'events'
import { app } from 'electron'
import { join, dirname } from 'path'
import { existsSync } from 'fs'

type Msg =
  | { type: 'ready' | 'started' | 'cancelled' | 'transcribing' }
  | { type: 'inserted'; chars: number }
  | { type: 'ax'; trusted: boolean }
  | { type: 'hotkey'; intent: 'start' | 'stop'; latched?: boolean }
  | { type: 'hotkey-status'; installed: boolean; reason?: string }
  | { type: 'audio'; path: string; seconds: number }
  | { type: 'partial' | 'final'; text: string }
  | { type: 'level'; value: number }
  | { type: 'error'; message: string }

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
  audioHandler: ((path: string, seconds: number) => Promise<string | null>) | null = null

  private proc: ChildProcessWithoutNullStreams | null = null
  private buffer = ''
  private pendingFinal: ((text: string) => void) | null = null
  private ready = false

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
    proc.on('error', (err) => {
      console.error('[stt] spawn failed:', err.message)
      this.emit('error', `helper failed to start: ${err.message}`)
      this.proc = null
    })
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => this.consume(chunk))
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (d: string) => this.emit('error', d.trim()))
    proc.on('exit', (code, signal) => {
      console.log('[stt] helper exited', { code, signal })
      this.proc = null
      this.ready = false
      this.pendingFinal?.('')
      this.pendingFinal = null
    })

    this.proc = proc
    return proc
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
      case 'ready':
        this.ready = true
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
      case 'audio':
        void this.handleAudio(msg.path, msg.seconds)
        break
      case 'final':
        this.emit('final', msg.text)
        this.pendingFinal?.(msg.text)
        this.pendingFinal = null
        break
      case 'inserted':
        this.emit('inserted', msg.chars)
        break
      case 'ax':
        this.emit('ax', msg.trusted)
        break
      case 'hotkey':
        this.emit('hotkey', msg.intent)
        break
      case 'hotkey-status':
        this.emit('hotkey-status', msg.installed)
        break
      case 'error':
        this.emit('error', msg.message)
        break
    }
  }

  /** Boots the helper early so its fn event tap is installed before first use. */
  warmup(): void {
    this.ensureProcess()
  }

  /** Cloud path: upload, and if that fails ask the helper to do it locally. */
  private async handleAudio(path: string, seconds: number): Promise<void> {
    if (!this.audioHandler) { this.emit('final', ''); this.pendingFinal?.(''); this.pendingFinal = null; return }
    const text = await this.audioHandler(path, seconds)
    if (text === null) {
      // Fallback — the helper still has the file and will emit 'final' itself.
      this.proc?.stdin.write(`transcribe-file ${path}\n`)
      return
    }
    this.emit('final', text)
    this.pendingFinal?.(text)
    this.pendingFinal = null
  }

  /** 'local' transcribes in the helper; 'cloud' hands the audio to audioHandler. */
  setEngine(mode: 'local' | 'cloud'): void {
    this.ensureProcess().stdin.write(`engine ${mode}\n`)
  }

  start(): void {
    const proc = this.ensureProcess()
    proc.stdin.write('start\n')
  }

  /** Resolves with the final transcript once the recogniser flushes. */
  stop(): Promise<string> {
    if (!this.proc) return Promise.resolve('')
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingFinal = null
        resolve('')
      }, 45_000)
      this.pendingFinal = (text) => {
        clearTimeout(timer)
        resolve(text)
      }
      this.proc!.stdin.write('stop\n')
    })
  }

  cancel(): void {
    this.proc?.stdin.write('cancel\n')
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

  checkAccessibility(): void {
    this.proc?.stdin.write('ax-check\n')
  }

  dispose(): void {
    if (!this.proc) return
    this.proc.stdin.write('quit\n')
    this.proc.kill()
    this.proc = null
  }
}

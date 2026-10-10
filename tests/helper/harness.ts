/**
 * Drives any Quill speech helper over its stdin/stdout line protocol.
 * The contract under test is docs/HELPER-PROTOCOL.md.
 *
 * Environment:
 *   HELPER_BIN         path to the helper binary. Defaults to the Swift reference
 *                      helper at resources/FlowSTT.app/Contents/MacOS/flow-stt.
 *   HELPER_ARGS        extra argv for the helper, space separated (optional).
 *   HELPER_NO_MIC=1    skip every test that opens the microphone (CI, headless).
 *   HELPER_MIC         device uid to pin for microphone tests. Defaults to
 *                      BuiltInMicrophoneDevice on macOS, so a Bluetooth headset is
 *                      never switched to its call profile. Required elsewhere.
 *   HELPER_MODEL       whisper model for transcription tests. Defaults to
 *                      ggml-tiny.en.bin in Quill's models folder.
 *   HELPER_SLOW=1      also run the slow tests (the mic test ending by itself).
 *   HELPER_EXPECT_CAPS=1  fail when the helper does not send the `capabilities`
 *                      handshake (the Swift reference helper does not).
 *   HELPER_REAL_HOME=1 do not redirect the helper's home folder. By default the
 *                      helper runs with a throwaway home so its log and its duck
 *                      state file never mix with the real app's.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { homedir, platform, tmpdir } from 'os'
import { join, resolve } from 'path'

export type Event = { type: string; [k: string]: unknown }
type Stamped = { at: number; ev: Event }

const ROOT = resolve(import.meta.dir, '..', '..')
const SWIFT_HELPER = join(ROOT, 'resources', 'FlowSTT.app', 'Contents', 'MacOS', 'flow-stt')

export const HELPER_BIN = process.env.HELPER_BIN ? resolve(process.env.HELPER_BIN) : SWIFT_HELPER
export const HELPER_ARGS = (process.env.HELPER_ARGS ?? '').split(' ').filter(Boolean)
export const IS_MAC = platform() === 'darwin'
export const NO_MIC = process.env.HELPER_NO_MIC === '1'
export const SLOW = process.env.HELPER_SLOW === '1'
export const EXPECT_CAPS = process.env.HELPER_EXPECT_CAPS === '1'
/** The microphone every mic test pins before it records. Empty means none is safe to open. */
export const MIC_UID = process.env.HELPER_MIC ?? (IS_MAC ? 'BuiltInMicrophoneDevice' : '')
export const MODEL =
  process.env.HELPER_MODEL ??
  join(homedir(), 'Library', 'Application Support', 'quill', 'models', 'ggml-tiny.en.bin')
export const HAS_MODEL = existsSync(MODEL)

/** One scratch folder per run: the fake home, fixtures. Removed by cleanupScratch(). */
const scratch = mkdtempSync(join(tmpdir(), 'quill-helper-test-'))
export const FAKE_HOME = process.env.HELPER_REAL_HOME === '1' ? null : join(scratch, 'home')
if (FAKE_HOME) mkdirSync(join(FAKE_HOME, 'Library', 'Logs'), { recursive: true })

export function cleanupScratch(): void {
  rmSync(scratch, { recursive: true, force: true })
}

/** Where the helper under test writes its log and duck state (macOS layout). */
export function helperHomePath(...parts: string[]): string {
  return join(FAKE_HOME ?? homedir(), ...parts)
}

const live = new Set<Helper>()

export class Helper {
  readonly proc: ChildProcessWithoutNullStreams
  /** Every JSON line from stdout, in arrival order, with its arrival time. */
  readonly log: Stamped[] = []
  /** Anything on stdout that was not one JSON object with a string `type`. */
  readonly stray: string[] = []
  stderr = ''
  /** Everything written to stdin, for failure messages. */
  readonly sent: string[] = []
  exit: { code: number | null; signal: NodeJS.Signals | null } | null = null
  private buffer = ''
  private waiters = new Set<() => void>()
  private exited: Promise<void>

  constructor() {
    const env = { ...process.env }
    if (FAKE_HOME) {
      // Foundation reads CFFIXED_USER_HOME; everything else reads HOME.
      env.HOME = FAKE_HOME
      env.CFFIXED_USER_HOME = FAKE_HOME
      env.USERPROFILE = FAKE_HOME
    }
    this.proc = spawn(HELPER_BIN, HELPER_ARGS, { stdio: ['pipe', 'pipe', 'pipe'], env })
    live.add(this)
    this.proc.stdin.on('error', () => { /* written to after it exited */ })
    // Written before the helper has printed anything, exactly as main writes
    // its settings straight after spawn: the hold key and the ducking are off
    // from the first line the helper reads, not from some moment after boot.
    this.makeSafe()
    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk: string) => this.consume(chunk))
    this.proc.stderr.setEncoding('utf8')
    this.proc.stderr.on('data', (d: string) => { this.stderr += d })
    this.exited = new Promise((done) => {
      this.proc.on('error', (err) => {
        this.exit ??= { code: null, signal: null }
        this.stderr += `spawn failed: ${err.message}\n`
        this.wake(); done()
      })
      this.proc.on('close', (code, signal) => {
        if (this.buffer.trim()) this.stray.push(this.buffer)
        this.exit = { code, signal }
        live.delete(this)
        this.wake(); done()
      })
    })
  }

  get pid(): number { return this.proc.pid ?? -1 }
  get events(): Event[] { return this.log.map((s) => s.ev) }

  private consume(chunk: string): void {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) { if (line.length) this.stray.push(line); continue }
      let ev: unknown
      try { ev = JSON.parse(line) } catch { this.stray.push(line); continue }
      if (!ev || typeof ev !== 'object' || Array.isArray(ev) || typeof (ev as Event).type !== 'string') {
        this.stray.push(line)
        continue
      }
      this.log.push({ at: performance.now(), ev: ev as Event })
    }
    this.wake()
  }

  private wake(): void {
    for (const w of [...this.waiters]) w()
  }

  /** Writes one command line. */
  send(line: string): void {
    this.sent.push(line)
    this.proc.stdin.write(line + '\n')
  }

  /** Index a later waitFor can pass as `from` to only see events after this point. */
  mark(): number { return this.log.length }

  /**
   * Resolves with the first event at or after `from` that matches. Rejects
   * with what did arrive when the timeout passes or the helper exits first.
   */
  waitFor<T extends Event = Event>(
    type: string,
    opts: { from?: number; timeout?: number; where?: (ev: T) => boolean } = {}
  ): Promise<T> {
    const { from = 0, timeout = 4000, where } = opts
    return new Promise((resolveEv, reject) => {
      let cursor = from
      let timer: ReturnType<typeof setTimeout> | null = null
      const finish = (fn: () => void): void => {
        if (timer) clearTimeout(timer)
        this.waiters.delete(check)
        fn()
      }
      const describe = (): string =>
        `sent: ${JSON.stringify(this.sent.slice(-8))}\n` +
        `got since: ${JSON.stringify(summarise(this.events.slice(from)))}\n` +
        (this.stderr ? `stderr: ${this.stderr.slice(-400)}\n` : '')
      const check = (): void => {
        for (; cursor < this.log.length; cursor++) {
          const ev = this.log[cursor].ev
          if (ev.type === type && (!where || where(ev as T))) { finish(() => resolveEv(ev as T)); return }
        }
        if (this.exit) finish(() => reject(new Error(`helper exited (${JSON.stringify(this.exit)}) before "${type}"\n${describe()}`)))
      }
      timer = setTimeout(
        () => finish(() => reject(new Error(`no "${type}" event within ${timeout} ms\n${describe()}`))),
        timeout
      )
      this.waiters.add(check)
      check()
    })
  }

  /** Events of one type at or after `from`. */
  since(from: number, type?: string): Event[] {
    const evs = this.log.slice(from).map((s) => s.ev)
    return type ? evs.filter((e) => e.type === type) : evs
  }

  /** Events of one type that arrived more than `graceMs` after the event at `index`. */
  lateAfter(index: number, type: string, graceMs: number): Event[] {
    const t0 = this.log[index]?.at ?? 0
    return this.log.slice(index + 1).filter((s) => s.ev.type === type && s.at - t0 > graceMs).map((s) => s.ev)
  }

  indexOf(ev: Event): number {
    return this.log.findIndex((s) => s.ev === ev)
  }

  waitExit(timeout = 3000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error(`helper still running after ${timeout} ms`)), timeout)
      void this.exited.then(() => { clearTimeout(timer); done(this.exit!) })
    })
  }

  /**
   * Sent first to every helper, from the constructor: nothing this run does
   * may touch the output volume or act on the user's hold key. Safe to repeat.
   */
  makeSafe(): void {
    this.send('duck off')
    this.send('holdkey off')
  }

  /** Always leaves no process behind, whatever state the test left it in. */
  async kill(): Promise<void> {
    if (this.exit) return
    this.send('cancel')
    this.send('mic-test-stop')
    this.send('quit')
    this.proc.stdin.end()
    try {
      await this.waitExit(1500)
    } catch {
      try { process.kill(this.pid, 'SIGKILL') } catch { /* already gone */ }
      await this.waitExit(1500).catch(() => {})
    }
  }
}

/**
 * Events a helper may send at any moment without being asked: the hold key's
 * install state (re-reported while it keeps failing), a re-sent capability
 * list. They never count as an answer to a command.
 */
export const UNSOLICITED = new Set(['hotkey-status', 'capabilities'])

/** What a helper said since `from`, leaving out what it may say unasked. */
export function answersSince(h: Helper, from: number): Event[] {
  return h.since(from).filter((e) => !UNSOLICITED.has(e.type))
}

/**
 * Waits until the helper has said everything it says by itself at boot (the
 * device list, the hold key's state), in whichever order, so that a test which
 * counts events afterwards does not count those.
 */
export async function settled(h: Helper): Promise<void> {
  await h.waitFor('devices', { timeout: 5000 })
  await h.waitFor('hotkey-status', { timeout: 1500 }).catch(() => { /* optional without the hotkey capability */ })
  await sleep(150)
}

/** Level and spectrum lines are frequent; collapse them so a failure message stays readable. */
function summarise(events: Event[]): unknown[] {
  const out: unknown[] = []
  let run: { type: string; n: number } | null = null
  for (const ev of events) {
    const noisy = ev.type === 'level' || ev.type === 'spectrum' || ev.type === 'mic-test-level' || ev.type === 'chunk'
    if (noisy) {
      if (run && run.type === ev.type) run.n++
      else { run = { type: ev.type, n: 1 }; out.push(run) }
    } else {
      run = null
      out.push(ev)
    }
  }
  return out
}

/** Spawns a helper (made safe as it spawns), waits for boot, runs the body, and always reaps it. */
export async function withHelper<T>(body: (h: Helper) => Promise<T>): Promise<T> {
  const h = new Helper()
  try {
    await h.waitFor('boot')
    return await body(h)
  } finally {
    await h.kill()
  }
}

/** Last line of defence: no helper survives the test process. */
export function killStragglers(): void {
  for (const h of live) {
    try { process.kill(h.pid, 'SIGKILL') } catch { /* already gone */ }
  }
}
process.on('exit', killStragglers)

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The device list after pinning the test microphone, or null when that microphone is not connected. */
export async function pinTestMic(h: Helper): Promise<Event | null> {
  if (!MIC_UID) return null
  const from = h.mark()
  h.send(`mic ${MIC_UID}`)
  const ev = await h.waitFor('devices', { from, where: (e) => e.pinned === MIC_UID })
  const devices = ev.devices as { uid: string }[]
  return devices.some((d) => d.uid === MIC_UID) ? ev : null
}

let micProbe: Promise<string | null> | null = null
/**
 * Why microphone tests cannot run here, or null when they can. A pinned
 * device that is not connected would make the helper fall back to the system
 * default, which may be a Bluetooth headset, so that is a skip and not a try.
 */
export function micUnavailable(): Promise<string | null> {
  micProbe ??= (async () => {
    if (NO_MIC) return 'HELPER_NO_MIC=1'
    if (!MIC_UID) return 'no HELPER_MIC given to pin'
    return withHelper(async (h) => ((await pinTestMic(h)) ? null : `microphone ${MIC_UID} is not connected`))
  })()
  return micProbe
}

// ---------------------------------------------------------------- fixtures

export const FIXTURE_TEXT = 'The quick brown fox jumps over the lazy dog.'
export const FIXTURE_WORDS = ['quick', 'brown', 'fox', 'lazy', 'dog']

let fixture: string | null | undefined
/**
 * A 16 kHz mono 16-bit WAV of FIXTURE_TEXT, spoken by macOS `say`. Null where
 * `say` or `afconvert` is missing, so the tests that need it skip.
 */
export function speechFixture(): string | null {
  if (fixture !== undefined) return fixture
  fixture = null
  if (!IS_MAC) return fixture
  const has = (bin: string): boolean => spawnSync('/usr/bin/which', [bin]).status === 0
  if (!has('say') || !has('afconvert')) return fixture
  const aiff = join(scratch, 'fixture.aiff')
  const wav = join(scratch, 'fixture.wav')
  if (spawnSync('say', ['-o', aiff, FIXTURE_TEXT]).status !== 0) return fixture
  if (spawnSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav]).status !== 0) return fixture
  if (!existsSync(wav) || statSync(wav).size < 16_000) return fixture
  fixture = wav
  return fixture
}

/** The fields of a canonical PCM WAV header and its sample bytes, or null when it is not one. */
export function wavInfo(path: string): { format: number; channels: number; rate: number; bits: number; dataBytes: number; data: Buffer } | null {
  const b = readFileSync(path)
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return null
  let off = 12
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4)
    const size = b.readUInt32LE(off + 4)
    if (id === 'fmt ') {
      fmt = { format: b.readUInt16LE(off + 8), channels: b.readUInt16LE(off + 10), rate: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) }
    } else if (id === 'data') {
      const dataBytes = Math.min(size, b.length - off - 8)
      return fmt ? { ...fmt, dataBytes, data: b.subarray(off + 8, off + 8 + dataBytes) } : null
    }
    off += 8 + size + (size % 2)
  }
  return null
}

/** System output volume (0 to 100), or null where it cannot be read without side effects. */
export function outputVolume(): number | null {
  if (!IS_MAC) return null
  const r = spawnSync('osascript', ['-e', 'output volume of (get volume settings)'], { encoding: 'utf8' })
  const v = Number(r.stdout.trim())
  return r.status === 0 && Number.isFinite(v) && r.stdout.trim() !== '' ? v : null
}

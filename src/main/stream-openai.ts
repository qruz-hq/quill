import WebSocket from 'ws'
import type { LiveStream, StreamOpts } from './stream'

const REALTIME = 'wss://api.openai.com/v1/realtime'
const OPEN_TIMEOUT_MS = 4_000
const FINAL_TIMEOUT_MS = 6_000
/** The only PCM rate a Realtime session accepts. The helper captures at 16 kHz. */
const RATE_IN = 16_000
const RATE_OUT = 24_000

/**
 * Models that send text while the audio is still arriving (measured: first
 * words under a second and a half in, then word by word).
 */
export const OPENAI_LIVE_MODELS = ['gpt-live-transcribe', 'gpt-realtime-whisper'] as const
/**
 * Models a realtime session accepts but that only start transcribing at the
 * commit, which for push-to-talk is the release. Nothing live to show, yet
 * the audio is already uploaded by then, so the text still comes back sooner
 * than from the batch upload.
 */
export const OPENAI_PREUPLOAD_MODELS = ['gpt-4o-transcribe', 'gpt-4o-mini-transcribe'] as const
/** The batch endpoint rejects the live models; a failed stream of one is redone with this. */
export const OPENAI_BATCH_FALLBACK = 'gpt-4o-mini-transcribe'

/** True when this OpenAI model shows words while the user is still speaking. */
export function openaiLive(model: string): boolean {
  return (OPENAI_LIVE_MODELS as readonly string[]).includes(model)
}

/** True when this OpenAI model can be streamed at all (live, or uploaded ahead of the release). */
export function openaiStreams(model: string): boolean {
  return openaiLive(model) || (OPENAI_PREUPLOAD_MODELS as readonly string[]).includes(model)
}

/** The model the batch endpoint should get for this setting. */
export function openaiBatchModel(model: string): string {
  return openaiLive(model) ? OPENAI_BATCH_FALLBACK : model
}

/**
 * 16 kHz to 24 kHz, PCM16 mono, by linear interpolation. Two input samples
 * become three, which for speech is indistinguishable from a proper filter.
 * Stateful: the last sample and the read position carry over, so chunk
 * boundaries are seamless.
 */
class Upsampler {
  private prev = 0
  /** Read position in input samples, relative to the next chunk; -1 is `prev`. */
  private pos = 0
  private primed = false

  run(input: Buffer): Buffer {
    const n = input.length >> 1
    if (!n) return Buffer.alloc(0)
    if (!this.primed) { this.prev = input.readInt16LE(0); this.primed = true }
    const step = RATE_IN / RATE_OUT
    const out = Buffer.alloc(Math.ceil((n - this.pos) / step + 1) * 2)
    let w = 0
    let p = this.pos
    for (; p < n - 1 || (p <= n - 1 && Number.isInteger(p)); p += step) {
      const i = Math.floor(p)
      const a = i < 0 ? this.prev : input.readInt16LE(i * 2)
      const b = i + 1 < n ? input.readInt16LE((i + 1) * 2) : a
      const f = p - i
      out.writeInt16LE(Math.round(a + (b - a) * f), w)
      w += 2
    }
    this.prev = input.readInt16LE((n - 1) * 2)
    this.pos = p - n
    return out.subarray(0, w)
  }
}

/**
 * OpenAI Realtime transcription over a WebSocket: the same job, and the same
 * surface, as the ElevenLabs RealtimeStream.
 *
 * A transcription session (`session.type = "transcription"`) with turn
 * detection off: push-to-talk already knows where the utterance ends, so the
 * audio is committed once, on release, and exactly one completed transcript
 * comes back. Deltas arrive while the user is still speaking and add up to
 * the running text.
 *
 * Every failure path is non-fatal. The helper still writes the WAV, so a
 * refused session, a dropped socket or a timeout falls through to the batch
 * upload: a slower dictation, never a lost one.
 */
export class OpenAIRealtimeStream implements LiveStream {
  private ws: WebSocket | null = null
  /** Text per conversation item, in the order the items first appeared. */
  private items = new Map<string, string>()
  private done = new Set<string>()
  private failure: string | null = null
  private opened = false
  private appended = false
  private resolveFinal: ((text: string) => void) | null = null
  /** Chunks captured before the session was configured. */
  private pending: string[] = []
  private up = new Upsampler()

  onText: ((text: string) => void) | null = null

  get error(): string | null {
    return this.failure
  }

  get live(): boolean {
    return this.opened && this.ws?.readyState === WebSocket.OPEN
  }

  async open(o: StreamOpts): Promise<boolean> {
    const langs = o.languages.filter((l) => l && l !== 'auto')
    const transcription: Record<string, unknown> = { model: o.model }
    // gpt-live-transcribe takes the whole set; every other model takes a
    // single hint and rejects the list outright.
    if (langs.length) {
      if (o.model === 'gpt-live-transcribe') transcription.languages = langs
      else if (langs.length === 1) transcription.language = langs[0]
    }
    // Only the live models have a delay to trade against accuracy.
    if (o.delay && openaiLive(o.model)) transcription.delay = o.delay

    return await new Promise<boolean>((resolve) => {
      let settled = false
      const done = (ok: boolean, err?: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (err) this.failure = err
        resolve(ok)
      }
      const timer = setTimeout(() => done(false, 'realtime connect timed out'), OPEN_TIMEOUT_MS)

      try {
        this.ws = new WebSocket(`${REALTIME}?intent=transcription`, {
          headers: { Authorization: `Bearer ${o.key}` }
        })
      } catch (e) {
        return done(false, (e as Error).message)
      }

      this.ws.on('open', () => {
        try {
          this.ws!.send(JSON.stringify({
            type: 'session.update',
            session: {
              type: 'transcription',
              audio: {
                input: {
                  format: { type: 'audio/pcm', rate: RATE_OUT },
                  transcription,
                  // Manual commit on release; no server VAD cutting the utterance.
                  turn_detection: null,
                  noise_reduction: { type: 'near_field' }
                }
              }
            }
          }))
        } catch (e) {
          done(false, (e as Error).message)
        }
      })
      this.ws.on('error', (e: Error) => {
        this.failure = e.message
        done(false, e.message)
        // A mid-stream error still has to release finish().
        this.resolveFinal?.(this.bestEffort())
      })
      this.ws.on('close', () => {
        this.opened = false
        done(false, this.failure ?? 'realtime socket closed')
        this.resolveFinal?.(this.bestEffort())
      })
      this.ws.on('message', (raw: Buffer) => this.onMessage(raw, done))
    })
  }

  private onMessage(raw: Buffer, opened: (ok: boolean, err?: string) => void): void {
    let m: Record<string, unknown>
    try {
      m = JSON.parse(raw.toString()) as Record<string, unknown>
    } catch {
      return
    }
    switch (m.type) {
      case 'session.updated': {
        // Only now is the session a transcription session with our settings.
        this.opened = true
        const queued = this.pending
        this.pending = []
        for (const b of queued) this.push(b)
        opened(true)
        break
      }
      case 'conversation.item.input_audio_transcription.delta': {
        const id = String(m.item_id ?? '')
        if (this.done.has(id)) break
        this.items.set(id, (this.items.get(id) ?? '') + String(m.delta ?? ''))
        this.emitText()
        break
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const id = String(m.item_id ?? '')
        this.done.add(id)
        this.items.set(id, String(m.transcript ?? ''))
        this.emitText()
        this.resolveFinal?.(this.bestEffort())
        break
      }
      case 'conversation.item.input_audio_transcription.failed':
      case 'error': {
        const e = m.error as { message?: unknown; code?: unknown } | undefined
        this.failure = String(e?.message ?? e?.code ?? m.type)
        // Before the session is configured this is the open failing.
        opened(false, this.failure)
        this.resolveFinal?.(this.bestEffort())
        break
      }
      default:
        break
    }
  }

  /** Takes the helper's 16 kHz PCM16 chunks (base64) and sends them on at 24 kHz. */
  push(b64: string): void {
    if (!this.live) {
      // Cap the buffer so a socket that never opens cannot grow without bound.
      if (!this.failure && this.pending.length < 100) this.pending.push(b64)
      return
    }
    try {
      const audio = this.up.run(Buffer.from(b64, 'base64'))
      if (!audio.length) return
      this.ws!.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: audio.toString('base64') }))
      this.appended = true
    } catch (e) {
      this.failure = (e as Error).message
    }
  }

  /** Commits the utterance and resolves with the transcript, or '' on any failure. */
  async finish(): Promise<string> {
    // Committing an empty buffer is an error, and there is nothing to wait for.
    if (!this.live || !this.appended) return this.bestEffort()

    const got = new Promise<string>((resolve) => {
      this.resolveFinal = resolve
    })
    try {
      this.ws!.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
    } catch (e) {
      this.failure = (e as Error).message
      this.close()
      return this.bestEffort()
    }

    const timeout = new Promise<string>((r) => setTimeout(() => r(''), FINAL_TIMEOUT_MS))
    const text = await Promise.race([got, timeout])
    // A failure after the commit means the text so far is not the whole
    // utterance: report nothing, so the batch upload redoes it properly.
    const complete = this.done.size > 0
    this.close()
    return complete ? (text || this.bestEffort()).trim() : ''
  }

  private emitText(): void {
    const text = this.bestEffort()
    if (text) this.onText?.(text)
  }

  private bestEffort(): string {
    return [...this.items.values()].map((t) => t.trim()).filter(Boolean).join(' ').trim()
  }

  close(): void {
    this.resolveFinal = null
    this.onText = null
    try {
      this.ws?.close()
    } catch {
      /* already gone */
    }
    this.ws = null
    this.opened = false
  }
}

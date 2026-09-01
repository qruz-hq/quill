import WebSocket from 'ws'

const REALTIME = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime'
const OPEN_TIMEOUT_MS = 4_000
const FINAL_TIMEOUT_MS = 6_000

export type StreamOpts = {
  key: string
  model: string
  languages: string[]
  noVerbatim: boolean
}

/**
 * ElevenLabs Scribe v2 Realtime over a WebSocket.
 *
 * The point is to have the audio uploaded by the time the key comes up, so the
 * only latency left is the tail rather than the whole clip. It saves ~400ms of
 * a ~1700ms wait — worth having, but the LLM cleanup afterwards is still the
 * floor, so this is not the difference between slow and instant.
 *
 * Commit strategy is `manual` rather than `vad`: push-to-talk already knows
 * where the utterance ends, and manual means exactly one committed_transcript
 * comes back, instead of having to guess whether VAD already flushed the tail.
 *
 * Every failure path here is non-fatal. The Swift side still writes the WAV,
 * so a refused connection, a dropped socket or a timeout just falls through to
 * the batch upload and the user sees a slower dictation, not a lost one.
 */
export class RealtimeStream {
  private ws: WebSocket | null = null
  private committed: string[] = []
  private lastPartial = ''
  private failure: string | null = null
  private opened = false
  private resolveFinal: ((text: string) => void) | null = null
  /** Chunks captured before the socket finished opening. */
  private pending: string[] = []

  get error(): string | null {
    return this.failure
  }

  get live(): boolean {
    return this.opened && this.ws?.readyState === WebSocket.OPEN
  }

  async open(o: StreamOpts): Promise<boolean> {
    const q = new URLSearchParams({
      model_id: o.model,
      audio_format: 'pcm_16000',
      commit_strategy: 'manual'
    })
    // Realtime takes a primary language plus secondaries, so unlike the batch
    // endpoint there is no reason to fall back to detection when several are
    // configured. Detection is what made French weak in the first place.
    //
    // secondary_languages MUST be repeated params: `a,b` and `["a"]` are both
    // accepted by the handshake and then hang the socket rather than erroring.
    const langs = o.languages.filter((l) => l && l !== 'auto')
    if (langs.length) {
      q.set('language_code', langs[0])
      for (const l of langs.slice(1)) q.append('secondary_languages', l)
    }
    // Drops filler words and false starts. scribe_v2 only — the API rejects it
    // on v1, which would take the whole connection down.
    if (o.noVerbatim && o.model.startsWith('scribe_v2')) q.set('no_verbatim', 'true')

    return await new Promise<boolean>((resolve) => {
      let settled = false
      const done = (ok: boolean, err?: string): void => {
        if (settled) return
        settled = true
        if (err) this.failure = err
        resolve(ok)
      }
      const timer = setTimeout(() => done(false, 'realtime connect timed out'), OPEN_TIMEOUT_MS)

      try {
        this.ws = new WebSocket(`${REALTIME}?${q.toString()}`, {
          headers: { 'xi-api-key': o.key }
        })
      } catch (e) {
        clearTimeout(timer)
        return done(false, (e as Error).message)
      }

      this.ws.on('open', () => {
        clearTimeout(timer)
        this.opened = true
        // Recording starts before the handshake completes, so the first half
        // second of speech is usually already waiting here.
        const queued = this.pending
        this.pending = []
        for (const b of queued) this.push(b)
        done(true)
      })
      this.ws.on('error', (e: Error) => {
        clearTimeout(timer)
        this.failure = e.message
        done(false, e.message)
        // A mid-stream error still has to release finish().
        this.resolveFinal?.(this.bestEffort())
      })
      this.ws.on('close', () => {
        this.opened = false
        this.resolveFinal?.(this.bestEffort())
      })
      this.ws.on('message', (raw: Buffer) => this.onMessage(raw))
    })
  }

  private onMessage(raw: Buffer): void {
    let m: Record<string, unknown>
    try {
      m = JSON.parse(raw.toString()) as Record<string, unknown>
    } catch {
      return
    }
    switch (m.message_type) {
      case 'committed_transcript': {
        const t = String(m.text ?? '')
        if (t) this.committed.push(t)
        this.lastPartial = ''
        this.resolveFinal?.(this.bestEffort())
        break
      }
      case 'partial_transcript':
        this.lastPartial = String(m.text ?? '')
        break
      case 'error':
      case 'auth_error':
      case 'quota_exceeded':
      case 'rate_limited':
        this.failure = String(m.error ?? m.message ?? m.message_type)
        this.resolveFinal?.(this.bestEffort())
        break
      default:
        break
    }
  }

  push(b64: string): void {
    if (!this.live) {
      // Cap the buffer so a socket that never opens cannot grow without bound.
      if (!this.failure && this.pending.length < 40) this.pending.push(b64)
      return
    }
    try {
      this.ws!.send(
        JSON.stringify({
          message_type: 'input_audio_chunk',
          audio_base_64: b64,
          sample_rate: 16_000,
          commit: false
        })
      )
    } catch (e) {
      this.failure = (e as Error).message
    }
  }

  /** Commits the utterance and resolves with the transcript, or '' on any failure. */
  async finish(): Promise<string> {
    if (!this.live) return this.bestEffort()

    const got = new Promise<string>((resolve) => {
      this.resolveFinal = resolve
    })
    try {
      this.ws!.send(
        JSON.stringify({
          message_type: 'input_audio_chunk',
          audio_base_64: '',
          sample_rate: 16_000,
          commit: true
        })
      )
    } catch (e) {
      this.failure = (e as Error).message
      this.close()
      return this.bestEffort()
    }

    const timeout = new Promise<string>((r) => setTimeout(() => r(''), FINAL_TIMEOUT_MS))
    const text = await Promise.race([got, timeout])
    this.close()
    return (text || this.bestEffort()).trim()
  }

  private bestEffort(): string {
    return (this.committed.join(' ') || this.lastPartial).trim()
  }

  close(): void {
    this.resolveFinal = null
    try {
      this.ws?.close()
    } catch {
      /* already gone */
    }
    this.ws = null
    this.opened = false
  }
}

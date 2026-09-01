import { readFileSync, unlinkSync, existsSync, statSync } from 'fs'
import { basename } from 'path'

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions'
const ELEVEN_ENDPOINT = 'https://api.elevenlabs.io/v1/speech-to-text'
const TIMEOUT_MS = 30_000

export type Provider = 'openai' | 'elevenlabs'

export type CloudResult = { text: string; error?: string; ms: number }

/**
 * Uploads a WAV to OpenAI for transcription.
 *
 * Cloud transcription exists for one reason: local models good enough at French
 * are 1.6GB resident, which is too much for something running all day. The
 * trade is that audio leaves the machine, so it is opt-in.
 */
export async function transcribeCloud(
  wavPath: string,
  key: string,
  model: string,
  languages: string[],
  provider: Provider = 'openai',
  noVerbatim = false
): Promise<CloudResult> {
  const started = Date.now()
  if (!existsSync(wavPath)) return { text: '', error: 'audio file missing', ms: 0 }

  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS)
  try {
    const eleven = provider === 'elevenlabs'
    const form = new FormData()
    form.append('file', new Blob([readFileSync(wavPath)], { type: 'audio/wav' }), basename(wavPath))
    // The two APIs disagree on every field name.
    form.append(eleven ? 'model_id' : 'model', model)

    // Only pin the language when there is exactly one; otherwise let it detect.
    const single = languages.filter((l) => l && l !== 'auto')
    if (single.length === 1) form.append(eleven ? 'language_code' : 'language', single[0])

    // Drops filler words, false starts and non-speech sounds. ElevenLabs only,
    // and only on scribe_v2 — v1 rejects the field outright.
    if (eleven && noVerbatim && model.startsWith('scribe_v2')) form.append('no_verbatim', 'true')

    const r = await fetch(eleven ? ELEVEN_ENDPOINT : OPENAI_ENDPOINT, {
      method: 'POST',
      signal: abort.signal,
      headers: eleven ? { 'xi-api-key': key } : { Authorization: `Bearer ${key}` },
      body: form
    })
    const ms = Date.now() - started
    if (!r.ok) {
      const body = await r.text().catch(() => '')
      let msg = `HTTP ${r.status}`
      try {
        const j = JSON.parse(body)
        const detail = j?.error?.message ?? j?.detail?.message ?? j?.detail
        if (detail) msg += ` — ${String(detail).slice(0, 140)}`
      } catch { /* keep the status */ }
      return { text: '', error: msg, ms }
    }
    const json = await r.json()
    // ElevenLabs returns text at the root, or per channel for multichannel audio.
    const text = json?.text ?? json?.transcripts?.[0]?.text ?? ''
    return { text: String(text).trim(), ms }
  } catch (err) {
    const e = err as Error
    return {
      text: '',
      error: e.name === 'AbortError' ? `timed out after ${TIMEOUT_MS}ms` : e.message,
      ms: Date.now() - started
    }
  } finally {
    clearTimeout(timer)
  }
}

export function audioSizeMB(p: string): number {
  try { return statSync(p).size / 1e6 } catch { return 0 }
}

export function discard(p: string): void {
  try { if (existsSync(p)) unlinkSync(p) } catch { /* non-fatal */ }
}

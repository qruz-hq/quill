import { app } from 'electron'
import { join } from 'path'
import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync, renameSync, readdirSync } from 'fs'
import { EventEmitter } from 'events'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'

export type ModelId = 'tiny.en' | 'base.en' | 'small.en' | 'base' | 'small' | 'large-v3-turbo'

export type ModelInfo = {
  id: ModelId
  label: string
  bytes: number
  /** Word error rate measured locally on a technical-vocabulary set. */
  wer: string
  note: string
  multilingual?: boolean
}

/** Sizes are the real ggml file sizes; WER figures are from our own benchmark. */
export const CATALOG: ModelInfo[] = [
  { id: 'tiny.en',        label: 'Tiny',   bytes:   77_691_713, wer: '4.8%', note: 'Fastest. Fine for short notes.' },
  { id: 'base.en',        label: 'Base',   bytes:  147_951_465, wer: '2.9%', note: 'Recommended. Best accuracy per megabyte.' },
  { id: 'small.en',       label: 'Small',  bytes:  487_601_967, wer: '2.9%', note: 'No better than Base here, but steadier on long audio.' },
  { id: 'base',           label: 'Base (multilingual)',  bytes:  147_951_465, wer: '—', note: 'Same size as Base, but understands ~99 languages.', multilingual: true },
  { id: 'small',          label: 'Small (multilingual)', bytes:  487_601_967, wer: '—', note: 'Noticeably better than Base outside English.', multilingual: true },
  { id: 'large-v3-turbo', label: 'Large',  bytes: 1_624_555_275, wer: '—',   note: 'Most accurate, and handles other languages.', multilingual: true }
]

const BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

export class ModelStore extends EventEmitter {
  private cancelled = new Set<ModelId>()

  get dir(): string {
    const d = join(app.getPath('userData'), 'models')
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
    return d
  }

  pathFor(id: ModelId): string {
    return join(this.dir, `ggml-${id}.bin`)
  }

  /** A model counts as installed only at its full expected size — a truncated
   *  download would otherwise look valid and fail cryptically at transcribe time. */
  isInstalled(id: ModelId): boolean {
    const p = this.pathFor(id)
    if (!existsSync(p)) return false
    const want = CATALOG.find((m) => m.id === id)?.bytes ?? 0
    return statSync(p).size >= want * 0.98
  }

  /**
   * Removes orphaned .part files. A download interrupted by a crash or a quit
   * leaves its temp file behind, silently occupying disk that nothing will ever
   * finish or clean up.
   */
  sweepPartials(): { removed: string[]; bytes: number } {
    const removed: string[] = []
    let bytes = 0
    try {
      for (const f of readdirSync(this.dir)) {
        if (!f.endsWith('.part')) continue
        const full = join(this.dir, f)
        bytes += statSync(full).size
        unlinkSync(full)
        removed.push(f)
      }
    } catch { /* non-fatal */ }
    return { removed, bytes }
  }

  list(): (ModelInfo & { installed: boolean })[] {
    return CATALOG.map((m) => ({ ...m, installed: this.isInstalled(m.id) }))
  }

  cancel(id: ModelId): void {
    this.cancelled.add(id)
  }

  async download(id: ModelId): Promise<void> {
    if (this.isInstalled(id)) return
    this.cancelled.delete(id)

    const dest = this.pathFor(id)
    const tmp = `${dest}.part`
    const res = await fetch(`${BASE_URL}/ggml-${id}.bin`)
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`)

    const total = Number(res.headers.get('content-length')) ||
                  CATALOG.find((m) => m.id === id)!.bytes
    let seen = 0
    let lastEmit = 0

    const src = Readable.fromWeb(res.body as never)
    src.on('data', (chunk: Buffer) => {
      seen += chunk.length
      const now = Date.now()
      if (now - lastEmit > 150) {           // don't flood the renderer
        lastEmit = now
        this.emit('progress', { id, received: seen, total })
      }
      if (this.cancelled.has(id)) src.destroy(new Error('cancelled'))
    })

    try {
      await pipeline(src, createWriteStream(tmp))
    } catch (err) {
      if (existsSync(tmp)) unlinkSync(tmp)
      if (this.cancelled.has(id)) { this.emit('cancelled', { id }); return }
      throw err
    }

    // Only becomes the real file once complete, so a crash can't leave a stub.
    renameSync(tmp, dest)
    this.emit('progress', { id, received: total, total })
    this.emit('done', { id })
  }

  remove(id: ModelId): void {
    const p = this.pathFor(id)
    if (existsSync(p)) unlinkSync(p)
  }
}

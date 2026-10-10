import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'

export type TransformKind = 'template' | 'bullets' | 'join' | 'case'

export type Transform = {
  id: string
  name: string
  description: string
  /** 1–9, applied with ⌥<n>. */
  slot: number
  kind: TransformKind
  /** template: text with {text}; case: upper|lower|title. */
  config: string
  /** Times applied with ⌥<n> (never previews). */
  uses?: number
  /** Epoch ms of the last real application. */
  lastUsedAt?: number
}

/** Broadcast on `transforms:applied` whenever ⌥<n> applies a transform. */
export type TransformApplied = { id: string; name: string; slot: number; at: number; uses: number }

const SEEDS: Omit<Transform, 'id'>[] = [
  { name: 'Bullet list', description: 'Break a spoken list into bullet points', slot: 1, kind: 'bullets', config: '' },
  { name: 'Prompt Engineer', description: 'Wrap the text as a well-formed prompt', slot: 2, kind: 'template',
    config: 'You are an expert assistant. Complete the following task precisely and concisely.\n\nTask: {text}\n\nIf anything is ambiguous, state your assumption before answering.' },
  { name: 'Single paragraph', description: 'Collapse line breaks into flowing prose', slot: 3, kind: 'join', config: '' },
  { name: 'Title Case', description: 'Capitalise each significant word', slot: 4, kind: 'case', config: 'title' }
]

export class TransformStore {
  private items: Transform[] = []
  private loaded = false

  private get file(): string {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return join(dir, 'transforms.json')
  }

  private load(): void {
    if (this.loaded) return
    try { this.items = JSON.parse(readFileSync(this.file, 'utf8')) }
    catch {
      this.items = SEEDS.map((t, i) => ({ ...t, id: `t${Date.now()}${i}` }))
      this.persist()
    }
    this.loaded = true
  }

  private persist(): void {
    try { writeFileSync(this.file, JSON.stringify(this.items, null, 2)) } catch { /* non-fatal */ }
  }

  list(): Transform[] { this.load(); return [...this.items].sort((a, b) => a.slot - b.slot) }
  bySlot(slot: number): Transform | undefined { this.load(); return this.items.find((t) => t.slot === slot) }

  save(patch: Partial<Transform> & { id?: string }): Transform {
    this.load()
    // Counters are main-owned; a stale copy from the renderer must not reset them.
    const { uses: _u, lastUsedAt: _l, ...clean } = patch
    patch = clean
    if (patch.id) {
      const found = this.items.find((t) => t.id === patch.id)
      if (found) { Object.assign(found, patch); this.persist(); return found }
    }
    const used = new Set(this.items.map((t) => t.slot))
    let slot = patch.slot ?? 1
    while (used.has(slot) && slot < 10) slot++
    const created: Transform = {
      id: `t${Date.now()}`,
      name: patch.name ?? 'Untitled',
      description: patch.description ?? '',
      slot,
      kind: patch.kind ?? 'template',
      config: patch.config ?? '{text}'
    }
    this.items.push(created)
    this.persist()
    return created
  }

  remove(id: string): void {
    this.load()
    this.items = this.items.filter((t) => t.id !== id)
    this.persist()
  }

  /** Counts one real application; returns the event payload. */
  recordUse(id: string): TransformApplied | null {
    this.load()
    const t = this.items.find((x) => x.id === id)
    if (!t) return null
    t.uses = (t.uses ?? 0) + 1
    t.lastUsedAt = Date.now()
    this.persist()
    return { id: t.id, name: t.name, slot: t.slot, at: t.lastUsedAt, uses: t.uses }
  }

  /** The most recently applied transform, for the hub's "Last applied" tile. */
  lastApplied(): TransformApplied | null {
    this.load()
    let best: Transform | null = null
    for (const t of this.items) if (t.lastUsedAt && (!best || t.lastUsedAt > (best.lastUsedAt ?? 0))) best = t
    return best ? { id: best.id, name: best.name, slot: best.slot, at: best.lastUsedAt!, uses: best.uses ?? 0 } : null
  }

  apply(t: Transform, text: string): string {
    switch (t.kind) {
      case 'template':
        return t.config.includes('{text}') ? t.config.replace(/\{text\}/g, text) : `${t.config}\n\n${text}`
      case 'join':
        return text.replace(/\s*\n+\s*/g, ' ').replace(/ {2,}/g, ' ').trim()
      case 'case':
        if (t.config === 'upper') return text.toUpperCase()
        if (t.config === 'lower') return text.toLowerCase()
        return titleCase(text)
      case 'bullets':
        return toBullets(text)
    }
  }
}

const MINOR = new Set(['a','an','and','as','at','but','by','for','in','of','on','or','the','to','with'])

function titleCase(s: string): string {
  return s.split(/(\s+)/).map((w, i) => {
    const bare = w.toLowerCase()
    if (i > 0 && MINOR.has(bare.replace(/[^a-z]/g, ''))) return bare
    return w.replace(/^([a-z])/, (c) => c.toUpperCase())
  }).join('')
}

/** Splits a spoken list into bullets, keeping any lead-in on its own line. */
function toBullets(text: string): string {
  const trimmed = text.trim().replace(/[.]$/, '')
  const parts = trimmed
    .split(/,| and (?=[^,]*$)/i)
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length < 2) return text

  let lead = ''
  const first = parts[0]
  const m = first.match(/^(.*?\b(?:buy|get|need|want|grab|are|include|order|bring|do)\b)\s+(.+)$/i)
  if (m) { lead = m[1]; parts[0] = m[2] }

  const bullets = parts
    .map((p) => p.replace(/^(and|or)\s+/i, ''))
    .map((p) => `- ${p.charAt(0).toUpperCase()}${p.slice(1)}`)
    .join('\n')
  return lead ? `${lead}:\n${bullets}` : bullets
}

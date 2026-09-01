import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'

export type Snippet = { id: string; trigger: string; expansion: string; enabled: boolean }

const SEEDS: Omit<Snippet, 'id'>[] = [
  { trigger: 'my email address', expansion: 'you@example.com', enabled: true },
  { trigger: 'intro email', expansion: 'Hey — would love to find some time to chat this week. Does Thursday or Friday suit you better?', enabled: true },
  { trigger: 'rewrite prompt', expansion: 'Rewrite this to be more concise while keeping the original meaning and tone.', enabled: true }
]

/**
 * Spoken shortcuts: say a trigger phrase, get the full text typed out.
 * Matching is done on letters and digits only, because whisper punctuates and
 * capitalises — "my email address" arrives as "My email address," and a naive
 * string compare would never fire.
 */
export class SnippetStore {
  private items: Snippet[] = []
  private loaded = false

  private get file(): string {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return join(dir, 'snippets.json')
  }

  private load(): void {
    if (this.loaded) return
    try { this.items = JSON.parse(readFileSync(this.file, 'utf8')) }
    catch {
      this.items = SEEDS.map((s, i) => ({ ...s, id: `s${Date.now()}${i}` }))
      this.persist()
    }
    this.loaded = true
  }

  private persist(): void {
    try { writeFileSync(this.file, JSON.stringify(this.items, null, 2)) } catch { /* non-fatal */ }
  }

  list(): Snippet[] { this.load(); return [...this.items] }

  save(patch: Partial<Snippet> & { id?: string }): Snippet {
    this.load()
    if (patch.id) {
      const found = this.items.find((s) => s.id === patch.id)
      if (found) { Object.assign(found, patch); this.persist(); return found }
    }
    const created: Snippet = {
      id: `s${Date.now()}`,
      trigger: patch.trigger ?? '',
      expansion: patch.expansion ?? '',
      enabled: patch.enabled ?? true
    }
    this.items.push(created)
    this.persist()
    return created
  }

  remove(id: string): void {
    this.load()
    this.items = this.items.filter((s) => s.id !== id)
    this.persist()
  }

  /** Replaces any spoken trigger in `text` with its expansion. */
  apply(text: string): { text: string; used: string[] } {
    this.load()
    const used: string[] = []
    let out = text

    // Longest triggers first, so "my email address" wins over "my email".
    const active = this.items
      .filter((s) => s.enabled && s.trigger.trim() && s.expansion)
      .sort((a, b) => b.trigger.length - a.trigger.length)

    for (const s of active) {
      const re = phraseRegex(s.trigger)
      if (re.test(out)) {
        out = out.replace(re, () => s.expansion)
        used.push(s.trigger)
      }
    }
    return { text: out, used }
  }
}

/**
 * Matches a spoken phrase regardless of the punctuation and casing whisper
 * adds: word characters are matched literally, gaps allow any non-word run.
 */
function phraseRegex(trigger: string): RegExp {
  const words = trigger.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean)
  if (!words.length) return /(?!)/
  const body = words.map(escapeRe).join('[^a-zA-Z0-9]+')
  return new RegExp(`\\b${body}\\b[.,!?;:]*`, 'gi')
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

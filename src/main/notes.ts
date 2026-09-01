import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'

export type Note = {
  id: string
  title: string
  body: string          // HTML from the rich-text editor
  createdAt: number
  updatedAt: number
}

/**
 * Scratchpad note storage. A single JSON file rather than a database: notes are
 * small, few, and read entirely on open — anything heavier would be ceremony.
 */
export class NoteStore {
  private notes: Note[] = []
  private loaded = false

  private get file(): string {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return join(dir, 'scratchpad.json')
  }

  private load(): void {
    if (this.loaded) return
    try { this.notes = JSON.parse(readFileSync(this.file, 'utf8')) } catch { this.notes = [] }
    this.loaded = true
  }

  private persist(): void {
    try { writeFileSync(this.file, JSON.stringify(this.notes, null, 2)) } catch { /* non-fatal */ }
  }

  /** Newest first — the note list is always most-recently-touched. */
  list(): Note[] {
    this.load()
    return [...this.notes].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get(id: string): Note | undefined {
    this.load()
    return this.notes.find((n) => n.id === id)
  }

  create(): Note {
    this.load()
    const now = Date.now()
    const note: Note = { id: `n${now}${Math.floor(Math.random() * 1e4)}`, title: '', body: '', createdAt: now, updatedAt: now }
    this.notes.push(note)
    this.persist()
    return note
  }

  update(id: string, patch: Partial<Pick<Note, 'title' | 'body'>>): Note | undefined {
    this.load()
    const n = this.notes.find((x) => x.id === id)
    if (!n) return undefined
    Object.assign(n, patch, { updatedAt: Date.now() })
    // Untitled notes take their name from the first line, like the real app.
    if (!patch.title && patch.body !== undefined) {
      const text = patch.body.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').trim()
      n.title = text.split('\n')[0].slice(0, 60)
    }
    this.persist()
    return n
  }

  remove(id: string): void {
    this.load()
    this.notes = this.notes.filter((n) => n.id !== id)
    this.persist()
  }
}

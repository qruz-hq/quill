import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'

export type Todo = {
  id: string
  title: string
  description: string
  /** Due date as YYYY-MM-DD, or null. A calendar date, deliberately not a timestamp. */
  due: string | null
  /** HH:MM, or null for an all-day item. Only meaningful with a due date. */
  time: string | null
  /** Parsed from a leading `@Name:` in the title. The title keeps the prefix. */
  project: string | null
  /** EventKit identifier once the todo has been placed on the calendar. */
  eventId: string | null
  done: boolean
  /** Manual sort position among open items; done items keep theirs for undo. */
  order: number
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

export type TodoPatch = Partial<Pick<Todo, 'title' | 'description' | 'due' | 'time' | 'done' | 'eventId'>>

export type Project = { name: string; count: number }

/** `@Quill release: fix it` -> "Quill release". Everything up to the first colon. */
export function parseProject(title: string): string | null {
  const m = /^@([^:]+):/.exec(title.trim())
  const name = m?.[1].trim()
  return name || null
}

type FileV2 = { version: 2; todos: Todo[]; collapsed: string[] }

/**
 * One global list, same JSON-file approach as notes. Kept separate from the
 * Scratchpad on purpose: a todo is a small structured record with a due date
 * and a done flag, not a document, and mixing the two would have meant parsing
 * checkboxes back out of note HTML.
 */
export class TodoStore {
  private todos: Todo[] = []
  /** Project names the user has collapsed, lower-cased. */
  private collapsed = new Set<string>()
  private loaded = false

  private get file(): string {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return join(dir, 'todos.json')
  }

  private load(): void {
    if (this.loaded) return
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Todo[] | FileV2
      // v1 was a bare array; projects had not been parsed yet.
      if (Array.isArray(raw)) {
        this.todos = raw.map((t) => ({ ...t, project: t.project ?? parseProject(t.title), time: t.time ?? null, eventId: t.eventId ?? null }))
      } else {
        this.todos = raw.todos.map((t) => ({ ...t, time: t.time ?? null, eventId: t.eventId ?? null }))
        this.collapsed = new Set(raw.collapsed)
      }
    } catch { this.todos = [] }
    this.loaded = true
  }

  private persist(): void {
    const data: FileV2 = { version: 2, todos: this.todos, collapsed: [...this.collapsed] }
    try { writeFileSync(this.file, JSON.stringify(data, null, 2)) } catch { /* non-fatal */ }
  }

  /**
   * Resolves a typed name to the spelling already in use, so `@quill:` joins
   * "Quill" instead of forking a second project. First spelling wins.
   */
  private canonical(name: string | null): string | null {
    if (!name) return null
    const lower = name.toLowerCase()
    const existing = this.todos.find((t) => t.project?.toLowerCase() === lower)
    return existing?.project ?? name
  }

  /** Rewrites the title's prefix to the canonical spelling. */
  private normaliseTitle(title: string, project: string | null): string {
    if (!project) return title
    return title.replace(/^@[^:]+:/, `@${project}:`)
  }

  /** Open items by manual order, then done items newest-completed first. */
  list(): Todo[] {
    this.load()
    return [...this.todos].sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1
      if (a.done) return (b.completedAt ?? 0) - (a.completedAt ?? 0)
      return a.order - b.order
    })
  }

  add(input: { title: string; description?: string; due?: string | null; time?: string | null }): Todo | null {
    this.load()
    const title = input.title.trim()
    if (!title) return null
    const now = Date.now()
    const project = this.canonical(parseProject(title))
    const todo: Todo = {
      id: `t${now}${Math.floor(Math.random() * 1e4)}`,
      title: this.normaliseTitle(title, project),
      description: (input.description ?? '').trim(),
      due: input.due || null,
      time: input.due ? input.time || null : null,
      project,
      eventId: null,
      done: false,
      // New items go to the top: the thing you just thought of is the thing
      // you are most likely to do next.
      order: Math.min(0, ...this.todos.filter((t) => !t.done).map((t) => t.order)) - 1,
      createdAt: now,
      updatedAt: now,
      completedAt: null
    }
    this.todos.push(todo)
    this.persist()
    return todo
  }

  update(id: string, patch: TodoPatch): Todo | undefined {
    this.load()
    const t = this.todos.find((x) => x.id === id)
    if (!t) return undefined
    if (patch.done !== undefined && patch.done !== t.done) {
      t.completedAt = patch.done ? Date.now() : null
    }
    Object.assign(t, patch, { updatedAt: Date.now() })
    // A time without a date is meaningless; clearing the date clears it too.
    if (!t.due) t.time = null
    if (patch.title !== undefined) {
      t.title = t.title.trim()
      t.project = this.canonical(parseProject(t.title))
      t.title = this.normaliseTitle(t.title, t.project)
    }
    this.persist()
    return t
  }

  /**
   * Every project ever used, in first-seen order, with a count of its open
   * items. A project whose todos are all done still appears (count 0) so the
   * autocomplete keeps offering it, finishing everything in a project should
   * not make its name vanish from your fingers.
   */
  projects(): Project[] {
    this.load()
    const seen = new Map<string, Project>()
    for (const t of this.todos) {
      if (!t.project) continue
      const key = t.project.toLowerCase()
      const p = seen.get(key) ?? { name: t.project, count: 0 }
      if (!t.done) p.count++
      seen.set(key, p)
    }
    return [...seen.values()]
  }

  collapsedProjects(): string[] {
    this.load()
    return [...this.collapsed]
  }

  setCollapsed(project: string, collapsed: boolean): void {
    this.load()
    const key = project.toLowerCase()
    if (collapsed) this.collapsed.add(key); else this.collapsed.delete(key)
    this.persist()
  }

  remove(id: string): void {
    this.load()
    this.todos = this.todos.filter((t) => t.id !== id)
    this.persist()
  }

  /** Takes the open items' ids in their new order; ids not listed keep their place. */
  reorder(ids: string[]): void {
    this.load()
    ids.forEach((id, i) => {
      const t = this.todos.find((x) => x.id === id)
      if (t) t.order = i
    })
    this.persist()
  }

  clearDone(): Todo[] {
    this.load()
    const gone = this.todos.filter((t) => t.done)
    this.todos = this.todos.filter((t) => !t.done)
    this.persist()
    return gone
  }

  /** Open items that belong on the calendar. */
  dated(): Todo[] {
    this.load()
    return this.todos.filter((t) => !t.done && !!t.due)
  }

  openCount(): number {
    this.load()
    return this.todos.filter((t) => !t.done).length
  }
}

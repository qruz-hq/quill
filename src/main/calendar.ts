import type { Todo, TodoStore } from './todos'
import type { SttEngine } from './stt'

export type CalStatus = 'granted' | 'writeOnly' | 'denied' | 'notDetermined' | 'unknown'
export type CalInfo = { id: string; title: string; source: string; color: string; isDefault: boolean }

const DEFAULT_MINUTES = 30

/**
 * One-way sync, todo -> Calendar.app. The todo is the source of truth; the
 * event follows it. Nothing here reads the calendar back except to find the
 * event we created, which is why full access is needed rather than write-only.
 *
 * Every call is fire-and-forget from the caller's point of view: a calendar
 * failure logs and leaves the todo alone. The list must keep working with the
 * calendar denied, offline, or mid-permission-prompt.
 */
export class CalendarSync {
  private enabled = false
  private calendarId = ''

  constructor(
    private readonly helper: SttEngine,
    private readonly todos: TodoStore,
    private readonly log: (line: string) => void
  ) {}

  configure(enabled: boolean, calendarId: string): void {
    this.enabled = enabled
    this.calendarId = calendarId
  }

  async status(): Promise<CalStatus> {
    const r = await this.helper.calendar('status')
    return (r.status as CalStatus) ?? 'unknown'
  }

  async requestAccess(): Promise<CalStatus> {
    const r = await this.helper.calendar('request', {}, 120_000)
    return (r.status as CalStatus) ?? 'unknown'
  }

  async calendars(): Promise<CalInfo[]> {
    const r = await this.helper.calendar('calendars')
    return (r.calendars as CalInfo[]) ?? []
  }

  /** Puts every open dated todo on the calendar. Run when the toggle goes on. */
  async backfill(): Promise<number> {
    if (!this.enabled) return 0
    let n = 0
    for (const t of this.todos.dated()) {
      if (await this.upsert(t)) n++
    }
    this.log(`[cal] backfilled ${n} todo(s)`)
    return n
  }

  /** Creates or updates the todo's event; removes it if the date was cleared. */
  async sync(todo: Todo): Promise<void> {
    if (!this.enabled) return
    if (!todo.due) {
      if (todo.eventId) await this.remove(todo)
      return
    }
    await this.upsert(todo)
  }

  /** Drops the event of a todo that still exists, and forgets the link. */
  async remove(todo: Todo): Promise<void> {
    if (!todo.eventId) return
    await this.removeEvent(todo.eventId, todo.title)
    this.todos.update(todo.id, { eventId: null })
  }

  /** For todos already deleted or cleared: nothing left to update. */
  async removeEvent(eventId: string, title = ''): Promise<void> {
    const r = await this.helper.calendar('delete', { eventId })
    if (r.error) this.log(`[cal] delete failed${title ? ` for "${title}"` : ''}: ${r.error}`)
  }

  private async upsert(todo: Todo): Promise<boolean> {
    const notes = [todo.description, todo.project ? `Project: ${todo.project}` : '']
      .filter(Boolean).join('\n\n')
    const r = await this.helper.calendar('upsert', {
      eventId: todo.eventId ?? '',
      calendarId: this.calendarId,
      title: todo.done ? `✓ ${todo.title}` : todo.title,
      date: todo.due,
      time: todo.time ?? '',
      minutes: DEFAULT_MINUTES,
      notes
    })
    if (r.error) {
      this.log(`[cal] upsert failed for "${todo.title}": ${r.error}`)
      return false
    }
    const eventId = String(r.eventId ?? '')
    if (eventId && eventId !== todo.eventId) this.todos.update(todo.id, { eventId })
    return true
  }
}

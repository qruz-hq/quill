import { app } from 'electron'
import { join } from 'path'
import { appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'

export type Dictation = {
  id: string
  text: string
  at: number        // epoch ms
  words: number
  durationMs: number
}

export type Insights = {
  totalWords: number
  totalDictations: number
  wpm: number
  streak: number
  longestStreak: number
  /** ISO date -> words dictated that day, for the contribution grid. */
  byDay: Record<string, number>
  topWords: { word: string; count: number }[]
  busiestHour: number | null
  avgWordsPerDictation: number
}

/**
 * Append-only JSONL. Deliberately not SQLite: the records are tiny and only
 * ever read whole, so a native module (and its rebuild step) would buy nothing.
 * The interface is narrow enough to swap later if the volume ever justifies it.
 */
export class DictationStore {
  private cache: Dictation[] | null = null

  private get file(): string {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return join(dir, 'dictations.jsonl')
  }

  private all(): Dictation[] {
    if (this.cache) return this.cache
    if (!existsSync(this.file)) { this.cache = []; return this.cache }
    const rows: Dictation[] = []
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { rows.push(JSON.parse(line)) } catch { /* skip a torn line */ }
    }
    this.cache = rows
    return rows
  }

  add(text: string, durationMs: number): Dictation {
    const d: Dictation = {
      id: `d${Date.now()}${Math.floor(Math.random() * 1e3)}`,
      text,
      at: Date.now(),
      words: countWords(text),
      durationMs
    }
    try { appendFileSync(this.file, JSON.stringify(d) + '\n') } catch { /* non-fatal */ }
    this.all().push(d)
    return d
  }

  /** Newest first. */
  list(limit = 500): Dictation[] {
    return [...this.all()].sort((a, b) => b.at - a.at).slice(0, limit)
  }

  remove(id: string): void {
    const kept = this.all().filter((d) => d.id !== id)
    this.cache = kept
    try { writeFileSync(this.file, kept.map((d) => JSON.stringify(d)).join('\n') + (kept.length ? '\n' : '')) }
    catch { /* non-fatal */ }
  }

  insights(): Insights {
    const rows = this.all()
    const totalWords = rows.reduce((n, d) => n + d.words, 0)
    const totalMs = rows.reduce((n, d) => n + d.durationMs, 0)

    const byDay: Record<string, number> = {}
    const hours = new Array(24).fill(0)
    for (const d of rows) {
      byDay[isoDay(d.at)] = (byDay[isoDay(d.at)] ?? 0) + d.words
      hours[new Date(d.at).getHours()] += d.words
    }

    const { current, longest } = streaks(Object.keys(byDay))
    const busiest = Math.max(...hours)

    return {
      totalWords,
      totalDictations: rows.length,
      // Speaking rate, so only time spent actually dictating counts.
      wpm: totalMs > 0 ? Math.round(totalWords / (totalMs / 60_000)) : 0,
      streak: current,
      longestStreak: longest,
      byDay,
      topWords: topWords(rows),
      busiestHour: busiest > 0 ? hours.indexOf(busiest) : null,
      avgWordsPerDictation: rows.length ? Math.round(totalWords / rows.length) : 0
    }
  }
}

function countWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length
}

export function isoDay(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function streaks(days: string[]): { current: number; longest: number } {
  if (!days.length) return { current: 0, longest: 0 }
  const set = new Set(days)
  const sorted = [...days].sort()

  let longest = 1, run = 1
  for (let i = 1; i < sorted.length; i++) {
    run = isNextDay(sorted[i - 1], sorted[i]) ? run + 1 : 1
    longest = Math.max(longest, run)
  }

  // A streak stays alive if today or yesterday has activity.
  let current = 0
  const cursor = new Date()
  if (!set.has(isoDay(cursor.getTime()))) cursor.setDate(cursor.getDate() - 1)
  while (set.has(isoDay(cursor.getTime()))) {
    current++
    cursor.setDate(cursor.getDate() - 1)
  }
  return { current, longest }
}

function isNextDay(a: string, b: string): boolean {
  const d = new Date(a + 'T00:00:00')
  d.setDate(d.getDate() + 1)
  return isoDay(d.getTime()) === b
}

const STOP = new Set(('a an the and or but if of to in on at for with from by as is are was were be been being it its this that these those i me my we our you your he she they them his her their there here what which who how why when do does did done have has had will would could should can may might not no so just really very much more most some any all one two out up so what about like get got make made need want know think see look use using into over than then them us'
).split(' '))

function topWords(rows: Dictation[]): { word: string; count: number }[] {
  const freq = new Map<string, number>()
  for (const d of rows) {
    for (const raw of d.text.toLowerCase().split(/[^a-z0-9''-]+/)) {
      const w = raw.replace(/^[''-]+|[''-]+$/g, '')
      if (w.length < 3 || STOP.has(w)) continue
      freq.set(w, (freq.get(w) ?? 0) + 1)
    }
  }
  return [...freq.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12)
}

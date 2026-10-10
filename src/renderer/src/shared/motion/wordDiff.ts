/**
 * Streaming word diff (docs/MOTION.md §3.3). Pure, no DOM.
 *
 * LCP fast path over normalized tokens, then a bounded Myers diff (maxD 24) on
 * the tails, with delete/insert runs paired into substitutions in order.
 */
import { STREAM } from './tokens'

export interface StreamWord {
  id: string
  raw: string
  norm: string
  confirmed: boolean
  /** Bumped on every substitution; drives the in-place re-blur (never a remount). */
  rev: number
}

export type DiffOp =
  | { type: 'equal'; oldIndex: number; newIndex: number }
  | { type: 'insert'; newIndex: number }
  | { type: 'delete'; oldIndex: number }
  | { type: 'substitute'; oldIndex: number; newIndex: number }

const NON_SPEECH = /^[[(].*[\])]$/
const PUNCT = /[.,!?;:"“”'’]/g

/** Split on whitespace, dropping bracketed non-speech tokens (`[BLANK_AUDIO]`, `(music)`). */
export function tokenize(text: string): string[] {
  const t = text.trim()
  if (!t) return []
  return t.split(/\s+/).filter((w) => !NON_SPEECH.test(w))
}

/** Comparison key: lowercase, punctuation stripped; punctuation-only tokens keep their raw text. */
export function normalize(raw: string): string {
  const n = raw.toLowerCase().replace(PUNCT, '')
  return n === '' ? raw : n
}

/**
 * Myers O(ND) shortest edit script between `a` and `b`, aborting past `maxD`.
 * Returns null when the edit distance exceeds `maxD`.
 */
export function myers(a: readonly string[], b: readonly string[], maxD: number): DiffOp[] | null {
  const n = a.length, m = b.length
  const max = Math.min(maxD, n + m)
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  let found = -1
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1]
      else x = v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) { x++; y++ }
      v[offset + k] = x
      if (x >= n && y >= m) { found = d; break }
    }
    if (found >= 0) break
  }
  if (found < 0) return null

  // Backtrack.
  const ops: DiffOp[] = []
  let x = n, y = m
  for (let d = found; d > 0; d--) {
    const vd = trace[d]
    const k = x - y
    const prevK = (k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1])) ? k + 1 : k - 1
    const prevX = vd[offset + prevK]
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) { x--; y--; ops.push({ type: 'equal', oldIndex: x, newIndex: y }) }
    if (x === prevX) { y--; ops.push({ type: 'insert', newIndex: y }) }
    else { x--; ops.push({ type: 'delete', oldIndex: x }) }
  }
  while (x > 0 && y > 0) { x--; y--; ops.push({ type: 'equal', oldIndex: x, newIndex: y }) }
  return ops.reverse()
}

/** Pairs each run of d deletes and i inserts into min(d, i) substitutions, in order. */
export function pairRuns(ops: DiffOp[]): DiffOp[] {
  const out: DiffOp[] = []
  let i = 0
  while (i < ops.length) {
    if (ops[i].type === 'equal') { out.push(ops[i++]); continue }
    const dels: number[] = [], ins: number[] = []
    while (i < ops.length && ops[i].type !== 'equal') {
      const op = ops[i++]
      if (op.type === 'delete') dels.push(op.oldIndex)
      else if (op.type === 'insert') ins.push(op.newIndex)
    }
    const p = Math.min(dels.length, ins.length)
    for (let j = 0; j < p; j++) out.push({ type: 'substitute', oldIndex: dels[j], newIndex: ins[j] })
    for (let j = p; j < dels.length; j++) out.push({ type: 'delete', oldIndex: dels[j] })
    for (let j = p; j < ins.length; j++) out.push({ type: 'insert', newIndex: ins[j] })
  }
  return out
}

/** Full diff of normalized token lists: LCP fast path + bounded Myers + pairing. */
export function diffTokens(
  oldNorm: readonly string[],
  newNorm: readonly string[],
  maxD: number = STREAM.maxD
): { ops: DiffOp[]; lcp: number; overflow: boolean } {
  let lcp = 0
  while (lcp < oldNorm.length && lcp < newNorm.length && oldNorm[lcp] === newNorm[lcp]) lcp++
  const ops: DiffOp[] = []
  for (let i = 0; i < lcp; i++) ops.push({ type: 'equal', oldIndex: i, newIndex: i })
  const tail = myers(oldNorm.slice(lcp), newNorm.slice(lcp), maxD)
  if (!tail) {
    // Too many edits: the whole tail re-keys and cross-fades as a block.
    for (let i = lcp; i < oldNorm.length; i++) ops.push({ type: 'delete', oldIndex: i })
    for (let i = lcp; i < newNorm.length; i++) ops.push({ type: 'insert', newIndex: i })
    return { ops, lcp, overflow: true }
  }
  for (const op of pairRuns(tail)) {
    if (op.type === 'equal') ops.push({ type: 'equal', oldIndex: op.oldIndex + lcp, newIndex: op.newIndex + lcp })
    else if (op.type === 'insert') ops.push({ type: 'insert', newIndex: op.newIndex + lcp })
    else if (op.type === 'delete') ops.push({ type: 'delete', oldIndex: op.oldIndex + lcp })
    else ops.push({ type: 'substitute', oldIndex: op.oldIndex + lcp, newIndex: op.newIndex + lcp })
  }
  return { ops, lcp, overflow: false }
}

export interface PartialResult {
  words: StreamWord[]
  /** Ids of newly inserted words, reading order. */
  inserted: string[]
  /** Ids whose text was replaced in place (rev bumped). */
  substituted: string[]
  /** Removed words (they exit with their separator). */
  deleted: StreamWord[]
  /** For each deleted word: the id of the first surviving word after it, if any. */
  neighbourOf: Map<string, string>
  /** Equal by key, raw text changed (casing/punctuation): updated in place, no animation. */
  retexted: string[]
  overflow: boolean
}

let seq = 0
/** Default id factory; unique within the renderer. */
export const nextWordId = (): string => `w${(++seq).toString(36)}`

/**
 * Applies one full running-text partial to the previous word list.
 * Confirmation (LocalAgreement-2): a word is confirmed once it survives at the
 * same aligned position in two consecutive partials (an `equal` op), or when
 * `final` is set.
 */
export function applyPartial(
  prev: readonly StreamWord[],
  text: string,
  opts: { final?: boolean; maxD?: number; makeId?: () => string } = {}
): PartialResult {
  const makeId = opts.makeId ?? nextWordId
  const raws = tokenize(text)
  const norms = raws.map(normalize)
  const { ops, overflow } = diffTokens(prev.map((w) => w.norm), norms, opts.maxD)

  const words: StreamWord[] = new Array(raws.length)
  const inserted: string[] = [], substituted: string[] = [], retexted: string[] = []
  const deleted: StreamWord[] = []
  const deletedAt: number[] = [] // new-list index the deleted word sat before

  // Ops are in order; track the next new index to locate deletion neighbours.
  let nextNew = 0
  for (const op of ops) {
    if (op.type === 'equal') {
      const old = prev[op.oldIndex]
      const raw = raws[op.newIndex]
      if (raw !== old.raw) retexted.push(old.id)
      words[op.newIndex] = { ...old, raw, norm: norms[op.newIndex], confirmed: true }
      nextNew = op.newIndex + 1
    } else if (op.type === 'substitute') {
      const old = prev[op.oldIndex]
      words[op.newIndex] = { id: old.id, raw: raws[op.newIndex], norm: norms[op.newIndex], confirmed: false, rev: old.rev + 1 }
      substituted.push(old.id)
      nextNew = op.newIndex + 1
    } else if (op.type === 'insert') {
      const id = makeId()
      words[op.newIndex] = { id, raw: raws[op.newIndex], norm: norms[op.newIndex], confirmed: false, rev: 0 }
      inserted.push(id)
      nextNew = op.newIndex + 1
    } else {
      deleted.push(prev[op.oldIndex])
      deletedAt.push(nextNew)
    }
  }
  // Inserts can be emitted out of reading order by pairing; normalize.
  const order = new Map(words.map((w, i) => [w.id, i]))
  inserted.sort((a, b) => order.get(a)! - order.get(b)!)

  const neighbourOf = new Map<string, string>()
  deleted.forEach((d, i) => {
    const n = words[deletedAt[i]]
    if (n) neighbourOf.set(d.id, n.id)
  })

  if (opts.final) for (const w of words) w.confirmed = true
  return { words, inserted, substituted, deleted, neighbourOf, retexted, overflow }
}

export interface FeedResult extends PartialResult {
  /** The word list before this partial. */
  prev: readonly StreamWord[]
}

export interface PartialFeed {
  /** The current word list. */
  readonly words: readonly StreamWord[]
  /**
   * Applies one partial. Returns null when this exact (text, final) is the one
   * applied last: seeing the same input again is not a second sighting, so it
   * must not confirm anything. That makes the caller idempotent when its effect
   * runs twice for one input (React StrictMode in dev, an unrelated dependency).
   */
  push(text: string, final?: boolean): FeedResult | null
  /** A new dictation: forget the words and the last input. */
  reset(): void
}

/** The running word list of one stream, fed with full-text partials. */
export function createPartialFeed(opts: { maxD?: number; makeId?: () => string } = {}): PartialFeed {
  let words: readonly StreamWord[] = []
  let last: { text: string; final: boolean } | null = null
  return {
    get words() { return words },
    push(text, final = false) {
      if (last && last.text === text && last.final === final) return null
      last = { text, final }
      const prev = words
      const res = applyPartial(prev, text, { ...opts, final })
      words = res.words
      return { ...res, prev }
    },
    reset() { words = []; last = null }
  }
}

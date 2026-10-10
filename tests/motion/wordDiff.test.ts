import { describe, expect, test } from 'bun:test'
import { applyPartial, createPartialFeed, diffTokens, myers, normalize, tokenize, type StreamWord } from '../../src/renderer/src/shared/motion/wordDiff'
import { STAGGER } from '../../src/renderer/src/shared/motion/tokens'

let n = 0
const mk = (): string => `t${++n}`
const run = (prev: StreamWord[], text: string, final = false) => applyPartial(prev, text, { makeId: mk, final })

describe('tokenize / normalize', () => {
  test('drops bracketed non-speech tokens', () => {
    expect(tokenize('  hello [BLANK_AUDIO] (music) world ')).toEqual(['hello', 'world'])
  })
  test('normalizes casing and punctuation; punctuation-only keeps raw', () => {
    expect(normalize('Hello,')).toBe('hello')
    expect(normalize('\u2014')).toBe('\u2014')
    expect(normalize('…')).toBe('…')
  })
})

describe('myers', () => {
  test('identity', () => {
    expect(myers(['a', 'b'], ['a', 'b'], 24)!.every((o) => o.type === 'equal')).toBe(true)
  })
  test('aborts past maxD', () => {
    const a = Array.from({ length: 30 }, (_, i) => `a${i}`)
    const b = Array.from({ length: 30 }, (_, i) => `b${i}`)
    expect(myers(a, b, 24)).toBeNull()
  })
  test('minimal script', () => {
    const ops = myers(['a', 'b', 'c'], ['a', 'x', 'c'], 24)!
    expect(ops.filter((o) => o.type !== 'equal').length).toBe(2)
  })
})

describe('applyPartial', () => {
  test('append: LCP keeps ids, only new words insert, first-time words unconfirmed', () => {
    const a = run([], 'hello there')
    expect(a.inserted.length).toBe(2)
    expect(a.words.every((w) => !w.confirmed)).toBe(true)
    const b = run(a.words, 'hello there how are you')
    expect(b.words[0].id).toBe(a.words[0].id)
    expect(b.words[1].id).toBe(a.words[1].id)
    expect(b.inserted).toEqual([b.words[2].id, b.words[3].id, b.words[4].id])
    expect(b.words[0].confirmed && b.words[1].confirmed).toBe(true)
    expect(b.words[2].confirmed).toBe(false)
  })

  test('substitution keeps the slot id and bumps rev (no remount)', () => {
    const a = run([], 'I want to meat you')
    const b = run(a.words, 'I want to meet you')
    expect(b.substituted).toEqual([a.words[3].id])
    expect(b.words[3].id).toBe(a.words[3].id)
    expect(b.words[3].rev).toBe(1)
    expect(b.words[3].confirmed).toBe(false)
    expect(b.inserted.length).toBe(0)
  })

  test('casing/punctuation change updates in place without animation', () => {
    const a = run([], 'hello world')
    const b = run(a.words, 'Hello, world.')
    expect(b.retexted.length).toBe(2)
    expect(b.inserted.length + b.substituted.length + b.deleted.length).toBe(0)
    expect(b.words[0].raw).toBe('Hello,')
  })

  test('delete reports the following neighbour', () => {
    const a = run([], 'go to the the store')
    const b = run(a.words, 'go to the store')
    expect(b.deleted.length).toBe(1)
    const nb = b.neighbourOf.get(b.deleted[0].id)
    expect(nb).toBe(b.words[3].id)
  })

  test('d deletes + i inserts pair into min(d,i) substitutions in order', () => {
    const a = run([], 'one two three four')
    const b = run(a.words, 'one alpha beta gamma four')
    expect(b.substituted).toEqual([a.words[1].id, a.words[2].id])
    expect(b.inserted.length).toBe(1)
  })

  test('cloud commit boundary (full running text) is not a re-insert', () => {
    const a = run([], 'this is a test of')
    const b = run(a.words, 'this is a test of the system')
    expect(b.inserted.length).toBe(2)
    expect(b.substituted.length + b.deleted.length).toBe(0)
  })

  test('over maxD: the tail re-keys as a block', () => {
    const a = run([], Array.from({ length: 30 }, (_, i) => `a${i}`).join(' '))
    const b = run(a.words, Array.from({ length: 30 }, (_, i) => `b${i}`).join(' '))
    expect(b.overflow).toBe(true)
    expect(b.inserted.length).toBe(30)
  })

  test('final confirms everything', () => {
    const a = run([], 'hello there')
    const b = run(a.words, 'hello there friend', true)
    expect(b.words.every((w) => w.confirmed)).toBe(true)
  })

  test('diff of 200 words is under 1 ms', () => {
    const words = Array.from({ length: 200 }, (_, i) => `w${i % 37}x${i}`)
    const prev = run([], words.join(' ')).words
    const next = [...words]; next[150] = 'changed'; next.push('extra')
    const t0 = performance.now()
    for (let i = 0; i < 50; i++) diffTokens(prev.map((w) => w.norm), next.map(normalize))
    expect((performance.now() - t0) / 50).toBeLessThan(1)
  })
})

describe('stagger tokens', () => {
  test('stream clamps 35–90 ms', () => {
    expect(STAGGER.stream(6, 1500)).toBeCloseTo(0.09)
    expect(STAGGER.stream(40, 1500)).toBeCloseTo(0.035)
  })
  test('fit: headline at t=80 with 4 tokens → 40 ms', () => {
    expect(STAGGER.fit(4, 0.4, 0.08)).toBeCloseTo(0.04)
    expect(STAGGER.fit(4, 0.4, 0.1)).toBeCloseTo(0.0333, 3)
  })
  test('fit below 12 ms reveals as one unit', () => {
    expect(STAGGER.fit(40, 0.22, 0.12)).toBe(0)
  })
})

describe('createPartialFeed (idempotent stream input)', () => {
  test('the same partial applied twice is one sighting: nothing confirmed, nothing re-inserted', () => {
    const feed = createPartialFeed({ makeId: mk })
    const first = feed.push('hold fn to talk')
    expect(first?.inserted.length).toBe(4)
    expect(first?.prev).toEqual([])
    // React StrictMode runs the effect again with the same text.
    expect(feed.push('hold fn to talk')).toBeNull()
    expect(feed.words.map((w) => w.confirmed)).toEqual([false, false, false, false])
    expect(feed.words.map((w) => w.id)).toEqual(first!.inserted)
  })
  test('a real second partial still confirms the agreed prefix', () => {
    const feed = createPartialFeed({ makeId: mk })
    feed.push('hold fn')
    const r = feed.push('hold fn to')
    expect(r?.inserted.length).toBe(1)
    expect(feed.words.map((w) => w.confirmed)).toEqual([true, true, false])
    expect(r?.prev.map((w) => w.confirmed)).toEqual([false, false])
  })
  test('final on the same text is a new input and confirms everything', () => {
    const feed = createPartialFeed({ makeId: mk })
    feed.push('hold fn')
    expect(feed.push('hold fn', true)?.words.every((w) => w.confirmed)).toBe(true)
    expect(feed.push('hold fn', true)).toBeNull()
  })
  test('reset forgets the last input, so the same text starts a new stream', () => {
    const feed = createPartialFeed({ makeId: mk })
    const a = feed.push('hello world')!
    feed.reset()
    expect(feed.words).toEqual([])
    const b = feed.push('hello world')
    expect(b?.inserted.length).toBe(2)
    expect(b!.inserted).not.toEqual(a.inserted)
  })
})

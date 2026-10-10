import { describe, expect, test } from 'bun:test'
import { PACE, Pacer, type PacerClock } from '../../src/renderer/src/hub/onboarding/pacer'

/** A clock the test moves by hand; timers fire in time order as it advances. */
function fakeClock(): PacerClock & { advance(ms: number): void; t: number } {
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const c = {
    t: 0,
    now: () => c.t,
    set: (fn: () => void, ms: number) => { timers.set(++seq, { at: c.t + ms, fn }); return seq },
    clear: (h: unknown) => { timers.delete(h as number) },
    advance(ms: number) {
      const end = c.t + ms
      for (;;) {
        const next = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
        if (!next) break
        timers.delete(next[0])
        c.t = next[1].at
        next[1].fn()
      }
      c.t = end
    }
  }
  return c
}

const words = (text: string, from = 0): { id: string; text: string }[] =>
  text.split(' ').map((w, i) => ({ id: `w${from + i}`, text: w }))

function setup(): { clock: ReturnType<typeof fakeClock>; out: { at: number; text: string }[]; pacer: Pacer<{ id: string; text: string }> } {
  const clock = fakeClock()
  const out: { at: number; text: string }[] = []
  const pacer = new Pacer<{ id: string; text: string }>((w) => out.push({ at: clock.t, text: w.text }), clock)
  return { clock, out, pacer }
}
const gaps = (out: { at: number }[]): number[] => out.slice(1).map((o, i) => o.at - out[i].at)

describe('Pacer', () => {
  test('a batch comes out one at a time, the first at once', () => {
    const { clock, out, pacer } = setup()
    pacer.push(words('one two three four'))
    expect(out.map((o) => o.text)).toEqual(['one'])
    clock.advance(2000)
    expect(out.map((o) => o.text)).toEqual(['one', 'two', 'three', 'four'])
    for (const g of gaps(out)) { expect(g).toBeGreaterThanOrEqual(PACE.minMs); expect(g).toBeLessThanOrEqual(PACE.maxMs) }
  })

  test('one batch a second of four words: an even rhythm, never a batch', () => {
    const { clock, out, pacer } = setup()
    let n = 0
    for (let b = 0; b < 6; b++) { pacer.push(words('a b c d', n)); n += 4; clock.advance(1000) }
    clock.advance(2000)
    expect(out.length).toBe(24)
    const g = gaps(out)
    // Four words a second come out a quarter of a second apart, across batches too.
    expect(Math.min(...g)).toBeGreaterThanOrEqual(240)
    expect(Math.max(...g)).toBeLessThanOrEqual(260)
    // The queue drains about when the next batch lands: it never piles up.
    expect(pacer.size).toBe(0)
  })

  test('small frequent updates are not released closer than the minimum', () => {
    const { clock, out, pacer } = setup()
    for (let i = 0; i < 20; i++) { pacer.push(words('x', i)); clock.advance(30) }
    clock.advance(5000)
    expect(out.length).toBeGreaterThan(0)
    expect(Math.min(...gaps(out))).toBeGreaterThanOrEqual(PACE.minMs)
  })

  test('more than eight waiting: the minimum interval until it is back under', () => {
    const { clock, out, pacer } = setup()
    pacer.push(words('a b c d e f g h i j k l'))
    clock.advance(3 * PACE.minMs)
    expect(gaps(out).every((g) => g === PACE.minMs)).toBe(true)
    expect(out.length).toBe(4)
  })

  test('the queue is capped: the oldest waiting items are dropped', () => {
    const { clock, out, pacer } = setup()
    pacer.push(words(Array.from({ length: 40 }, (_, i) => `n${i}`).join(' ')))
    clock.advance(60_000)
    // The first went out at once; of the other 39 only the newest 16 were kept.
    expect(out.length).toBe(1 + PACE.maxQueue - 1)
    expect(out[out.length - 1].text).toBe('n39')
  })

  test('a correction to a waiting word replaces it; a released one is not in the queue', () => {
    const { clock, out, pacer } = setup()
    pacer.push(words('its going well'))
    expect(pacer.replace('w0', { id: 'w0', text: 'nope' })).toBe(false)     // already out
    expect(pacer.replace('w2', { id: 'w2', text: 'badly' })).toBe(true)
    expect(pacer.remove('w1')).toBe(true)
    clock.advance(2000)
    expect(out.map((o) => o.text)).toEqual(['its', 'badly'])
  })

  test('flush: the rest goes out 40 ms apart, capped at 400 ms, then done', () => {
    const { clock, out, pacer } = setup()
    pacer.push(words(Array.from({ length: 15 }, (_, i) => `n${i}`).join(' ')))
    const before = out.length
    let done = -1
    pacer.flush(() => { done = clock.t })
    clock.advance(1000)
    const flushed = out.slice(before)
    expect(flushed.length).toBe(PACE.flushBudgetMs / PACE.flushStepMs)
    expect(gaps(flushed).every((g) => g === PACE.flushStepMs)).toBe(true)
    expect(done).toBeGreaterThan(0)
    expect(done).toBeLessThanOrEqual(PACE.flushBudgetMs)
    pacer.push(words('late'))
    clock.advance(1000)
    expect(out.length).toBe(before + flushed.length)
  })

  test('flush with nothing waiting is done at once; clear stops releases', () => {
    const a = setup()
    let done = false
    a.pacer.flush(() => { done = true })
    expect(done).toBe(true)
    const b = setup()
    b.pacer.push(words('one two three'))
    b.pacer.clear()
    b.clock.advance(5000)
    expect(b.out.map((o) => o.text)).toEqual(['one'])
  })
})

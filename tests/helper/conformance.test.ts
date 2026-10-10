/**
 * Conformance tests for the Quill speech helper. Any binary that passes these
 * speaks the protocol in docs/HELPER-PROTOCOL.md well enough for src/main/stt.ts.
 *
 *   bun test tests/helper                                # the Swift reference helper
 *   HELPER_BIN=/path/to/helper bun test tests/helper     # any other helper
 *   HELPER_NO_MIC=1 bun test tests/helper                # CI, no microphone
 *
 * Nothing here presses the hold key or types into another app; those checks
 * are in docs/HELPER-MANUAL-TESTS.md. Every helper is sent `duck off` and
 * `holdkey off` as it spawns, and every microphone test pins HELPER_MIC before
 * it records, so the user's volume and Bluetooth headset are left alone.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, rmSync, statSync } from 'fs'
import { isAbsolute } from 'path'
import {
  EXPECT_CAPS, FIXTURE_WORDS, HAS_MODEL, HELPER_BIN, Helper, IS_MAC, MIC_UID, MODEL, SLOW,
  answersSince, cleanupScratch, helperHomePath, killStragglers, micUnavailable, outputVolume, pinTestMic,
  settled, sleep, speechFixture, wavInfo, withHelper, type Event
} from './harness'

if (!existsSync(HELPER_BIN)) {
  throw new Error(`No helper at ${HELPER_BIN}. Build one (bun run stt:build) or set HELPER_BIN.`)
}

// Above every wait inside a test, so a failure reports what the helper sent instead of a bare timeout.
setDefaultTimeout(12_000)

const micSkipReason = await micUnavailable()
const fixture = speechFixture()
const skipMic = micSkipReason !== null
const skipSpeech = fixture === null || !HAS_MODEL

console.log(`[helper] binary: ${HELPER_BIN}`)
console.log(`[helper] microphone tests: ${skipMic ? `skipped (${micSkipReason})` : `on, pinned to ${MIC_UID}`}`)
console.log(`[helper] speech tests: ${skipSpeech ? `skipped (${fixture === null ? 'no say/afconvert' : `no model at ${MODEL}`})` : 'on'}`)

/** Every WAV a helper handed over in an `audio` event. They are ours to delete, also when a test fails half way. */
const handedOver: string[] = []
function own(audio: Event): Event {
  if (typeof audio.path === 'string') handedOver.push(audio.path)
  return audio
}

afterAll(() => {
  killStragglers()
  for (const path of handedOver) rmSync(path, { force: true })
  cleanupScratch()
})

const unit = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1

/** No `error` or `start-failed` may appear in a run that did nothing wrong. */
function expectNoErrors(h: Helper, from = 0): void {
  expect(h.since(from).filter((e) => e.type === 'error' || e.type === 'start-failed')).toEqual([])
}

function expectDevices(ev: Event): void {
  expect(Array.isArray(ev.devices)).toBe(true)
  expect(typeof ev.pinned).toBe('string')
  const devices = ev.devices as Record<string, unknown>[]
  for (const d of devices) {
    expect(typeof d.id).toBe('number')
    expect(typeof d.uid).toBe('string')
    expect((d.uid as string).length).toBeGreaterThan(0)
    expect(typeof d.name).toBe('string')
    expect(typeof d.isDefault).toBe('boolean')
  }
  expect(new Set(devices.map((d) => d.uid)).size).toBe(devices.length)
  expect(devices.filter((d) => d.isDefault).length).toBeLessThanOrEqual(1)
}

/** A `final` answering `id`: same id, a string text, an optional string error. */
function expectFinal(ev: Event, id: string): void {
  expect(ev.id).toBe(id)
  expect(typeof ev.text).toBe('string')
  if ('error' in ev) expect(typeof ev.error).toBe('string')
}

/** Starts a recording on the pinned test microphone and waits for `started`. */
async function startRecording(h: Helper): Promise<number> {
  expect(await pinTestMic(h)).not.toBeNull()
  const from = h.mark()
  h.send('start')
  await h.waitFor('started', { from })
  return from
}

/** Size of a file, 0 when it is not there. */
const sizeOf = (path: string): number => (existsSync(path) ? statSync(path).size : 0)

/**
 * Records until a recording comes back as an `audio` event (cloud engine).
 *
 * Where the microphone delivers a signal, the first recording does. A process
 * without microphone permission is handed digital silence, which the helper
 * answers with the microphone error once it is longer than 0.5 s (pipeline
 * step 2) and with an empty final at 0.3 s or less (step 3). Between the two a
 * silent recording is handed over like any other, so the length is narrowed
 * into that window. Returns the mark taken before the `start` that worked.
 */
async function recordForAudio(h: Helper, id: string, firstMs: number): Promise<{ from: number; audio: Event; id: string }> {
  let lo = 250
  let hi = 550
  let ms = firstMs
  const seen: string[] = []
  for (let attempt = 0; attempt < 6; attempt++) {
    const useId = attempt === 0 ? id : `${id}-${attempt}`
    const from = await startRecording(h)
    await sleep(ms)
    h.send(`stop ${useId}`)
    const answer = await Promise.race([
      h.waitFor('audio', { from, timeout: 8000 }),
      h.waitFor('final', { from, timeout: 8000 })
    ])
    if (answer.type === 'audio') own(answer)
    expect(answer.id).toBe(useId)
    if (answer.type === 'audio') return { from, audio: answer, id: useId }
    expectFinal(answer, useId)
    expect(answer.text).toBe('')
    seen.push(`${ms} ms: ${'error' in answer ? answer.error : 'empty final'}`)
    if ('error' in answer) {
      // Only the silent-microphone reason is a legitimate way not to hand the audio over.
      expect(answer.error as string).toMatch(/microphone/i)
      hi = Math.min(hi, ms)
    } else {
      lo = Math.max(lo, ms)
    }
    ms = Math.round((lo + hi) / 2)
    await sleep(150)
  }
  throw new Error(`cloud engine never handed a recording over as "audio": ${seen.join('; ')}`)
}

// ------------------------------------------------------------------- boot

describe('boot', () => {
  test('the first line is the boot event', async () => {
    const h = new Helper()
    try {
      await h.waitFor('boot')
      expect(h.events[0].type).toBe('boot')
      // Optional, but when present it is this process.
      if ('pid' in h.events[0]) expect(h.events[0].pid).toBe(h.pid)
      await settled(h)
      expect(h.events.filter((e) => e.type === 'boot').length).toBe(1)
    } finally {
      await h.kill()
    }
    expect(h.stray).toEqual([])
  })

  test('commands written before boot are honoured', async () => {
    // Main writes its settings straight after spawn and never waits for boot.
    const h = new Helper()
    try {
      h.send('mic not-a-connected-device')
      h.send('stop pre-1')
      const final = await h.waitFor('final', { timeout: 5000 })
      expectFinal(final, 'pre-1')
      expect(final.text).toBe('')
      const pinned = await h.waitFor('devices', { timeout: 5000, where: (e) => e.pinned === 'not-a-connected-device' })
      expectDevices(pinned)
      expect(h.events[0].type).toBe('boot')
      expectNoErrors(h)
    } finally {
      await h.kill()
    }
    expect(h.stray).toEqual([])
  })

  test('the device list arrives by itself after boot', async () => {
    await withHelper(async (h) => {
      const ev = await h.waitFor('devices', { timeout: 5000 })
      expectDevices(ev)
      expect(ev.pinned).toBe('')
    })
  })

  test('hotkey-status arrives by itself after boot, in the documented shape', async () => {
    await withHelper(async (h) => {
      await settled(h)
      const statuses = h.events.filter((e) => e.type === 'hotkey-status')
      // A helper that declares no `hotkey` capability has no hold key to report on.
      const caps = h.events.find((e) => e.type === 'capabilities')
      const noHotkey = Array.isArray(caps?.capabilities) && !(caps!.capabilities as unknown[]).includes('hotkey')
      if (!noHotkey) expect(statuses.length).toBeGreaterThanOrEqual(1)
      for (const ev of statuses) {
        expect(typeof ev.installed).toBe('boolean')
        if (ev.installed) expect('reason' in ev).toBe(false)
        else expect((ev.reason as string).length).toBeGreaterThan(0)
      }
    })
  })

  test('capabilities handshake (proposed): valid when sent', async () => {
    await withHelper(async (h) => {
      await settled(h)
      const caps = h.events.filter((e) => e.type === 'capabilities')
      if (EXPECT_CAPS) expect(caps.length).toBeGreaterThanOrEqual(1)
      // The first one follows boot directly, before anything else. A later
      // one (the list changed while running) may come at any time.
      if (caps.length) expect(h.events[1]).toBe(caps[0])
      for (const ev of caps) {
        expect(['macos', 'windows', 'linux']).toContain(ev.platform as string)
        expect(Array.isArray(ev.capabilities)).toBe(true)
        for (const c of ev.capabilities as unknown[]) expect(typeof c).toBe('string')
        if ('protocol' in ev) expect(typeof ev.protocol).toBe('number')
        if ('helper' in ev) expect(typeof ev.helper).toBe('string')
        if ('holdKeys' in ev) {
          expect(Array.isArray(ev.holdKeys)).toBe(true)
          for (const k of ev.holdKeys as unknown[]) expect(typeof k).toBe('number')
        }
        if ('notes' in ev) expect(ev.notes !== null && typeof ev.notes === 'object' && !Array.isArray(ev.notes)).toBe(true)
      }
    })
  })

  test.skipIf(!IS_MAC)('the log file is written (macOS path)', async () => {
    const log = helperHomePath('Library', 'Logs', 'Quill-stt.log')
    // Other helpers of this run (and, with HELPER_REAL_HOME, the app) write
    // the same file, so what counts is that this helper added to it.
    const before = sizeOf(log)
    await withHelper(async (h) => {
      await settled(h)
      h.send('lang en')
      h.send('model /nonexistent/for-the-log.bin')
      const from = h.mark()
      h.send('devices')
      await h.waitFor('devices', { from })
    })
    expect(sizeOf(log)).toBeGreaterThan(before)
  })
})

// ---------------------------------------------------------------- devices

describe('devices', () => {
  test('`devices` answers with the list', async () => {
    await withHelper(async (h) => {
      await settled(h)
      const from = h.mark()
      h.send('devices')
      const ev = await h.waitFor('devices', { from })
      expectDevices(ev)
      expect(ev.pinned).toBe('')
      expectNoErrors(h)
    })
  })

  test('`mic <uid>` pins, `mic default` unpins, each echoed in a devices event', async () => {
    await withHelper(async (h) => {
      const first = await h.waitFor('devices', { timeout: 5000 })
      // Pinning does not open the device, so any listed uid is safe here; an
      // unknown uid is kept too, for when the device comes back.
      const uid = ((first.devices as { uid: string }[])[0]?.uid) ?? 'not-a-connected-device'
      // Each answer is found by its `pinned`, so a device list sent for a
      // hot-plug in the same instant is not mistaken for it.
      let from = h.mark()
      h.send(`mic ${uid}`)
      const pinned = await h.waitFor('devices', { from, where: (e) => e.pinned === uid })
      expectDevices(pinned)

      from = h.mark()
      h.send('mic not-a-connected-device')
      const unknown = await h.waitFor('devices', { from, where: (e) => e.pinned === 'not-a-connected-device' })
      // The pin is kept, but an unknown device is not invented into the list.
      expect((unknown.devices as { uid: string }[]).some((d) => d.uid === 'not-a-connected-device')).toBe(false)

      // A uid may contain spaces: the argument runs to the end of the line.
      from = h.mark()
      h.send('mic Some Device: With Spaces')
      await h.waitFor('devices', { from, where: (e) => e.pinned === 'Some Device: With Spaces' })

      from = h.mark()
      h.send('mic default')
      await h.waitFor('devices', { from, where: (e) => e.pinned === '' })

      // The pin is what `devices` reports from then on.
      h.send(`mic ${uid}`)
      await h.waitFor('devices', { from, where: (e) => e.pinned === uid })
      from = h.mark()
      h.send('devices')
      expect((await h.waitFor('devices', { from })).pinned).toBe(uid)
      expectNoErrors(h)
    })
  })
})

// ------------------------------------------------- stop, retry, no recording

describe('stop and retry without a recording', () => {
  test('`stop <id>` with nothing recording answers an empty final with that id', async () => {
    await withHelper(async (h) => {
      const from = h.mark()
      h.send('stop 41')
      const ev = await h.waitFor('final', { from })
      expectFinal(ev, '41')
      expect(ev.text).toBe('')
      expect('error' in ev).toBe(false)
      await sleep(200)
      // An early out: one answer, and nothing was "transcribed".
      expect(h.since(from, 'final').length).toBe(1)
      expect(h.since(from, 'transcribing')).toEqual([])
      expect(h.since(from, 'audio')).toEqual([])
      expectNoErrors(h)
    })
  })

  test('`retry <id>` with nothing kept answers an empty final with that id', async () => {
    await withHelper(async (h) => {
      const from = h.mark()
      h.send('retry 5')
      const ev = await h.waitFor('final', { from })
      expectFinal(ev, '5')
      expect(ev.text).toBe('')
      expect('error' in ev).toBe(false)
      expect(h.since(from, 'transcribing')).toEqual([])
      expectNoErrors(h)
    })
  })

  test('each stop and retry gets its own final, in order', async () => {
    await withHelper(async (h) => {
      const from = h.mark()
      h.send('stop a1')
      h.send('retry b2')
      h.send('stop 3')
      await h.waitFor('final', { from, where: (e) => e.id === '3' })
      await sleep(200)
      expect(h.since(from, 'final').map((e) => e.id)).toEqual(['a1', 'b2', '3'])
    })
  })

  test('the id is opaque: echoed unchanged, whatever it looks like', async () => {
    await withHelper(async (h) => {
      const from = h.mark()
      h.send('stop 0007')
      h.send('retry c1760000000000123456')
      h.send('stop id with spaces')
      await h.waitFor('final', { from, where: (e) => e.id === 'id with spaces' })
      expect(h.since(from, 'final').map((e) => e.id)).toEqual(['0007', 'c1760000000000123456', 'id with spaces'])
    })
  })

  test('a bare `stop` is answered with an empty id', async () => {
    await withHelper(async (h) => {
      const from = h.mark()
      h.send('stop')
      const ev = await h.waitFor('final', { from })
      expect(ev.id ?? '').toBe('')
      expect(ev.text).toBe('')
    })
  })

  test('a bare `retry` is answered with an empty id', async () => {
    await withHelper(async (h) => {
      const from = h.mark()
      h.send('retry')
      const ev = await h.waitFor('final', { from })
      expect(ev.id ?? '').toBe('')
      expect(ev.text).toBe('')
    })
  })

  test('`cancel` with nothing recording still answers cancelled', async () => {
    await withHelper(async (h) => {
      const from = h.mark()
      h.send('cancel')
      await h.waitFor('cancelled', { from })
      h.send('cancel')
      h.send('stop after-cancel')
      await h.waitFor('final', { from, where: (e) => e.id === 'after-cancel' })
      // One `cancelled` per `cancel`, and never a final for a cancel.
      expect(h.since(from, 'cancelled').length).toBe(2)
      expect(h.since(from, 'final').length).toBe(1)
      expectNoErrors(h)
    })
  })
})

// --------------------------------------------------- accepted, ignored, quit

describe('commands that answer nothing', () => {
  /**
   * `devices` is sent after the silent commands as a marker: when its answer
   * is in, they have been read. Nothing but device lists may have been said
   * (the hold key's own status reports aside, which need no command).
   */
  function expectOnlyDevices(h: Helper, from: number): void {
    const types = answersSince(h, from).map((e) => e.type)
    expect(types.length).toBeGreaterThanOrEqual(1)
    expect(types.filter((t) => t !== 'devices')).toEqual([])
  }

  test('`unlatch` is accepted silently', async () => {
    await withHelper(async (h) => {
      await settled(h)
      const from = h.mark()
      h.send('unlatch')
      h.send('unlatch')
      h.send('devices')
      await h.waitFor('devices', { from })
      await sleep(150)
      expectOnlyDevices(h, from)
      expect(h.exit).toBeNull()
    })
  })

  test('settings commands are accepted silently', async () => {
    await withHelper(async (h) => {
      await settled(h)
      const from = h.mark()
      // What stt.ts sends on every spawn, minus `mic` (which answers), plus
      // malformed arguments, which leave the setting as it was. Never a
      // `duck <number>` or a `holdkey <code>`: those would arm the real thing.
      for (const line of ['model ', 'model /nonexistent/model.bin', 'model /path with spaces/ggml model.bin',
        'lang en,fr', 'lang auto', 'lang ', 'duck off', 'duck loud', 'holdkey off', 'holdkey none',
        'engine cloud', 'engine local', 'stream on', 'stream off', 'hold-ms 300', 'doubletap-ms 350',
        'hold-ms soon']) {
        h.send(line)
      }
      h.send('devices')
      await h.waitFor('devices', { from })
      await sleep(150)
      expectOnlyDevices(h, from)
      expect(h.exit).toBeNull()
    })
  })

  test('unknown commands, blank lines and junk are ignored', async () => {
    await withHelper(async (h) => {
      await settled(h)
      const from = h.mark()
      // The `insert` lines hold nothing that even a lenient base64 decoder
      // could turn into text, so nothing can be typed into the focused app.
      for (const line of ['bogus-command', 'bogus with arguments', '', '   ', '{"type":"start"}', 'START', 'Stop 9',
        'startx', 'transcribe-file', 'transcribe-file onlyid', 'cal', 'cal not-json', 'cal []', 'cal {"op":"status"}',
        'cal {"id":7,"op":"status"}', 'cal {"id":"no-op"}', 'insert', 'insert !!!']) {
        h.send(line)
      }
      h.send('devices')
      await h.waitFor('devices', { from })
      await sleep(150)
      expectOnlyDevices(h, from)
      expect(h.exit).toBeNull()
      expect(h.stray).toEqual([])
    })
  })

  test('`mic-test-stop` with no test running says nothing', async () => {
    await withHelper(async (h) => {
      await settled(h)
      const from = h.mark()
      h.send('mic-test-stop')
      h.send('devices')
      await h.waitFor('devices', { from })
      await sleep(150)
      expectOnlyDevices(h, from)
    })
  })
})

describe('queries', () => {
  test('`ax-check` answers ax with a boolean', async () => {
    await withHelper(async (h) => {
      const from = h.mark()
      h.send('ax-check')
      const ev = await h.waitFor('ax', { from })
      expect(typeof ev.trusted).toBe('boolean')
    })
  })

  test('`cal` echoes the id, with a status or an error', async () => {
    await withHelper(async (h) => {
      let from = h.mark()
      h.send(`cal ${JSON.stringify({ id: 'c-status-1', op: 'status' })}`)
      const status = await h.waitFor('cal', { from })
      expect(status.id).toBe('c-status-1')
      if ('status' in status) expect(['granted', 'writeOnly', 'denied', 'notDetermined']).toContain(status.status as string)
      else expect(typeof status.error).toBe('string')

      from = h.mark()
      h.send(`cal ${JSON.stringify({ id: 'c-bogus-2', op: 'no-such-op' })}`)
      const bogus = await h.waitFor('cal', { from })
      expect(bogus.id).toBe('c-bogus-2')
      expect(typeof bogus.error).toBe('string')
      await sleep(150)
      expect(h.since(0, 'cal').length).toBe(2)
    })
  })

  // None of these can prompt or write: `calendars` only reads, the event to
  // delete does not exist, and the date is rejected before anything is saved.
  test('`cal` ops answer once each, with their fields or an error', async () => {
    await withHelper(async (h) => {
      const from = h.mark()
      h.send(`cal ${JSON.stringify({ id: 'c-list', op: 'calendars' })}`)
      h.send(`cal ${JSON.stringify({ id: 'c-del', op: 'delete', eventId: 'quill-conformance-no-such-event' })}`)
      h.send(`cal ${JSON.stringify({ id: 'c-bad', op: 'upsert', title: 'never saved', date: 'not-a-date', time: '', eventId: '', calendarId: '' })}`)
      const list = await h.waitFor('cal', { from, where: (e) => e.id === 'c-list' })
      const del = await h.waitFor('cal', { from, where: (e) => e.id === 'c-del' })
      const bad = await h.waitFor('cal', { from, where: (e) => e.id === 'c-bad' })

      if ('error' in list) expect(typeof list.error).toBe('string')
      else {
        expect(Array.isArray(list.calendars)).toBe(true)
        for (const c of list.calendars as Record<string, unknown>[]) {
          expect(typeof c.id).toBe('string')
          expect(typeof c.title).toBe('string')
          expect(typeof c.source).toBe('string')
          expect(c.color as string).toMatch(/^(#[0-9a-f]{6})?$/)
          expect(typeof c.isDefault).toBe('boolean')
        }
      }
      if ('error' in del) expect(typeof del.error).toBe('string')
      else expect(del.gone).toBe(true)
      // No access, a bad date, or no calendar here at all: an error either way.
      expect((bad.error as string).length).toBeGreaterThan(0)
      expect('eventId' in bad).toBe(false)
      for (const ev of [list, del, bad]) {
        if (ev.error === 'no access') expect(['granted', 'writeOnly', 'denied', 'notDetermined']).toContain(ev.status as string)
      }
      await sleep(150)
      expect(h.since(from, 'cal').length).toBe(3)
    })
  })
})

describe('quit', () => {
  /** Every line the helper wrote was one JSON event, and nothing came after the last command. */
  function expectClean(h: Helper): void {
    expect(h.stray).toEqual([])
    for (const ev of h.events) expect(typeof ev.type).toBe('string')
  }

  test('`quit` exits with code 0 and no stray output', async () => {
    const h = new Helper()
    try {
      await h.waitFor('boot')
      await settled(h)
      const from = h.mark()
      h.send('quit')
      const exit = await h.waitExit(2000)
      expect(exit).toEqual({ code: 0, signal: null })
      expect(answersSince(h, from)).toEqual([])
      expectClean(h)
    } finally {
      await h.kill()
    }
  })

  test('closing stdin exits with code 0', async () => {
    const h = new Helper()
    try {
      await h.waitFor('boot')
      await settled(h)
      const from = h.mark()
      h.proc.stdin.end()
      expect(await h.waitExit(2000)).toEqual({ code: 0, signal: null })
      expect(answersSince(h, from)).toEqual([])
      expectClean(h)
    } finally {
      await h.kill()
    }
  })

  test.skipIf(process.platform === 'win32')('SIGTERM exits cleanly with code 0', async () => {
    const h = new Helper()
    try {
      await h.waitFor('boot')
      await settled(h)
      process.kill(h.pid, 'SIGTERM')
      expect(await h.waitExit(2000)).toEqual({ code: 0, signal: null })
      expectClean(h)
    } finally {
      await h.kill()
    }
  })

  test.skipIf(skipMic)('`quit` while recording still exits with code 0', async () => {
    const h = new Helper()
    try {
      await h.waitFor('boot')
      const from = await startRecording(h)
      await sleep(300)
      h.send('quit')
      expect(await h.waitExit(2500)).toEqual({ code: 0, signal: null })
      // Quitting is not a stop: the recording is dropped, not answered.
      for (const t of ['final', 'audio', 'cancelled', 'transcribing']) expect(h.since(from, t)).toEqual([])
      expectClean(h)
    } finally {
      await h.kill()
    }
  })

  test('`quit` does not wait for an answer that is still owed', async () => {
    const h = new Helper()
    try {
      await h.waitFor('boot')
      await settled(h)
      // What dispose() writes, with ids still outstanding.
      h.send('stop q-1')
      h.send('retry q-2')
      h.send('quit')
      h.proc.stdin.end()
      expect(await h.waitExit(2000)).toEqual({ code: 0, signal: null })
      expectClean(h)
    } finally {
      await h.kill()
    }
  })
})

// ------------------------------------------------------------- transcription

describe('transcribe-file', () => {
  test.skipIf(skipSpeech)('returns the words spoken in a WAV, with the id', async () => {
    await withHelper(async (h) => {
      h.send(`model ${MODEL}`)
      h.send('lang en')
      const from = h.mark()
      h.send(`transcribe-file tf-7 ${fixture}`)
      const ev = await h.waitFor('final', { from, timeout: 30_000 })
      expectFinal(ev, 'tf-7')
      expect('error' in ev).toBe(false)
      const text = (ev.text as string).toLowerCase()
      expect(text.length).toBeGreaterThan(0)
      for (const word of FIXTURE_WORDS) expect(text).toContain(word)
      // One line of plain text: no timestamps, no line breaks.
      expect(ev.text as string).not.toMatch(/[\n\r]|-->/)
      expect(ev.text).toBe((ev.text as string).trim())
      // The fallback must not delete the recording; main still owns it.
      expect(existsSync(fixture!)).toBe(true)
      expectNoErrors(h)
    })
  }, 40_000)

  test.skipIf(skipSpeech)('a path with spaces is one argument', async () => {
    const spaced = fixture!.replace(/fixture\.wav$/, 'a recording with spaces.wav')
    await Bun.write(spaced, Bun.file(fixture!))
    await withHelper(async (h) => {
      h.send(`model ${MODEL}`)
      h.send('lang en')
      const from = h.mark()
      h.send(`transcribe-file tf-8 ${spaced}`)
      const ev = await h.waitFor('final', { from, timeout: 30_000 })
      expectFinal(ev, 'tf-8')
      expect((ev.text as string).toLowerCase()).toContain('fox')
    })
  }, 40_000)

  test.skipIf(skipSpeech)('answers each id when two are queued', async () => {
    await withHelper(async (h) => {
      h.send(`model ${MODEL}`)
      h.send('lang en')
      const from = h.mark()
      h.send(`transcribe-file q1 ${fixture}`)
      h.send(`transcribe-file q2 ${fixture}`)
      const a = await h.waitFor('final', { from, timeout: 40_000, where: (e) => e.id === 'q1' })
      const b = await h.waitFor('final', { from, timeout: 40_000, where: (e) => e.id === 'q2' })
      expect((a.text as string).toLowerCase()).toContain('fox')
      expect((b.text as string).toLowerCase()).toContain('fox')
    })
  }, 60_000)

  test.skipIf(!HAS_MODEL)('a file that cannot be read still gets its final, empty', async () => {
    await withHelper(async (h) => {
      h.send(`model ${MODEL}`)
      h.send('lang en')
      const from = h.mark()
      h.send('transcribe-file tf-missing /nonexistent/quill conformance.wav')
      // Main waits 45 s for an id that is never answered, so silence is not an option.
      const ev = await h.waitFor('final', { from, timeout: 30_000 })
      expectFinal(ev, 'tf-missing')
      expect(ev.text).toBe('')
      expect(h.since(from, 'transcribing')).toEqual([])
      expect(h.since(from, 'error')).toEqual([])
    })
  }, 40_000)

  test('with no model installed it answers a final carrying the reason', async () => {
    await withHelper(async (h) => {
      h.send('model ')
      const from = h.mark()
      h.send(`transcribe-file tf-9 ${fixture ?? '/nonexistent/file.wav'}`)
      const ev = await h.waitFor('final', { from })
      expectFinal(ev, 'tf-9')
      expect(ev.text).toBe('')
      expect(ev.error as string).toMatch(/model/i)
      // The reason travels in the final, never as a separate error event.
      expect(h.since(from, 'transcribing')).toEqual([])
      expectNoErrors(h)

      // A model path that names no file is the same as no model.
      h.send('model /nonexistent/model.bin')
      const m = h.mark()
      h.send(`transcribe-file tf-10 ${fixture ?? '/nonexistent/file.wav'}`)
      const again = await h.waitFor('final', { from: m })
      expectFinal(again, 'tf-10')
      expect(again.text).toBe('')
      expect(again.error as string).toMatch(/model/i)
    })
  })
})

// ---------------------------------------------------------------- microphone

describe('microphone', () => {
  test.skipIf(skipMic)('start then cancel: started, level and spectrum, cancelled', async () => {
    await withHelper(async (h) => {
      const before = outputVolume()
      const from = await startRecording(h)
      await sleep(1000)
      const during = outputVolume()
      h.send('cancel')
      const cancelled = await h.waitFor('cancelled', { from })
      await sleep(400)

      const types = h.since(from).map((e) => e.type)
      // Meter lines may race `started` to the pipe; nothing else may precede it.
      expect(types.filter((t) => t !== 'level' && t !== 'spectrum')[0]).toBe('started')
      expect(types.filter((t) => t === 'started').length).toBe(1)
      expect(types.filter((t) => t === 'cancelled').length).toBe(1)

      const levels = h.since(from, 'level')
      expect(levels.length).toBeGreaterThanOrEqual(5)
      for (const ev of levels) expect(unit(ev.value)).toBe(true)

      const spectra = h.since(from, 'spectrum')
      expect(spectra.length).toBeGreaterThanOrEqual(3)
      for (const ev of spectra) {
        expect(Array.isArray(ev.bands)).toBe(true)
        expect((ev.bands as unknown[]).length).toBe(28)
        for (const b of ev.bands as unknown[]) expect(unit(b)).toBe(true)
      }

      // Nothing of a cancelled recording is transcribed or kept.
      expect(types).not.toContain('transcribing')
      expect(types).not.toContain('final')
      expect(types).not.toContain('audio')
      expect(types).not.toContain('mic-test-level')
      const at = h.indexOf(cancelled)
      expect(h.lateAfter(at, 'level', 250)).toEqual([])
      expect(h.lateAfter(at, 'spectrum', 250)).toEqual([])
      expectNoErrors(h, from)

      const m = h.mark()
      h.send('retry r-after-cancel')
      const ev = await h.waitFor('final', { from: m })
      expectFinal(ev, 'r-after-cancel')
      expect(ev.text).toBe('')

      // `duck off` was sent first, so the output volume never moved.
      if (before !== null && during !== null) expect(during).toBe(before)
      expect(outputVolume()).toBe(before)
    })
    if (IS_MAC) expect(existsSync(helperHomePath('Library', 'Logs', 'Quill-duck.json'))).toBe(false)
  }, 15_000)

  test.skipIf(skipMic)('a second `start` while recording is ignored', async () => {
    await withHelper(async (h) => {
      const from = await startRecording(h)
      h.send('start')
      await sleep(400)
      // `retry` during a recording has nothing to re-run and must not end it.
      const m = h.mark()
      h.send('retry r-while-recording')
      const ev = await h.waitFor('final', { from: m })
      expectFinal(ev, 'r-while-recording')
      expect(ev.text).toBe('')
      expect('error' in ev).toBe(false)
      const after = h.mark()
      await sleep(400)
      expect(h.since(after, 'level').length).toBeGreaterThan(0)
      expect(h.since(from, 'transcribing')).toEqual([])
      h.send('cancel')
      await h.waitFor('cancelled', { from })
      expect(h.since(from, 'started').length).toBe(1)
      expectNoErrors(h, from)
    })
  }, 15_000)

  test.skipIf(skipMic)('stop on a tiny recording answers a final with the same id', async () => {
    await withHelper(async (h) => {
      h.send('model ')
      const from = await startRecording(h)
      h.send('stop 42')
      const ev = await h.waitFor('final', { from, timeout: 8000 })
      expectFinal(ev, '42')
      // No model is set, so there is no text whichever way the length fell.
      expect(ev.text).toBe('')
      expect(h.since(from, 'final').length).toBe(1)
      expect(h.since(from, 'cancelled')).toEqual([])
      const at = h.indexOf(ev)
      await sleep(400)
      expect(h.lateAfter(at, 'level', 250)).toEqual([])
      expect(h.since(from).filter((e) => e.type === 'error' || e.type === 'start-failed')).toEqual([])
    })
  }, 15_000)

  test.skipIf(skipMic)('stop with no model: the reason comes in the final, and retry repeats it', async () => {
    await withHelper(async (h) => {
      h.send('engine local')
      h.send('model ')
      const from = await startRecording(h)
      await sleep(1200)
      h.send('stop 50')
      const ev = await h.waitFor('final', { from, timeout: 8000 })
      expectFinal(ev, '50')
      expect(ev.text).toBe('')
      // Either "no model" or, with no microphone permission, "no audio".
      expect(ev.error as string).toMatch(/model|microphone/i)
      expect(h.since(from).filter((e) => e.type === 'error')).toEqual([])
      // Both are early outs: nothing was transcribed, so nothing said it was.
      expect(h.since(from, 'transcribing')).toEqual([])
      expect(h.since(from, 'audio')).toEqual([])

      // The recording is kept for "Try again" and fails the same way.
      const m = h.mark()
      h.send('retry 51')
      const again = await h.waitFor('final', { from: m, timeout: 8000 })
      expectFinal(again, '51')
      expect(again.text).toBe('')
      expect(again.error).toBe(ev.error)

      // `retry` reads the settings as they are now, and a `stop` with nothing
      // recording does not throw the kept recording away.
      h.send('engine cloud')
      h.send('stop 52')
      await h.waitFor('final', { from: m, where: (e) => e.id === '52' })
      const c = h.mark()
      h.send('retry 53')
      const cloud = await Promise.race([
        h.waitFor('audio', { from: c, timeout: 8000 }),
        h.waitFor('final', { from: c, timeout: 8000 })
      ])
      if (cloud.type === 'audio') own(cloud)
      expect(cloud.id).toBe('53')
      if (cloud.type === 'audio') rmSync(cloud.path as string, { force: true })
      // Without a signal the same recording still fails the same way; with one it is handed over.
      else expect(cloud.error as string).toMatch(/microphone/i)
    })
  }, 20_000)

  test.skipIf(skipMic || !HAS_MODEL)('local engine: stop transcribes and answers the id; retry answers again', async () => {
    await withHelper(async (h) => {
      h.send('engine local')
      h.send(`model ${MODEL}`)
      h.send('lang en')
      const from = await startRecording(h)
      await sleep(1200)
      h.send('stop 60')
      const ev = await h.waitFor('final', { from, timeout: 30_000 })
      expectFinal(ev, '60')
      if (!('error' in ev)) {
        // Real audio: `transcribing` came first, exactly once.
        const types = h.since(from).map((e) => e.type)
        expect(types.filter((t) => t === 'transcribing').length).toBe(1)
        expect(types.indexOf('transcribing')).toBeLessThan(types.indexOf('final'))
      } else {
        expect(ev.error as string).toMatch(/microphone/i)
      }
      // Partials stop with the recording.
      const at = h.indexOf(ev)
      const m = h.mark()
      h.send('retry 61')
      const again = await h.waitFor('final', { from: m, timeout: 30_000 })
      expectFinal(again, '61')
      expect(h.lateAfter(at, 'partial', 0)).toEqual([])
      for (const p of h.since(from, 'partial')) expect(typeof p.text).toBe('string')
    })
  }, 70_000)

  test.skipIf(skipMic)('cloud engine: stop hands over a 16 kHz mono WAV with the id; retry hands it over again', async () => {
    await withHelper(async (h) => {
      h.send('engine cloud')
      h.send('stream off')
      h.send('model ')
      const { from, audio, id } = await recordForAudio(h, '70', 1200)
      expect(typeof audio.path).toBe('string')
      expect(typeof audio.seconds).toBe('number')
      expect(audio.seconds as number).toBeGreaterThan(0.3)
      expect(audio.seconds as number).toBeLessThan(5)
      const types = h.since(from).map((e) => e.type)
      expect(types.filter((t) => t === 'transcribing').length).toBe(1)
      expect(types.indexOf('transcribing')).toBeLessThan(types.indexOf('audio'))
      expect(types).not.toContain('chunk')
      // The app answers this one itself, so the helper sends no final for it.
      await sleep(300)
      expect(h.since(from, 'final')).toEqual([])
      expect(h.since(from, 'audio').length).toBe(1)
      expect(h.lateAfter(h.indexOf(audio), 'level', 250)).toEqual([])

      const path = audio.path as string
      const made = [path]
      try {
        expect(isAbsolute(path)).toBe(true)
        const wav = wavInfo(path)
        expect(wav).not.toBeNull()
        expect(wav).toMatchObject({ format: 1, channels: 1, rate: 16_000, bits: 16 })
        expect(Math.abs(wav!.dataBytes / 32_000 - (audio.seconds as number))).toBeLessThan(0.001)

        // The upload "failed": the same file is transcribed here, same id.
        let m = h.mark()
        h.send(`transcribe-file ${id} ${path}`)
        const fallback = await h.waitFor('final', { from: m, timeout: 8000 })
        expectFinal(fallback, id)
        expect(fallback.error as string).toMatch(/model/i)
        // The file is main's: the helper leaves it where it is.
        expect(existsSync(path)).toBe(true)

        // "Try again" in cloud mode: the kept recording, handed over once more.
        m = h.mark()
        h.send('retry 71')
        const again = own(await h.waitFor('audio', { from: m, timeout: 8000 }))
        made.push(again.path as string)
        expect(again.id).toBe('71')
        expect(again.seconds).toBe(audio.seconds)
        expect(h.since(m, 'transcribing').length).toBe(1)
        expect(wavInfo(again.path as string)!.data.equals(wav!.data)).toBe(true)
      } finally {
        for (const f of made) rmSync(f, { force: true })
      }
    })
  }, 60_000)

  test.skipIf(skipMic)('streaming: PCM16 chunks while recording, none after stop, together the recording', async () => {
    await withHelper(async (h) => {
      h.send('engine cloud')
      h.send('stream on')
      h.send('model ')
      const { from, audio } = await recordForAudio(h, '80', 1000)
      const chunks = h.since(from, 'chunk')
      // One every 200 ms and a last one flushed by `stop`.
      expect(chunks.length).toBeGreaterThanOrEqual((audio.seconds as number) >= 0.9 ? 3 : 1)
      const parts: Buffer[] = []
      for (const c of chunks) {
        expect(typeof c.b64).toBe('string')
        const raw = Buffer.from(c.b64 as string, 'base64')
        expect(raw.length).toBeGreaterThan(0)
        expect(raw.length % 2).toBe(0)
        expect(raw.toString('base64')).toBe(c.b64 as string)
        parts.push(raw)
      }
      // Every chunk precedes the answer; streaming replaces local partials.
      const at = h.indexOf(audio)
      await sleep(300)
      expect(h.lateAfter(at, 'chunk', 0)).toEqual([])
      expect(h.since(from, 'partial')).toEqual([])
      try {
        // Sample for sample what the WAV holds: nothing dropped, repeated or reordered.
        const wav = wavInfo(audio.path as string)
        expect(wav).not.toBeNull()
        const pcm = Buffer.concat(parts)
        expect(pcm.length).toBe(wav!.dataBytes)
        expect(pcm.equals(wav!.data)).toBe(true)
      } finally {
        rmSync(audio.path as string, { force: true })
      }

      // A cancelled recording flushes nothing more, and `stream off` stops the chunks.
      const c = await startRecording(h)
      await sleep(500)
      h.send('cancel')
      const cancelled = await h.waitFor('cancelled', { from: c })
      await sleep(300)
      expect(h.lateAfter(h.indexOf(cancelled), 'chunk', 0)).toEqual([])
      h.send('stream off')
      const off = await startRecording(h)
      await sleep(500)
      h.send('cancel')
      await h.waitFor('cancelled', { from: off })
      expect(h.since(off, 'chunk')).toEqual([])
    })
  }, 60_000)
})

describe('mic test', () => {
  test.skipIf(skipMic)('mic-test: started with the device, levels, then ended on mic-test-stop', async () => {
    await withHelper(async (h) => {
      const pinned = await pinTestMic(h)
      const name = (pinned!.devices as { uid: string; name: string }[]).find((d) => d.uid === MIC_UID)!.name
      const from = h.mark()
      h.send('mic-test')
      const started = await h.waitFor('mic-test', { from })
      expect(started.state).toBe('started')
      expect(started.device).toBe(name)
      expect('error' in started).toBe(false)
      await sleep(900)
      h.send('mic-test-stop')
      const ended = await h.waitFor('mic-test', { from, where: (e) => e.state === 'ended' })
      expect('error' in ended).toBe(false)
      await sleep(400)

      const levels = h.since(from, 'mic-test-level')
      expect(levels.length).toBeGreaterThanOrEqual(5)
      for (const ev of levels) expect(unit(ev.value)).toBe(true)
      const spectra = h.since(from, 'spectrum')
      expect(spectra.length).toBeGreaterThanOrEqual(3)
      for (const ev of spectra) expect((ev.bands as unknown[]).length).toBe(28)

      // A test is not a recording.
      const types = h.since(from).map((e) => e.type)
      for (const t of ['level', 'started', 'cancelled', 'final', 'transcribing', 'partial', 'chunk']) expect(types).not.toContain(t)
      expect(h.since(from, 'mic-test').map((e) => e.state)).toEqual(['started', 'ended'])
      const at = h.indexOf(ended)
      expect(h.lateAfter(at, 'mic-test-level', 250)).toEqual([])
      expectNoErrors(h, from)
    })
  }, 15_000)

  test.skipIf(skipMic)('a second `mic-test` restarts it quietly; `cancel` and `stop` leave it running', async () => {
    await withHelper(async (h) => {
      expect(await pinTestMic(h)).not.toBeNull()
      const from = h.mark()
      h.send('mic-test')
      await h.waitFor('mic-test', { from, where: (e) => e.state === 'started' })
      await sleep(300)
      const second = h.mark()
      h.send('mic-test')
      await h.waitFor('mic-test', { from: second, where: (e) => e.state === 'started' })
      // Recording commands are not about the test.
      h.send('cancel')
      h.send('stop mt-1')
      await h.waitFor('final', { from: second, where: (e) => e.id === 'mt-1' })
      const m = h.mark()
      await sleep(400)
      expect(h.since(m, 'mic-test-level').length).toBeGreaterThan(0)
      h.send('mic-test-stop')
      await h.waitFor('mic-test', { from: m, where: (e) => e.state === 'ended' })
      await sleep(200)
      // The first test ended without a word; only the second one's end is reported.
      expect(h.since(from, 'mic-test').map((e) => e.state)).toEqual(['started', 'started', 'ended'])
      expect(h.since(from, 'level')).toEqual([])
    })
  }, 15_000)

  test.skipIf(skipMic)('`start` takes the microphone from a running test', async () => {
    await withHelper(async (h) => {
      expect(await pinTestMic(h)).not.toBeNull()
      const from = h.mark()
      h.send('mic-test')
      await h.waitFor('mic-test', { from, where: (e) => e.state === 'started' })
      h.send('start')
      await h.waitFor('started', { from })
      await sleep(300)
      h.send('cancel')
      await h.waitFor('cancelled', { from })
      const types = h.since(from).filter((e) => e.type === 'mic-test' || e.type === 'started').map((e) => (e.type === 'mic-test' ? `mic-test:${e.state}` : e.type))
      // The test ends before the recording reports it has started.
      expect(types).toEqual(['mic-test:started', 'mic-test:ended', 'started'])
    })
  }, 15_000)

  test.skipIf(skipMic)('`mic-test` while recording ends at once and leaves the recording alone', async () => {
    await withHelper(async (h) => {
      const from = await startRecording(h)
      const m = h.mark()
      h.send('mic-test')
      const ev = await h.waitFor('mic-test', { from: m })
      expect(ev.state).toBe('ended')
      await sleep(300)
      expect(h.since(m, 'mic-test-level')).toEqual([])
      expect(h.since(m, 'level').length).toBeGreaterThan(0)
      h.send('cancel')
      await h.waitFor('cancelled', { from })
    })
  }, 15_000)

  test.skipIf(skipMic || !SLOW)('a mic test ends by itself after about 6 seconds', async () => {
    await withHelper(async (h) => {
      expect(await pinTestMic(h)).not.toBeNull()
      const from = h.mark()
      const t0 = performance.now()
      h.send('mic-test')
      await h.waitFor('mic-test', { from, where: (e) => e.state === 'started' })
      await h.waitFor('mic-test', { from, timeout: 9000, where: (e) => e.state === 'ended' })
      const took = performance.now() - t0
      expect(took).toBeGreaterThan(5000)
      expect(took).toBeLessThan(8000)
    })
  }, 15_000)
})

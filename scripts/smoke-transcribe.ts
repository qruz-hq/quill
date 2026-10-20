/**
 * Transcribes whisper.cpp's jfk.wav with the built Rust helper and checks the
 * words come back. Catches a whisper build that runs but decodes garbage (a
 * line of "!" is NaN logits), which the conformance tests cannot see on
 * Windows and Linux: their speech fixture needs macOS `say`.
 *
 *   bun scripts/smoke-transcribe.ts <helper> <run> [<run> ...]
 *
 * A run is `<model>[,<lang>[,<threads>]]`: the language is `en` unless given,
 * and the thread count the helper's own choice. With a language other than
 * English the text is not checked for the words, only for being real text.
 */
import { spawn } from 'child_process'
import { join, resolve } from 'path'

const root = resolve(import.meta.dir, '..')
// SMOKE_WAV replays another recording (one a user's helper saved after a
// failure); its words are not checked, only that they are real text.
const custom = process.env.SMOKE_WAV
const wav = custom ? resolve(custom) : join(root, 'native', 'helper', 'vendor', 'whisper-rs-sys', 'whisper.cpp', 'samples', 'jfk.wav')
const [helper, ...runs] = process.argv.slice(2)
if (!helper || runs.length === 0) {
  console.error('usage: bun scripts/smoke-transcribe.ts <helper> <model>[,<lang>[,<threads>]] ...')
  process.exit(2)
}

function transcribe(model: string, lang: string, threads: string | undefined): Promise<string> {
  return new Promise((done, fail) => {
    const env = threads ? { ...process.env, QUILL_WHISPER_THREADS: threads } : process.env
    const child = spawn(resolve(helper), [], { stdio: ['pipe', 'pipe', 'inherit'], env })
    const timer = setTimeout(() => {
      child.kill()
      fail(new Error('no final within 180 s'))
    }, 180_000)
    let buffer = ''
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      let at: number
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim()
        buffer = buffer.slice(at + 1)
        if (!line.startsWith('{')) continue
        const ev = JSON.parse(line) as { type?: string; id?: string; text?: string; error?: string }
        if (ev.type === 'final' && ev.id === 'smoke') {
          clearTimeout(timer)
          child.stdin.end('quit\n')
          if (ev.error) fail(new Error(ev.error))
          else done(ev.text ?? '')
        }
      }
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      fail(new Error(`helper exited (${code}) before a final`))
    })
    child.stdin.write(`model ${resolve(model)}\nlang ${lang}\ntranscribe-file smoke ${wav}\n`)
  })
}

let failed = false
for (const run of runs) {
  const [model, lang = 'en', threads] = run.split(',')
  const started = performance.now()
  try {
    const text = await transcribe(model, lang, threads)
    const ms = Math.round(performance.now() - started)
    // A line of "!" is token 0 over and over: NaN logits.
    const real = /\p{L}{3}/u.test(text) && !/!{5}/.test(text)
    const ok = lang === 'en' && !custom ? /ask not what your country/i.test(text) : real
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${run} in ${ms} ms: ${JSON.stringify(text.slice(0, 200))}`)
    if (!ok) failed = true
  } catch (error) {
    console.log(`FAIL ${model}: ${(error as Error).message}`)
    failed = true
  }
}
process.exit(failed ? 1 : 0)

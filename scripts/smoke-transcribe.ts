/**
 * Transcribes whisper.cpp's jfk.wav with the built Rust helper and checks the
 * words come back. Catches a whisper build that runs but decodes garbage (a
 * line of "!" is NaN logits), which the conformance tests cannot see on
 * Windows and Linux: their speech fixture needs macOS `say`.
 *
 *   bun scripts/smoke-transcribe.ts <helper> <model> [<model> ...]
 */
import { spawn } from 'child_process'
import { join, resolve } from 'path'

const root = resolve(import.meta.dir, '..')
const wav = join(root, 'native', 'helper', 'vendor', 'whisper-rs-sys', 'whisper.cpp', 'samples', 'jfk.wav')
const [helper, ...models] = process.argv.slice(2)
if (!helper || models.length === 0) {
  console.error('usage: bun scripts/smoke-transcribe.ts <helper> <model> [<model> ...]')
  process.exit(2)
}

function transcribe(model: string): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn(resolve(helper), [], { stdio: ['pipe', 'pipe', 'inherit'] })
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
    child.stdin.write(`model ${resolve(model)}\nlang en\ntranscribe-file smoke ${wav}\n`)
  })
}

let failed = false
for (const model of models) {
  const started = performance.now()
  try {
    const text = await transcribe(model)
    const ms = Math.round(performance.now() - started)
    const ok = /ask not what your country/i.test(text)
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${model} in ${ms} ms: ${JSON.stringify(text.slice(0, 200))}`)
    if (!ok) failed = true
  } catch (error) {
    console.log(`FAIL ${model}: ${(error as Error).message}`)
    failed = true
  }
}
process.exit(failed ? 1 : 0)

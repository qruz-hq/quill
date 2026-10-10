/**
 * Puts the whisper.cpp source where the Rust build looks for it:
 * native/helper/vendor/whisper-rs-sys/whisper.cpp, at the commit in
 * vendor/whisper-rs-sys/PIN (the commit the app's whisper-cli is built from).
 *
 *   bun native/helper/scripts/whisper-src.ts     fetch it if it is not there yet
 *
 * `helper:build` calls this. It takes the commit from the Swift helper's own
 * checkout (.build/whisper.cpp) when that has it, and from GitHub otherwise.
 * Set QUILL_WHISPER_CPP_DIR to build from a checkout of your own instead.
 */
import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { join, resolve } from 'path'

const root = resolve(import.meta.dir, '..', '..', '..')
const sys = resolve(import.meta.dir, '..', 'vendor', 'whisper-rs-sys')
const UPSTREAM = 'https://github.com/ggml-org/whisper.cpp.git'

function git(cwd: string, ...argv: string[]): { ok: boolean; out: string } {
  const result = spawnSync('git', argv, { cwd, encoding: 'utf8' })
  return { ok: result.status === 0, out: `${result.stdout ?? ''}`.trim() }
}

/** The folder holding the pinned whisper.cpp source, fetched on first use. */
export function whisperSource(): string {
  const pin = readFileSync(join(sys, 'PIN'), 'utf8').trim()
  const named = process.env.QUILL_WHISPER_CPP_DIR
  if (named) return resolve(named)

  const dir = join(sys, 'whisper.cpp')
  if (existsSync(join(dir, '.git')) && git(dir, 'rev-parse', 'HEAD').out === pin) return dir

  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '--quiet')
  const local = join(root, '.build', 'whisper.cpp')
  const sources = [...(existsSync(join(local, '.git')) ? [local] : []), UPSTREAM]
  for (const source of sources) {
    console.log(`whisper.cpp ${pin.slice(0, 12)}: fetching from ${source}`)
    if (!git(dir, 'fetch', '--quiet', '--depth', '1', source, pin).ok) continue
    if (!git(dir, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--force', 'FETCH_HEAD').ok) continue
    if (git(dir, 'rev-parse', 'HEAD').out === pin) return dir
  }
  rmSync(dir, { recursive: true, force: true })
  console.error(`whisper.cpp ${pin} could not be fetched (tried ${sources.join(', ')}).`)
  process.exit(1)
}

if (import.meta.main) console.log(whisperSource())

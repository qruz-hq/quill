/**
 * Builds the Rust helper for this machine and puts it where the app looks:
 * resources/helper/flow-stt (flow-stt.exe on Windows).
 *
 *   bun run helper:build              release build with local whisper (cargo feature "asr")
 *   bun run helper:build --no-asr     without whisper: no cmake needed, no local transcription
 *   bun run helper:build --debug      debug profile
 *
 * whisper.cpp is built from source at a pinned commit (whisper-src.ts fetches
 * it on the first run) and needs cmake. When cmake is not on PATH the copy that
 * the Swift helper's whisper build keeps in .build/cmake is used.
 *
 * On a Mac the whole build (Rust, and the C, C++ and Objective-C of whisper.cpp)
 * targets MACOS_TARGET unless MACOSX_DEPLOYMENT_TARGET is already set. Without
 * it the compilers target the macOS of the build machine, and a helper built
 * on a new macOS does not start on an older one.
 */
import { spawnSync } from 'child_process'
import { copyFileSync, chmodSync, existsSync, mkdirSync } from 'fs'
import { delimiter, join, resolve } from 'path'
import { whisperSource } from './whisper-src'

const root = resolve(import.meta.dir, '..', '..', '..')
const crate = resolve(import.meta.dir, '..')
const args = new Set(process.argv.slice(2))
const asr = !args.has('--no-asr')
const debug = args.has('--debug')
const exe = process.platform === 'win32' ? 'flow-stt.exe' : 'flow-stt'

/** The oldest macOS the helper runs on. vendor/whisper-rs-sys/build.rs has the same default. */
const MACOS_TARGET = '11.0'

const env = { ...process.env }
if (process.platform === 'darwin' && !env.MACOSX_DEPLOYMENT_TARGET) env.MACOSX_DEPLOYMENT_TARGET = MACOS_TARGET
const localCmake = join(root, '.build', 'cmake', 'CMake.app', 'Contents', 'bin')
if (asr && existsSync(join(localCmake, 'cmake'))) env.PATH = `${env.PATH ?? ''}${delimiter}${localCmake}`
if (asr) env.QUILL_WHISPER_CPP_DIR = whisperSource()

function run(cmd: string, argv: string[], cwd: string): void {
  console.log(`$ ${cmd} ${argv.join(' ')}`)
  const result = spawnSync(cmd, argv, { cwd, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const cargo = ['build', '--locked']
if (!debug) cargo.push('--release')
if (asr) cargo.push('--features', 'asr')
run('cargo', cargo, crate)

const built = join(crate, 'target', debug ? 'debug' : 'release', exe)
const outDir = join(root, 'resources', 'helper')
const out = join(outDir, exe)
mkdirSync(outDir, { recursive: true })
copyFileSync(built, out)
if (process.platform !== 'win32') chmodSync(out, 0o755)

if (process.platform === 'darwin') {
  // Ad-hoc signature with the helper's bundle id, the same one the Swift helper is
  // signed with, so macOS sees one identity whichever helper the app ships.
  run('codesign', ['--force', '--sign', '-', '--identifier', 'studio.saudad.quill.stt', out], root)
}
console.log(`helper: ${out}${asr ? '' : ' (no local transcription)'}`)

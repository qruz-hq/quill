/**
 * Builds the Rust helper for the machine this runs on and leaves it where the
 * app and electron-builder look: resources/helper/flow-stt (flow-stt.exe on
 * Windows).
 *
 *   bun run helper:build              release build with local whisper
 *   bun run helper:build --no-asr     without whisper (no cmake or libclang needed)
 *   bun run helper:build --debug      debug profile
 *
 * The compiling is native/helper/scripts/build.ts; this adds what differs per
 * OS and says what is missing before cargo gets to say it less clearly:
 *
 *  - macOS: whisper with Metal, built for this Mac's architecture. cmake comes
 *    from PATH or from .build/cmake.
 *  - Windows (MSVC): the C runtime is linked statically, so the installer does
 *    not have to carry the Visual C++ redistributable. whisper runs on the CPU.
 *  - Linux: whisper runs on the CPU. Needs the ALSA and PulseAudio headers
 *    (Debian: libasound2-dev libpulse-dev pkg-config) and libclang.
 *
 * There is no cross-compiling: build on the OS you ship for (CI does, see
 * .github/workflows).
 */
import { spawnSync } from 'child_process'
import { existsSync, statSync } from 'fs'
import { join, resolve } from 'path'

const root = resolve(import.meta.dir, '..')
const args = process.argv.slice(2)
const asr = !args.includes('--no-asr')
const exe = process.platform === 'win32' ? 'flow-stt.exe' : 'flow-stt'

function has(cmd: string): boolean {
  const probe = process.platform === 'win32' ? 'where' : 'which'
  return spawnSync(probe, [cmd], { stdio: 'ignore' }).status === 0
}

const missing: string[] = []
if (!has('cargo')) missing.push('cargo (install Rust from https://rustup.rs)')
if (asr) {
  const localCmake = join(root, '.build', 'cmake', 'CMake.app', 'Contents', 'bin', 'cmake')
  if (!has('cmake') && !existsSync(localCmake)) missing.push('cmake (whisper.cpp is built from source; or pass --no-asr)')
  if (!has('git')) missing.push('git (fetches the pinned whisper.cpp source)')
  if (process.platform === 'linux' && !has('pkg-config')) missing.push('pkg-config, with libasound2-dev and libpulse-dev')
}
if (missing.length) {
  console.error(`helper:build cannot start, missing:\n${missing.map((m) => `  - ${m}`).join('\n')}`)
  process.exit(1)
}

const env = { ...process.env }
if (process.platform === 'win32') {
  // Static CRT for the helper and, through the cmake crate, for whisper.cpp.
  const flag = '-C target-feature=+crt-static'
  if (!(env.RUSTFLAGS ?? '').includes('crt-static')) env.RUSTFLAGS = `${env.RUSTFLAGS ?? ''} ${flag}`.trim()
  // bindgen needs libclang; the LLVM installer and the GitHub runners put it here.
  const llvm = 'C:\\Program Files\\LLVM\\bin'
  if (asr && !env.LIBCLANG_PATH && existsSync(join(llvm, 'libclang.dll'))) env.LIBCLANG_PATH = llvm
}

const build = spawnSync('bun', [join(root, 'native', 'helper', 'scripts', 'build.ts'), ...args], {
  cwd: root,
  env,
  stdio: 'inherit'
})
if (build.error) throw build.error
if (build.status !== 0) process.exit(build.status ?? 1)

const out = join(root, 'resources', 'helper', exe)
if (!existsSync(out)) {
  console.error(`helper:build finished but ${out} is not there`)
  process.exit(1)
}
console.log(`helper for ${process.platform}/${process.arch}: ${out} (${(statSync(out).size / 1e6).toFixed(1)} MB)`)

/**
 * Packages Quill for the OS this runs on. electron-builder cannot build a
 * macOS app on Windows or the reverse, and the native helper is not cross
 * compiled either, so each OS packages itself (CI runs all three).
 *
 *   bun run package     unpacked app in dist/, no installer (fast, for checking)
 *   bun run dist        installers in dist/: dmg + zip (macOS), nsis (Windows), AppImage + deb (Linux)
 *   bun run release     the same, uploaded to a draft GitHub release
 *
 * Flags: --dir, --publish always|never, --skip-typecheck.
 *
 * It refuses to start when a native helper it would package is not built,
 * because electron-builder leaves a missing extra file out without failing
 * and the result is an app that cannot record.
 */
import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { join, resolve } from 'path'

const root = resolve(import.meta.dir, '..')
const args = process.argv.slice(2)
const dirOnly = args.includes('--dir')
const publishAt = args.indexOf('--publish')
const publish = publishAt >= 0 ? args[publishAt + 1] : undefined
const target = process.platform === 'darwin' ? '--mac' : process.platform === 'win32' ? '--win' : '--linux'

function run(cmd: string, argv: string[]): void {
  console.log(`$ ${cmd} ${argv.join(' ')}`)
  const result = spawnSync(cmd, argv, { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

// What electron-builder.yml packages for this OS, and how to make it.
const needed: { path: string; make: string }[] =
  process.platform === 'darwin'
    ? [
        { path: 'resources/FlowSTT.app/Contents/MacOS/flow-stt', make: 'bun run stt:build' },
        { path: 'resources/helper/flow-stt', make: 'bun run helper:build' },
        { path: 'resources/whisper/whisper-cli', make: 'see .build/rebuild.sh' }
      ]
    : process.platform === 'win32'
      ? [{ path: 'resources/helper/flow-stt.exe', make: 'bun run helper:build' }]
      : [{ path: 'resources/helper/flow-stt', make: 'bun run helper:build' }]
const absent = needed.filter((n) => !existsSync(join(root, n.path)))
if (absent.length) {
  console.error(`Not built yet:\n${absent.map((n) => `  - ${n.path}  (${n.make})`).join('\n')}`)
  process.exit(1)
}

// The Swift helper's whisper-cli finds its dylibs through @loader_path.
if (process.platform === 'darwin') run('bun', ['run', 'whisper:fixrpath'])
if (!dirOnly && !args.includes('--skip-typecheck')) run('bun', ['run', 'typecheck'])
run('bun', ['x', 'electron-vite', 'build'])

const builder = [target]
if (dirOnly) builder.push('--dir')
if (publish) builder.push('--publish', publish)
run('bun', ['x', 'electron-builder', ...builder])

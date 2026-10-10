#!/usr/bin/env bun
/**
 * Dock/app icon and menu-bar template icon, drawn from the Quill nib (app-mark).
 *
 *   bun scripts/icons/app-icon.ts
 *
 * Writes:
 *   build/icon.png                      1024² app icon (electron-builder input)
 *   build/icon.icns                     via macOS `iconutil`
 *   resources/icons/trayTemplate.png    22×22  menu-bar template (16 master at 1×, centred)
 *   resources/icons/trayTemplate@2x.png 44×44  (same 16 master at 2×)
 */
import { Resvg } from '@resvg/resvg-js'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const ROOT = resolve(import.meta.dir, '../..')
const SVG = join(import.meta.dir, 'source/svg')

/** Brand tokens (design.pen: $violet / $violet-on). */
const TILE = '#6A4BFF'
const INK = '#FFFFFF'

const pathOf = (file: string): string => {
  const d = /<path[^>]*\sd="([^"]+)"/.exec(readFileSync(join(SVG, file), 'utf8'))?.[1]
  if (!d) throw new Error(`no path in ${file}`)
  return d
}

const render = (svg: string, width: number): Buffer =>
  new Resvg(svg, { fitTo: { mode: 'width', value: width }, shapeRendering: 2 }).render().asPng()

/* ---- app icon: macOS grid, 824² tile inset 100 on a 1024 canvas, corner radius 185.4 ---- */
const mark20 = pathOf('app-mark.20.active.svg') // filled nib, as in the hub sidebar brand
const S = 28 // 20-unit master → 560 px box; ink spans ~15 units ≈ 420 px, about half the tile
const off = 512 - 10 * S
const appSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <rect x="100" y="100" width="824" height="824" rx="185.4" fill="${TILE}"/>
  <path transform="translate(${off} ${off}) scale(${S})" fill="${INK}" d="${mark20}"/>
</svg>`

mkdirSync(join(ROOT, 'build'), { recursive: true })
writeFileSync(join(ROOT, 'build/icon.png'), render(appSvg, 1024))

const set = join(tmpdir(), `quill-${process.pid}.iconset`)
rmSync(set, { recursive: true, force: true })
mkdirSync(set)
for (const s of [16, 32, 128, 256, 512]) {
  writeFileSync(join(set, `icon_${s}x${s}.png`), render(appSvg, s))
  writeFileSync(join(set, `icon_${s}x${s}@2x.png`), render(appSvg, s * 2))
}
execFileSync('iconutil', ['-c', 'icns', set, '-o', join(ROOT, 'build/icon.icns')])
rmSync(set, { recursive: true, force: true })

/* ---- tray template: 16 master, black + alpha, centred in the 22 pt menu-bar slot ---- */
const mark16 = pathOf('app-mark.16.active.svg')
const traySvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 22" width="22" height="22">
  <path transform="translate(3 3)" fill="#000" d="${mark16}"/>
</svg>`
mkdirSync(join(ROOT, 'resources/icons'), { recursive: true })
writeFileSync(join(ROOT, 'resources/icons/trayTemplate.png'), render(traySvg, 22))
writeFileSync(join(ROOT, 'resources/icons/trayTemplate@2x.png'), render(traySvg, 44))

console.log('wrote build/icon.png, build/icon.icns, resources/icons/trayTemplate{,@2x}.png')

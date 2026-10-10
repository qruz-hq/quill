#!/usr/bin/env bun
/**
 * Quill icon family → src/renderer/src/shared/icons.tsx
 *
 *   bun scripts/icons/build.ts                  # regenerate icons.tsx from scripts/icons/source
 *   bun scripts/icons/build.ts --from <dir>     # first sync <dir>/manifest.json + <dir>/svg/* into source
 *
 * <dir> is the icon kit's outlined export folder (the `out/` of `bun outline.ts`):
 * manifest.json plus one SVG per master and state. The SVG files are the source of
 * truth; the manifest only says which files exist. Each master (16, 20, 32) is emitted
 * as drawn; nothing is ever scaled from another size.
 */
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '../..')
const SOURCE = join(import.meta.dir, 'source')
const OUT = join(ROOT, 'src/renderer/src/shared/icons.tsx')

type Ref = { file: string; d: string }
type Entry = {
  master: 16 | 20 | 32
  stroke: number
  meaning: string
  rest: Ref
  active?: Ref
  duo?: Ref & { secondary: string; opacity: number }
}
type Manifest = Record<string, Entry>

/* ---------- optional sync from the kit export ---------- */
const fromIdx = process.argv.indexOf('--from')
if (fromIdx > 0) {
  const from = resolve(process.argv[fromIdx + 1] ?? '')
  const m: Manifest = JSON.parse(readFileSync(join(from, 'manifest.json'), 'utf8'))
  rmSync(SOURCE, { recursive: true, force: true })
  mkdirSync(join(SOURCE, 'svg'), { recursive: true })
  copyFileSync(join(from, 'manifest.json'), join(SOURCE, 'manifest.json'))
  let n = 0
  for (const e of Object.values(m)) {
    for (const r of [e.rest, e.active, e.duo]) {
      if (!r) continue
      mkdirSync(dirname(join(SOURCE, r.file)), { recursive: true })
      copyFileSync(join(from, r.file), join(SOURCE, r.file)); n++
    }
  }
  console.log(`synced ${n} SVGs from ${from}`)
}

/* ---------- read + verify ---------- */
const manifest: Manifest = JSON.parse(readFileSync(join(SOURCE, 'manifest.json'), 'utf8'))

type Layer = { d: string; rule?: 'evenodd' | 'nonzero'; opacity?: number }
/** Parses one exported SVG into its paint layers, in document order. */
function readSvg(file: string, master: number): Layer[] {
  const src = readFileSync(join(SOURCE, file), 'utf8')
  const vb = /viewBox="([^"]+)"/.exec(src)?.[1]
  if (vb !== `0 0 ${master} ${master}`) throw new Error(`${file}: viewBox "${vb}" is not the ${master} master`)
  if (!/<svg[^>]*fill="currentColor"/.test(src)) throw new Error(`${file}: root fill is not currentColor`)
  if (/transform=|stroke=/.test(src)) throw new Error(`${file}: transforms/strokes are not allowed in outlined exports`)
  const rootRule = /<svg[^>]*fill-rule="(evenodd|nonzero)"/.exec(src)?.[1] as Layer['rule']
  const layers: Layer[] = []
  // Each <path> optionally sits inside a <g opacity="…"> (duo-tone secondary layer).
  const re = /(<g[^>]*>)?\s*<path([^>]*)\/>/g
  let mm: RegExpExecArray | null
  while ((mm = re.exec(src))) {
    const attrs = mm[2]
    const d = /\sd="([^"]+)"/.exec(attrs)?.[1]
    if (!d) throw new Error(`${file}: path without d`)
    const rule = (/fill-rule="(evenodd|nonzero)"/.exec(attrs)?.[1] as Layer['rule']) ?? rootRule
    const op = mm[1] ? /opacity="([\d.]+)"/.exec(mm[1])?.[1] : undefined
    layers.push({ d, ...(rule && rule !== 'nonzero' ? { rule } : {}), ...(op ? { opacity: Number(op) } : {}) })
  }
  if (!layers.length) throw new Error(`${file}: no paths`)
  return layers
}

type Variant = { d: string; rule?: 'evenodd' }
type Master = { rest: Variant; active?: Variant; rtl?: Variant; rtlActive?: Variant; duo?: { d: string; secondary: string; opacity: number } }
const glyphs = new Map<string, { meaning: string; masters: Partial<Record<16 | 20 | 32, Master>> }>()

const single = (file: string, master: number, expectD: string): Variant => {
  const l = readSvg(file, master)
  if (l.length !== 1) throw new Error(`${file}: expected one compound path, got ${l.length}`)
  if (l[0].d !== expectD) throw new Error(`${file}: path data differs from manifest`)
  return l[0].rule === 'evenodd' ? { d: l[0].d, rule: 'evenodd' } : { d: l[0].d }
}

for (const [key, e] of Object.entries(manifest)) {
  const parts = key.split('.')           // name.N  or  name.N.rtl
  const name = parts[0]
  const size = Number(parts[1]) as 16 | 20 | 32
  const rtl = parts[2] === 'rtl'
  if (size !== e.master) throw new Error(`${key}: master mismatch`)
  const g = glyphs.get(name) ?? { meaning: e.meaning, masters: {} }
  glyphs.set(name, g)
  const m: Master = g.masters[size] ?? ({} as Master)
  g.masters[size] = m
  const rest = single(e.rest.file, size, e.rest.d)
  const active = e.active ? single(e.active.file, size, e.active.d) : undefined
  if (rtl) { m.rtl = rest; if (active) m.rtlActive = active }
  else {
    m.rest = rest; if (active) m.active = active
    if (e.duo) {
      const l = readSvg(e.duo.file, size)
      const sec = l.find((x) => x.opacity !== undefined)
      const pri = l.find((x) => x.opacity === undefined)
      if (!sec || !pri || pri.d !== e.rest.d || sec.d !== e.duo.secondary) throw new Error(`${e.duo.file}: duo layers differ from manifest`)
      m.duo = { d: pri.d, secondary: sec.d, opacity: sec.opacity! }
    }
  }
}
for (const [name, g] of glyphs) {
  for (const [s, m] of Object.entries(g.masters)) if (!m!.rest) throw new Error(`${name}.${s}: rtl without ltr master`)
  if (!g.masters[16] || !g.masters[20]) throw new Error(`${name}: every glyph needs both the 16 and 20 masters`)
}

/* ---------- legacy wrappers: old export → closest Quill glyph ---------- */
const LEGACY: [string, string][] = [
  ['MicIcon', 'microphone'], ['RecordIcon', 'note-plus'], ['ChartIcon', 'gauge'],
  ['ScissorsIcon', 'speech-bubble'], ['TypeIcon', 'accessibility'], ['WandIcon', 'wand'],
  ['NoteIcon', 'notepad'], ['GearIcon', 'sliders'], ['HelpIcon', 'info'], ['SidebarIcon', 'sidebar'],
  ['BellIcon', 'bell'], ['SearchIcon', 'magnifier'], ['PlayIcon', 'play'], ['CopyIcon', 'copy'],
  ['FlagIcon', 'flag'], ['EllipsisIcon', 'ellipsis'], ['UndoIcon', 'undo'], ['RetryIcon', 'retry'],
  ['TrashIcon', 'trash'], ['AudioFileIcon', 'audio-file'], ['GlobeIcon', 'globe'], ['ChevronLeftIcon', 'chevron-left']
]
for (const [, n] of LEGACY) if (!glyphs.has(n)) throw new Error(`legacy map points at unknown glyph ${n}`)

/* ---------- emit ---------- */
const names = [...glyphs.keys()].sort()
const n32 = names.filter((n) => glyphs.get(n)!.masters[32])
const q = (s: string) => `'${s}'`
const v = (x?: Variant) => (x ? (x.rule ? `{ d: ${q(x.d)}, rule: 'evenodd' }` : `{ d: ${q(x.d)} }`) : undefined)
const master = (m: Master) => {
  const f: string[] = [`rest: ${v(m.rest)}`]
  if (m.active) f.push(`active: ${v(m.active)}`)
  if (m.rtl) f.push(`rtl: ${v(m.rtl)}`)
  if (m.rtlActive) f.push(`rtlActive: ${v(m.rtlActive)}`)
  if (m.duo) f.push(`duo: { secondary: ${q(m.duo.secondary)}, opacity: ${m.duo.opacity} }`)
  return `{\n      ${f.join(',\n      ')}\n    }`
}

const data = names.map((n) => {
  const g = glyphs.get(n)!
  const ms = ([16, 20, 32] as const).filter((s) => g.masters[s]).map((s) => `    ${s}: ${master(g.masters[s]!)}`)
  return `  /** ${g.meaning} */\n  ${q(n)}: {\n${ms.join(',\n')}\n  }`
}).join(',\n')

const tsx = `/* eslint-disable */
// GENERATED by scripts/icons/build.ts from the Quill icon family (scripts/icons/source).
// Do not edit by hand: change the drawing in the icon kit, export, then
//   bun scripts/icons/build.ts --from <kit>/out
import type { SVGProps } from 'react'

/** Every Quill glyph. Each has hand-drawn 16 and 20 px masters. */
export type IconName =
${names.map((n) => `  | ${q(n)}`).join('\n')}

/** Glyphs that also have a hand-drawn 32 px master (bento tiles, empty states). */
export type Icon32Name =
${n32.map((n) => `  | ${q(n)}`).join('\n')}

/** The only render sizes. A master is never scaled to another size. */
export type IconSize = 16 | 20 | 32

type Variant = { d: string; rule?: 'evenodd' }
type Master = {
  rest: Variant
  active?: Variant
  rtl?: Variant
  rtlActive?: Variant
  duo?: { secondary: string; opacity: number }
}

const GLYPHS: Record<IconName, { 16: Master; 20: Master; 32?: Master }> = {
${data}
}

export const ICON_NAMES = Object.keys(GLYPHS) as IconName[]

type SvgRest = Omit<SVGProps<SVGSVGElement>, 'name' | 'width' | 'height' | 'viewBox' | 'fill' | 'children' | 'ref'>
type Common = SvgRest & {
  /** Filled variant for the selected / on / recording state (falls back to rest when a glyph has none). */
  active?: boolean
  /** Accessible name. Without one the icon is decorative (aria-hidden). */
  label?: string
  /** Use the RTL redraw where one exists. Defaults to the document direction. */
  rtl?: boolean
}
export type IconProps =
  | (Common & { name: IconName; size?: 16 | 20; duo?: never })
  | (Common & { name: Icon32Name; size: 32; /** Duo-tone accent layer (32 master only). */ duo?: boolean })

const docRtl = (): boolean =>
  typeof document !== 'undefined' && document.documentElement.dir === 'rtl'

export function Icon(props: IconProps): React.JSX.Element {
  const { name, size = 16, active = false, duo = false, label, rtl, className, style, ...rest } = props
  const glyph = GLYPHS[name]
  const m = (glyph as Record<number, Master | undefined>)[size] ?? glyph[20]
  const isRtl = rtl ?? docRtl()
  const pick: Variant =
    (isRtl && (active ? m.rtlActive ?? m.rtl : m.rtl)) || (active ? m.active ?? m.rest : m.rest)
  const a11y = label
    ? { role: 'img', 'aria-label': label }
    : { 'aria-hidden': true as const }
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={\`0 0 \${size} \${size}\`}
      width={size}
      height={size}
      fill="currentColor"
      focusable="false"
      data-icon={name}
      className={className ? \`qicon \${className}\` : 'qicon'}
      // Inline size beats any legacy \`.foo svg { width: 15px }\` rule: masters render only at their own size.
      style={{ width: size, height: size, flex: 'none', ...style }}
      {...a11y}
      {...rest}
    >
      {duo && m.duo && !active ? (
        <>
          <path d={m.duo.secondary} opacity={m.duo.opacity} />
          <path d={pick.d} fillRule={pick.rule} />
        </>
      ) : (
        <path d={pick.d} fillRule={pick.rule} />
      )}
    </svg>
  )
}

/* ---- brand ---- */
type MarkProps = Omit<Common, 'rtl'> & { size?: 16 | 20 }
/** The Quill nib. */
export const AppMark = ({ size = 20, ...p }: MarkProps): React.JSX.Element => (
  <Icon name="app-mark" size={size} {...p} />
)

/* ---- legacy named exports (thin wrappers; prefer <Icon name=…>) ---- */
type LegacyProps = SvgRest & { width?: number | string; height?: number | string }
const snap = (w?: number | string): 16 | 20 => (Number(w) > 17 ? 20 : 16)
const legacy = (name: IconName) => {
  const C = ({ width, height: _h, ...p }: LegacyProps): React.JSX.Element => (
    <Icon name={name} size={snap(width)} {...p} />
  )
  return C
}
${LEGACY.map(([k, n]) => `/** @deprecated use <Icon name="${n}" /> */\nexport const ${k} = legacy('${n}')`).join('\n')}
/** @deprecated use <AppMark /> */
export const FlowMark = ({ size, ...p }: LegacyProps & { size?: number }): React.JSX.Element => (
  <AppMark size={snap(size)} {...p} />
)
`

writeFileSync(OUT, tsx)
console.log(`wrote ${OUT}: ${names.length} glyphs (${n32.length} with a 32 master), ${tsx.length} bytes`)
if (!existsSync(OUT)) process.exit(1)

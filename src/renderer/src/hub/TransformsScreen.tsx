import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, m, type Variants } from 'motion/react'
import { Icon } from '../shared/icons'
import { Bento, Button, IconButton, Keycap, Tile, TileTop } from '../shared/ui'
import { BLUR, BlurNumber, BlurWords, DIST, DUR_MS, SPRING, blurPx, isReducedMotion, presets, tween } from '../shared/motion'
import TransformDialog from './dialogs/TransformDialog'
import { SAMPLES, applyTransform, slotAccent, type Transform } from './transformPreview'
import { Highlight, MORPH_SETTLE, Press, relTime, useDialogHost, useMinuteTick, useSwapReveal } from './sniptfMotion'
import './transforms.css'

const SLOTS = 9
/* $radius-lg as a number: Motion only scale-corrects a px radius set in `style`. */
const RADIUS_LG = 24
const NEW_ID = 'transform-new'
const morphIdOf = (id: string): string => `transform-${id}`
/* The cell's own id: cards keep their place in the reflow across grid rows. */
const cellIdOf = (id: string): string => `transform-cell-${id}`

/* Card states (docs/MOTION.md §4.8):
   fresh = just created (content fades in from blur 4)
   shown = at rest
   away  = its dialog is open: the card is the dialog now
   gone  = deleted (scale 0.96, blur 2, dur.micro), then the grid reflows */
type CardState = 'shown' | 'away' | 'gone'
const CARD: Variants = {
  fresh: presets.rowInsert.initial,
  shown: presets.rowInsert.animate,
  away: presets.rowInsert.animate,
  gone: presets.cardDelete.exit
}
/* Card content while the box morphs back from the dialog: in at t = 60. */
const PART: Variants = {
  shown: {
    opacity: 1, filter: [blurPx(BLUR.xs), blurPx(0)],
    transition: tween('fast', 'out', 0.06), transitionEnd: { filter: 'none' }
  },
  away: { opacity: 0, transition: { duration: 0 } }
}

/**
 * The cell's box (fill, radius, stroke) as its own text-free layer. It shares
 * `layoutId` with the dialog, so the container transform scales this layer and
 * never the card's text; the card itself only ever moves (`layout="position"`).
 */
function Ghost({ id, dep, returning, className }: {
  id: string; dep: string; returning: boolean; className: string
}): React.JSX.Element {
  return (
    <m.span
      aria-hidden="true"
      className={className}
      layoutId={id}
      layoutDependency={dep}
      layoutCrossfade={false}
      transition={{ layout: returning ? { ...SPRING.exit, ...MORPH_SETTLE } : SPRING.ui }}
      style={{ borderRadius: RADIUS_LG }}
    />
  )
}

/** Hub, Transforms (gsPhJ). */
export default function TransformsScreen(): React.JSX.Element {
  const [items, setItems] = useState<Transform[]>([])
  const [last, setLast] = useState<FlowTransformApplied | null>(null)
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set())
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set())
  const [flash, setFlash] = useState<{ id: string; n: number } | null>(null)
  const host = useDialogHost<Transform>()
  const now = useMinuteTick()
  const itemsRef = useRef(items)
  itemsRef.current = items
  const loaded = useRef(false)
  // The list waiting for the deleted cards to finish leaving.
  const pending = useRef<Transform[] | null>(null)

  // A cell that changes grid row is remounted. If it held focus (the dialog's
  // trigger), hand focus to its new instance so it never falls to <body>.
  const [ready, setReady] = useState(false)
  const focusCell = useRef<string | null>(null)
  const keepFocus = (): void => {
    focusCell.current = document.activeElement?.closest<HTMLElement>('[data-cell]')?.dataset.cell ?? null
  }
  useLayoutEffect(() => {
    const id = focusCell.current
    focusCell.current = null
    if (!id || document.activeElement !== document.body) return
    document.querySelector<HTMLElement>(`[data-cell="${id}"]`)?.focus({ preventScroll: true })
  }, [items])

  // Backstop for the commit: a card whose exit never reports back (Reduce
  // Motion switched on mid-way, a hidden window) must not stay on screen.
  const commitTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(commitTimer.current), [])
  const commit = (): void => {
    clearTimeout(commitTimer.current)
    if (!pending.current) return
    keepFocus()
    setItems(pending.current)
    pending.current = null
    setLeaving(new Set())
  }
  const apply = (list: unknown): void => {
    const next = list as Transform[]
    void window.flow.transforms.last().then(setLast)
    if (pending.current) { pending.current = next; return }
    const cur = itemsRef.current
    if (!loaded.current) { loaded.current = true; setItems(next); setReady(true); return }
    setFresh(new Set(next.filter((n) => !cur.some((x) => x.id === n.id)).map((n) => n.id)))
    const gone = cur.filter((x) => !next.some((n) => n.id === x.id)).map((x) => x.id)
    if (gone.length && !isReducedMotion() && document.visibilityState === 'visible') {
      pending.current = next
      setLeaving(new Set(gone))
      clearTimeout(commitTimer.current)
      commitTimer.current = setTimeout(commit, DUR_MS.signature)
    } else { keepFocus(); setItems(next) }
  }

  useEffect(() => {
    void window.flow.transforms.list().then(apply)
    // ⌥<n> anywhere: the tile shows it at once, the counters follow on `changed`.
    const offApplied = window.flow.transforms.onApplied(setLast)
    const offChanged = window.flow.transforms.onChanged(apply)
    return () => { offApplied(); offChanged() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const free = Math.max(0, SLOTS - items.length)
  const blank = (): Transform => {
    const used = new Set(items.map((t) => t.slot))
    let slot = 1
    for (let n = 1; n <= SLOTS; n++) if (!used.has(n)) { slot = n; break }
    return { id: '', name: '', description: '', slot, kind: 'template', config: '{text}' }
  }
  const save = (t: Transform): void => {
    const saved = window.flow.transforms.save(t)
    host.close(() => {
      void saved.then((list) => {
        apply(list)
        if (t.id) setFlash({ id: t.id, n: Date.now() })
      })
    })
  }
  const remove = (id: string): void => {
    const removed = window.flow.transforms.remove(id)
    host.close(() => { void removed.then(apply) })
  }

  // Grid (sUfLc): rows of three; the "Create your own" card follows the transforms.
  const cells: (Transform | 'new' | null)[] = [...items, 'new']
  while (cells.length % 3) cells.push(null)
  const rows: (typeof cells)[] = []
  for (let i = 0; i < cells.length; i += 3) rows.push(cells.slice(i, i + 3))

  const openId = host.open?.morphId ?? null
  // Cards re-measure only when the grid, or the dialog they morph with, changes.
  const dep = `${items.map((t) => t.id).join('|')}/${openId ?? ''}/${host.returning ?? ''}`
  const morphDep = `${openId ?? ''}/${host.returning ?? ''}`
  const editing = host.open?.value

  return (
    <Bento>
      <div className="tf__row1">
        <Tile accent="tangerine" hero className="tf__hero">
          <TileTop
            label="TRANSFORMS"
            after={<span className="tf__beta">Beta</span>}
            right={
              <Press>
                <Button className="tf__new" onClick={(e) => { if (free) host.show(blank(), e.currentTarget) }} disabled={!free}>
                  New transform
                </Button>
              </Press>
            }
          />
          <BlurWords as="h1" className="tf__headline" variant="titleUnit" initial text="Reshape it after you say it." />
          <div className="tf__shortcut">
            <span className="tf__shortcut-text">Hold</span>
            <Keycap>⌥ option</Keycap>
            <span className="tf__shortcut-text">and press</span>
            <Keycap>1–9</Keycap>
            <span className="tf__shortcut-text">to rewrite the last thing you dictated.</span>
          </div>
        </Tile>

        <Tile accent="violet" className="tf__last">
          <TileTop label="LAST APPLIED" icon="undo" />
          <LastApplied last={last} now={now} />
        </Tile>
      </div>

      <div className="tf__grid">
        {/* Nothing is drawn before the list arrives: a "Create your own" card
            placed first and then pushed along by the loaded transforms would
            slide in from the top left on every visit. */}
        {ready && rows.map((row, r) => (
          <div className="tf__grid-row" key={r}>
            {row.map((c, i) => {
              if (c === null) return <div key={`gap${i}`} className="tf__cell-gap" aria-hidden />
              if (c === 'new') return (
                <m.button
                  key="new"
                  type="button"
                  className="tf__create"
                  disabled={!free}
                  onClick={(e) => { if (free) host.show(blank(), e.currentTarget, { morphId: NEW_ID }) }}
                  data-cell="new"
                  data-returning={host.returning === NEW_ID ? '' : undefined}
                  layoutId={cellIdOf('new')}
                  layout="position"
                  layoutDependency={dep}
                  initial={false}
                  animate={openId === NEW_ID ? 'away' : 'shown'}
                  whileTap={free ? presets.press('card').whileTap : undefined}
                  transition={{ default: SPRING.snappy, layout: SPRING.ui }}
                >
                  <Ghost id={NEW_ID} dep={morphDep} returning={host.returning === NEW_ID} className="tf__ghost tf__ghost--create" />
                  <m.span className="tf__plus" variants={PART}><Icon name="plus" size={20} /></m.span>
                  <m.span className="tf__create-name" variants={PART}>Create your own</m.span>
                  <m.span className="tf__create-desc" variants={PART}>
                    {free ? `Write a prompt or pick a rule. ${free} of ${SLOTS} slots free.` : `All ${SLOTS} slots are taken.`}
                  </m.span>
                </m.button>
              )
              const id = morphIdOf(c.id)
              return (
                <TransformCard
                  key={c.id}
                  t={c}
                  state={leaving.has(c.id) ? 'gone' : openId === id ? 'away' : 'shown'}
                  fresh={fresh.has(c.id)}
                  returning={host.returning === id}
                  dep={dep}
                  morphDep={morphDep}
                  flash={flash?.id === c.id ? flash.n : 0}
                  onFlashed={() => setFlash(null)}
                  onOpen={(from, focus) => host.show(c, from, { morphId: id, focus })}
                  onGone={commit}
                />
              )
            })}
          </div>
        ))}
      </div>

      <AnimatePresence onExitComplete={host.settled}>
        {host.open && editing && (
          <TransformDialog
            key={host.open.key}
            transform={editing}
            taken={items.filter((x) => x.id !== editing.id).map((x) => x.slot)}
            total={items.length}
            motion={{ origin: host.open.origin, morphId: host.open.morphId }}
            onClose={() => host.close()}
            onSave={save}
            onDelete={remove}
          />
        )}
      </AnimatePresence>
    </Bento>
  )
}

/** "Bottom" of Tile / Last applied (WhXxz): the transform ⌥<n> ran last, from main. */
function LastApplied({ last, now }: { last: FlowTransformApplied | null; now: number }): React.JSX.Element {
  const name = last ? last.name : 'Nothing yet'
  const value = useSwapReveal<HTMLSpanElement>(name)
  return (
    <div className="tf__last-bottom">
      <span ref={value} className="tf__last-value" title={last ? last.name : undefined}>{name}</span>
      <span className="tf__last-caption">
        {last ? (
          <>⌥{last.slot} · <BlurNumber value={last.uses} size="subtle" /> {last.uses === 1 ? 'time' : 'times'} · {relTime(last.at, now)}</>
        ) : 'Dictate, then press ⌥ and a number.'}
      </span>
      <div className="tf__undo">
        <span className="tf__undo-label">Undo with</span>
        <Keycap className="tf__undo-key">⌘ Z</Keycap>
      </div>
    </div>
  )
}

/** Transform card (e0f1v …): Top (Key + More), Text, Preview. */
function TransformCard({ t, state, fresh, returning, dep, morphDep, flash, onFlashed, onOpen, onGone }: {
  t: Transform
  state: CardState
  /** Created after the screen loaded: its content fades in. */
  fresh: boolean
  /** Its dialog is closing back into it. */
  returning: boolean
  dep: string
  morphDep: string
  /** Bumps on each saved edit of this card; 0 = no highlight. */
  flash: number
  onFlashed: () => void
  onOpen: (from: Element, focus?: HTMLElement | null) => void
  onGone: () => void
}): React.JSX.Element {
  const accent = slotAccent(t.slot)
  const preview = applyTransform(t, SAMPLES[t.kind])
  const key = useSwapReveal<HTMLSpanElement>(t.slot)
  const name = useSwapReveal<HTMLSpanElement>(t.name)
  const desc = useSwapReveal<HTMLSpanElement>(t.description)
  const out = useSwapReveal<HTMLSpanElement>(preview)
  const gone = state === 'gone'
  const off = gone || state === 'away'
  return (
    <m.div
      className={`tf__card tf__card--${accent}`}
      role="button"
      tabIndex={off ? -1 : 0}
      inert={off}
      data-cell={t.id}
      data-returning={returning ? '' : undefined}
      onClick={(e) => onOpen(e.currentTarget)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(e.currentTarget) } }}
      layoutId={cellIdOf(t.id)}
      layout="position"
      layoutDependency={dep}
      style={gone ? { pointerEvents: 'none' } : undefined}
      variants={CARD}
      initial={fresh ? 'fresh' : false}
      animate={state}
      onAnimationComplete={(def) => { if (def === 'gone') onGone() }}
      whileHover={{ y: -DIST.xs, transition: SPRING.snappy }}
      whileTap={presets.press('card').whileTap}
      transition={{ default: SPRING.snappy, layout: SPRING.ui }}
    >
      <Ghost id={morphIdOf(t.id)} dep={morphDep} returning={returning} className="tf__ghost" />
      {flash > 0 && <Highlight key={flash} className="tf__flash" onDone={onFlashed} />}
      <m.div className="tf__card-top" variants={PART}>
        <span className="tf__key"><span ref={key} className="tf__key-label">⌥ {t.slot}</span></span>
        <IconButton
          icon="ellipsis"
          label={`Edit ${t.name}`}
          className="tf__more"
          onClick={(e) => {
            e.stopPropagation()
            const card = e.currentTarget.closest('.tf__card')
            if (card) onOpen(card, e.currentTarget)
          }}
        />
      </m.div>
      <m.div className="tf__card-text" variants={PART}>
        <span ref={name} className="tf__card-name">{t.name}</span>
        <span ref={desc} className="tf__card-desc">{t.description}</span>
      </m.div>
      <m.div className="tf__preview" variants={PART}>
        <span ref={out} className="tf__preview-text">{preview}</span>
      </m.div>
    </m.div>
  )
}

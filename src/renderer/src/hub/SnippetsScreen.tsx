import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, m, useIsPresent, type TargetAndTransition, type Variants } from 'motion/react'
import { Icon } from '../shared/icons'
import { Badge, Bento, Button, IconButton, Tile, TileStat, TileTop } from '../shared/ui'
import { BlurNumber, BlurWords, INSTANT_CAP, SPRING, presets } from '../shared/motion'
import { SnippetExample } from './SnippetExample'
import SnippetDialog, { type Snippet } from './dialogs/SnippetDialog'
import { Highlight, Press, useDialogHost, useMinuteTick, useSwapReveal } from './sniptfMotion'
import './snippets.css'

const WEEK = 7 * 24 * 60 * 60 * 1000

/* Why the visible rows changed (docs/MOTION.md §4.8):
   edit    = insert / delete: real height + rowInsert / rowDelete
   filter  = search: filterOut, rows close ranks with their real height
   instant = a keystroke changed more than INSTANT_CAP.filter rows: no motion */
type Mode = 'edit' | 'filter' | 'instant'
const INSTANT = { duration: 0 }
const t = (v: unknown): TargetAndTransition => v as TargetAndTransition

/* The <li> owns the real height; the row inside owns opacity, blur and x. */
const ITEM: Variants = {
  initial: { height: 0 },
  animate: (mode: Mode) => ({ height: 'auto', transition: mode === 'instant' ? INSTANT : presets.HEIGHT.open }),
  exit: (mode: Mode) => ({ height: 0, transition: mode === 'instant' ? INSTANT : presets.HEIGHT.close })
}
const ROW: Variants = {
  initial: (mode: Mode) => t(mode === 'filter' ? presets.filterOut.initial : presets.rowInsert.initial),
  animate: (mode: Mode) =>
    mode === 'instant' ? { opacity: 1, filter: 'none', transition: INSTANT }
    : t(mode === 'filter' ? presets.filterOut.animate : presets.rowInsert.animate),
  exit: (mode: Mode) =>
    mode === 'instant' ? { opacity: 0, transition: INSTANT }
    : t(mode === 'filter' ? presets.filterOut.exit : presets.rowDelete.exit)
}

/** Hub, Snippets (gSWzJ). */
export default function SnippetsScreen(): React.JSX.Element {
  const [items, setItems] = useState<Snippet[]>([])
  // Rows that are there when the list first arrives render at rest.
  const [loaded, setLoaded] = useState(false)
  const [q, setQ] = useState('')
  const [flash, setFlash] = useState<{ id: string; n: number } | null>(null)
  const host = useDialogHost<Snippet>()
  const now = useMinuteTick()
  // What caused the next change of the visible rows, read while rendering it.
  const cause = useRef<'edit' | 'filter'>('edit')
  const prevIds = useRef<string[]>([])

  const apply = (list: unknown): void => { cause.current = 'edit'; setItems(list as Snippet[]) }

  useEffect(() => {
    void window.flow.snippets.list().then((list) => { apply(list); setLoaded(true) })
    // Main counts a use each time a delivered dictation expands a snippet.
    return window.flow.snippets.onChanged(apply)
  }, [])

  // Real counters from main: `usedAt` holds one timestamp per delivered
  // expansion (trimmed to 7 days there). Snippets last used before main kept
  // them have none and count as 0.
  const { week, keystrokes } = useMemo(() => {
    const since = now - WEEK
    let week = 0
    let keystrokes = 0
    for (const s of items) {
      const n = (s.usedAt ?? []).filter((at) => at >= since).length
      week += n
      keystrokes += n * s.expansion.trim().length
    }
    return { week, keystrokes }
  }, [items, now])

  const sorted = useMemo(() => [...items].sort((a, b) => (b.uses ?? 0) - (a.uses ?? 0)), [items])
  const shown = q
    ? sorted.filter((s) => (s.trigger + ' ' + s.expansion).toLowerCase().includes(q.toLowerCase()))
    : sorted
  const hero = sorted[0]

  const ids = shown.map((s) => s.id)
  const order = ids.join('|')
  let mode: Mode = cause.current
  if (mode === 'filter') {
    const before = new Set(prevIds.current)
    const after = new Set(ids)
    const changed = ids.filter((id) => !before.has(id)).length + prevIds.current.filter((id) => !after.has(id)).length
    if (changed > INSTANT_CAP.filter) mode = 'instant'
  }
  useEffect(() => { prevIds.current = ids }, [order]) // eslint-disable-line react-hooks/exhaustive-deps

  const remove = async (id: string): Promise<void> => {
    apply(await window.flow.snippets.remove(id))
  }
  const startNew = (e: React.MouseEvent<HTMLElement>): void =>
    host.show({ id: '', trigger: '', expansion: '', enabled: true }, e.currentTarget)
  const save = (s: Snippet): void => {
    const saved = window.flow.snippets.save(s)
    // Close first; the list updates once the dialog is on its way out.
    host.close(() => {
      void saved.then((list) => {
        apply(list)
        if (s.id) setFlash({ id: s.id, n: Date.now() })
      })
    })
  }

  return (
    <Bento>
      <div className="snip__row1">
        <Tile accent="pink" hero className="snip__hero">
          <TileTop
            label="SNIPPETS"
            right={<Press><Button className="snip__new" onClick={startNew}>New snippet</Button></Press>}
          />
          <BlurWords as="h1" className="snip__headline" variant="titleUnit" initial text="Say it short, write it long." />
          <SnippetExample
            swap
            trigger={hero?.trigger ?? 'my address'}
            expansion={hero?.expansion ?? '12 rue de la Paix, 75002 Paris'}
          />
        </Tile>
        <Tile accent="lime" className="snip__stat">
          <TileTop label="EXPANSIONS · 7 DAYS" icon="speech-bubble" />
          <TileStat
            value={<BlurNumber value={week} />}
            caption={<>≈ <BlurNumber value={keystrokes} size="subtle" /> keystrokes you didn't type</>}
          />
        </Tile>
      </div>

      <div className="snip__row2">
        <section className="snip__all" aria-label="All snippets">
          <div className="snip__all-top">
            <div className="snip__all-title">
              <span className="snip__all-label">ALL SNIPPETS</span>
              <Badge><BlurNumber value={items.length} size="subtle" /></Badge>
            </div>
            <label className="snip__search">
              <Icon name="magnifier" size={16} className="snip__search-icon" />
              <input
                placeholder="Search snippets"
                value={q}
                onChange={(e) => { cause.current = 'filter'; setQ(e.target.value) }}
              />
            </label>
          </div>

          <m.ul className="snip__list" layoutScroll>
            {loaded && <AnimatePresence initial={false} custom={mode}>
              {shown.map((s) => (
                <SnippetRow
                  key={s.id}
                  s={s}
                  mode={mode}
                  order={order}
                  flash={flash?.id === s.id ? flash.n : 0}
                  onFlashed={() => setFlash(null)}
                  onEdit={(from, focus) => host.show(s, from, { focus })}
                  onRemove={() => void remove(s.id)}
                />
              ))}
            </AnimatePresence>}
            {loaded && !shown.length && (
              <li className="snip__empty">
                <BlurWords variant="block" text={q ? 'No snippets match.' : 'No snippets yet.'} />
              </li>
            )}
          </m.ul>
        </section>

        <Tile accent="cyan" className="snip__how">
          <TileTop label="HOW IT WORKS" />
          <div className="snip__how-bottom">
            <div className="snip__demo">
              <div className="snip__spoken">
                <span className="snip__demo-label">YOU SAY</span>
                <span className="snip__demo-text">“Can you send it to my email?”</span>
              </div>
              <div className="snip__pasted">
                <span className="snip__demo-label">QUILL PASTES</span>
                <span className="snip__demo-text">Can you send it to gui@saudad.studio?</span>
              </div>
            </div>
            <p className="snip__how-body">Say a trigger anywhere in a sentence. Quill swaps in the full text before it pastes.</p>
            <p className="snip__how-caption">Triggers match whole words, any capitalisation.</p>
          </div>
        </Tile>
      </div>

      <AnimatePresence onExitComplete={host.settled}>
        {host.open && (
          <SnippetDialog
            key={host.open.key}
            snippet={host.open.value}
            motion={{ origin: host.open.origin }}
            onClose={() => host.close()}
            onSave={save}
          />
        )}
      </AnimatePresence>
    </Bento>
  )
}

const usesLabel = (v: number): string => `${v}×`

/** Snippet row (nUEJa / wmSBO) inside its real-height list item. */
function SnippetRow({ s, mode, order, flash, onFlashed, onEdit, onRemove }: {
  s: Snippet
  mode: Mode
  /** The visible ids in order: rows only re-measure when it changes (re-rank). */
  order: string
  /** Bumps on each saved edit of this row; 0 = no highlight. */
  flash: number
  onFlashed: () => void
  onEdit: (from: Element, focus?: HTMLElement | null) => void
  onRemove: () => void
}): React.JSX.Element {
  const present = useIsPresent()
  const trigger = useSwapReveal<HTMLSpanElement>(s.trigger)
  const expansion = useSwapReveal<HTMLSpanElement>(s.expansion)
  const n = s.uses ?? 0
  return (
    <m.li
      className="snip__item"
      inert={!present}
      style={present ? undefined : { pointerEvents: 'none' }}
      custom={mode}
      variants={ITEM}
      initial="initial"
      animate="animate"
      exit="exit"
      layout="position"
      layoutDependency={order}
      transition={{ layout: SPRING.ui }}
    >
      <m.div
        className="snip__row"
        custom={mode}
        variants={ROW}
        onClick={(e) => onEdit(e.currentTarget, e.currentTarget.querySelector<HTMLElement>('[data-edit]'))}
      >
        {flash > 0 && <Highlight key={flash} className="snip__flash" onDone={onFlashed} />}
        <span className="snip__trigger-col">
          <span className="snip__trigger"><span ref={trigger} className="snip__trigger-label">{s.trigger}</span></span>
        </span>
        <Icon name="arrow-right" size={16} className="snip__arrow" />
        <span ref={expansion} className="snip__expansion">{s.expansion}</span>
        <span className="snip__uses">{n > 0 && <BlurNumber value={n} format={usesLabel} size="subtle" />}</span>
        <span className="snip__actions" onClick={(e) => e.stopPropagation()}>
          <Press kind="icon">
            <IconButton
              icon="copy"
              label="Copy text"
              className="snip__act"
              onClick={() => void navigator.clipboard.writeText(s.expansion)}
            />
          </Press>
          <Press kind="icon">
            <IconButton icon="rename" label="Edit" data-edit="" className="snip__act" onClick={(e) => onEdit(e.currentTarget)} />
          </Press>
          <Press kind="icon">
            <IconButton icon="trash" label="Delete" className="snip__act snip__act--danger" onClick={onRemove} />
          </Press>
        </span>
      </m.div>
    </m.li>
  )
}

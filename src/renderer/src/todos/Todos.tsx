import { forwardRef, useContext, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, m, useDragControls, useIsPresent, useMotionValue, type Variants } from 'motion/react'
import { Icon, type IconName } from '../shared/icons'
import { Badge, Button } from '../shared/ui'
import {
  BLUR, BULK_DIP, BlurNumber, BlurWords, DIST, HOLD, INSTANT_CAP, PresenceSwap, SCALE, SPRING, Z, blurPx, isReducedMotion, onWinShown, presets,
  springPhysics, useExitInert, useWindowShown
} from '../shared/motion'
import DatePicker from './DatePicker'
import {
  AutoHeight, CLEAR_COLLAPSE_DELAY, CONTENT, Collapse, CollapseBox, DETAIL, EnterCtx, HEADER_INSERT,
  INSTANT, ShownCtx, tw, useEnter, type ContentCustom, type EnterMode, type Leave
} from './motion'

/* Todos window, translated 1:1 from design.pen: "Todos - List" c9q6y,
   "- Empty" R8pow, "- Adding" rXrLL, "- Completed open" z5bvb,
   "- Projects" H9heB, "- Autocomplete" sAMWu, "- Date picker" wtWtv.
   Motion: docs/MOTION.md §4.12, built only from shared/motion tokens. */

type Todo = {
  id: string
  title: string
  description: string
  due: string | null
  time: string | null
  project: string | null
  eventId: string | null
  done: boolean
  order: number
}
type Project = { name: string; count: number }

/** Body VAVgk gap: boxes that open and close take it along. */
const GAP = 8
/** §4.12 Drag reorder: pointer travel before a drag starts. */
const DRAG_HYSTERESIS = 4
/** §4.12 Pin: the icon settles from this tilt. */
const PIN_TILT = 45
/** §4.12 Empty: "All clear." starts at t = 100. */
const EMPTY_TITLE_AT = 0.1

/** Panel content layer (§4.12 Open): x -24 on spring.fluid, opacity fast, blur 8 over base. */
const PANEL: Variants = {
  hidden: { opacity: 0, x: -DIST.xl, filter: blurPx(BLUR.lg) },
  shown: {
    opacity: 1, x: 0, filter: blurPx(0),
    transition: { default: SPRING.fluid, opacity: tw('fast'), filter: tw('base') },
    transitionEnd: { filter: 'none' }
  },
  // §4.12 Close: x -16, opacity 0, blur 4, dur.fast ease.exit.
  closing: { opacity: 0, x: -DIST.lg, filter: blurPx(BLUR.sm), transition: tw('fast', 'exit') }
}

/** Composer content swap: the outgoing side leaves in dur.flash; the form's fields come in at t = 40. */
const COMPOSER_SWAP: Variants = {
  initial: { opacity: 0 },
  animate: (open: boolean) => ({ opacity: 1, transition: tw('fast', 'out', open ? 0.04 : 0) }),
  exit: { opacity: 0, transition: tw('flash', 'exit') }
}

/** Autocomplete rows: they filter in place, the rest keep their position. */
const AC_ROW: Variants = {
  initial: (instant: boolean) => ({ opacity: instant ? 1 : 0 }),
  animate: (instant: boolean) => ({ opacity: 1, transition: instant ? INSTANT : tw('fast') }),
  exit: (instant: boolean) => ({ opacity: 0, pointerEvents: 'none', transition: instant ? INSTANT : tw('micro', 'exit') })
}

/** Release and cancel settle on spring.gesture, carrying the pointer's velocity. */
const gesture = springPhysics(SPRING.gesture)
const DROP = { bounceStiffness: gesture.stiffness, bounceDamping: gesture.damping }

/** "Today", "Tomorrow", "Yesterday", a weekday inside a week, else "Sep 28". */
function fmtDue(due: string): { label: string; overdue: boolean } {
  const [y, m_, d] = due.split('-').map(Number)
  const date = new Date(y, m_ - 1, d)
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const days = Math.round((date.getTime() - today.getTime()) / 86_400_000)
  const overdue = days < 0
  let label: string
  if (days === 0) label = 'Today'
  else if (days === 1) label = 'Tomorrow'
  else if (days === -1) label = 'Yesterday'
  else if (days > 1 && days < 7) label = date.toLocaleDateString(undefined, { weekday: 'short' })
  else label = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return { label, overdue }
}

/** "Tomorrow · 14:00" when a time is set, else just the day. */
const chipLabel = (due: string, time: string | null): string =>
  time ? `${fmtDue(due).label} · ${time.replace(/^0/, '')}` : fmtDue(due).label

/** Splits `@Quill release: fix it` into its prefix and the task. */
const splitTitle = (title: string): [string, string] => {
  const m_ = /^(@[^:]+:\s*)(.*)$/s.exec(title)
  return m_ ? [m_[1], m_[2]] : ['', title]
}

const sameProject = (t: Todo, name: string): boolean => t.project?.toLowerCase() === name.toLowerCase()

/**
 * Date Chip jzFJa / Overdue v0V55 / Synced PjMQZ, or Add Date e0cLHk when
 * there is no date. Always a button: it opens the picker.
 */
const DateChip = forwardRef<HTMLButtonElement, {
  due: string | null; time: string | null; synced?: boolean; hoverOnly?: boolean; onClick: () => void
}>(function DateChip({ due, time, synced, hoverOnly, onClick }, ref) {
  if (!due) {
    return (
      <button ref={ref} type="button" className={`add-date ${hoverOnly ? 'add-date--hover' : ''}`} onClick={onClick}>
        <Icon name="plus" />
        <span className="date-chip__label">date</span>
      </button>
    )
  }
  const f = fmtDue(due)
  return (
    <button ref={ref} type="button" className={`date-chip ${f.overdue ? 'date-chip--overdue' : ''}`} onClick={onClick}>
      <Icon name="calendar" />
      <BlurWords variant="label" animateWidth className="date-chip__label" text={chipLabel(due, time)} />
      <AnimatePresence initial={false}>
        {synced && (
          <m.span key="dot" className="date-chip__dot" title="On your calendar" variants={presets.popIn} initial="initial" animate="animate" exit="exit" />
        )}
      </AnimatePresence>
    </button>
  )
})

/** A chevron whose glyph is the design's for each state; on a change it turns in from the other one. */
function Chevron({ name, from }: { name: IconName; from: number }): React.JSX.Element {
  return (
    <m.span className="chev" initial={false} animate={{ rotate: [from, 0] }} transition={SPRING.snappy}>
      <Icon name={name} />
    </m.span>
  )
}

export default function Todos(): React.JSX.Element {
  const [items, setItems] = useState<Todo[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [pinned, setPinned] = useState(false)
  const [showDone, setShowDone] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [bulk, setBulk] = useState(0)                         // bumps on a bulk refresh: the list remounts at rest
  const [held, setHeld] = useState<ReadonlySet<string>>(new Set())   // just checked: staying put for hold.todoCheck
  const [clearing, setClearing] = useState(false)

  const shown = useWindowShown(onWinShown)
  /* Close handshake: main asks (todos:will-close), the panel plays its exit and
     answers with the same seq. A cancel retargets to open and is never answered. */
  const [closing, setClosing] = useState<number | null>(null)
  useEffect(() => {
    const offWill = window.flow.todos.onWillClose?.((e) => {
      if (isReducedMotion()) window.flow.todos.closed(e.seq)
      else setClosing(e.seq)
    })
    const offCancel = window.flow.todos.onCancelClose?.(() => setClosing(null))
    return () => { offWill?.(); offCancel?.() }
  }, [])
  const enter = useRef<{ current: EnterMode }>({ current: 'stagger' }).current
  const bulkSeen = useRef(0)
  if (bulkSeen.current !== bulk) { bulkSeen.current = bulk; enter.current = 'none' }
  // Whatever mounted in this commit has read its mode; later arrivals insert.
  useEffect(() => { if (loaded) enter.current = 'insert' })

  const last = useRef<Todo[] | null>(null)
  const seq = useRef(0)
  const isLoaded = useRef(false)
  const pinTouched = useRef(false)
  const hadItems = useRef(false)
  const holdTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  /** Projects travel with the list so a new group and its first item land in one commit. */
  const apply = async (list: Todo[]): Promise<void> => {
    const mine = ++seq.current
    const first = !isLoaded.current
    const [p, c, pin] = await Promise.all([
      window.flow.todos.projects(),
      first ? window.flow.todos.collapsed() : null,
      first ? window.flow.todos.pinned() : null
    ])
    if (mine !== seq.current) return
    const before = last.current
    if (before) {
      const was = new Map(before.map((t) => [t.id, t.done]))
      let changes = 0
      for (const t of list) { if (was.get(t.id) !== t.done) changes++; was.delete(t.id) }
      if (changes + was.size > INSTANT_CAP.bulk) setBulk((g) => g + 1)
    }
    last.current = list
    setItems(list)
    setProjects(p)
    if (c) setCollapsed(new Set(c))
    if (pin !== null) setPinned(pin)
    if (first) { isLoaded.current = true; setLoaded(true) }
  }
  useEffect(() => {
    void window.flow.todos.list().then((l) => apply(l as Todo[]))
    const timers = holdTimers.current
    const off = window.flow.todos.onChanged((l) => void apply(l as Todo[]))
    return () => { off(); timers.forEach((t) => clearTimeout(t)); timers.clear() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* A checked item is saved at once but keeps its place, checked, for
     hold.todoCheck (the undo window); only then does it move to Completed. */
  const unhold = (id: string): void => {
    const t = holdTimers.current.get(id)
    if (t) clearTimeout(t)
    holdTimers.current.delete(id)
    setHeld((s) => { const n = new Set(s); n.delete(id); return n })
  }
  const toggle = (t: Todo): void => {
    if (held.has(t.id)) {                                     // undone inside the hold
      unhold(t.id)
      void window.flow.todos.update(t.id, { done: false })
      return
    }
    if (!t.done) {
      setHeld((s) => new Set(s).add(t.id))
      holdTimers.current.set(t.id, setTimeout(() => unhold(t.id), HOLD.todoCheck))
    }
    void window.flow.todos.update(t.id, { done: !t.done })
  }

  const open = items.filter((t) => !t.done || held.has(t.id)).sort((a, b) => a.order - b.order)
  const done = items.filter((t) => t.done && !held.has(t.id))
  const unassigned = open.filter((t) => !t.project)
  const groups = projects
    .map((p) => ({ name: p.name, rows: open.filter((t) => sameProject(t, p.name)) }))
    .filter((g) => g.rows.length > 0)
  const empty = loaded && open.length === 0 && done.length === 0
  if (open.length + done.length > 0) hadItems.current = true
  useEffect(() => { if (clearing && done.length === 0) setClearing(false) }, [clearing, done.length])

  const toggleCollapse = async (name: string): Promise<void> => {
    const next = await window.flow.todos.collapse(name, !collapsed.has(name.toLowerCase()))
    setCollapsed(new Set(next))
  }
  const togglePin = async (): Promise<void> => {
    pinTouched.current = true
    setPinned(await window.flow.todos.pin(!pinned))
  }
  const clearDone = (): void => {
    setClearing(true)                                         // rows start leaving before the list answers
    void window.flow.todos.clearDone()
  }

  /**
   * Order is global in the store, so a move inside one group is written back
   * as: the group's slots in the full open list, refilled in the new order.
   */
  const commitOrder = async (group: string[]): Promise<void> => {
    const all = (await window.flow.todos.list()) as Todo[]
    const ids = all.filter((t) => !t.done).map((t) => t.id)
    const slots = new Set(group)
    const next = group.filter((id) => ids.includes(id))
    let k = 0
    void window.flow.todos.reorder(ids.map((id) => (slots.has(id) ? next[k++] : id)))
  }

  // Position in the panel's first paint (0 is the composer): the open stagger follows it.
  let index = 1
  const take = (n: number): number => { const at = index; index += n; return at }
  const listProps = { held, onToggle: toggle, commitOrder }

  return (
    <EnterCtx.Provider value={enter}>
      <ShownCtx.Provider value={shown}>
        <m.div
          className="todos"
          inert={closing !== null}
          variants={PANEL}
          initial="hidden"
          animate={closing !== null ? 'closing' : shown ? 'shown' : 'hidden'}
          onAnimationComplete={(def) => { if (def === 'closing' && closing !== null) window.flow.todos.closed(closing) }}
        >
          {/* Title Bar bxLDk */}
          <header className="todos__bar">
            <div className="todos__mark"><Icon name="checklist" active /></div>
            <div className="todos__title">
              <span className="todos__label">Todos</span>
              {loaded && (
                <AnimatePresence initial={false}>
                  {open.length > 0 && (
                    <m.span key="count" className="todos__count" variants={presets.popIn} initial="initial" animate="animate" exit="exit">
                      <Badge tone="lime"><BlurNumber value={open.length} /></Badge>
                    </m.span>
                  )}
                </AnimatePresence>
              )}
            </div>
            <button
              type="button"
              className={`todos__icon ${pinned ? 'is-on' : ''}`}
              title={pinned ? 'Unpin: closes when the cursor leaves' : 'Pin: stays open'}
              aria-pressed={pinned}
              onClick={() => void togglePin()}
            >
              <m.span
                className="todos__pin"
                initial={false}
                animate={{ rotate: pinTouched.current ? [pinned ? PIN_TILT : -PIN_TILT, 0] : 0 }}
                transition={SPRING.snappy}
              >
                <Icon name="pin" active={pinned} />
              </m.span>
            </button>
            <button type="button" className="todos__icon" aria-label="Close" title="Close" onClick={() => window.flow.todos.close()}>
              <Icon name="close" />
            </button>
          </header>

          {/* Body VAVgk */}
          <m.div className="todos__body" layoutScroll>
            <Composer projects={projects} />
            <m.div
              key={bulk}
              className="todos__list"
              initial={bulk ? { opacity: BULK_DIP.from } : false}
              animate={{ opacity: 1, transition: { ...tw('fast'), duration: BULK_DIP.duration } }}
            >
              {empty && <Empty animate={hadItems.current} />}
              <List rows={unassigned} baseIndex={take(unassigned.length)} draggable {...listProps} />
              <AnimatePresence>
                {groups.map((g) => {
                  const isCollapsed = collapsed.has(g.name.toLowerCase())
                  const at = take(1 + (isCollapsed ? 0 : g.rows.length))
                  return (
                    <ProjectGroup
                      key={g.name.toLowerCase()}
                      name={g.name}
                      count={g.rows.length}
                      index={at}
                      collapsed={isCollapsed}
                      onToggle={() => void toggleCollapse(g.name)}
                    >
                      <List rows={g.rows} baseIndex={at + 1} draggable {...listProps} />
                    </ProjectGroup>
                  )
                })}
              </AnimatePresence>
              <AnimatePresence>
                {done.length > 0 && (
                  <Completed
                    key="done"
                    count={done.length}
                    open={showDone}
                    clearing={clearing}
                    onToggle={() => setShowDone((v) => !v)}
                    onClear={clearDone}
                  >
                    <List rows={done} baseIndex={0} clearing={clearing} {...listProps} />
                  </Completed>
                )}
              </AnimatePresence>
            </m.div>
          </m.div>
        </m.div>
      </ShownCtx.Provider>
    </EnterCtx.Provider>
  )
}

/** Empty mhZ3s. It only animates when the list just became empty, never on open. */
function Empty({ animate }: { animate: boolean }): React.JSX.Element {
  return (
    <div className="empty">
      <div className="empty__tile">
        <m.span
          className="empty__glyph"
          initial={animate ? { clipPath: 'inset(0% 100% 0% 0%)' } : false}
          animate={{ clipPath: 'inset(0% 0% 0% 0%)', transition: tw('reveal'), transitionEnd: { clipPath: 'none' } }}
        >
          <Icon name="checklist" size={32} />
        </m.span>
      </div>
      <BlurWords as="h2" className="empty__headline" variant="title" text="All clear." initial={animate} delay={EMPTY_TITLE_AT} />
      <p className="empty__text">Add one above, or rest the cursor on the left edge whenever something comes up.</p>
    </div>
  )
}

/** A section's rows: real height on expand and collapse; rows fade (staggered in, together out). */
function Section({ open, children }: { open: boolean; children: React.ReactNode }): React.JSX.Element {
  return <AnimatePresence>{open && <SectionBox key="rows">{children}</SectionBox>}</AnimatePresence>
}
function SectionBox({ children }: { children: React.ReactNode }): React.JSX.Element {
  // Mounted while its parent is at rest means the user expanded it.
  const { mode, cell } = useEnter((mine) => (mine === 'insert' ? 'expand' : mine))
  return (
    <CollapseBox gap={GAP} enter={mode === 'insert'} className="section">
      <EnterCtx.Provider value={cell}>{children}</EnterCtx.Provider>
    </CollapseBox>
  )
}

/** A header that takes part in whatever its container is doing as it mounts. */
function HeadIn({ mode, index, children }: { mode: EnterMode; index: number; children: React.ReactNode }): React.JSX.Element {
  const shown = useContext(ShownCtx)
  const variants = mode === 'stagger' ? CONTENT.stagger : HEADER_INSERT
  const animated = mode === 'stagger' || mode === 'insert'
  const custom: ContentCustom = { index, pos: 0, leave: 'move', fromEnd: 0 }
  return (
    <m.div
      className="head-in"
      variants={variants}
      custom={custom}
      initial={animated ? 'initial' : false}
      animate={mode === 'stagger' && !shown ? 'initial' : 'animate'}
    >
      {children}
    </m.div>
  )
}

/** Project Header k6c3zW and its items. A new project inserts as one: header and first item together. */
function ProjectGroup({ name, count, index, collapsed, onToggle, children }: {
  name: string; count: number; index: number; collapsed: boolean; onToggle: () => void; children: React.ReactNode
}): React.JSX.Element {
  const { mode, cell } = useEnter((mine) => (mine === 'insert' ? 'newgroup' : mine))
  return (
    <CollapseBox gap={GAP} enter={mode === 'insert'} className="group" closeSpring={SPRING.exit}>
      <EnterCtx.Provider value={cell}>
        <HeadIn mode={mode} index={index}>
          <button type="button" className="project-head" aria-expanded={!collapsed} onClick={onToggle}>
            <Chevron name={collapsed ? 'chevron-right' : 'chevron-down'} from={collapsed ? 90 : -90} />
            <span className="project-head__name">{name}</span>
            <BlurNumber className="project-head__count" value={count} />
          </button>
        </HeadIn>
        <Section open={!collapsed}>{children}</Section>
      </EnterCtx.Provider>
    </CollapseBox>
  )
}

/** Completed Header Murv0 and the done items. Clear collapses it from t = 40 while its rows leave. */
function Completed({ count, open, clearing, onToggle, onClear, children }: {
  count: number; open: boolean; clearing: boolean; onToggle: () => void; onClear: () => void; children: React.ReactNode
}): React.JSX.Element {
  const { mode, cell } = useEnter((mine) => (mine === 'insert' ? 'newgroup' : mine))
  return (
    <CollapseBox
      gap={GAP}
      enter={mode === 'insert'}
      className="group"
      closeSpring={SPRING.exit}
      closeDelay={clearing ? CLEAR_COLLAPSE_DELAY : 0}
    >
      <EnterCtx.Provider value={cell}>
        <HeadIn mode={mode} index={0}>
          <div className="done-head">
            <button type="button" className="done-head__left" aria-expanded={open} onClick={onToggle}>
              <Chevron name={open ? 'chevron-up' : 'chevron-down'} from={open ? 180 : -180} />
              <span className="done-head__label">Completed (<BlurNumber value={count} />)</span>
            </button>
            <button type="button" className="done-head__clear" onClick={onClear}>Clear</button>
          </div>
        </HeadIn>
        <Section open={open}>{children}</Section>
      </EnterCtx.Provider>
    </CollapseBox>
  )
}

/** The `@Project` token and task, drawn under a transparent input. */
function Composer({ projects }: { projects: Project[] }): React.JSX.Element {
  const [openState, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [desc, setDesc] = useState('')
  const [due, setDue] = useState<string | null>(null)
  const [time, setTime] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [acIndex, setAcIndex] = useState(0)
  const [calSync, setCalSync] = useState(false)
  const [tokenKey, setTokenKey] = useState(0)
  const tokenPop = useRef(false)
  const titleRef = useRef<HTMLInputElement>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const shown = useContext(ShownCtx)

  // The title input takes focus at t = 0: the form is mounted (still fading in) in the same commit.
  useEffect(() => { if (openState) titleRef.current?.focus({ preventScroll: true }) }, [openState])
  useEffect(() => {
    if (!openState) return
    void window.flow.settings.get().then((p) => setCalSync(!!(p as { calSync?: boolean }).calSync))
  }, [openState])
  useEffect(() => { tokenPop.current = false })

  // Autocomplete is live while the title is `@` + a fragment with no colon yet.
  const frag = /^@([^:]*)$/.exec(title)?.[1] ?? null
  const matches = frag === null ? [] : projects.filter((p) => p.name.toLowerCase().includes(frag.toLowerCase()))
  const canCreate = frag !== null && frag.trim().length > 0 && !projects.some((p) => p.name.toLowerCase() === frag.trim().toLowerCase())
  const acRows = frag === null ? 0 : matches.length + (canCreate ? 1 : 0)
  useEffect(() => { setAcIndex(0) }, [frag])

  /** Accepting a project: its token pops in the title and the list leaves. */
  const accept = (name: string): void => {
    tokenPop.current = true
    setTokenKey((k) => k + 1)
    setTitle(`@${name}: `)
    titleRef.current?.focus({ preventScroll: true })
  }
  const acceptAt = (i: number): void => {
    if (i < matches.length) accept(matches[i].name)
    else if (canCreate) accept(frag!.trim())
  }

  const reset = (): void => { setOpen(false); setTitle(''); setDesc(''); setDue(null); setTime(null); setPicking(false) }
  const submit = async (): Promise<void> => {
    if (!title.trim()) return
    await window.flow.todos.add({ title, description: desc, due, time })
    // Keep it open with a clean slate: adding several in a row is the common case.
    setTitle(''); setDesc(''); setDue(null); setTime(null)
    titleRef.current?.focus({ preventScroll: true })
  }
  // The mirror draws the typed text (prefix dimmed) under a transparent input.
  const syncMirror = (): void => {
    if (mirrorRef.current && titleRef.current) mirrorRef.current.scrollLeft = titleRef.current.scrollLeft
  }
  useEffect(syncMirror, [title])

  const [prefix, task] = splitTitle(title)
  const first: ContentCustom = { index: 0, pos: 0, leave: 'move', fromEnd: 0 }
  return (
    /* Composer Wrap INZvi */
    <m.div className="composer-wrap" ref={wrapRef} variants={CONTENT.stagger} custom={first} initial="initial" animate={shown ? 'animate' : 'initial'}>
      {/* Composer tgTwL / Open kXyn7: one surface whose real height follows its content. */}
      <AutoHeight flip={openState} closing={!openState} className={`composer ${openState ? 'composer--open' : ''}`}>
        <PresenceSwap swapKey={openState ? 'form' : 'closed'} variants={COMPOSER_SWAP} custom={openState}>
          {openState ? (
            <div className="composer__form">
              <div className="composer__title">
                <div className="composer__mirror" ref={mirrorRef} aria-hidden>
                  {prefix && (
                    <m.span
                      key={tokenKey}
                      className="composer__prefix"
                      variants={presets.chipIn}
                      initial={tokenPop.current ? 'initial' : false}
                      animate="animate"
                    >
                      {prefix}
                    </m.span>
                  )}
                  <span className="composer__task">{task}</span>
                </div>
                <input
                  ref={titleRef}
                  className="composer__input"
                  placeholder="What needs doing?  Start with @project: to group it"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onScroll={syncMirror}
                  onSelect={syncMirror}
                  onKeyDown={(e) => {
                    if (acRows > 0) {
                      if (e.key === 'ArrowDown') { e.preventDefault(); setAcIndex((i) => (i + 1) % acRows); return }
                      if (e.key === 'ArrowUp') { e.preventDefault(); setAcIndex((i) => (i - 1 + acRows) % acRows); return }
                      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptAt(acIndex); return }
                      if (e.key === 'Escape') { e.preventDefault(); setTitle(title.replace(/^@/, '')); return }
                    }
                    if (e.key === 'Enter') { e.preventDefault(); void submit() }
                    if (e.key === 'Escape') reset()
                  }}
                />
              </div>
              <textarea
                className="composer__desc"
                placeholder="Add a description…"
                rows={1}
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') reset() }}
              />
              <div className="composer__footer">
                <DateChip due={due} time={time} onClick={() => setPicking((v) => !v)} />
                <div className="composer__buttons">
                  <Button variant="ghost" onClick={reset}>Cancel</Button>
                  <Button variant="lime" disabled={!title.trim() || acRows > 0} onClick={() => void submit()}>Add</Button>
                </div>
              </div>
            </div>
          ) : (
            <button type="button" className="composer__closed" onClick={() => setOpen(true)}>
              <span className="composer__plus"><Icon name="plus" /></span>
              <span className="composer__placeholder">Add a todo</span>
              <span className="composer__spacer" />
              <span className="composer__hint">@project:</span>
            </button>
          )}
        </PresenceSwap>
      </AutoHeight>
      <AnimatePresence>
        {openState && acRows > 0 && (
          <Autocomplete
            key="ac"
            frag={frag!}
            matches={matches}
            canCreate={canCreate}
            acIndex={acIndex}
            onHover={setAcIndex}
            onAccept={accept}
          />
        )}
      </AnimatePresence>
      {createPortal(
        <AnimatePresence>
          {picking && wrapRef.current && (
            <DatePicker
              key="picker"
              anchor={wrapRef.current}
              dx={8}
              dy={0}
              below
              value={due}
              time={time}
              synced={calSync}
              onChange={(d, t) => { setDue(d); setTime(t) }}
              onClose={() => setPicking(false)}
            />
          )}
        </AnimatePresence>,
        document.body
      )}
    </m.div>
  )
}

/** Project Autocomplete bATMI. Rows enter with it, never staggered; the highlight moves instantly. */
function Autocomplete({ frag, matches, canCreate, acIndex, onHover, onAccept }: {
  frag: string; matches: Project[]; canCreate: boolean; acIndex: number
  onHover: (i: number) => void; onAccept: (name: string) => void
}): React.JSX.Element {
  const inert = useExitInert()
  const instant = matches.length + (canCreate ? 1 : 0) > INSTANT_CAP.autocomplete
  const dep = `${matches.map((p) => p.name).join('|')}|${canCreate}`
  const row = {
    layout: instant ? (false as const) : ('position' as const),
    layoutDependency: dep,
    transition: { layout: SPRING.ui },
    variants: AC_ROW,
    custom: instant,
    initial: 'initial',
    animate: 'animate',
    exit: 'exit'
  }
  return (
    <m.div className="ac" inert={inert.inert} style={inert.style} variants={presets.autocomplete} initial="initial" animate="animate" exit="exit">
      <AnimatePresence mode="popLayout" initial={false}>
        {matches.map((p, i) => {
          const at = p.name.toLowerCase().indexOf(frag.toLowerCase())
          return (
            <m.button
              key={p.name}
              {...row}
              type="button"
              className={`ac__row ${i === acIndex ? 'is-hi' : ''}`}
              onMouseEnter={() => onHover(i)}
              onMouseDown={(e) => { e.preventDefault(); onAccept(p.name) }}
            >
              <span className="ac__left">
                <Icon name="folder" />
                <span className="ac__name">
                  {p.name.slice(0, at)}<span className="ac__match">{p.name.slice(at, at + frag.length)}</span>{p.name.slice(at + frag.length)}
                </span>
              </span>
              {p.count > 0 && <span className="ac__count">{p.count}</span>}
            </m.button>
          )
        })}
        {canCreate && matches.length > 0 && <m.div key=":sep" {...row} className="ac__sep" />}
        {canCreate && (
          <m.button
            key=":create"
            {...row}
            type="button"
            className={`ac__row ac__row--create ${acIndex === matches.length ? 'is-hi' : ''}`}
            onMouseEnter={() => onHover(matches.length)}
            onMouseDown={(e) => { e.preventDefault(); onAccept(frag.trim()) }}
          >
            <Icon name="plus" />
            <span className="ac__label">Create “{frag.trim()}”</span>
          </m.button>
        )}
      </AnimatePresence>
    </m.div>
  )
}

/**
 * One group's rows. Reordering is pointer driven: the picked-up row follows
 * the pointer 1:1 and its siblings make room. Order is global in the store, so
 * the new order only becomes real when the drop is written back (commitOrder);
 * until the store answers, the rows keep the order they were dropped in.
 */
function List({ rows, baseIndex, draggable = false, clearing = false, held, onToggle, commitOrder }: {
  rows: Todo[]
  baseIndex: number
  draggable?: boolean
  clearing?: boolean
  held: ReadonlySet<string>
  onToggle: (t: Todo) => void
  commitOrder: (ids: string[]) => Promise<void>
}): React.JSX.Element {
  const storeKey = rows.map((t) => t.id).join()
  const [override, setOverride] = useState<string[] | null>(null)
  useEffect(() => { setOverride(null) }, [storeKey])

  const byId = new Map(rows.map((t) => [t.id, t]))
  const ordered = override
    ? [...override.flatMap((id) => byId.get(id) ?? []), ...rows.filter((t) => !override.includes(t.id))]
    : rows
  const ids = ordered.map((t) => t.id)
  const listKey = ids.join()
  const order = useRef(ids)
  order.current = ids
  const els = useRef(new Map<string, HTMLElement>())

  const move = (id: string, to: number): void => {
    const next = [...order.current]
    const from = next.indexOf(id)
    if (from < 0 || to < 0 || to >= next.length) return
    next.splice(from, 1)
    next.splice(to, 0, id)
    order.current = next
    setOverride(next)
  }
  /** Swap with the neighbour in the direction of travel once the dragged edge passes its centre. */
  const onDrag = (id: string, y: number, vy: number): void => {
    if (!vy) return
    const at = order.current.indexOf(id)
    const to = vy > 0 ? at + 1 : at - 1
    const el = els.current.get(id)
    const other = els.current.get(order.current[to] ?? '')
    if (!el || !other) return
    const top = el.offsetTop + y
    const centre = other.offsetTop + other.offsetHeight / 2
    if (vy > 0 ? top + el.offsetHeight > centre : top < centre) move(id, to)
  }
  const settle = (): void => {
    if (order.current.join() === storeKey) setOverride(null)
    else void commitOrder(order.current)
  }

  return (
    <AnimatePresence>
      {ordered.map((t, pos) => (
        <Row
          key={t.id}
          todo={t}
          held={held.has(t.id)}
          custom={{ index: baseIndex + pos, pos, leave: 'move', fromEnd: ordered.length - 1 - pos }}
          listKey={listKey}
          draggable={draggable && !t.done && !held.has(t.id)}
          clearing={clearing}
          register={(el) => { if (el) els.current.set(t.id, el); else els.current.delete(t.id) }}
          onToggle={() => onToggle(t)}
          onDrag={(y, vy) => onDrag(t.id, y, vy)}
          onDrop={settle}
          onNudge={(by) => { move(t.id, order.current.indexOf(t.id) + by); settle() }}
        />
      ))}
    </AnimatePresence>
  )
}

/** Todo Item h0n3gl / Done U3eZJF / Project IRYt3, in a slot that owns its height, position and drag. */
function Row({ todo, held, custom, listKey, draggable, clearing, register, onToggle, onDrag, onDrop, onNudge }: {
  todo: Todo
  held: boolean
  custom: ContentCustom
  listKey: string
  draggable: boolean
  clearing: boolean
  register: (el: HTMLElement | null) => void
  onToggle: () => void
  onDrag: (y: number, vy: number) => void
  onDrop: () => void
  onNudge: (by: -1 | 1) => void
}): React.JSX.Element {
  const ctx = useContext(EnterCtx)
  const [mode] = useState(() => ctx.current)
  const shown = useContext(ShownCtx)
  const present = useIsPresent()
  const [settled, setSettled] = useState(mode !== 'insert')
  const [leave, setLeave] = useState<Leave>('move')
  const [dragging, setDragging] = useState(false)     // in the hand: lifted, elevated
  const [raised, setRaised] = useState(false)         // above its neighbours until it has settled
  const [picking, setPicking] = useState(false)
  const chipRef = useRef<HTMLButtonElement>(null)
  const y = useMotionValue(0)
  const controls = useDragControls()

  const [prefix, task] = splitTitle(todo.title)
  const checked = todo.done || held

  /** A drag starts only after the pointer has travelled, and never from a control. */
  const armDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!draggable || e.button !== 0) return
    const target = e.target as Element
    if (!e.currentTarget.contains(target) || target.closest('button, input, textarea, a')) return
    const { clientX: sx, clientY: sy } = e
    const disarm = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', disarm)
      window.removeEventListener('pointercancel', disarm)
    }
    const onMove = (ev: PointerEvent): void => {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_HYSTERESIS) return
      disarm()
      controls.start(ev, { distanceThreshold: 0 })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', disarm)
    window.addEventListener('pointercancel', disarm)
  }
  /** ⌥↑ / ⌥↓ moves the row one slot (no drag physics, no lift). */
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!draggable || !e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
    if (!e.currentTarget.contains(e.target as Node)) return
    e.preventDefault()
    onNudge(e.key === 'ArrowUp' ? -1 : 1)
  }

  const cls = [
    'item', checked && 'is-done', held && 'is-held', dragging && 'is-dragging',
    picking && 'is-picking', !todo.due && 'is-undated'
  ].filter(Boolean).join(' ')

  return (
    <m.div
      ref={register}
      className="row"
      inert={!present}
      style={{
        y,
        overflow: present && settled ? 'visible' : 'hidden',
        zIndex: raised ? Z.drag : undefined,
        pointerEvents: present ? undefined : 'none'
      }}
      layout="position"
      layoutDependency={listKey}
      transition={{ layout: SPRING.ui }}
      initial={mode === 'insert' ? { height: 0, marginTop: -GAP } : false}
      animate={{ height: 'auto', marginTop: 0, scale: dragging ? SCALE.lift : 1, transition: { default: SPRING.ui, scale: SPRING.snappy } }}
      exit={{ height: 0, marginTop: -GAP, transition: leave === 'delete' ? SPRING.exit : SPRING.ui }}
      onAnimationComplete={() => setSettled(true)}
      drag={draggable ? 'y' : false}
      dragControls={controls}
      dragListener={false}
      dragSnapToOrigin
      dragTransition={DROP}
      onDragStart={() => { setDragging(true); setRaised(true) }}
      onDrag={(_e, info) => onDrag(y.get(), info.velocity.y)}
      onDragEnd={() => { setDragging(false); onDrop() }}
      onDragTransitionEnd={() => setRaised(false)}
      onPointerDown={armDrag}
      onKeyDown={onKeyDown}
    >
      <m.div
        variants={CONTENT[mode]}
        custom={{ ...custom, leave: clearing ? 'clear' : leave }}
        initial={mode === 'none' ? false : 'initial'}
        animate={clearing ? 'cleared' : mode === 'stagger' && !shown ? 'initial' : 'animate'}
        exit="exit"
      >
        <div className={cls}>
          <span className="item__grip" aria-hidden><Icon name="grip" /></span>
          <span className="item__checkwrap">
            <button
              type="button"
              className={`check ${checked ? 'is-on' : ''}`}
              aria-label={checked ? 'Mark as not done' : 'Mark as done'}
              onClick={onToggle}
            >
              {/* Checkbox / Done BDqkL: the fill and its check pop in together. */}
              <AnimatePresence initial={false}>
                {checked && (
                  <m.span key="fill" className="check__fill" variants={presets.popIn} initial="initial" animate="animate" exit="exit">
                    <Icon name="check" active />
                  </m.span>
                )}
              </AnimatePresence>
            </button>
          </span>
          <div className="item__text">
            {prefix ? (
              <div className="item__title item__title--split">
                <span className="item__prefix">{prefix}</span>
                <span className="item__task"><span className="item__ink">{task}</span></span>
              </div>
            ) : (
              <div className="item__title"><span className="item__ink">{task}</span></div>
            )}
            <Collapse open={!!todo.description && !checked} content={DETAIL}>
              <div className="item__desc">{todo.description}</div>
            </Collapse>
            <Collapse open={!checked} content={DETAIL}>
              <div className="item__meta">
                <DateChip
                  ref={chipRef}
                  due={todo.due}
                  time={todo.time}
                  synced={!!todo.eventId}
                  hoverOnly
                  onClick={() => setPicking((v) => !v)}
                />
              </div>
            </Collapse>
          </div>
          <button
            type="button"
            className="item__del"
            aria-label="Delete"
            title="Delete"
            onClick={() => { setLeave('delete'); void window.flow.todos.remove(todo.id) }}
          >
            <Icon name="trash" />
          </button>
        </div>
      </m.div>
      {createPortal(
        <AnimatePresence>
          {picking && chipRef.current && (
            <DatePicker
              key="picker"
              anchor={chipRef.current}
              dx={-6}
              value={todo.due}
              time={todo.time}
              synced={!!todo.eventId}
              onChange={(d, t) => void window.flow.todos.update(todo.id, { due: d, time: t })}
              onClose={() => setPicking(false)}
            />
          )}
        </AnimatePresence>,
        document.body
      )}
    </m.div>
  )
}

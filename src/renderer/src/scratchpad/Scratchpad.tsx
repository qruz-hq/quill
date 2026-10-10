import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, LayoutGroup, m, useIsPresent, type TargetAndTransition, type Transition, type Variants } from 'motion/react'
import { Icon, AppMark } from '../shared/icons'
import { Keycap } from '../shared/ui'
import { holdKeyFor, usePlatform } from '../shared/platform'
import {
  BLUR, BlurNumber, BlurWords, DIST, DUR, DUR_MS, HOLD, INSTANT_CAP, Indicator, PresenceSwap, SCALE, SPRING, WORD_VARIANTS,
  blurPx, filterBudget, inputModality, isReducedMotion, onWinShown, presets, tween, useExitInert, useReduceMotion,
  useWindowShown, type DurToken, type EaseToken
} from '../shared/motion'

/* Scratchpad window, 1:1 from design.pen "Scratchpad - Window" (vytSm).
   DOM mirrors the node tree: Title Bar / Body { Notes, Editor }.
   Motion: docs/MOTION.md §4.9, built only from shared/motion tokens. */

type Note = { id: string; title: string; body: string; createdAt: number; updatedAt: number }
type Fmt = { bold: boolean; italic: boolean; underline: boolean; block: string; todo: boolean }
type Transform = { id: string; name: string; description: string; slot: number }

const AUTOSAVE_MS = 500
/** A note this young at window load is the voice note that opened the window. */
const VOICE_NOTE_FRESH_MS = 4000
/** Layout gaps that collapse together with an animated width (Tabs vqwDC gap 4, Body y2Th0 gap 8, Notes jKD4h 204). */
const TAB_GAP = 4
const BODY_GAP = 8
const NOTES_W = 204

const tw = (d: DurToken, e: EaseToken = 'out', delay = 0): Transition => tween(d, e, delay) as Transition

/** Window card (§4.9 Window open): opacity fast, y 8 + scale 0.97 on spring.fluid, blur 4 over base. */
const CARD: Variants = {
  hidden: { opacity: 0, y: DIST.md, scale: SCALE.press },
  // `blur` false (a voice note reveals with the window): the card carries no
  // filter at all, so no word blurs under a filtered ancestor (rule 8).
  shown: (blur: boolean) => ({
    opacity: 1, y: 0, scale: 1, ...(blur ? { filter: [blurPx(BLUR.sm), blurPx(0)] } : {}),
    transition: { default: SPRING.fluid, opacity: tw('fast'), filter: tw('base') },
    transitionEnd: blur ? { filter: 'none' } : undefined
  }),
  // §4.9 Window close: opacity 0, scale 0.98, blur 4, dur.fast ease.exit.
  closing: { opacity: 0, y: 0, scale: SCALE.exit, filter: blurPx(BLUR.sm), transition: tw('fast', 'exit') }
}

/** Tab: real width 0 to measured (spring.ui), opacity fast; close opacity micro, width spring.exit. */
const TAB: Variants = {
  initial: { width: 0, opacity: 0, marginRight: -TAB_GAP },
  animate: { width: 'auto', opacity: 1, marginRight: 0, transition: { default: SPRING.ui, opacity: tw('fast') } },
  exit: { width: 0, opacity: 0, marginRight: -TAB_GAP, transition: { default: SPRING.exit, opacity: tw('micro', 'exit') } }
}

/** Notes sidebar: width on spring.ui; content out micro, in fast at t = 60. */
const SIDEBAR: Variants = {
  initial: { width: 0, marginRight: -BODY_GAP },
  animate: { width: NOTES_W, marginRight: 0, transition: SPRING.ui },
  exit: { width: 0, marginRight: -BODY_GAP, transition: SPRING.ui }
}
const SIDEBAR_CONTENT: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: tw('fast', 'out', 0.06) },
  exit: { opacity: 0, transition: tw('micro', 'exit') }
}

type RowCustom = { fresh: boolean; deleting: boolean; instant: boolean }
const INSTANT: Transition = { duration: DUR.instant }
/** Note row: a new note inserts (§4.8), a filtered row fades, a deleted row leaves as §4.8 delete. */
const NOTE_ROW: Variants = {
  initial: (c: RowCustom) =>
    (c.instant ? { opacity: 1 } : c.fresh ? presets.rowInsert.initial : presets.filterOut.initial) as TargetAndTransition,
  animate: (c: RowCustom) =>
    (c.instant ? { opacity: 1, transition: INSTANT } : c.fresh ? presets.rowInsert.animate : presets.filterOut.animate) as TargetAndTransition,
  exit: (c: RowCustom) =>
    (c.instant ? { opacity: 0, transition: INSTANT } : c.deleting ? presets.rowDelete.exit : presets.filterOut.exit) as TargetAndTransition
}

/** Copy all icon swap: `label`-style blur swap plus scale 0.6 to 1 on spring.snappy. */
const L = WORD_VARIANTS.label
const COPY_ICON: Variants = {
  initial: { opacity: 0, scale: SCALE.pop, filter: blurPx(L.blur) },
  animate: {
    opacity: 1, scale: 1, filter: blurPx(0),
    transition: {
      default: SPRING.snappy,
      opacity: { duration: L.opacity, ease: L.ease as unknown as Transition['ease'] },
      filter: { duration: L.filter, ease: L.ease as unknown as Transition['ease'] }
    },
    transitionEnd: { filter: 'none' }
  },
  exit: { opacity: 0, filter: blurPx(L.blur), transition: { ...tw('flash', 'exit'), duration: L.exit } }
}

const LIVE_HINT: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: tw('fast') },
  exit: { opacity: 0, transition: tw('micro', 'exit') }
}

/** Text of a note body, as the editor will show it. */
const bodyText = (html: string): string => {
  const d = document.createElement('div')
  d.innerHTML = html
  return (d.textContent ?? '').replace(/\s+/g, ' ').trim()
}
const NO_FMT: Fmt = { bold: false, italic: false, underline: false, block: '', todo: false }

/** Mirrors main/notes.ts: an untitled note takes its name from the body text. */
const deriveTitle = (body: string): string =>
  body.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').trim().split('\n')[0].slice(0, 60)
/** Visible text of a note's HTML body (for search). */
const plain = (html: string): string => html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ')
/** A title the user typed (as opposed to one main derived from the body). */
const isManualTitle = (n: Note): boolean => !!n.title.trim() && n.title !== deriveTitle(n.body)

/** §4.9: with the window, the voice note body starts at t = 120; the last word lands by `dur.signature`. */
const REVEAL_WITH_WINDOW = 0.12
type Reveal = { id: string; text: string; delay: number }

export default function Scratchpad(): React.JSX.Element {
  const [notes, setNotes] = useState<Note[]>([])
  const [openIds, setOpenIds] = useState<string[]>([])     // tab strip
  const [activeId, setActiveId] = useState<string | null>(null)
  const [ready, setReady] = useState(false)                // first list loaded
  const [collapsed, setCollapsed] = useState(false)
  const [showFormat, setShowFormat] = useState(true)
  const [query, setQuery] = useState('')
  const [titleDraft, setTitleDraft] = useState<{ id: string; value: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [words, setWords] = useState(0)
  const [fmt, setFmt] = useState<Fmt>(NO_FMT)
  const [holdKey, setHoldKey] = useState(63)
  const platform = usePlatform()
  const [transforms, setTransforms] = useState<Transform[] | null>(null)   // open menu when non-null
  const [recording, setRecording] = useState(false)
  const [copied, setCopied] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [reveal, setReveal] = useState<Reveal | null>(null)   // voice note body reveal
  const [, tick] = useState(0)
  /* Pending autosaves, one per note and field ("<id>:body", "<id>:title"), so
     typing in another note never cancels this one's save. */
  const pending = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; run: () => void }>())
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savedRange = useRef<Range | null>(null)
  const known = useRef<Set<string> | null>(null)           // note ids seen so far (null until loaded)
  const freshTabs = useRef(new Set<string>())              // tabs that animate in
  const freshNotes = useRef(new Set<string>())             // note rows that insert (not filter results)
  const sidebarToggled = useRef(false)
  const introBlur = useRef(true)
  const focusNext = useRef(false)

  const reduced = useReduceMotion()
  const shown = useWindowShown(onWinShown)
  const entered = shown && ready
  /* Close handshake: every close path arrives as pad:will-close; the card plays
     its exit (from wherever it is) and answers with the same seq. */
  const [closing, setClosing] = useState<number | null>(null)
  useEffect(() => window.flow.pad.onWillClose?.((e) => {
    flushSaves()                                            // before the answer: main may destroy the window on it
    if (isReducedMotion()) window.flow.pad.closed(e.seq)
    else setClosing(e.seq)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [])

  /* One editor element per open note (the switch cross-fades two of them), so
     "the editor" is whichever belongs to the active note. */
  const editors = useRef(new Map<string, HTMLDivElement>())
  const activeRef = useRef<string | null>(null)
  activeRef.current = activeId
  const editor = useRef({
    get current(): HTMLDivElement | null { return editors.current.get(activeRef.current ?? '') ?? null }
  }).current

  const active = notes.find((n) => n.id === activeId) ?? null

  useEffect(() => {
    let alive = true
    void (async () => {
      const list = (await window.flow.notes.list()) as Note[]
      const first = list[0] ?? ((await window.flow.notes.create()) as Note)
      if (!alive) return
      const all = list.length ? list : [first]
      known.current = new Set(all.map((n) => n.id))
      // A voice note opened this window: its body reveals with the window.
      if (list.length && !isReducedMotion() && Date.now() - first.createdAt < VOICE_NOTE_FRESH_MS) {
        const text = bodyText(first.body)
        if (text) { introBlur.current = false; setReveal({ id: first.id, text, delay: REVEAL_WITH_WINDOW }) }
      }
      setNotes(all)
      setOpenIds([first.id])
      setActiveId(first.id)
      setReady(true)
    })()
    void window.flow.settings.get().then((p) => setHoldKey(p.holdKey ?? 63)).catch(() => {})
    const t = setInterval(() => tick((x) => x + 1), 30_000)   // keep "2 min ago" fresh
    const off = window.flow.notes.onChanged((raw) => {
      const list = raw as Note[]
      setNotes(list)
      const seen = known.current
      if (!seen) return
      // A note this window did not create, arriving with a body, is a voice note.
      const arrived = list.find((n) => !seen.has(n.id) && bodyText(n.body))
      list.forEach((n) => seen.add(n.id))
      if (!arrived) return
      freshTabs.current.add(arrived.id)
      // Its row inserts with a blur: that is one of the window's 12 live filters, taken before the words take theirs.
      if (filterBudget.take(1)) {
        freshNotes.current.add(arrived.id)
        setTimeout(() => filterBudget.release(1), DUR_MS.base)
      }
      setOpenIds((prev) => (prev.includes(arrived.id) ? prev : [...prev, arrived.id]))
      setActiveId(arrived.id)
      if (!isReducedMotion()) setReveal({ id: arrived.id, text: bodyText(arrived.body), delay: 0 })
    })
    const offState = window.flow.dictation.onState((s) => setRecording(s === 'recording'))
    return () => { alive = false; clearInterval(t); off?.(); offState?.() }
  }, [])

  // Load the active note into its editor without clobbering what's being typed.
  useLayoutEffect(() => {
    const el = editor.current
    if (el && active && el.dataset.loaded !== active.id) {
      el.innerHTML = active.body
      el.dataset.loaded = active.id
      setWords(countWords(el.innerText))
      setFmt(NO_FMT)                                        // the old note's caret state no longer applies
      if (focusNext.current) { focusNext.current = false; el.focus() }
    }
  }, [active, editor])

  /** Debounces one save per key; a newer one for the same key replaces it. */
  const queueSave = useCallback((key: string, save: () => Promise<unknown>): void => {
    const map = pending.current
    const old = map.get(key)
    if (old) clearTimeout(old.timer)
    setSaving(true)
    const run = (): void => {
      const mine = map.get(key)
      if (mine) clearTimeout(mine.timer)
      map.delete(key)
      void save().finally(() => { if (!map.size) setSaving(false) })
    }
    map.set(key, { timer: setTimeout(run, AUTOSAVE_MS), run })
  }, [])
  /** Sends every pending save now (all notes, or one note's). */
  const flushSaves = useCallback((noteId?: string): void => {
    for (const [key, p] of [...pending.current]) if (!noteId || key.startsWith(`${noteId}:`)) p.run()
  }, [])
  /** Forgets a deleted note's pending saves. */
  const dropSaves = (noteId: string): void => {
    for (const [key, p] of [...pending.current]) {
      if (key.startsWith(`${noteId}:`)) { clearTimeout(p.timer); pending.current.delete(key) }
    }
    if (!pending.current.size) setSaving(false)
  }
  // Leaving a note (tab or note switch) saves it at once; so does the window losing focus or unloading.
  useEffect(() => () => { if (activeId) flushSaves(activeId) }, [activeId, flushSaves])
  useEffect(() => {
    const all = (): void => flushSaves()
    window.addEventListener('blur', all)
    window.addEventListener('pagehide', all)
    window.addEventListener('beforeunload', all)
    return () => { window.removeEventListener('blur', all); window.removeEventListener('pagehide', all); window.removeEventListener('beforeunload', all) }
  }, [flushSaves])

  const scheduleSave = useCallback(() => {
    const el = editor.current
    if (!activeId || !el) return
    setWords(countWords(el.innerText))
    const body = el.innerHTML
    const note = notes.find((n) => n.id === activeId)
    // Keep a typed title; otherwise let main re-derive it from the body.
    const title = note && isManualTitle(note) ? note.title : undefined
    queueSave(`${activeId}:body`, () => window.flow.notes.update(activeId, title !== undefined ? { body, title } : { body }))
  }, [activeId, notes, editor, queueSave])

  const changeTitle = (value: string): void => {
    if (!activeId) return
    const id = activeId
    setTitleDraft({ id, value })
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, title: value } : n)))
    queueSave(`${id}:title`, () => window.flow.notes.update(id, { title: value }).finally(() => {
      setTitleDraft((d) => (d && d.id === id && d.value === value ? null : d))
    }))
  }

  const newNote = async (): Promise<void> => {
    const n = (await window.flow.notes.create()) as Note
    known.current?.add(n.id)
    freshTabs.current.add(n.id)
    freshNotes.current.add(n.id)
    focusNext.current = true                                // its editor mounts with the tab
    setNotes((prev) => [n, ...prev])
    setOpenIds((prev) => [...prev, n.id])
    setActiveId(n.id)
    setWords(0)
    setFmt(NO_FMT)
  }

  const openNote = (id: string): void => {
    if (!openIds.includes(id)) freshTabs.current.add(id)
    setOpenIds((prev) => (prev.includes(id) ? prev : [...prev, id]))
    setActiveId(id)
  }

  /** Closing the last tab closes the window. */
  const closeTab = (id: string): void => {
    const next = openIds.filter((x) => x !== id)
    if (!next.length) { window.flow.pad.close(); return }
    setOpenIds(next)
    if (activeId === id) setActiveId(next[next.length - 1])
  }

  /** Deleting a note never closes the window: it falls back to another note. */
  const removeNote = async (id: string): Promise<void> => {
    dropSaves(id)
    setDeletingId(id)                                       // its row leaves as a delete, not a filter
    const list = (await window.flow.notes.remove(id)) as Note[]
    const next = openIds.filter((x) => x !== id && list.some((n) => n.id === x))
    if (!next.length) {
      const fallback = list[0] ?? ((await window.flow.notes.create()) as Note)
      known.current?.add(fallback.id)
      setNotes(list.length ? list : [fallback])
      setOpenIds([fallback.id])
      setActiveId(fallback.id)
      return
    }
    setNotes(list)
    setOpenIds(next)
    if (activeId === id || !next.includes(activeId ?? '')) setActiveId(next[next.length - 1])
  }

  /* ---- formatting ---- */
  const readFmt = useCallback((): void => {
    const el = editor.current
    const sel = document.getSelection()
    if (!el || !sel || !sel.anchorNode || !el.contains(sel.anchorNode)) return
    const node = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode.parentElement
    setFmt({
      bold: document.queryCommandState('bold'),
      italic: document.queryCommandState('italic'),
      underline: document.queryCommandState('underline'),
      block: String(document.queryCommandValue('formatBlock') || '').toLowerCase(),
      todo: !!node?.closest('ul.todo')
    })
  }, [editor])

  useEffect(() => {
    document.addEventListener('selectionchange', readFmt)
    return () => document.removeEventListener('selectionchange', readFmt)
  }, [readFmt])

  const cmd = (c: string, arg?: string): void => {
    editor.current?.focus()
    document.execCommand(c, false, arg)
    scheduleSave()
    readFmt()
  }
  const block = (tag: string): void => cmd('formatBlock', fmt.block === tag ? 'div' : tag)
  /** Turns the current line(s) into checklist items (or back into text). */
  const checklist = (): void => {
    if (fmt.todo) { cmd('insertUnorderedList'); return }
    const el = editor.current
    if (!el) return
    el.focus()
    const before = new Set(el.querySelectorAll('ul'))
    document.execCommand('insertUnorderedList')
    const a = document.getSelection()?.anchorNode
    const at = (a instanceof Element ? a : a?.parentElement)?.closest('ul')
    if (at && el.contains(at)) at.classList.add('todo')
    el.querySelectorAll('ul').forEach((ul) => { if (!before.has(ul)) ul.classList.add('todo') })
    scheduleSave()
    readFmt()
  }

  /** A click on a checklist item's checkbox toggles it done. */
  const onDocMouseDown = (e: React.MouseEvent<HTMLDivElement>): void => {
    const li = (e.target as Element).closest('ul.todo > li')
    if (!li) return
    if (e.clientX - li.getBoundingClientRect().left > 18) return
    e.preventDefault()
    li.classList.toggle('done')
    scheduleSave()
  }

  /* ---- transforms: run one on the selection, or on the whole note ---- */
  const toggleTransforms = async (): Promise<void> => {
    if (transforms) { setTransforms(null); return }
    const el = editor.current
    const sel = document.getSelection()
    savedRange.current = el && sel && sel.rangeCount && el.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null
    setTransforms((await window.flow.transforms.list()) as Transform[])
  }

  useEffect(() => {
    if (!transforms) return
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setTransforms(null) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [transforms])

  const runTransform = async (t: Transform): Promise<void> => {
    setTransforms(null)
    const el = editor.current
    if (!el) return
    let range = savedRange.current
    if (!range || range.collapsed) { range = document.createRange(); range.selectNodeContents(el) }
    const text = range.toString().trim() ? range.toString() : el.innerText
    const out = (await window.flow.transforms.preview(t.id, text)) as string
    el.focus()
    const sel = document.getSelection()
    sel?.removeAllRanges(); sel?.addRange(range)
    document.execCommand('insertText', false, out)
    scheduleSave()
  }

  /** Copies the note; the icon shows a check for `hold.copied`. */
  const copyAll = (): void => {
    const text = editor.current?.innerText ?? ''
    void navigator.clipboard.writeText(text)
    setCopied(true)
    if (copiedTimer.current) clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => setCopied(false), HOLD.copied)
  }
  useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current) }, [])

  const focusEnd = useCallback((): void => {
    const el = editor.current
    if (!el) return
    el.focus()
    const r = document.createRange()
    r.selectNodeContents(el)
    r.collapse(false)
    const s = document.getSelection()
    s?.removeAllRanges(); s?.addRange(r)
  }, [editor])

  /* ---- voice note reveal (§4.9): an overlay over the editor, never spans in it ---- */
  const revealing = !!reveal && reveal.id === activeId && !reduced
  const revealRef = useRef(reveal)
  revealRef.current = reveal
  // Dropped when its note is no longer the one on screen, or Reduce Motion turns on.
  useEffect(() => {
    if (reveal && (reduced || (activeId !== null && reveal.id !== activeId))) setReveal(null)
  }, [reveal, activeId, reduced])
  /** Settled: overlay out and ink back in the same commit, caret to the end. */
  const revealSettled = (id: string): void => {
    if (revealRef.current?.id !== id || activeRef.current !== id) return
    setReveal(null)
    focusEnd()
  }
  /** The first key or pointer press in the editor ends the reveal at once. */
  const interruptReveal = (): void => { if (revealRef.current) setReveal(null) }

  const visible = query
    ? notes.filter((n) => (n.title + ' ' + plain(n.body)).toLowerCase().includes(query.toLowerCase()))
    : notes
  const titleValue = titleDraft && titleDraft.id === activeId ? titleDraft.value : active?.title ?? ''
  // The hold key in this OS's name (the same set Settings offers); none when it is Off or the system has no hold key.
  const holdLabel = holdKeyFor(holdKey, platform)?.name
  const listInstant = notes.length > INSTANT_CAP.filter
  const listKey = visible.map((n) => n.id).join()
  /** Selection indicators fly for the pointer and jump for the keyboard. */
  const pill = (spring: Transition): Transition => (inputModality() === 'keyboard' ? INSTANT : spring)

  return (
    <LayoutGroup id="pad">
      <m.div
        className="pad"
        inert={closing !== null}
        variants={CARD}
        custom={introBlur.current}
        initial="hidden"
        animate={closing !== null ? 'closing' : entered ? 'shown' : 'hidden'}
        onAnimationComplete={(def) => { if (def === 'closing' && closing !== null) window.flow.pad.closed(closing) }}
      >
        {/* Title Bar BOmlw */}
        <header className="pad__bar">
          <AppMark size={16} className="pad__mark" />
          <m.div className="pad__tabs" layoutScroll>
            {ready && (
              <AnimatePresence initial={false}>
                {openIds.map((id) => (
                  <Tab
                    key={id}
                    title={notes.find((x) => x.id === id)?.title?.trim() || 'Untitled'}
                    on={id === activeId}
                    fresh={freshTabs.current.has(id)}
                    dep={activeId}
                    pill={pill(SPRING.fluid)}
                    onSettled={() => freshTabs.current.delete(id)}
                    onSelect={() => setActiveId(id)}
                    onClose={() => closeTab(id)}
                  />
                ))}
              </AnimatePresence>
            )}
            <button type="button" className="pad__newTab" onClick={() => void newNote()} aria-label="New tab" title="New tab">
              <Icon name="plus" />
            </button>
          </m.div>
          <button type="button" className="pad__win" onClick={() => window.flow.pad.expand()} aria-label="Expand" title="Expand">
            <Icon name="expand" />
          </button>
          <button type="button" className="pad__win" onClick={() => window.flow.pad.close()} aria-label="Close" title="Close">
            <Icon name="close" />
          </button>
        </header>

        {/* Body y2Th0 */}
        <div className="pad__body">
          <AnimatePresence initial={false}>
            {!collapsed && (
              <NotesPane key="notes" fresh={sidebarToggled.current}>
                <div className="pad__notesHead">
                  <h2 className="pad__notesTitle">Notes</h2>
                  <div className="pad__spacer" />
                  <button type="button" className="pad__round" onClick={() => void newNote()} aria-label="New note" title="New note">
                    <Icon name="note-plus" />
                  </button>
                  <button
                    type="button"
                    className="pad__round"
                    onClick={() => { sidebarToggled.current = true; setCollapsed(true) }}
                    aria-label="Collapse notes"
                    title="Collapse notes"
                  >
                    <Icon name="sidebar" />
                  </button>
                </div>

                <label className="pad__search">
                  <Icon name="magnifier" />
                  <input
                    placeholder="Search notes"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>

                <m.div className="pad__list" layoutScroll>
                  <AnimatePresence mode="popLayout" initial={false}>
                    {visible.map((n) => (
                      <NoteRow
                        key={n.id}
                        title={n.title?.trim() || 'Untitled'}
                        time={listTime(n.updatedAt)}
                        on={n.id === activeId}
                        custom={{ fresh: freshNotes.current.has(n.id), deleting: n.id === deletingId, instant: listInstant }}
                        listKey={listKey}
                        dep={activeId}
                        pill={pill(SPRING.snappy)}
                        onSettled={() => freshNotes.current.delete(n.id)}
                        onOpen={() => openNote(n.id)}
                        onDelete={() => void removeNote(n.id)}
                      />
                    ))}
                  </AnimatePresence>
                </m.div>

                <div className="pad__foot">
                  {transforms && <div className="pad__menuScrim" onMouseDown={() => setTransforms(null)} />}
                  <AnimatePresence>
                    {transforms && (
                      <TransformsMenu
                        key="menu"
                        items={transforms}
                        onRun={(t) => void runTransform(t)}
                        onAdd={() => { setTransforms(null); window.flow.hub.show() }}
                      />
                    )}
                  </AnimatePresence>
                  <button
                    type="button"
                    className={`pad__footItem ${transforms ? 'is-active' : ''}`}
                    aria-haspopup="menu"
                    aria-expanded={!!transforms}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => void toggleTransforms()}
                  >
                    <Icon name="wand" active={!!transforms} />
                    <span className="pad__footLabel">Transforms</span>
                  </button>
                  <button
                    type="button"
                    className={`pad__footItem ${showFormat ? 'is-active' : ''}`}
                    aria-pressed={showFormat}
                    onClick={() => setShowFormat((f) => !f)}
                  >
                    <Icon name="letter-a" active={showFormat} />
                    <span className="pad__footLabel">Formatting</span>
                  </button>
                </div>
              </NotesPane>
            )}
          </AnimatePresence>

          {/* Editor to64Y */}
          <main className={`pad__editor ${collapsed ? 'is-collapsed' : ''}`}>
            {collapsed && (
              <button
                type="button"
                className="pad__round pad__showNotes"
                onClick={() => { sidebarToggled.current = true; setCollapsed(false) }}
                aria-label="Show notes"
                title="Show notes"
              >
                <Icon name="sidebar" />
              </button>
            )}
            <div className="pad__head">
              <input
                className="pad__title"
                value={titleValue}
                placeholder="Untitled"
                aria-label="Note title"
                onChange={(e) => changeTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); focusEnd() } }}
              />
              <div className="pad__meta">
                {active && (
                  <>
                    <BlurWords variant="label" text={`Edited ${ago(active.updatedAt)}`} />
                    {' · '}
                    <BlurNumber value={words} size="subtle" />
                    {` ${words === 1 ? 'word' : 'words'} · `}
                    <BlurWords variant="label" text={saving ? 'saving' : 'saved'} />
                  </>
                )}
              </div>
            </div>

            <div className="pad__content">
              {/* Tab switch: the two editors cross-fade (out flash, in fast), no blur, no y. */}
              {activeId && (
                <PresenceSwap swapKey={activeId} variants={presets.crossFade} className="pad__docWrap">
                  <div
                    ref={(el) => {
                      const id = activeId
                      if (el) editors.current.set(id, el)
                      return () => { if (editors.current.get(id) === el) editors.current.delete(id) }
                    }}
                    className={`pad__doc ${revealing ? 'is-revealing' : ''}`}
                    contentEditable
                    suppressContentEditableWarning
                    onInput={scheduleSave}
                    onKeyUp={readFmt}
                    onKeyDown={interruptReveal}
                    onPointerDown={interruptReveal}
                    onMouseDown={onDocMouseDown}
                  />
                  {revealing && reveal && (
                    <RevealOverlay text={reveal.text} delay={reveal.delay} hold={!entered} onDone={() => revealSettled(reveal.id)} />
                  )}
                </PresenceSwap>
              )}
              <AnimatePresence initial={false}>
                {holdLabel && !recording && (
                  <m.div key="live" className="pad__live" variants={LIVE_HINT} initial="initial" animate="animate" exit="exit" onClick={focusEnd}>
                    <span className="pad__caret" />
                    <span className="pad__hint">Hold</span>
                    <Keycap size="sm" className="pad__key">{holdLabel}</Keycap>
                    <span className="pad__hint">to dictate here</span>
                  </m.div>
                )}
              </AnimatePresence>
            </div>

            <div className="pad__toolbar">
              <AnimatePresence initial={false}>
                {showFormat && (
                  <FormatBar key="fmt">
                    <FmtBtn label="Bold" cls="pad__fmtBtn--b" on={fmt.bold} onClick={() => cmd('bold')}>B</FmtBtn>
                    <FmtBtn label="Italic" cls="pad__fmtBtn--i" on={fmt.italic} onClick={() => cmd('italic')}>I</FmtBtn>
                    <FmtBtn label="Underline" on={fmt.underline} onClick={() => cmd('underline')}>U</FmtBtn>
                    <FmtBtn label="Code" cls="pad__fmtBtn--code" on={fmt.block === 'pre'} onClick={() => block('pre')}>{'</>'}</FmtBtn>
                    <span className="pad__sep" />
                    <FmtBtn label="Heading 1" on={fmt.block === 'h1'} onClick={() => block('h1')}>H1</FmtBtn>
                    <FmtBtn label="Heading 2" on={fmt.block === 'h2'} onClick={() => block('h2')}>H2</FmtBtn>
                    <span className="pad__sep" />
                    <FmtBtn label="Checklist" cls="pad__fmtBtn--icon" on={fmt.todo} onClick={checklist}>
                      <Icon name="checkbox" active={fmt.todo} />
                    </FmtBtn>
                    <FmtBtn label="Quote" on={fmt.block === 'blockquote'} onClick={() => block('blockquote')}>Quote</FmtBtn>
                  </FormatBar>
                )}
              </AnimatePresence>
              <div className="pad__spacer" />
              <m.button type="button" className="pad__copy" onClick={copyAll} {...presets.press('button')}>
                <span className="pad__copyIcon">
                  <AnimatePresence mode="popLayout" initial={false}>
                    <m.span key={copied ? 'check' : 'copy'} className="pad__copyGlyph" variants={COPY_ICON} initial="initial" animate="animate" exit="exit">
                      <Icon name={copied ? 'check' : 'copy'} />
                    </m.span>
                  </AnimatePresence>
                </span>
                <span>Copy all</span>
              </m.button>
            </div>
          </main>
        </div>
      </m.div>
    </LayoutGroup>
  )
}

/**
 * The voice note's words, resolving over the (transparent) editor text with
 * the editor's own metrics. Reports once when the last word has landed.
 */
function RevealOverlay({ text, delay, hold, onDone }: {
  text: string; delay: number; hold: boolean; onDone: () => void
}): React.JSX.Element {
  const started = useRef(0)
  const done = useRef(onDone)
  done.current = onDone
  useEffect(() => {
    if (hold) return
    started.current = performance.now()
    // Backstop: the spec's own bound (last word by dur.signature) plus one standard fade.
    const t = setTimeout(() => done.current(), DUR_MS.signature + DUR_MS.base)
    return () => clearTimeout(t)
  }, [hold])
  // A settle sooner than one word's fade is a cancelled run (remount), not the reveal finishing.
  const settled = (): void => {
    if (performance.now() - started.current >= WORD_VARIANTS.body.opacity * 1000) done.current()
  }
  return (
    <div className="pad__doc pad__reveal" aria-hidden="true">
      <BlurWords as="div" variant="body" userContent text={text} delay={delay} total={DUR.signature} hold={hold} onSettled={settled} />
    </div>
  )
}

/** Overflow is clipped only while a real width is animating, so pills can fly and focus rings show at rest. */
function useClip(fresh: boolean): { present: boolean; clip: boolean; done: (def: unknown) => void } {
  const present = useIsPresent()
  const [settled, setSettled] = useState(!fresh)
  return { present, clip: !present || !settled, done: (def) => { if (def === 'animate') setSettled(true) } }
}

/** Tab MiEje / BgUSI in a slot whose real width animates on open and close. */
function Tab({ title, on, fresh, dep, pill, onSettled, onSelect, onClose }: {
  title: string; on: boolean; fresh: boolean; dep: unknown; pill: Transition
  onSettled: () => void; onSelect: () => void; onClose: () => void
}): React.JSX.Element {
  const { present, clip, done } = useClip(fresh)
  return (
    <m.div
      className="pad__tabSlot"
      inert={!present}
      style={{ overflow: clip ? 'hidden' : 'visible', pointerEvents: present ? undefined : 'none' }}
      variants={TAB}
      initial="initial"
      animate="animate"
      exit="exit"
      onAnimationComplete={(def) => { done(def); if (def === 'animate') onSettled() }}
    >
      <button type="button" className={`pad__tab ${on ? 'is-active' : ''}`} onClick={onSelect}>
        {/* A tab still growing keeps its own pill: a shared one would be measured at width 0. */}
        {on && present && (clip
          ? <span className="pad__tabPill pad__tabPill--static" aria-hidden="true" />
          : <Indicator layoutId="pad-tab" className="pad__tabPill" dependency={dep} transition={pill} />)}
        {on && <span className="pad__tabDot" />}
        <span className="pad__tabLabel">{title}</span>
        <span
          className="pad__tabClose"
          role="button"
          aria-label="Close tab"
          onClick={(e) => { e.stopPropagation(); onClose() }}
        >
          <Icon name="close" />
        </span>
      </button>
    </m.div>
  )
}

/** Notes jKD4h: the pane's real width collapses; its content fades. */
function NotesPane({ fresh, children }: { fresh: boolean; children: React.ReactNode }): React.JSX.Element {
  const { present, clip, done } = useClip(fresh)
  return (
    <m.div
      className="pad__notesSlot"
      inert={!present}
      style={{ overflow: clip ? 'hidden' : 'visible', pointerEvents: present ? undefined : 'none' }}
      variants={SIDEBAR}
      initial="initial"
      animate="animate"
      exit="exit"
      onAnimationComplete={done}
    >
      <aside className="pad__notes">
        <m.div className="pad__notesInner" variants={SIDEBAR_CONTENT} initial="initial" animate="animate" exit="exit">
          {children}
        </m.div>
      </aside>
    </m.div>
  )
}

/** Note zmk5K. Rows keep their place with `layout="position"`; the active fill is a shared indicator. */
function NoteRow({ title, time, on, custom, listKey, dep, pill, onSettled, onOpen, onDelete, ref }: {
  title: string; time: string; on: boolean; custom: RowCustom; listKey: string; dep: unknown; pill: Transition
  onSettled: () => void; onOpen: () => void; onDelete: () => void; ref?: React.Ref<HTMLDivElement>
}): React.JSX.Element {
  const present = useIsPresent()
  return (
    <m.div
      ref={ref}
      className={`pad__note ${on ? 'is-active' : ''}`}
      inert={!present}
      style={present ? undefined : { pointerEvents: 'none' }}
      layout={custom.instant ? false : 'position'}
      layoutDependency={listKey}
      transition={{ layout: SPRING.ui }}
      variants={NOTE_ROW}
      custom={custom}
      initial="initial"
      animate="animate"
      exit="exit"
      onAnimationComplete={(def) => { if (def === 'animate') onSettled() }}
      onClick={onOpen}
    >
      {on && present && <Indicator layoutId="pad-note-active" className="pad__notePill" radius={8} dependency={dep} transition={pill} />}
      <div className="pad__noteText">
        <div className="pad__noteTitle">{title}</div>
        <div className="pad__noteTime">{time}</div>
      </div>
      <button
        type="button"
        className="pad__noteDel"
        aria-label="Delete note"
        title="Delete note"
        onClick={(e) => { e.stopPropagation(); onDelete() }}
      >
        <Icon name="trash" />
      </button>
    </m.div>
  )
}

/** Transforms menu (Menu I8sEup) above the footer: popover rules (§4.11), origin at its trigger. */
function TransformsMenu({ items, onRun, onAdd }: {
  items: Transform[]; onRun: (t: Transform) => void; onAdd: () => void
}): React.JSX.Element {
  const inert = useExitInert()
  return (
    <m.div
      className="pad__menu"
      role="menu"
      aria-label="Transforms"
      inert={inert.inert}
      style={inert.style}
      variants={presets.popover('bottom')}
      initial="initial"
      animate="animate"
      exit="exit"
    >
      {items.length ? items.map((t) => (
        <button
          key={t.id}
          type="button"
          role="menuitem"
          className="pad__menuItem"
          title={t.description}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onRun(t)}
        >
          <Icon name="wand" />
          <span className="pad__menuLabel">{t.name}</span>
        </button>
      )) : (
        <button type="button" role="menuitem" className="pad__menuItem" onClick={onAdd}>
          <Icon name="plus" />
          <span className="pad__menuLabel">Add a transform</span>
        </button>
      )}
    </m.div>
  )
}

/** Format Bar ifu2l: shows and hides with the popover rules (§4.11). */
function FormatBar({ children }: { children: React.ReactNode }): React.JSX.Element {
  const inert = useExitInert()
  return (
    <m.div
      className="pad__fmt"
      role="toolbar"
      aria-label="Formatting"
      inert={inert.inert}
      style={inert.style}
      variants={presets.popover('bottom')}
      initial="initial"
      animate="animate"
      exit="exit"
    >
      {children}
    </m.div>
  )
}

/** A Format Bar button. Mousedown is swallowed so the editor keeps its selection. */
function FmtBtn({ on, label, cls, onClick, children }: {
  on?: boolean; label: string; cls?: string; onClick: () => void; children: React.ReactNode
}): React.JSX.Element {
  return (
    <m.button
      type="button"
      className={['pad__fmtBtn', cls, on && 'is-on'].filter(Boolean).join(' ')}
      aria-label={label}
      aria-pressed={!!on}
      title={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      {...presets.press('icon')}
    >
      {children}
    </m.button>
  )
}

function countWords(text: string): number {
  const t = text.trim()
  return t ? t.split(/\s+/).length : 0
}

/** "just now", "2 min ago", "3 h ago", "2 days ago". */
function ago(ts: number): string {
  const m = Math.floor((Date.now() - ts) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h ago`
  return days(ts)
}

function days(ts: number): string {
  const start = new Date(); start.setHours(0, 0, 0, 0)
  const d = Math.ceil((start.getTime() - ts) / 86_400_000)
  if (d <= 0) return 'Today'
  if (d === 1) return 'Yesterday'
  if (d < 7) return `${d} days ago`
  if (d < 30) { const w = Math.floor(d / 7); return `${w} ${w === 1 ? 'week' : 'weeks'} ago` }
  return new Date(ts).toLocaleDateString()
}

/** Notes list: "Today · 2 min ago", otherwise "2 days ago". */
function listTime(ts: number): string {
  const d = days(ts)
  return d === 'Today' ? `Today · ${ago(ts)}` : d
}

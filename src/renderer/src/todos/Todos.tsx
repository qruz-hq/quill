import { useEffect, useRef, useState } from 'react'
import { FlowMark, TrashIcon } from '../shared/icons'
import DatePicker from './DatePicker'

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

/** "Today", "Tomorrow", "Yesterday", a weekday inside a week, else "Sep 28". */
function fmtDue(due: string): { label: string; overdue: boolean } {
  const [y, m, d] = due.split('-').map(Number)
  const date = new Date(y, m - 1, d)
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

const CalDot = (): React.JSX.Element => <span className="chip__dot" title="On your calendar" />

/** Splits `@Quill release: fix it` into its dimmed prefix and the task. */
const splitTitle = (title: string): [string, string] => {
  const m = /^(@[^:]+:\s*)(.*)$/s.exec(title)
  return m ? [m[1], m[2]] : ['', title]
}

const CalIcon = (): React.JSX.Element => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" />
  </svg>
)
const CheckIcon = (): React.JSX.Element => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
)
const GripIcon = (): React.JSX.Element => (
  <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" /></svg>
)
const ChevronIcon = ({ open }: { open: boolean }): React.JSX.Element => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: open ? undefined : 'rotate(-90deg)' }}><path d="m6 9 6 6 6-6" /></svg>
)
const PinIcon = (): React.JSX.Element => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 17v5M9 3h6l-1 7 3 3H7l3-3z" /></svg>
)
const PlusIcon = (): React.JSX.Element => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
)
const FolderIcon = (): React.JSX.Element => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.2 3.9A2 2 0 0 0 7.5 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" /></svg>
)
const DoneRingIcon = (): React.JSX.Element => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="m8.5 12 2.5 2.5 4.5-5" /></svg>
)

export default function Todos(): React.JSX.Element {
  const [items, setItems] = useState<Todo[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [pinned, setPinned] = useState(false)
  const [showDone, setShowDone] = useState(false)

  const refresh = (list: Todo[]): void => {
    setItems(list)
    void window.flow.todos.projects().then(setProjects)
  }
  useEffect(() => {
    void window.flow.todos.list().then(refresh as never)
    void window.flow.todos.collapsed().then((c) => setCollapsed(new Set(c)))
    void window.flow.todos.pinned().then(setPinned)
    return window.flow.todos.onChanged(refresh as never)
  }, [])

  const open = items.filter((t) => !t.done)
  const done = items.filter((t) => t.done)
  const unassigned = open.filter((t) => !t.project)

  const toggleCollapse = async (name: string): Promise<void> => {
    const next = await window.flow.todos.collapse(name, !collapsed.has(name.toLowerCase()))
    setCollapsed(new Set(next))
  }
  const togglePin = async (): Promise<void> => setPinned(await window.flow.todos.pin(!pinned))

  return (
    <div className="todos">
      <header className="todos__bar">
        <FlowMark size={15} className="todos__mark" />
        <div className="todos__title">
          Todos
          {open.length > 0 && <span className="todos__count">{open.length}</span>}
        </div>
        <button
          className={`todos__icon ${pinned ? 'is-on' : ''}`}
          title={pinned ? 'Unpin — closes when the cursor leaves' : 'Pin — stays open'}
          onClick={() => void togglePin()}
        >
          <PinIcon />
        </button>
        <button className="todos__icon" aria-label="Close" onClick={() => window.flow.todos.close()}>×</button>
      </header>

      <div className="todos__body">
        <Composer projects={projects} />
        {open.length === 0 && done.length === 0 && (
          <div className="empty">
            <DoneRingIcon />
            <p>Nothing to do. Add one above, or rest the cursor on the left edge whenever something comes up.</p>
          </div>
        )}
        <Group items={unassigned} />
        {projects.filter((p) => p.count > 0).map((p) => {
          const isCollapsed = collapsed.has(p.name.toLowerCase())
          return (
            <div key={p.name} className="project">
              <button className="project__head" onClick={() => void toggleCollapse(p.name)}>
                <ChevronIcon open={!isCollapsed} />
                <span className="project__name">{p.name}</span>
                <span className="project__count">{p.count}</span>
              </button>
              {!isCollapsed && <Group items={open.filter((t) => t.project?.toLowerCase() === p.name.toLowerCase())} />}
            </div>
          )
        })}
        {done.length > 0 && (
          <>
            <div className="done-head">
              <button className="done-head__toggle" onClick={() => setShowDone((v) => !v)}>
                <ChevronIcon open={showDone} /> Completed ({done.length})
              </button>
              <button className="done-head__clear" onClick={() => void window.flow.todos.clearDone()}>Clear</button>
            </div>
            {showDone && done.map((t) => <Item key={t.id} todo={t} />)}
          </>
        )}
      </div>
    </div>
  )
}

/** A single line until focused, then it grows a description and a date. */
function Composer({ projects }: { projects: Project[] }): React.JSX.Element {
  const [openState, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [desc, setDesc] = useState('')
  const [due, setDue] = useState<string | null>(null)
  const [time, setTime] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [acIndex, setAcIndex] = useState(0)
  const titleRef = useRef<HTMLInputElement>(null)
  const chipRef = useRef<HTMLButtonElement>(null)

  useEffect(() => { if (openState) titleRef.current?.focus() }, [openState])

  // Autocomplete is live while the title is `@` + a fragment with no colon yet.
  const frag = /^@([^:]*)$/.exec(title)?.[1] ?? null
  const matches = frag === null ? [] : projects.filter((p) => p.name.toLowerCase().includes(frag.toLowerCase()))
  const canCreate = frag !== null && frag.trim().length > 0 && !projects.some((p) => p.name.toLowerCase() === frag.trim().toLowerCase())
  const acRows = frag === null ? 0 : matches.length + (canCreate ? 1 : 0)
  useEffect(() => { setAcIndex(0) }, [frag])

  const accept = (name: string): void => {
    setTitle(`@${name}: `)
    titleRef.current?.focus()
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
    titleRef.current?.focus()
  }

  if (!openState) {
    return (
      <button className="composer" onClick={() => setOpen(true)}>
        <PlusIcon /> Add a todo
      </button>
    )
  }
  const f = due ? fmtDue(due) : null
  return (
    <div className="composer--open">
      <input
        ref={titleRef}
        className="composer__title"
        placeholder="What needs doing?  Start with @project: to group it"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
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
      {acRows > 0 && (
        <div className="ac">
          {matches.map((p, i) => {
            const at = p.name.toLowerCase().indexOf(frag!.toLowerCase())
            return (
              <button
                key={p.name}
                className={`ac__row ${i === acIndex ? 'is-hi' : ''}`}
                onMouseEnter={() => setAcIndex(i)}
                onMouseDown={(e) => { e.preventDefault(); accept(p.name) }}
              >
                <FolderIcon />
                <span className="ac__name">
                  {p.name.slice(0, at)}<b>{p.name.slice(at, at + frag!.length)}</b>{p.name.slice(at + frag!.length)}
                </span>
                {p.count > 0 && <span className="ac__count">{p.count}</span>}
              </button>
            )
          })}
          {canCreate && (
            <>
              {matches.length > 0 && <div className="ac__sep" />}
              <button
                className={`ac__row ac__row--create ${acIndex === matches.length ? 'is-hi' : ''}`}
                onMouseEnter={() => setAcIndex(matches.length)}
                onMouseDown={(e) => { e.preventDefault(); accept(frag!.trim()) }}
              >
                <PlusIcon /> Create “{frag!.trim()}”
              </button>
            </>
          )}
        </div>
      )}
      <textarea
        className="composer__desc"
        placeholder="Add a description…"
        rows={1}
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') reset() }}
      />
      <div className="composer__foot">
        <button
          ref={chipRef}
          className={`chip chip--pick ${f?.overdue ? 'chip--overdue' : ''} ${!f ? 'chip--empty' : ''}`}
          onClick={() => setPicking((v) => !v)}
        >
          {f ? <CalIcon /> : <PlusIcon />}
          {f ? chipLabel(due!, time) : 'date'}
        </button>
        <div className="btns">
          <button className="btn btn--ghost" onClick={reset}>Cancel</button>
          <button className="btn btn--dark" disabled={!title.trim()} onClick={() => void submit()}>Add</button>
        </div>
      </div>
      {picking && chipRef.current && (
        <DatePicker anchor={chipRef.current} value={due} time={time} onChange={(d, t) => { setDue(d); setTime(t) }} onClose={() => setPicking(false)} />
      )}
    </div>
  )
}

/**
 * HTML5 drag and drop within one group. Order is global in the store, so a
 * move is expressed as "put the dragged id where the target id sits" over the
 * full open list; the grouped display re-derives from that.
 */
function Group({ items }: { items: Todo[] }): React.JSX.Element {
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)

  const drop = async (targetId: string): Promise<void> => {
    const from = dragId
    setDragId(null); setOverId(null)
    if (!from || from === targetId) return
    const all = (await window.flow.todos.list()) as Todo[]
    const ids = all.filter((t) => !t.done).map((t) => t.id)
    ids.splice(ids.indexOf(from), 1)
    ids.splice(ids.indexOf(targetId), 0, from)
    void window.flow.todos.reorder(ids)
  }

  return (
    <>
      {items.map((t) => (
        <Item
          key={t.id}
          todo={t}
          dragging={dragId === t.id}
          over={overId === t.id && dragId !== t.id}
          onDragStart={() => setDragId(t.id)}
          onDragOver={(e) => { e.preventDefault(); setOverId(t.id) }}
          onDrop={() => void drop(t.id)}
          onDragEnd={() => { setDragId(null); setOverId(null) }}
        />
      ))}
    </>
  )
}

function Item({ todo, dragging, over, onDragStart, onDragOver, onDrop, onDragEnd }: {
  todo: Todo
  dragging?: boolean
  over?: boolean
  onDragStart?: () => void
  onDragOver?: (e: React.DragEvent) => void
  onDrop?: () => void
  onDragEnd?: () => void
}): React.JSX.Element {
  const [picking, setPicking] = useState(false)
  const chipRef = useRef<HTMLButtonElement>(null)
  const f = todo.due ? fmtDue(todo.due) : null
  const [prefix, task] = splitTitle(todo.title)
  const draggable = !todo.done
  return (
    <div
      className={`item ${todo.done ? 'is-done' : ''} ${dragging ? 'is-dragging' : ''} ${over ? 'is-over' : ''}`}
      draggable={draggable}
      onDragStart={draggable ? onDragStart : undefined}
      onDragOver={draggable ? onDragOver : undefined}
      onDrop={draggable ? onDrop : undefined}
      onDragEnd={draggable ? onDragEnd : undefined}
    >
      <span className="item__grip" aria-hidden><GripIcon /></span>
      <button
        className={`check ${todo.done ? 'is-on' : ''}`}
        aria-label={todo.done ? 'Mark as not done' : 'Mark as done'}
        onClick={() => void window.flow.todos.update(todo.id, { done: !todo.done })}
      >
        {todo.done && <CheckIcon />}
      </button>
      <div className="item__text">
        <div className="item__title">
          {prefix && <span className="item__prefix">{prefix}</span>}{task}
        </div>
        {todo.description && !todo.done && <div className="item__desc">{todo.description}</div>}
        {!todo.done && (
          <div className="item__meta">
            <button
              ref={chipRef}
              className={`chip chip--pick ${f?.overdue ? 'chip--overdue' : ''} ${!f ? 'chip--empty chip--hover' : ''}`}
              onClick={() => setPicking((v) => !v)}
            >
              {f ? <CalIcon /> : <PlusIcon />}
              {f ? chipLabel(todo.due!, todo.time) : 'date'}
              {f && todo.eventId && <CalDot />}
            </button>
          </div>
        )}
      </div>
      <button className="item__del" aria-label="Delete" onClick={() => void window.flow.todos.remove(todo.id)}>
        <TrashIcon />
      </button>
      {picking && chipRef.current && (
        <DatePicker
          anchor={chipRef.current}
          value={todo.due}
          time={todo.time}
          onChange={(d, t) => void window.flow.todos.update(todo.id, { due: d, time: t })}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  )
}

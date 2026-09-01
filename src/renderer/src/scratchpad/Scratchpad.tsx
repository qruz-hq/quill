import { useCallback, useEffect, useRef, useState } from 'react'
import { FlowMark, SidebarIcon, NoteIcon, SearchIcon, WandIcon, CopyIcon, TrashIcon } from '../shared/icons'

type Note = { id: string; title: string; body: string; createdAt: number; updatedAt: number }

const AUTOSAVE_MS = 500

export default function Scratchpad(): React.JSX.Element {
  const [notes, setNotes] = useState<Note[]>([])
  const [openIds, setOpenIds] = useState<string[]>([])     // tab strip
  const [activeId, setActiveId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [showFormat, setShowFormat] = useState(false)
  const [query, setQuery] = useState('')
  const editor = useRef<HTMLDivElement>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const active = notes.find((n) => n.id === activeId) ?? null

  useEffect(() => {
    void (async () => {
      const list = (await window.flow.notes.list()) as Note[]
      setNotes(list)
      const first = list[0] ?? ((await window.flow.notes.create()) as Note)
      setOpenIds([first.id])
      setActiveId(first.id)
      if (!list.length) setNotes([first])
    })()
    return window.flow.notes.onChanged((n) => setNotes(n as Note[]))
  }, [])

  // Load the active note into the editor without clobbering what's being typed.
  useEffect(() => {
    if (editor.current && active && editor.current.dataset.loaded !== active.id) {
      editor.current.innerHTML = active.body
      editor.current.dataset.loaded = active.id
    }
  }, [active])

  const scheduleSave = useCallback(() => {
    if (!activeId || !editor.current) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    const body = editor.current.innerHTML
    saveTimer.current = setTimeout(() => {
      void window.flow.notes.update(activeId, { body })
    }, AUTOSAVE_MS)
  }, [activeId])

  const newNote = async (): Promise<void> => {
    const n = (await window.flow.notes.create()) as Note
    setNotes((prev) => [n, ...prev])
    setOpenIds((prev) => [...prev, n.id])
    setActiveId(n.id)
    if (editor.current) { editor.current.innerHTML = ''; editor.current.dataset.loaded = n.id }
    editor.current?.focus()
  }

  const openNote = (id: string): void => {
    setOpenIds((prev) => (prev.includes(id) ? prev : [...prev, id]))
    setActiveId(id)
  }

  const closeTab = (id: string): void => {
    setOpenIds((prev) => {
      const next = prev.filter((x) => x !== id)
      if (activeId === id) setActiveId(next[next.length - 1] ?? null)
      if (!next.length) window.flow.pad.close()
      return next
    })
  }

  const cmd = (c: string, arg?: string): void => {
    editor.current?.focus()
    document.execCommand(c, false, arg)
    scheduleSave()
  }

  const copyAll = (): void => {
    const text = editor.current?.innerText ?? ''
    void navigator.clipboard.writeText(text)
  }

  const visible = query
    ? notes.filter((n) => (n.title + n.body).toLowerCase().includes(query.toLowerCase()))
    : notes

  return (
    <div className="pad">
      <header className="pad__bar">
        <FlowMark size={15} className="pad__mark" />
        <div className="pad__tabs">
          {openIds.map((id) => {
            const n = notes.find((x) => x.id === id)
            return (
              <button
                key={id}
                className={`tab ${id === activeId ? 'is-active' : ''}`}
                onClick={() => setActiveId(id)}
              >
                <span className="tab__label">{n?.title?.trim() || 'Untitled'}</span>
                <span className="tab__x" onClick={(e) => { e.stopPropagation(); closeTab(id) }}>×</span>
              </button>
            )
          })}
          <button className="tab tab--add" onClick={() => void newNote()} aria-label="New tab">+</button>
        </div>
        <button className="pad__icon" onClick={() => window.flow.pad.expand()} aria-label="Expand">⤢</button>
        <button className="pad__icon" onClick={() => window.flow.pad.close()} aria-label="Close">×</button>
      </header>

      <div className="pad__body">
        {!collapsed && (
          <aside className="pad__side">
            <button className="side__item" onClick={() => setCollapsed(true)}>
              <SidebarIcon /> <span>Collapse Notes</span>
            </button>
            <button className="side__item" onClick={() => void newNote()}>
              <NoteIcon /> <span>New note</span>
            </button>
            <div className="side__search">
              <SearchIcon />
              <input
                placeholder="Search notes…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>

            <div className="side__list">
              {visible.map((n) => (
                <div
                  key={n.id}
                  className={`side__note ${n.id === activeId ? 'is-active' : ''}`}
                  onClick={() => openNote(n.id)}
                >
                  <div className="side__noteTitle">{n.title?.trim() || 'Untitled'}</div>
                  <div className="side__noteTime">{ago(n.updatedAt)}</div>
                  <button
                    className="side__del"
                    aria-label="Delete note"
                    onClick={async (e) => {
                      e.stopPropagation()
                      setNotes((await window.flow.notes.remove(n.id)) as Note[])
                      closeTab(n.id)
                    }}
                  >
                    <TrashIcon />
                  </button>
                </div>
              ))}
            </div>

            <button className="side__item side__item--foot"><WandIcon /> <span>Transforms</span></button>
            <button
              className={`side__item side__item--foot ${showFormat ? 'is-active' : ''}`}
              onClick={() => setShowFormat((f) => !f)}
            >
              <span className="side__aa">AA</span> <span>Formatting</span>
            </button>
          </aside>
        )}

        <main className="pad__main">
          {collapsed && (
            <button className="pad__expandSide" onClick={() => setCollapsed(false)} aria-label="Show notes">
              <SidebarIcon />
            </button>
          )}
          <div
            ref={editor}
            className="pad__editor"
            contentEditable
            suppressContentEditableWarning
            data-placeholder="fn to dictate"
            onInput={scheduleSave}
            onBlur={scheduleSave}
          />
          <button className="pad__copy" onClick={copyAll}><CopyIcon /> Copy</button>

          {showFormat && (
            <div className="fmt">
              <button onClick={() => cmd('bold')}><b>B</b></button>
              <button onClick={() => cmd('italic')}><i>I</i></button>
              <button onClick={() => cmd('underline')}><u>U</u></button>
              <button onClick={() => cmd('formatBlock', 'pre')}>{'<>'}</button>
              <span className="fmt__sep" />
              <button onClick={() => cmd('insertUnorderedList')}>•≡</button>
              <button onClick={() => cmd('insertOrderedList')}>1≡</button>
              <button onClick={() => cmd('insertHTML', '<ul class="todo"><li>&nbsp;</li></ul>')}>✓≡</button>
              <span className="fmt__sep" />
              <button onClick={() => cmd('formatBlock', 'blockquote')}>❞</button>
              <button onClick={() => cmd('indent')}>≻≡</button>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

function ago(ts: number): string {
  const d = Math.floor((Date.now() - ts) / 86_400_000)
  if (d === 0) return 'Today'
  if (d === 1) return 'Yesterday'
  if (d < 30) return `${d} days ago`
  return new Date(ts).toLocaleDateString()
}

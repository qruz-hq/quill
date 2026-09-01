import { useEffect, useState } from 'react'
import { SearchIcon, TrashIcon, NoteIcon } from '../shared/icons'

type Note = { id: string; title: string; body: string; createdAt: number; updatedAt: number }

/** Body is stored as editor HTML; the card shows a plain-text preview. */
function preview(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

export default function ScratchpadScreen(): React.JSX.Element {
  const [notes, setNotes] = useState<Note[]>([])
  const [q, setQ] = useState('')
  const [searching, setSearching] = useState(false)

  const refresh = (): void => { void window.flow.notes.list().then(setNotes as never) }
  useEffect(() => {
    refresh()
    return window.flow.notes.onChanged((n) => setNotes(n as Note[]))
  }, [])

  const shown = q
    ? notes.filter((n) => (n.title + preview(n.body)).toLowerCase().includes(q.toLowerCase()))
    : notes

  const newNote = async (): Promise<void> => {
    await window.flow.notes.create()
    window.flow.pad.open()
  }

  return (
    <div className="screen">
      <header className="screen__head">
        <h1 className="screen__title">Scratchpad <span className="badge">Beta</span></h1>
        <span className="keyhint">
          <span className="keycap">⌥ Opt</span> <span className="keycap">S</span> to open
        </span>
      </header>

      <section className="promo promo--pad">
        <div className="promo__art promo__art--pad" aria-hidden />
        <div className="promo__body">
          <h2 className="promo__title">Somewhere to put a thought</h2>
          <p className="promo__sub">
            A note that is always one keystroke away. Dictate into it, keep it, come back to it.
          </p>
          <button className="promo__cta promo__cta--snip" onClick={() => void newNote()}>
            Start new note
          </button>
        </div>
        <div className="padmock" aria-hidden>
          <div className="padmock__bar">
            <span className="padmock__dot" /><span className="padmock__tab">Untitled</span><span>+</span>
          </div>
          <div className="padmock__body">
            <span className="padmock__line" /><span className="padmock__line padmock__line--short" />
            <span className="padmock__line" />
          </div>
        </div>
      </section>

      <div className="listhead">
        <span className="listhead__label">Recents</span>
        <div className="listhead__tools">
          {searching && (
            <input
              className="listhead__search"
              autoFocus
              placeholder="Search notes"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onBlur={() => { if (!q) setSearching(false) }}
            />
          )}
          <button className="iconbtn" aria-label="Search notes" onClick={() => setSearching((v) => !v)}>
            <SearchIcon />
          </button>
          <button className="iconbtn" aria-label="New note" onClick={() => void newNote()}>+</button>
        </div>
      </div>

      <div className="notecards">
        {shown.map((n) => {
          const text = preview(n.body)
          return (
            <article key={n.id} className="notecard" onClick={() => window.flow.pad.open()}>
              <h3 className="notecard__title">{n.title?.trim() || 'Untitled'}</h3>
              {text && <p className="notecard__preview">{text}</p>}
              <footer className="notecard__foot">
                <span>{new Date(n.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                <span>{new Date(n.updatedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
              </footer>
              <button
                className="iconbtn notecard__del"
                aria-label="Delete note"
                onClick={async (e) => { e.stopPropagation(); setNotes((await window.flow.notes.remove(n.id)) as Note[]) }}
              >
                <TrashIcon />
              </button>
            </article>
          )
        })}
        {!shown.length && (
          <div className="notecards__empty">
            <NoteIcon />
            <p>{q ? 'No notes match that search.' : 'No notes yet — start one above, or press ⌥S anywhere.'}</p>
          </div>
        )}
      </div>
    </div>
  )
}

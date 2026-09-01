import { useEffect, useState } from 'react'
import { SearchIcon, TrashIcon } from '../shared/icons'

type Snippet = { id: string; trigger: string; expansion: string; enabled: boolean }


export default function SnippetsScreen(): React.JSX.Element {
  const [items, setItems] = useState<Snippet[]>([])
  const [editing, setEditing] = useState<Snippet | null>(null)
  const [q, setQ] = useState('')

  useEffect(() => { void window.flow.snippets.list().then(setItems as never) }, [])

  const shown = q
    ? items.filter((s) => (s.trigger + s.expansion).toLowerCase().includes(q.toLowerCase()))
    : items

  return (
    <div className="screen">
      <header className="screen__head">
        <h1 className="screen__title">Snippets</h1>
        <button
          className="btn btn--dark"
          onClick={() => setEditing({ id: '', trigger: '', expansion: '', enabled: true })}
        >
          Add new
        </button>
      </header>

      <section className="promo promo--snip">
        <div className="promo__art promo__art--snip" aria-hidden />
        <div className="promo__body">
          <h2 className="promo__title">Say it short, <em>write it long</em></h2>
          <p className="promo__sub">
            Give a phrase you use often a spoken trigger, and say the trigger instead.
          </p>
        </div>
      </section>

      <div className="listhead">
        <span className="listhead__label">All snippets</span>
        <div className="searchinline">
          <SearchIcon />
          <input placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      <ul className="rowlist">
        {shown.map((s) => (
          <li key={s.id} className="rowlist__row" onClick={() => setEditing(s)}>
            <span className="rowlist__trigger">{s.trigger}</span>
            <span className="rowlist__arrow">→</span>
            <span className="rowlist__body">{s.expansion}</span>
            <button
              className="iconbtn rowlist__del"
              aria-label="Delete"
              onClick={async (e) => { e.stopPropagation(); setItems((await window.flow.snippets.remove(s.id)) as Snippet[]) }}
            >
              <TrashIcon />
            </button>
          </li>
        ))}
        {!shown.length && <li className="rowlist__empty">No snippets yet.</li>}
      </ul>

      {editing && (
        <Editor
          snippet={editing}
          onClose={() => setEditing(null)}
          onSave={async (s) => { setItems((await window.flow.snippets.save(s)) as Snippet[]); setEditing(null) }}
        />
      )}
    </div>
  )
}

function Editor({ snippet, onClose, onSave }: {
  snippet: Snippet; onClose: () => void; onSave: (s: Snippet) => void
}): React.JSX.Element {
  const [trigger, setTrigger] = useState(snippet.trigger)
  const [expansion, setExpansion] = useState(snippet.expansion)

  return (
    <>
      <div className="sheet__scrim" onClick={onClose} />
      <div className="dialog">
        <h3 className="dialog__title">{snippet.id ? 'Edit snippet' : 'New snippet'}</h3>
        <label className="field">
          <span>When I say</span>
          <input value={trigger} onChange={(e) => setTrigger(e.target.value)} placeholder="my email address" autoFocus />
        </label>
        <label className="field">
          <span>Type this</span>
          <textarea rows={5} value={expansion} onChange={(e) => setExpansion(e.target.value)} placeholder="you@example.com" />
        </label>
        <div className="dialog__foot">
          <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn btn--dark"
            disabled={!trigger.trim() || !expansion.trim()}
            onClick={() => onSave({ ...snippet, trigger: trigger.trim(), expansion })}
          >
            Save
          </button>
        </div>
      </div>
    </>
  )
}

import { useEffect, useState } from 'react'
import { TrashIcon } from '../shared/icons'

type Kind = 'template' | 'bullets' | 'join' | 'case'
type Transform = { id: string; name: string; description: string; slot: number; kind: Kind; config: string }

const SAMPLE = 'we need to pick up milk, eggs, bread and butter'

const KINDS: { id: Kind; label: string; hint: string }[] = [
  { id: 'template', label: 'Template',        hint: 'Wrap the text — use {text} for where it goes' },
  { id: 'bullets',  label: 'Bullet list',     hint: 'Split a spoken list into bullets' },
  { id: 'join',     label: 'Single paragraph', hint: 'Collapse line breaks into prose' },
  { id: 'case',     label: 'Change case',     hint: 'upper, lower or title' }
]

export default function TransformsScreen(): React.JSX.Element {
  const [items, setItems] = useState<Transform[]>([])
  const [editing, setEditing] = useState<Transform | null>(null)

  useEffect(() => { void window.flow.transforms.list().then(setItems as never) }, [])

  return (
    <div className="screen">
      <header className="screen__head">
        <h1 className="screen__title">Transforms <span className="badge">Beta</span></h1>
        <span className="keyhint">
          <span className="keycap">⌥ Opt</span> <span className="keycap">1–9</span> to apply
        </span>
      </header>

      <section className="promo promo--tf">
        <div className="promo__art promo__art--tf" aria-hidden />
        <div className="promo__body">
          <h2 className="promo__title">Reshape it after you say it</h2>
          <p className="promo__sub">
            Press <b>⌥</b> and a number to restructure the last thing you dictated.
          </p>
        </div>
      </section>

      <div className="listhead"><span className="listhead__label">My transforms</span></div>

      <div className="tfgrid">
        {items.map((t) => (
          <button key={t.id} className="tfcard" onClick={() => setEditing(t)}>
            <span className="tfcard__slot"><span className="keycap">⌥ {t.slot}</span></span>
            <span className="tfcard__name">{t.name}</span>
            <span className="tfcard__desc">{t.description}</span>
            <span
              className="iconbtn tfcard__del"
              role="button"
              aria-label="Delete"
              onClick={async (e) => { e.stopPropagation(); setItems((await window.flow.transforms.remove(t.id)) as Transform[]) }}
            >
              <TrashIcon />
            </span>
          </button>
        ))}
        <button
          className="tfcard tfcard--new"
          onClick={() => setEditing({ id: '', name: '', description: '', slot: items.length + 1, kind: 'template', config: '{text}' })}
        >
          <span className="tfcard__plus">+</span>
          <span className="tfcard__name">Create your own</span>
          <span className="tfcard__desc">Write a template or pick a rule</span>
        </button>
      </div>

      {editing && (
        <Editor
          transform={editing}
          onClose={() => setEditing(null)}
          onSave={async (t) => { setItems((await window.flow.transforms.save(t)) as Transform[]); setEditing(null) }}
        />
      )}
    </div>
  )
}

function Editor({ transform, onClose, onSave }: {
  transform: Transform; onClose: () => void; onSave: (t: Transform) => void
}): React.JSX.Element {
  const [t, setT] = useState(transform)
  const [preview, setPreview] = useState('')

  // Preview needs a saved transform, so only existing ones can show one.
  useEffect(() => {
    if (!t.id) { setPreview(''); return }
    void window.flow.transforms.preview(t.id, SAMPLE).then(setPreview as never)
  }, [t.id])

  const set = (patch: Partial<Transform>): void => setT((x) => ({ ...x, ...patch }))
  const kind = KINDS.find((k) => k.id === t.kind)!

  return (
    <>
      <div className="sheet__scrim" onClick={onClose} />
      <div className="dialog dialog--wide">
        <h3 className="dialog__title">{t.id ? 'Edit transform' : 'New transform'}</h3>

        <div className="field2">
          <label className="field">
            <span>Name</span>
            <input value={t.name} onChange={(e) => set({ name: e.target.value })} placeholder="Prompt Engineer" autoFocus />
          </label>
          <label className="field field--slot">
            <span>Shortcut</span>
            <select value={t.slot} onChange={(e) => set({ slot: Number(e.target.value) })}>
              {[1,2,3,4,5,6,7,8,9].map((n) => <option key={n} value={n}>⌥ {n}</option>)}
            </select>
          </label>
        </div>

        <label className="field">
          <span>Description</span>
          <input value={t.description} onChange={(e) => set({ description: e.target.value })} placeholder="What it does" />
        </label>

        <label className="field">
          <span>Rule</span>
          <select value={t.kind} onChange={(e) => set({ kind: e.target.value as Kind })}>
            {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
          </select>
          <small className="field__hint">{kind.hint}</small>
        </label>

        {t.kind === 'template' && (
          <label className="field">
            <span>Template</span>
            <textarea rows={5} value={t.config} onChange={(e) => set({ config: e.target.value })} />
          </label>
        )}
        {t.kind === 'case' && (
          <label className="field">
            <span>Style</span>
            <select value={t.config || 'title'} onChange={(e) => set({ config: e.target.value })}>
              <option value="title">Title Case</option>
              <option value="upper">UPPERCASE</option>
              <option value="lower">lowercase</option>
            </select>
          </label>
        )}

        {preview && (
          <div className="preview">
            <div className="preview__label">Preview</div>
            <div className="preview__in">{SAMPLE}</div>
            <div className="preview__out">{preview}</div>
          </div>
        )}

        <div className="dialog__foot">
          <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn--dark" disabled={!t.name.trim()} onClick={() => onSave(t)}>Save</button>
        </div>
      </div>
    </>
  )
}

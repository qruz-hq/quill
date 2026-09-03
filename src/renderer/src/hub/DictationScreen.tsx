import { useEffect, useRef, useState } from 'react'
import {
  SearchIcon, PlayIcon, CopyIcon, FlagIcon, EllipsisIcon,
  UndoIcon, RetryIcon, TrashIcon, AudioFileIcon
} from '../shared/icons'
import { VOICE_PROFILE } from '../shared/fixtures'

type Row = { id: string; text: string; at: number; words: number; durationMs: number }

export default function DictationScreen(): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
  const [stats, setStats] = useState({ totalWords: 0, wpm: 0, streak: 0 })
  const [toast, setToast] = useState<string | null>(null)
  const [name, setName] = useState('')

  const refresh = (): void => {
    void window.flow.dictations.list().then(setRows as never)
    void window.flow.dictations.insights().then((i: Record<string, number>) =>
      setStats({ totalWords: i.totalWords, wpm: i.wpm, streak: i.streak }))
  }

  // History is persisted, so it survives a restart; new dictations push in live.
  useEffect(() => {
    refresh()
    void window.flow.system.user().then((u) => setName(u.name))
    return window.flow.dictations.onAdded(() => refresh())
  }, [])

  const copy = (text: string): void => {
    navigator.clipboard.writeText(text)
    setToast('You can also paste your last transcript with ^ Ctrl + ⌘ Cmd + v')
  }

  return (
    <div className="dictation">
      <div className="dictation__main">
        <h1 className="greeting">Welcome back{name ? `, ${name}` : ''}</h1>

        <section className="promo">
          <div className="promo__art" aria-hidden />
          <div className="promo__body">
            <h2 className="promo__title">Everything you say, <em>already written</em></h2>
            <p className="promo__sub">Hold fn anywhere and speak. Nothing leaves this Mac.</p>
            <div className="promo__ctaWrap">
              <button className="promo__cta">Start now</button>
              <span className="promo__dot" aria-hidden />
            </div>
          </div>
        </section>

        {groupByDay(rows).map(([label, group]) => (
          <section key={label}>
            <div className="listhead">
              <span className="listhead__label">{label}</span>
              {label === groupByDay(rows)[0][0] && (
                <button className="iconbtn" aria-label="Search transcripts"><SearchIcon /></button>
              )}
            </div>
            <ul className="translist">
              {group.map((row) => (
                <TranscriptRow
                  key={row.id}
                  row={row}
                  onCopy={() => copy(row.text)}
                  onDelete={async () => setRows((await window.flow.dictations.remove(row.id)) as Row[])}
                />
              ))}
            </ul>
          </section>
        ))}
        {!rows.length && <p className="rowlist__empty">Nothing dictated yet — hold fn and speak.</p>}
      </div>

      <aside className="rail">
        <div className="rail__card">
          <div className="stat"><span className="stat__num">{stats.totalWords.toLocaleString()}</span><span className="stat__label">total words</span></div>
          <div className="stat"><span className="stat__num">{stats.wpm}</span><span className="stat__label">wpm</span></div>
          <div className="stat"><span className="stat__num">{stats.streak}</span><span className="stat__label">day streak</span></div>
        </div>
        <div className="rail__card rail__card--profile">
          <div>
            <div className="profile__title">{VOICE_PROFILE.title}</div>
            <div className="profile__name">{VOICE_PROFILE.name}</div>
          </div>
          <div className="profile__avatar" aria-hidden />
        </div>
      </aside>

      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  )
}

/** Groups rows under Today / Yesterday / a date, newest group first. */
function groupByDay(rows: Row[]): [string, Row[]][] {
  const out = new Map<string, Row[]>()
  const today = new Date().toDateString()
  const yest = new Date(Date.now() - 86_400_000).toDateString()
  for (const r of rows) {
    const d = new Date(r.at).toDateString()
    const label = d === today ? 'Today' : d === yest ? 'Yesterday'
      : new Date(r.at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    if (!out.has(label)) out.set(label, [])
    out.get(label)!.push(r)
  }
  return [...out.entries()]
}

function TranscriptRow({ row, onCopy, onDelete }: {
  row: Row; onCopy: () => void; onDelete: () => void
}): React.JSX.Element {
  const [menu, setMenu] = useState(false)

  return (
    <li className={`trow ${menu ? 'is-open' : ''}`}>
      <button className="trow__hit" onClick={onCopy}>
        <span className="trow__time">
          {new Date(row.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).toLowerCase()}
        </span>
        <span className="trow__text">{row.text}</span>
      </button>

      <div className="trow__actions">
        <button className="iconbtn" aria-label="Play"><PlayIcon /></button>
        <button className="iconbtn" aria-label="Copy" onClick={onCopy}><CopyIcon /></button>
        <button className="iconbtn" aria-label="Flag"><FlagIcon /></button>
        <button
          className="iconbtn"
          aria-label="More actions"
          onClick={() => setMenu((m) => !m)}
        >
          <EllipsisIcon />
        </button>
      </div>

      {menu && (
        <>
          <div className="menu__scrim" onClick={() => setMenu(false)} />
          <div className="menu">
            <button className="menu__item"><UndoIcon /> Undo AI edit</button>
            <button className="menu__item"><RetryIcon /> Retry transcript</button>
            <button className="menu__item menu__item--danger" onClick={() => { onDelete(); setMenu(false) }}>
              <TrashIcon /> Delete transcript
            </button>
            <button className="menu__item"><AudioFileIcon /> Extract audio</button>
          </div>
        </>
      )}
    </li>
  )
}

function Toast({ message, onDone }: { message: string; onDone: () => void }): React.JSX.Element {
  const done = useRef(onDone)
  done.current = onDone
  useEffect(() => {
    const t = setTimeout(() => done.current(), 4000)
    return () => clearTimeout(t)
  }, [message])

  return (
    <div className="toast" role="status">
      <span className="toast__check" aria-hidden>✓</span>
      <span>{message}</span>
    </div>
  )
}

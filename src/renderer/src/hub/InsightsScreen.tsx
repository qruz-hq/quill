import { useEffect, useMemo, useState } from 'react'

type Insights = {
  totalWords: number
  totalDictations: number
  wpm: number
  streak: number
  longestStreak: number
  byDay: Record<string, number>
  topWords: { word: string; count: number }[]
  busiestHour: number | null
  avgWordsPerDictation: number
}

const WEEKS = 26

export default function InsightsScreen(): React.JSX.Element {
  const [d, setD] = useState<Insights | null>(null)
  useEffect(() => {
    void window.flow.dictations.insights().then(setD as never)
    return window.flow.dictations.onAdded(() => {
      void window.flow.dictations.insights().then(setD as never)
    })
  }, [])

  if (!d) return <div className="screen"><h1 className="screen__title">Insights</h1></div>

  return (
    <div className="screen">
      <header className="screen__head"><h1 className="screen__title">Insights</h1></header>

      <div className="insgrid">
        <div className="inscard">
          <div className="inscard__num">{d.wpm}</div>
          <div className="inscard__label">Words per minute</div>
          <Gauge value={d.wpm} max={200} />
        </div>

        <div className="inscard">
          <div className="inscard__num">{d.totalWords.toLocaleString()}</div>
          <div className="inscard__label">Total words dictated</div>
          <div className="inscard__rows">
            <div><b>{d.totalDictations.toLocaleString()}</b> dictations</div>
            <div><b>{d.avgWordsPerDictation}</b> words each on average</div>
          </div>
        </div>

        <div className="inscard">
          <div className="inscard__num">{d.streak}</div>
          <div className="inscard__label">Day streak</div>
          <div className="inscard__rows">
            <div>Longest <b>{d.longestStreak}</b> days</div>
            {d.busiestHour !== null && <div>Busiest around <b>{fmtHour(d.busiestHour)}</b></div>}
          </div>
        </div>
      </div>

      <div className="insrow">
        <section className="insbox">
          <header className="insbox__head">
            <h2 className="insbox__title">Most used words</h2>
          </header>
          {d.topWords.length ? (
            <ul className="wordbars">
              {d.topWords.map((w, i) => (
                <li key={w.word}>
                  <span className="wordbars__w">{w.word}</span>
                  <span className="wordbars__track">
                    <span
                      className="wordbars__fill"
                      style={{ width: `${(w.count / d.topWords[0].count) * 100}%`, opacity: 1 - i * 0.05 }}
                    />
                  </span>
                  <span className="wordbars__n">{w.count}</span>
                </li>
              ))}
            </ul>
          ) : <p className="rowlist__empty">Not enough dictation yet.</p>}
        </section>

        <section className="insbox">
          <header className="insbox__head">
            <h2 className="insbox__title">{d.streak} day streak</h2>
            <span className="insbox__meta">Longest | {d.longestStreak} days</span>
          </header>
          <Heatmap byDay={d.byDay} />
        </section>
      </div>
    </div>
  )
}

/** Semicircular arc, matching the gauge on the real Insights page. */
function Gauge({ value, max }: { value: number; max: number }): React.JSX.Element {
  const pct = Math.max(0, Math.min(1, value / max))
  const R = 46, C = Math.PI * R
  return (
    <svg className="gauge" viewBox="0 0 120 66" aria-hidden>
      <path d="M14 60 A46 46 0 0 1 106 60" fill="none" stroke="var(--sand-600)" strokeWidth="11" strokeLinecap="round" />
      <path
        d="M14 60 A46 46 0 0 1 106 60"
        fill="none" stroke="var(--fathom-800)" strokeWidth="11" strokeLinecap="round"
        strokeDasharray={`${pct * C} ${C}`}
      />
    </svg>
  )
}

/** GitHub-style contribution grid: a column per week, a row per weekday. */
function Heatmap({ byDay }: { byDay: Record<string, number> }): React.JSX.Element {
  const { weeks, months, max } = useMemo(() => {
    const end = new Date()
    end.setHours(0, 0, 0, 0)
    // Wind back to the most recent Saturday so columns are whole weeks.
    end.setDate(end.getDate() + (6 - end.getDay()))

    const cells: { key: string; v: number; date: Date }[] = []
    for (let i = WEEKS * 7 - 1; i >= 0; i--) {
      const dt = new Date(end)
      dt.setDate(end.getDate() - i)
      const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
      cells.push({ key, v: byDay[key] ?? 0, date: dt })
    }
    const weeks: (typeof cells)[] = []
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))

    const months: { label: string; col: number }[] = []
    weeks.forEach((w, i) => {
      const m = w[0].date.getMonth()
      if (i === 0 || m !== weeks[i - 1][0].date.getMonth()) {
        months.push({ label: w[0].date.toLocaleString(undefined, { month: 'short' }), col: i })
      }
    })
    return { weeks, months, max: Math.max(1, ...cells.map((c) => c.v)) }
  }, [byDay])

  const level = (v: number): number => {
    if (!v) return 0
    const r = v / max
    return r > 0.66 ? 4 : r > 0.33 ? 3 : r > 0.1 ? 2 : 1
  }

  return (
    <div className="heat">
      <div className="heat__months">
        {months.map((m) => (
          <span key={`${m.label}-${m.col}`} style={{ gridColumn: m.col + 1 }}>{m.label}</span>
        ))}
      </div>
      <div className="heat__grid">
        {weeks.map((w, i) => (
          <div key={i} className="heat__col">
            {w.map((c) => (
              <span
                key={c.key}
                className={`heat__cell heat__cell--${level(c.v)}`}
                title={`${c.key} · ${c.v} words`}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="heat__legend">
        <span>Less</span>
        {[0, 1, 2, 3, 4].map((l) => <span key={l} className={`heat__cell heat__cell--${l}`} />)}
        <span>More</span>
      </div>
    </div>
  )
}

function fmtHour(h: number): string {
  const am = h < 12
  const v = h % 12 === 0 ? 12 : h % 12
  return `${v} ${am ? 'am' : 'pm'}`
}

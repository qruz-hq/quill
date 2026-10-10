import { useMemo } from 'react'
import { m, type Variants } from 'motion/react'
import { Icon } from '../shared/icons'
import { TileTop, TileStat } from '../shared/ui'
import { SCALE, SPRING, STAGGER, STAGGER_CAP, staggerDelay } from '../shared/motion'
import { AFTER_ROW_MS, AT, Count, EntranceTile, streakSweep, useEntrance, useEntranceStep, useLagged } from './dictationMotion'

/* The four insight tiles of Hub, Dictation (vBtIm): Words today (DKicC),
   Words / min (O6MgzZ), Streak (k09rs) and Most used words (E6uv7B).
   Layout lives in dictation.css; DictationScreen places them in the rows.
   Numbers are BlurNumbers once the data is in: they never count up on mount,
   and only the digits that change move (docs/MOTION.md §3.4, §4.3.2). */

export type Insights = {
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

export function isoDay(ts: number | Date): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/* ---- Tile / Words today (DKicC) ---- */
export function WordsTodayTile({ d }: { d: Insights | null }): React.JSX.Element {
  const today = isoDay(Date.now())
  const words = d?.byDay[today] ?? 0
  // The daily average is taken over the other days that had any dictation.
  const others = d ? Object.entries(d.byDay).filter(([k, v]) => k !== today && v > 0).map(([, v]) => v) : []
  const avg = others.length ? others.reduce((a, b) => a + b, 0) / others.length : 0
  const pct = avg ? Math.round(((words - avg) / avg) * 100) : null
  const caption = pct === null
    ? 'words dictated today'
    : `${pct >= 0 ? '+' : '−'}${Math.abs(pct)}% on your daily average`

  return (
    <EntranceTile name="wordsToday" accent="tangerine" className="dict-words">
      <TileTop label="WORDS TODAY" icon="text" className="dict-words__top" />
      <TileStat value={d ? <Count value={words} /> : '0'} caption={caption} />
    </EntranceTile>
  )
}

/* ---- Tile / WPM (O6MgzZ) ---- */
const WPM_MAX = 200
/** Average typing speed the caption compares against. */
const TYPING_WPM = 40

export function WpmTile({ d }: { d: Insights | null }): React.JSX.Element {
  const wpm = d?.wpm ?? 0
  return (
    <EntranceTile name="wpm" accent="cyan" className="dict-wpm">
      <TileTop label="WORDS / MIN" icon="gauge" className="dict-wpm__top" />
      <div className="dict-wpm__bottom">
        <div className="dict-gauge">
          <GaugeArcs pct={wpm / WPM_MAX} />
          {d ? <Count className="dict-gauge__value" value={wpm} /> : <span className="dict-gauge__value">0</span>}
          <span className="dict-gauge__unit">of {WPM_MAX} wpm</span>
        </div>
        <span className="dict-wpm__caption">
          {wpm ? `${(wpm / TYPING_WPM).toFixed(1)}× faster than typing` : 'Dictate to measure your pace'}
        </span>
      </div>
    </EntranceTile>
  )
}

/* Track (w0Hpo): ellipse 132, innerRadius 0.84, startAngle -60, sweep 300.
   Value Arc (ckrPK): same ring, startAngle 240, sweep -(300 × pct).
   Pencil angles are counter-clockwise from 3 o'clock, so both arcs start at
   8 o'clock and run clockwise over the top. Drawn as a butt-capped stroke on
   the ring's centre line: r = 66 × (1 + 0.84) / 2, width = 66 × (1 − 0.84). */
const G = 66
const RING_R = (G * (1 + 0.84)) / 2      // 60.72
const RING_W = G * (1 - 0.84)            // 10.56
function pt(deg: number): string {
  const a = (deg * Math.PI) / 180
  return `${(G + RING_R * Math.cos(a)).toFixed(3)} ${(G - RING_R * Math.sin(a)).toFixed(3)}`
}
function arc(fromDeg: number, sweepCw: number): string {
  return `M ${pt(fromDeg)} A ${RING_R} ${RING_R} 0 ${sweepCw > 180 ? 1 : 0} 1 ${pt(fromDeg - sweepCw)}`
}
function GaugeArcs({ pct }: { pct: number }): React.JSX.Element {
  const sweep = 300 * Math.max(0, Math.min(1, pct))
  return (
    <svg className="dict-gauge__arcs" viewBox="0 0 132 132" aria-hidden>
      <path className="dict-gauge__track" d={arc(240, 300)} strokeWidth={RING_W} />
      {sweep > 0 && <path className="dict-gauge__fill" d={arc(240, sweep)} strokeWidth={RING_W} />}
    </svg>
  )
}

/* ---- Tile / Streak (k09rs) ---- */
const WEEKS = 30
/** First dictation of the day: today's cell pops in as its fill arrives. */
const TODAY_POP: Variants = {
  off: { scale: 1 },
  on: { scale: [SCALE.popSignature, 1], transition: SPRING.pop }
}

/** "LONGEST 21 DAYS" moves after the streak count it follows. */
function Longest({ value }: { value: number }): React.JSX.Element {
  return <Count value={useLagged(value, AFTER_ROW_MS.longest - AFTER_ROW_MS.counters)} />
}

export function StreakTile({ d }: { d: Insights | null }): React.JSX.Element {
  const sweep = useEntrance(streakSweep)
  const byDay = d?.byDay
  const today = isoDay(Date.now())
  const weeks = useMemo(() => {
    const end = new Date()
    end.setHours(0, 0, 0, 0)
    end.setDate(end.getDate() + (6 - end.getDay()))   // this week's Saturday
    const today = isoDay(Date.now())
    const vals: { key: string; v: number }[] = []
    for (let i = WEEKS * 7 - 1; i >= 0; i--) {
      const dt = new Date(end)
      dt.setDate(end.getDate() - i)
      const key = isoDay(dt)
      vals.push({ key, v: key > today ? 0 : byDay?.[key] ?? 0 })
    }
    const max = Math.max(1, ...vals.map((c) => c.v))
    const cells = vals.map((c) => ({ ...c, level: !c.v ? 0 : c.v / max > 0.66 ? 3 : c.v / max > 0.33 ? 2 : 1 }))
    const out: (typeof cells)[] = []
    for (let i = 0; i < cells.length; i += 7) out.push(cells.slice(i, i + 7))
    return out
  }, [byDay])

  const streak = d?.streak ?? 0
  return (
    <EntranceTile name="streak" className="dict-streak">
      <div className="dict-streak__top">
        <div className="dict-streak__title">
          <Icon name="flame" size={20} />
          <span className="dict-streak__value">{d ? <Count value={streak} /> : streak}-day streak</span>
        </div>
        <span className="dict-label dict-label--fg3">LONGEST {d ? <Longest value={d.longestStreak} /> : 0} DAYS</span>
      </div>
      <m.div className="dict-streak__grid" {...sweep}>
        {weeks.map((w, i) => (
          <div key={i} className="dict-streak__week">
            {w.map((c) => c.key === today ? (
              // Keyed on the data arriving, so a day that already has words never pops on load.
              <m.span
                key={d ? c.key : 'pending'}
                className={`dict-streak__day dict-streak__day--today dict-streak__day--${c.level}`}
                title={`${c.key} · ${c.v} words`}
                variants={TODAY_POP}
                initial={false}
                animate={c.level ? 'on' : 'off'}
              />
            ) : (
              <span key={c.key} className={`dict-streak__day dict-streak__day--${c.level}`} title={`${c.key} · ${c.v} words`} />
            ))}
          </div>
        ))}
      </m.div>
    </EntranceTile>
  )
}

/* ---- Tile / Most used words (E6uv7B) ---- */
/* In the design the top word's bar fills 196 of the 372 track (52.7%), and
   every other bar is in proportion to its count. */
const TOP_BAR = 196 / 372

/* "Bar": its real width grows (first entrance from t = 240, `stagger.tight`;
   later whenever the count changes), so the round cap never distorts. */
function Bar({ index, pct }: { index: number; pct: number }): React.JSX.Element {
  const { step, entering } = useEntranceStep()
  return (
    <m.span
      className="dict-most__bar"
      initial={entering ? { width: '0%' } : false}
      animate={{ width: step === 'initial' ? '0%' : `${pct}%` }}
      transition={{ ...SPRING.ui, delay: entering ? staggerDelay(index, STAGGER.tight, STAGGER_CAP.tight, AT.viz) : 0 }}
    />
  )
}

export function MostUsedTile({ d }: { d: Insights | null }): React.JSX.Element {
  const words = (d?.topWords ?? []).slice(0, 5)
  const top = words[0]?.count ?? 1
  const ranking = words.map((w) => w.word).join(' ')
  return (
    <EntranceTile name="mostUsed" className="dict-most">
      <div className="dict-most__top">
        <span className="dict-label">MOST USED WORDS</span>
      </div>
      {words.length ? (
        <div className="dict-most__list">
          {words.map((w, i) => (
            // A re-rank moves rows by position only; nothing in them is scaled.
            <m.div key={w.word} className="dict-most__row" layout="position" layoutDependency={ranking} transition={SPRING.ui}>
              <span className="dict-most__word">{w.word}</span>
              <span className="dict-most__track">
                <Bar index={i} pct={(w.count / top) * TOP_BAR * 100} />
              </span>
              <Count className="dict-most__count" value={w.count} />
            </m.div>
          ))}
        </div>
      ) : (
        <p className="dict-empty">Not enough dictation yet.</p>
      )}
    </EntranceTile>
  )
}

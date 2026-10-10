import { useState } from 'react'
import { Icon } from '../../shared/icons'
import { Badge, IconButton } from '../../shared/ui'
import { Toggle } from './controls'
import { LANGUAGES } from '../languages'
import { MonoLabel, PaneHeader, type PaneProps } from './shared'

/** The grid before you search: the twelve in "Languages" (xNum3), in its order. */
const FEATURED = ['en', 'fr', 'es', 'de', 'pt', 'it', 'nl', 'ja', 'ko', 'pl', 'sv', 'tr']
  .map((c) => LANGUAGES.find((l) => l.code === c)!)
  .filter(Boolean)
const FIRST = FEATURED.length
const chunk = <T,>(a: T[], n: number): T[][] => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n))

/**
 * Settings, Languages. The order of the selection matters: the first
 * language is used for live partials and as the fallback when detection fails.
 */
export default function LanguagesPane({ prefs, update }: PaneProps): React.JSX.Element {
  const [q, setQ] = useState('')
  const [drag, setDrag] = useState<number | null>(null)
  const selected = prefs?.languages ?? ['en']
  const auto = selected.includes('auto')
  const englishOnlyModel = prefs?.sttEngine !== 'cloud' && (prefs?.model ?? '').includes('.en')
  const needsMultilingual = englishOnlyModel && (auto || selected.some((c) => c !== 'en'))

  const set = (codes: string[]): void => void update({ languages: codes.length ? codes : ['en'] })   // never empty
  const toggle = (code: string): void => {
    set(selected.includes(code)
      ? selected.filter((c) => c !== code)
      : [...selected.filter((c) => c !== 'auto'), code])
  }
  const move = (from: number, to: number): void => {
    if (from === to) return
    const next = [...selected]
    const [x] = next.splice(from, 1)
    next.splice(to, 0, x)
    set(next)
  }

  const shown = q
    ? LANGUAGES.filter((l) => (l.name + l.native + l.code).toLowerCase().includes(q.toLowerCase()))
    : FEATURED
  const picked = auto ? [] : selected

  return (
    <div className="set-pane">
      <PaneHeader pane="languages" />
      <div className="set-body">
        <section className="set-tile set-langs">
          <div className="set-langs__toolbar">
            <label className="set-search">
              <Icon name="magnifier" className="set-search__icon" />
              <input
                className="set-search__input"
                placeholder="Search languages"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </label>
            <span className="set-auto">
              <span className="set-auto__label">Auto-detect</span>
              <Toggle label="Auto-detect" on={auto} disabled={!prefs} onChange={(v) => set(v ? ['auto'] : ['en'])} />
            </span>
          </div>

          {chunk(shown, 3).map((row, i) => (
            <div key={i} className={`set-langs__row ${auto ? 'is-dim' : ''}`}>
              {row.map((l) => {
                const on = !auto && selected.includes(l.code)
                return (
                  <button
                    key={l.code}
                    type="button"
                    className={`set-lang ${on ? 'is-on' : ''}`}
                    aria-pressed={on}
                    disabled={auto}
                    onClick={() => toggle(l.code)}
                  >
                    {on ? (
                      <span className="set-lang__head">
                        <span className="set-lang__name">{l.name}</span>
                        <Icon name="check" active className="set-lang__check" />
                      </span>
                    ) : (
                      <span className="set-lang__name">{l.name}</span>
                    )}
                    <span className="set-lang__native">{l.native || l.name}</span>
                  </button>
                )
              })}
              {/* keep the last row's cards at a third of the width */}
              {row.length < 3 && Array.from({ length: 3 - row.length }, (_, k) => <span key={k} className="set-lang set-lang--ghost" aria-hidden />)}
            </div>
          ))}
          {!shown.length && <p className="set-desc">No language matches “{q}”.</p>}

          <div className="set-langs__spacer" />
          <span className="set-hint">
            {q ? `${shown.length} of ${LANGUAGES.length} match` : `${FIRST} of ${LANGUAGES.length} shown · type to find the rest`}
          </span>
        </section>

        <section className="set-tile set-picked">
          <div className="set-picked__head">
            <MonoLabel>SELECTED</MonoLabel>
            <Badge>{auto ? 'auto' : picked.length}</Badge>
          </div>
          <div className="set-picked__list">
            {auto ? (
              <p className="set-desc">Detecting from all {LANGUAGES.length} languages.</p>
            ) : picked.map((code, i) => {
              const l = LANGUAGES.find((x) => x.code === code)
              return (
                <div
                  key={code}
                  className={`set-pick ${drag === i ? 'is-dragging' : ''}`}
                  draggable={picked.length > 1}
                  onDragStart={(e) => { setDrag(i); e.dataTransfer.effectAllowed = 'move' }}
                  onDragOver={(e) => { if (drag !== null) e.preventDefault() }}
                  onDrop={(e) => { e.preventDefault(); if (drag !== null) move(drag, i); setDrag(null) }}
                  onDragEnd={() => setDrag(null)}
                >
                  <Icon name="grip" className="set-pick__grip" />
                  <span className="set-pick__order">{i + 1}</span>
                  <span className="set-pick__text">
                    <span className="set-pick__name">{l?.name ?? code}</span>
                    <span className="set-pick__native">{l?.native || l?.name || code}</span>
                  </span>
                  <IconButton
                    icon="close"
                    label={`Remove ${l?.name ?? code}`}
                    className="set-pick__remove"
                    disabled={picked.length === 1}
                    onClick={() => toggle(code)}
                  />
                </div>
              )
            })}
          </div>
          <div className="set-picked__spacer" />
          {needsMultilingual && (
            <div className="set-notice set-notice--warn">
              <Icon name="warning" className="set-notice__icon" />
              <span className="set-notice__msg set-notice__msg--sm">
                The selected model is English-only. Pick a multilingual one under Speech models, or everything is transcribed as English.
              </span>
            </div>
          )}
          <div className="set-notice set-notice--cyan">
            <Icon name="info" className="set-notice__icon" />
            <span className="set-notice__msg set-notice__msg--sm">
              {picked.length > 1
                ? 'Drag to reorder. Quill only listens for the languages picked here.'
                : auto
                  ? 'Quill detects the language of each dictation.'
                  : 'Quill only listens for the languages picked here.'}
            </span>
          </div>
        </section>
      </div>
    </div>
  )
}

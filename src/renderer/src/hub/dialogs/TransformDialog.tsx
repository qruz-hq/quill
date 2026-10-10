import { useCallback, useId, useRef, useState } from 'react'
import { LayoutGroup, m, type Variants } from 'motion/react'
import { Icon } from '../../shared/icons'
import { Button, Keycap } from '../../shared/ui'
import { BlurStream, BlurWords, Indicator, RealHeight, SPRING, presets, tween } from '../../shared/motion'
import { DialogFrame, EscHint, useDialogSettled, type DialogMotion } from './DialogFrame'
import { FollowHeight, Press } from '../sniptfMotion'
import { SAMPLES, applyTransform, slotAccent, type Kind, type Transform } from '../transformPreview'
import './transform-dialog.css'

const SLOTS = 9

const KINDS: { id: Kind; label: string; hint: string }[] = [
  { id: 'template', label: 'Template',         hint: 'Wrap the text: use {text} for where it goes.' },
  { id: 'bullets',  label: 'Bullet list',      hint: 'Split a spoken list into bullets, no template needed.' },
  { id: 'join',     label: 'Single paragraph', hint: 'Collapse line breaks into prose, no template needed.' },
  { id: 'case',     label: 'Change case',      hint: 'Upper, lower or title case.' }
]

const CASES: { id: string; label: string }[] = [
  { id: 'title', label: 'Title Case' },
  { id: 'upper', label: 'UPPERCASE' },
  { id: 'lower', label: 'lowercase' }
]

/* Conditional field inside its RealHeight (§4.8): opacity dur.fast at t = 50 in,
   dur.micro out. The height springs come from RealHeight. */
const FIELD: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: tween('fast', 'out', 0.05) },
  exit: { opacity: 0, transition: tween('micro', 'exit') }
}

/**
 * Segmented control (XPl64): the selected fill is one text-free indicator that
 * moves between options with `spring.snappy` (§4.13).
 */
function Segmented<V extends string>({ label, value, options, onPick }: {
  label: string; value: V; options: { id: V; label: string }[]; onPick: (id: V) => void
}): React.JSX.Element {
  const group = useId()
  const settled = useDialogSettled()
  return (
    <div className="tfdlg__segmented" role="radiogroup" aria-label={label}>
      <LayoutGroup id={group}>
        {options.map((o) => {
          const on = o.id === value
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={on}
              className={`tfdlg__option${on ? ' is-selected' : ''}`}
              onClick={() => onPick(o.id)}
            >
              {on && (settled
                ? <Indicator layoutId="pick" className="tfdlg__option-ind" transition={SPRING.snappy} dependency={value} />
                : <span aria-hidden="true" className="tfdlg__option-ind tfdlg__option-ind--static" />)}
              <span className="tfdlg__option-label">{o.label}</span>
            </button>
          )
        })}
      </LayoutGroup>
    </div>
  )
}

/** What the hero's "Shortcut" line says the rule will do. */
function purpose(t: Transform): string {
  switch (t.kind) {
    case 'bullets': return 'to split your last dictation into bullets.'
    case 'join': return 'to collapse your last dictation into one paragraph.'
    case 'case': return 'to change the case of your last dictation.'
    case 'template': return `to turn your last dictation into ${t.name.trim().toLowerCase() || 'something new'}.`
  }
}

/** "Dialog, New transform" (ddCUn) and "Dialog, Edit transform" (OWYl9). */
export default function TransformDialog({ transform, taken, total, onClose, onSave, onDelete, motion }: {
  transform: Transform
  /** Slots used by the other transforms. */
  taken: number[]
  /** How many transforms exist now (for the "n of 9" caption). */
  total: number
  onClose: () => void
  onSave: (t: Transform) => void
  onDelete: (id: string) => void
  motion?: DialogMotion
}): React.JSX.Element {
  const [t, setT] = useState(transform)
  const set = (patch: Partial<Transform>): void => setT((x) => ({ ...x, ...patch }))
  const area = useRef<HTMLTextAreaElement>(null)
  const isEdit = !!transform.id
  // New transforms use the screen's tangerine; an existing one wears its slot's accent.
  const accent = isEdit ? slotAccent(t.slot) : 'tangerine'
  const kind = KINDS.find((k) => k.id === t.kind)!
  const free = Math.max(0, SLOTS - total)
  const sample = SAMPLES[t.kind]
  const save = useCallback(() => { if (t.name.trim()) onSave({ ...t, name: t.name.trim() }) }, [t, onSave])

  const insertToken = (): void => {
    const el = area.current
    const at = el ? el.selectionStart : t.config.length
    const end = el ? el.selectionEnd : at
    set({ config: t.config.slice(0, at) + '{text}' + t.config.slice(end) })
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at + 6, at + 6) })
  }

  const pickKind = (k: Kind): void => {
    if (k === t.kind) return
    set({ kind: k, config: k === 'template' ? (t.kind === 'template' ? t.config : '{text}') : k === 'case' ? 'title' : '' })
  }

  return (
    <DialogFrame
      accent={accent}
      wide
      label="TRANSFORMS"
      headline={isEdit ? 'Edit transform' : 'New transform'}
      lead={
        <div className="tfdlg__shortcut">
          <span className="tfdlg__shortcut-text">Press</span>
          <Keycap><BlurWords variant="label" text={`⌥ ${t.slot}`} /></Keycap>
          <span className="tfdlg__shortcut-text">{purpose(t)}</span>
        </div>
      }
      onClose={onClose}
      onSubmit={save}
      motion={motion}
      footer={<>
        {isEdit ? (
          <m.button type="button" className="tfdlg__delete" onClick={() => onDelete(transform.id)} {...presets.press('button')}>
            <Icon name="trash" size={16} />
            <span className="tfdlg__delete-label">Delete</span>
          </m.button>
        ) : <EscHint />}
        <div className="dlg__actions">
          <Press><Button variant="ghost" onClick={onClose}>Cancel</Button></Press>
          <Press>
            <Button className="dlg__save" disabled={!t.name.trim()} onClick={save}>
              {isEdit ? 'Save changes' : `Save to ⌥${t.slot}`}
            </Button>
          </Press>
        </div>
      </>}
    >
      <div className="tfdlg__identity">
        <div className="dlg__tile tfdlg__name">
          <label className="dlg__field">
            <span className="dlg__label">NAME</span>
            <span className="dlg__input">
              <input value={t.name} onChange={(e) => set({ name: e.target.value })} placeholder="Meeting notes" autoFocus />
            </span>
          </label>
          <label className="dlg__field">
            <span className="dlg__label">DESCRIPTION</span>
            <span className="dlg__input">
              <input value={t.description} onChange={(e) => set({ description: e.target.value })} placeholder="What it does" />
            </span>
          </label>
        </div>

        <div className="dlg__tile tfdlg__shortcut-tile" role="radiogroup" aria-label="Shortcut">
          <span className="dlg__label">SHORTCUT</span>
          <div className="tfdlg__slots">
            {[0, 1, 2].map((r) => (
              <div className="tfdlg__slot-row" key={r}>
                {[1, 2, 3].map((c) => {
                  const n = r * 3 + c
                  const state = n === t.slot ? 'selected' : taken.includes(n) ? 'taken' : 'free'
                  return (
                    <button
                      key={n}
                      type="button"
                      role="radio"
                      aria-checked={state === 'selected'}
                      disabled={state === 'taken'}
                      className={`tfdlg__slot tfdlg__slot--${state}`}
                      onClick={() => set({ slot: n })}
                    >
                      ⌥{n}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
          <span className="tfdlg__caption">
            {isEdit
              ? `Currently on ⌥${transform.slot} · ${free} of ${SLOTS} free`
              : `⌥${t.slot} is free · ${free} of ${SLOTS} left`}
          </span>
        </div>
      </div>

      <div className="dlg__tile tfdlg__rule">
        <div className="dlg__field">
          <span className="dlg__label">RULE</span>
          <Segmented label="Rule" value={t.kind} options={KINDS} onPick={pickKind} />
          <span className="dlg__hint">{kind.hint}</span>
        </div>

        <RealHeight open={t.kind === 'template'} content={FIELD}>
          <label className="dlg__field tfdlg__cond">
            <span className="dlg__label">TEMPLATE</span>
            <span className="tfdlg__textarea">
              <textarea
                ref={area}
                value={t.config}
                onChange={(e) => set({ config: e.target.value })}
                placeholder="Turn the following into meeting notes:"
              />
              <m.button type="button" className="tfdlg__token" onClick={insertToken} title="Insert {text} at the cursor" {...presets.press('button')}>
                {'{text}'}
              </m.button>
            </span>
          </label>
        </RealHeight>
        <RealHeight open={t.kind === 'case'} content={FIELD}>
          <div className="dlg__field tfdlg__cond">
            <span className="dlg__label">STYLE</span>
            <Segmented label="Style" value={t.config || 'title'} options={CASES} onPick={(id) => set({ config: id })} />
          </div>
        </RealHeight>
      </div>

      <div className="tfdlg__preview">
        <div className="dlg__top">
          <span className="tfdlg__preview-label">PREVIEW</span>
          <span className="tfdlg__sample">Sample dictation</span>
        </div>
        <div className="tfdlg__say">
          <Icon name="microphone" size={16} active className="tfdlg__say-icon" />
          <span className="tfdlg__in">{sample}</span>
        </div>
        {/* Result: only the words that changed reveal (stream variant); the
            block's real height follows. One stream per line keeps the breaks. */}
        <div className="tfdlg__types">
          <FollowHeight>
            <div className="tfdlg__out">
              {applyTransform(t, sample).split('\n').map((line, i) => line.trim()
                ? <BlurStream key={i} text={line} final initial={false} />
                : <div key={i} className="tfdlg__out-gap" />)}
            </div>
          </FollowHeight>
        </div>
      </div>
    </DialogFrame>
  )
}

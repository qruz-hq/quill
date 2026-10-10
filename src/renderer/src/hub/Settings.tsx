import { useEffect, useRef, useState } from 'react'
import { LayoutGroup, m } from 'motion/react'
import { Icon, AppMark } from '../shared/icons'
import { Bento } from '../shared/ui'
import { Indicator, PRESET, PresenceSwap } from '../shared/motion'
import { emitPrefs, onPrefs } from './shell/prefsBus'
import { PANES, type Pane, type Prefs } from './settings/shared'
import ShortcutsPane from './settings/ShortcutsPane'
import GeneralPane from './settings/GeneralPane'
import DictationPane from './settings/DictationPane'
import LanguagesPane from './settings/LanguagesPane'
import ModelsPane from './settings/ModelsPane'
import AiPane from './settings/AiPane'
import AboutPane from './settings/AboutPane'
import './settings.css'

export type { Pane } from './settings/shared'
export { pretty } from './settings/shared'

type UpdateState = { current: string; latest?: string; newer: boolean }

/**
 * Settings route: "Tile / Panes" rail beside the "Pane" column
 * (Settings, all frames in design.pen). Escape returns to the last screen.
 */
export default function Settings({ onClose, initialPane, paneRequest }: {
  onClose: () => void; initialPane?: Pane
  /** Bump to ask for `initialPane` again while Settings stays mounted (same pane twice in a row). */
  paneRequest?: number
}): React.JSX.Element {
  const [pane, setPaneState] = useState<Pane>(initialPane ?? 'shortcuts')
  // +1 when the new pane sits below the old one in the rail, -1 when above.
  const dir = useRef(1)
  const setPane = (next: Pane): void => {
    setPaneState((cur) => {
      const d = PANES.findIndex((p) => p.key === next) - PANES.findIndex((p) => p.key === cur)
      if (d) dir.current = Math.sign(d)
      return next
    })
  }
  const [updates, setUpdates] = useState<UpdateState | null>(null)
  const [prefs, setPrefs] = useState<Prefs | null>(null)

  useEffect(() => { void window.flow.settings.get().then(setPrefs) }, [])
  useEffect(() => { void window.flow.updates.check().then(setUpdates) }, [])

  const update = async (patch: Partial<Prefs>): Promise<void> => {
    setPrefs((p) => (p ? { ...p, ...patch } : p))   // optimistic
    const saved = await window.flow.settings.set(patch)
    setPrefs(saved)
    if ('micUid' in patch) emitPrefs({ micUid: saved.micUid })
  }

  // The title-bar mic picker writes micUid too.
  useEffect(() => onPrefs((p) => {
    if (p.micUid !== undefined) setPrefs((cur) => (cur ? { ...cur, micUid: p.micUid! } : cur))
  }), [])

  // App passes a new initialPane when a pane is asked for while Settings is open.
  useEffect(() => {
    if (initialPane) setPane(initialPane)
  }, [initialPane, paneRequest])

  // "Change model" on the Flow Bar error, and anything else that asks for a pane.
  useEffect(() => window.flow.hub.onOpenSettings((p) => {
    if (PANES.some((x) => x.key === p)) setPane(p)
  }), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // A key recorder or the permissions overlay handles its own Escape.
      if (e.key === 'Escape' && !e.defaultPrevented) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const props = { prefs, update }

  return (
    <Bento direction="horizontal" aria-label="Settings">
      <nav className="set-rail" aria-label="Settings panes">
        <div className="set-rail__head">
          <span className="set-mono">SETTINGS</span>
        </div>
        <LayoutGroup id="set-rail">
          {PANES.map(({ key, label, icon, accent }) => {
            const on = pane === key
            return (
              <m.button
                key={key}
                type="button"
                className={`set-item ${on ? `is-active set-accent--${accent}` : ''}`}
                aria-current={on ? 'page' : undefined}
                onClick={() => setPane(key)}
                {...PRESET.press('card')}
              >
                {on && <Indicator layoutId="pane-active" className="set-item__pill" dependency={pane} />}
                <span className="set-item__chip"><Icon name={icon} active={on} /></span>
                <span className="set-item__label">{label}</span>
              </m.button>
            )
          })}
        </LayoutGroup>
        <div className="set-rail__spacer" />
        <div className="set-rail__foot">
          <AppMark size={16} className="set-rail__mark" />
          <div className="set-rail__text">
            <span className="set-rail__version">Quill {updates?.current || '…'}</span>
            <span className="set-rail__status">
              {updates ? (updates.newer ? `${updates.latest} available` : 'Up to date') : 'Checking…'}
            </span>
          </div>
        </div>
      </nav>

      <PresenceSwap swapKey={pane} variants={PRESET.paneSwitch} custom={dir.current} className="set-swap">
        {pane === 'shortcuts' && <ShortcutsPane {...props} />}
        {pane === 'general'   && <GeneralPane {...props} onPane={setPane} />}
        {pane === 'dictation' && <DictationPane {...props} />}
        {pane === 'languages' && <LanguagesPane {...props} />}
        {pane === 'models'    && <ModelsPane {...props} />}
        {pane === 'ai'        && <AiPane {...props} />}
        {pane === 'about'     && <AboutPane {...props} updates={updates} onUpdates={setUpdates} />}
      </PresenceSwap>
    </Bento>
  )
}

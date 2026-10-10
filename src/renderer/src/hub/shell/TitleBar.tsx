import { LayoutGroup, m } from 'motion/react'
import { Icon, AppMark, type IconName } from '../../shared/icons'
import { Indicator, presets } from '../../shared/motion'
import MicPicker from './MicPicker'
import './titlebar.css'

export type Route = 'dictation' | 'snippets' | 'transforms' | 'settings'

const NAV: { key: Route; label: string; icon: IconName }[] = [
  { key: 'dictation',  label: 'Dictation',  icon: 'microphone' },
  { key: 'snippets',   label: 'Snippets',   icon: 'speech-bubble' },
  { key: 'transforms', label: 'Transforms', icon: 'wand' }
]
const SETTINGS = { key: 'settings' as const, label: 'Settings', icon: 'sliders' as IconName }

/** "Title Bar" (fc0Qi in Hub - Dictation): Left · Nav · Right. */
export default function TitleBar({ route, onNavigate, micMissing, onMicSettings }: {
  route: Route
  onNavigate: (r: Route) => void
  /** Microphone permission refused: the picker's level dot turns $error. */
  micMissing: boolean
  onMicSettings: () => void
}): React.JSX.Element {
  const item = ({ key, label, icon }: { key: Route; label: string; icon: IconName }): React.JSX.Element => {
    const on = route === key
    return (
      <m.button
        key={key}
        type="button"
        className={`tb-nav__item ${on ? 'is-active' : ''}`}
        aria-current={on ? 'page' : undefined}
        onClick={() => onNavigate(key)}
        {...presets.press('button')}
      >
        {/* The "Nav Item / Active" fill: one text-free pill that flies between items. */}
        {on && <Indicator layoutId="nav-active" dependency={route} className="tb-nav__pill" />}
        <Icon name={icon} active={on} />
        <span className="tb-nav__label">{label}</span>
      </m.button>
    )
  }

  return (
    <header className="tb">
      <div className="tb__left">
        {/* The native traffic lights draw over this box (trafficLightPosition in main). */}
        <div className="tb__lights" aria-hidden>
          <span className="tb__light" /><span className="tb__light" /><span className="tb__light" />
        </div>
        <div className="tb__brand">
          <AppMark size={20} active className="tb__mark" />
          <span className="tb__wordmark">Quill</span>
        </div>
      </div>

      <nav className="tb-nav" aria-label="Sections">
        <LayoutGroup id="nav">
          {NAV.map(item)}
          <span className="tb-nav__divider" aria-hidden />
          {item(SETTINGS)}
        </LayoutGroup>
      </nav>

      <div className="tb__right">
        <MicPicker micMissing={micMissing} onSettings={onMicSettings} />
      </div>
    </header>
  )
}

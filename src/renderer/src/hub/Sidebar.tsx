import {
  FlowMark, MicIcon, RecordIcon, ChartIcon, BookIcon, ScissorsIcon,
  TypeIcon, WandIcon, NoteIcon, GearIcon, HelpIcon, SidebarIcon
} from '../shared/icons'

export type NavKey =
  | 'dictation' | 'notetaker' | 'insights' | 'dictionary'
  | 'snippets' | 'style' | 'transforms' | 'scratchpad'

const NAV: { key: NavKey; label: string; Icon: typeof MicIcon }[] = [
  { key: 'dictation',  label: 'Dictation',  Icon: MicIcon },
  { key: 'notetaker',  label: 'Notetaker',  Icon: RecordIcon },
  { key: 'insights',   label: 'Insights',   Icon: ChartIcon },
  { key: 'dictionary', label: 'Dictionary', Icon: BookIcon },
  { key: 'snippets',   label: 'Snippets',   Icon: ScissorsIcon },
  { key: 'style',      label: 'Style',      Icon: TypeIcon },
  { key: 'transforms', label: 'Transforms', Icon: WandIcon },
  { key: 'scratchpad', label: 'Scratchpad', Icon: NoteIcon }
]

const FOOTER = [
  { label: 'Settings', Icon: GearIcon },
  { label: 'Help',     Icon: HelpIcon }
] as const

type Props = { active: NavKey; onNavigate: (k: NavKey) => void; onToggle: () => void; onSettings: () => void }

export default function Sidebar({ active, onNavigate, onToggle, onSettings }: Props): React.JSX.Element {
  return (
    <aside className="sidebar">
      <div className="sidebar__top">
        <button className="titlebar__icon" onClick={onToggle} aria-label="Collapse sidebar">
          <SidebarIcon />
        </button>
      </div>

      <div className="sidebar__brand">
        <FlowMark size={17} />
        <span className="sidebar__wordmark">Quill</span>
      </div>

      <nav className="sidebar__nav">
        {NAV.map(({ key, label, Icon }) => (
          <button
            key={key}
            className={`navitem ${active === key ? 'is-active' : ''}`}
            onClick={() => onNavigate(key)}
          >
            <Icon className="navitem__icon" />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar__footer">
        {FOOTER.map(({ label, Icon }) => (
          <button
            key={label}
            className="navitem navitem--sm"
            onClick={label === 'Settings' ? onSettings : undefined}
          >
            <Icon className="navitem__icon" />
            <span>{label}</span>
          </button>
        ))}
      </div>
    </aside>
  )
}

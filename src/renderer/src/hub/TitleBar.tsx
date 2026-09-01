import { SidebarIcon } from '../shared/icons'

export default function TitleBar({ onToggleSidebar }: { onToggleSidebar: () => void }): React.JSX.Element {
  return (
    <header className="titlebar">
      <button className="titlebar__icon titlebar__icon--left" onClick={onToggleSidebar} aria-label="Toggle sidebar">
        <SidebarIcon />
      </button>
      <div className="titlebar__spacer" />
    </header>
  )
}


import { useState } from 'react'
import Sidebar, { type NavKey } from './Sidebar'
import TitleBar from './TitleBar'
import DictationScreen from './DictationScreen'
import Settings from './Settings'
import SnippetsScreen from './SnippetsScreen'
import TransformsScreen from './TransformsScreen'
import InsightsScreen from './InsightsScreen'
import ScratchpadScreen from './ScratchpadScreen'

const TITLES: Record<Exclude<NavKey, 'dictation'>, string> = {
  notetaker: 'Notetaker',
  insights: 'Insights',
  dictionary: 'Dictionary',
  snippets: 'Snippets',
  style: 'Style',
  transforms: 'Transforms',
  scratchpad: 'Scratchpad'
}

export default function App(): React.JSX.Element {
  const [route, setRoute] = useState<NavKey>('dictation')
  const [collapsed, setCollapsed] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  return (
    <div className={`app ${collapsed ? 'app--collapsed' : ''}`}>
      <Sidebar
        active={route}
        onNavigate={setRoute}
        onToggle={() => setCollapsed((c) => !c)}
        onSettings={() => setSettingsOpen(true)}
      />
      <main className="content">
        <TitleBar onToggleSidebar={() => setCollapsed((c) => !c)} />
        <div className="content__card">
          {route === 'dictation'   && <DictationScreen />}
          {route === 'snippets'    && <SnippetsScreen />}
          {route === 'transforms'  && <TransformsScreen />}
          {route === 'insights'    && <InsightsScreen />}
          {route === 'scratchpad'  && <ScratchpadScreen />}
          {!['dictation', 'snippets', 'transforms', 'insights', 'scratchpad'].includes(route) && (
            <Placeholder title={TITLES[route as Exclude<NavKey, 'dictation'>]} />
          )}
        </div>
      </main>
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}

function Placeholder({ title }: { title: string }): React.JSX.Element {
  return (
    <div className="placeholder">
      <h1 className="page-title">{title}</h1>
      <p className="placeholder__note">Not in this pass — scope was Dictation + Flow Bar.</p>
    </div>
  )
}

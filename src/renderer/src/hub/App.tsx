import { useEffect, useRef, useState } from 'react'
import TitleBar, { type Route } from './shell/TitleBar'
import DictationScreen from './DictationScreen'
import Settings, { type Pane } from './Settings'
import SnippetsScreen from './SnippetsScreen'
import TransformsScreen from './TransformsScreen'
import Permissions from './Permissions'
import RouteSwitch, { focusRoute, routeDir } from './shell/RouteSwitch'
import ToastHost from './shell/Toast'
import PermissionBanner from './PermissionBanner'
import './shell/shell.css'

export default function App(): React.JSX.Element {
  // `dir` is the side the new route comes in from: +1 right, -1 left (nav order).
  const [{ route, dir }, setNav] = useState<{ route: Route; dir: number }>({ route: 'dictation', dir: 1 })
  const setRoute = (r: Route): void =>
    setNav((cur) => (cur.route === r ? cur : { route: r, dir: routeDir(cur.route, r) }))
  // Settings opens on this pane; each request bumps `n`, so asking for the
  // same pane twice still switches to it (Settings animates the switch).
  const [settingsPane, setSettingsPane] = useState<{ pane?: Pane; n: number }>({ n: 0 })
  const lastScreen = useRef<Exclude<Route, 'settings'>>('dictation')
  const [perms, setPerms] = useState<FlowPerms | null>(null)
  const [permsOpen, setPermsOpen] = useState(false)
  const [firstRun, setFirstRun] = useState(false)
  // Whether the setup screen opens at launch is known only once this resolves.
  const [setupChecked, setSetupChecked] = useState(false)
  const [toggleShortcut, setToggleShortcut] = useState('')
  const [axNudgeHidden, setAxNudgeHidden] = useState(false)

  const navigate = (r: Route): void => {
    if (r !== 'settings') lastScreen.current = r
    else if (route !== 'settings') setSettingsPane((s) => ({ pane: undefined, n: s.n + 1 }))
    setRoute(r)
  }
  const openSettings = (pane: Pane): void => {
    setSettingsPane((s) => ({ pane, n: s.n + 1 }))
    setRoute('settings')
  }

  // The Flow Bar's "Change model" (and anything else in main) asks for a
  // Settings pane. A hub created by that request was not listening yet.
  // While Settings is already open it switches pane itself (a re-mount here
  // would cut its pane switch short).
  const routeRef = useRef(route)
  routeRef.current = route
  useEffect(() => {
    void window.flow.hub.pendingSettings().then((pane) => { if (pane) openSettings(pane) })
    return window.flow.hub.onOpenSettings((pane) => { if (routeRef.current !== 'settings') openSettings(pane) })
  }, [])

  // First run shows the setup screen, unless everything is already in place
  // (an existing install: both grants and a speech model), in which case it
  // is just marked done.
  useEffect(() => {
    void Promise.all([
      window.flow.settings.get(), window.flow.perms.status(), window.flow.perms.pending(), window.flow.models.list()
    ]).then(([s, p, pending, list]) => {
      setPerms(p)
      setToggleShortcut(s.toggleShortcut)
      setSetupChecked(true)
      if (pending) { openPerms(); return }
      if (s.onboarded) return
      const models = list as { id: string; installed: boolean }[]
      const hasModel = s.sttEngine === 'cloud' || models.some((m) => m.id === s.model && m.installed)
      if (p.mic === 'granted' && p.ax && hasModel) { void window.flow.settings.set({ onboarded: true }); return }
      setFirstRun(true)
      setPermsOpen(true)
    })
    return window.flow.perms.onShow(() => { void window.flow.perms.pending(); openPerms() })
  }, [])

  // A grant can be withdrawn in System Settings at any time; re-check while
  // the window is in view so the banner appears without a restart.
  useEffect(() => {
    const poll = (): void => {
      if (document.visibilityState === 'visible') void window.flow.perms.status().then(setPerms)
    }
    const t = setInterval(poll, 4000)
    window.addEventListener('focus', poll)
    const off = window.flow.perms.onChanged(setPerms)
    return () => { clearInterval(t); window.removeEventListener('focus', poll); off() }
  }, [])

  // The shortcut named in the screen's note may have changed in Settings since.
  const openPerms = (): void => {
    void window.flow.settings.get().then((s) => setToggleShortcut(s.toggleShortcut))
    setPermsOpen(true)
  }

  const finishPerms = (): void => {
    setPermsOpen(false)
    if (firstRun) { setFirstRun(false); void window.flow.settings.set({ onboarded: true }) }
    void window.flow.perms.status().then(setPerms)
  }

  const micMissing = !!perms && perms.mic !== 'granted' && perms.mic !== 'unknown'

  return (
    <div className="shell">
      <TitleBar
        route={route}
        onNavigate={navigate}
        micMissing={micMissing}
        onMicSettings={() => { openSettings('dictation'); focusRoute() }}
      />

      {/* "Banner Slot" (ePPbx / FZG9v) sits between the title bar and the bento. */}
      <PermissionBanner
        perms={perms}
        suppressed={permsOpen || firstRun}
        axDismissed={axNudgeHidden}
        onFix={openPerms}
        onNotNow={() => setAxNudgeHidden(true)}
      />

      {/* Each screen renders its own <Bento> root. */}
      <RouteSwitch route={route} dir={dir}>
        {route === 'dictation'  && (
          <DictationScreen holdEntrance={!setupChecked || permsOpen} onOpenSettings={openSettings} />
        )}
        {route === 'snippets'   && <SnippetsScreen />}
        {route === 'transforms' && <TransformsScreen />}
        {route === 'settings'   && (
          <Settings
            initialPane={settingsPane.pane}
            paneRequest={settingsPane.n}
            onClose={() => setRoute(lastScreen.current)}
          />
        )}
      </RouteSwitch>

      {permsOpen && (
        <Permissions
          firstRun={firstRun}
          toggleShortcut={toggleShortcut}
          onDone={finishPerms}
          onOpenSettings={(pane) => { finishPerms(); openSettings(pane) }}
        />
      )}

      <ToastHost />
    </div>
  )
}


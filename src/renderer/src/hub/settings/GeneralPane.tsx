import { useEffect, useState } from 'react'
import { Icon } from '../../shared/icons'
import { Button, SettingsGroup, SettingsRow, StatusChip } from '../../shared/ui'
import { Toggle } from './controls'
import Permissions from '../Permissions'
import { MonoLabel, PaneHeader, type Pane, type PaneProps } from './shared'

/** Settings, General: rows, then the Permissions tile beside the cyan Todo edge tile. */
export default function GeneralPane({ prefs, update, onPane }: PaneProps & { onPane: (p: Pane) => void }): React.JSX.Element {
  const [perms, setPerms] = useState<FlowPerms | null>(null)
  const [review, setReview] = useState(false)

  useEffect(() => {
    const poll = (): void => void window.flow.perms.status().then(setPerms)
    poll()
    const t = setInterval(poll, 4000)
    const off = window.flow.perms.onChanged(setPerms)
    return () => { clearInterval(t); off() }
  }, [])

  const edgeOn = prefs?.todoEdge ?? true

  return (
    <div className="set-pane">
      <PaneHeader pane="general" />

      <SettingsGroup>
        <SettingsRow
          title="Open at login"
          desc="Starts Quill in the background when you log in, so the hotkey works without launching it first."
        >
          <Toggle label="Open at login" on={prefs?.launchAtLogin ?? false} disabled={!prefs} onChange={(v) => void update({ launchAtLogin: v })} />
        </SettingsRow>
        <SettingsRow
          title="Todos on the left edge"
          desc="Rest the cursor on the left edge of the screen for a moment to open your todo list. It closes when the cursor leaves."
        >
          <Toggle label="Todos on the left edge" on={edgeOn} disabled={!prefs} onChange={(v) => void update({ todoEdge: v })} />
        </SettingsRow>
        <SettingsRow title="Shortcuts" desc="Hold-to-talk and the global hotkeys are configured under Shortcuts.">
          <button type="button" className="q-pill" onClick={() => onPane('shortcuts')}>See Shortcuts</button>
        </SettingsRow>
      </SettingsGroup>

      <div className="set-row">
        <section className="set-tile set-perms">
          <div className="set-perms__top">
            <div className="set-perms__head">
              <h3 className="set-title3">Permissions</h3>
              <Button variant="ghost" className="set-btn32" onClick={() => setReview(true)}>Review</Button>
            </div>
            <p className="set-desc">Quill needs two permissions from macOS. This updates as soon as you grant them.</p>
          </div>
          <div className="set-perms__list">
            <div className="set-perm">
              <Icon name="microphone" className="set-perm__icon" />
              <span className="set-perm__label">Microphone</span>
              {!perms ? <StatusChip tone="checking">Checking…</StatusChip>
                : perms.mic === 'granted' || perms.mic === 'unknown' ? <StatusChip tone="granted">Allowed</StatusChip>
                  : perms.mic === 'not-determined' ? <StatusChip tone="checking">Not asked yet</StatusChip>
                    : <StatusChip tone="missing">Not allowed</StatusChip>}
            </div>
            <div className="set-perm">
              <Icon name="accessibility" className="set-perm__icon" />
              <span className="set-perm__label">Accessibility</span>
              {!perms ? <StatusChip tone="checking">Checking…</StatusChip>
                : perms.ax ? <StatusChip tone="granted">Allowed</StatusChip>
                  : <StatusChip tone="missing">Not allowed</StatusChip>}
            </div>
          </div>
        </section>

        <section className="set-tile set-edge set-accent--cyan">
          <div className="set-tile__top">
            <MonoLabel className="set-mono--ink">TODO EDGE</MonoLabel>
            <Icon name="checklist" size={20} />
          </div>
          <div className="set-edge__bottom">
            <span className="set-edge__value">{edgeOn ? 'Left edge' : 'Off'}</span>
            <span className="set-edge__caption">
              {edgeOn ? 'Opens your todo list. Move away and it closes.' : 'Switch it on above to open todos from the left edge.'}
            </span>
          </div>
        </section>
      </div>

      {review && (
        <Permissions
          firstRun={false}
          toggleShortcut={prefs?.toggleShortcut ?? ''}
          onDone={() => { setReview(false); void window.flow.perms.status().then(setPerms) }}
        />
      )}
    </div>
  )
}

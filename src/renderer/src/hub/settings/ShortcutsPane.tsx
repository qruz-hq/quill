import { useEffect, useRef, useState } from 'react'
import { Icon, type IconName } from '../../shared/icons'
import { Button } from '../../shared/ui'
import { Select } from './controls'
import { has, holdKeyFor, holdKeyOptions, isWayland, metaAccelerator, usePlatform } from '../../shared/platform'
import { Keycaps, PaneHeader, type PaneProps } from './shared'

/** Settings, Shortcuts: four tiles in two rows ("Row 1", "Row 2"). */
export default function ShortcutsPane({ prefs, update }: PaneProps): React.JSX.Element {
  const [failed, setFailed] = useState<string[]>([])
  useEffect(() => window.flow.shortcuts.onFailed(setFailed), [])
  const platform = usePlatform()
  // The keys this OS has, in its own names. Empty: no hold key here at all.
  const holdKeys = holdKeyOptions(platform)
  const off = holdKeys.find((h) => h.code === 0)
  // What the helper is listening for: a saved key that does not exist here
  // (fn off a Mac) reads as the first one that does, as it does in main.
  const hold = (prefs?.holdKey ?? 63) > 0 ? holdKeyFor(prefs?.holdKey, platform) ?? off : off
  const wayland = isWayland(platform)

  const bound = (key: 'toggleShortcut' | 'padShortcut' | 'noteShortcut'): React.JSX.Element => (
    <KeyRecorder
      value={prefs?.[key] ?? ''}
      failed={!!prefs?.[key] && failed.includes(prefs[key])}
      onChange={(v) => { setFailed((f) => f.filter((x) => x !== prefs?.[key])); void update({ [key]: v }) }}
    />
  )

  return (
    <div className="set-pane">
      <PaneHeader pane="shortcuts" />
      <div className="set-row">
        {hold ? (
          <ShortcutTile icon="fn-key" title="Hold to talk" desc={`${hold.note} Hold to dictate; double-tap to keep it listening.`}>
            <Select
              value={String(hold.code)}
              options={holdKeys.map((h) => ({ value: String(h.code), label: h.label }))}
              onChange={(v) => void update({ holdKey: Number(v) })}
              disabled={!prefs}
              label="Hold-to-talk key"
              className="set-fill"
            />
          </ShortcutTile>
        ) : (
          // No hold key on this system: the tile says so and points at the shortcut beside it.
          <ShortcutTile
            icon="fn-key"
            title="Hold to talk"
            desc={wayland
              ? 'On Wayland an app cannot watch the keyboard or type into other windows, so Quill starts and stops with the shortcut and copies the result for you to paste.'
              : has(platform, 'insert')
                ? 'There is no hold key on this system. Start and stop dictation with the shortcut instead.'
                : 'There is no hold key on this system. Start and stop dictation with the shortcut; the result is copied for you to paste.'}
          >
            <span className="set-desc">Not available here</span>
          </ShortcutTile>
        )}
        <ShortcutTile
          icon="microphone"
          title="Start / stop dictation"
          desc={has(platform, 'accessibility') ? 'Works without Accessibility permission.' : 'Press once to start, again to stop.'}
        >
          {bound('toggleShortcut')}
        </ShortcutTile>
      </div>
      <div className="set-row">
        <ShortcutTile icon="notepad" title="Open Scratchpad" desc="Floating notepad, always one keystroke away.">
          {bound('padShortcut')}
        </ShortcutTile>
        <ShortcutTile icon="note-plus" title="New voice note" desc="Records straight into a new Scratchpad note.">
          {bound('noteShortcut')}
        </ShortcutTile>
      </div>
    </div>
  )
}

function ShortcutTile({ icon, title, desc, children }: {
  icon: IconName; title: string; desc: string; children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="set-tile set-sc">
      <div className="set-sc__top">
        <span className="set-chip36"><Icon name={icon} size={20} /></span>
        <div className="set-text">
          <h3 className="set-title3">{title}</h3>
          <p className="set-desc">{desc}</p>
        </div>
      </div>
      <div className="set-sc__control">{children}</div>
    </section>
  )
}

/**
 * Keycaps + Change; while listening, the "Recorder" field + Cancel. Captures
 * a real combination (a modifier is required) in Electron accelerator form.
 */
function KeyRecorder({ value, failed, onChange }: {
  value: string; failed: boolean; onChange: (v: string) => void
}): React.JSX.Element {
  const { os } = usePlatform()
  const [listening, setListening] = useState(false)
  const field = useRef<HTMLDivElement>(null)
  useEffect(() => { if (listening) field.current?.focus() }, [listening])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') { setListening(false); return }
    if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return   // modifier alone

    const parts: string[] = []
    if (e.ctrlKey) parts.push('Control')
    if (e.altKey) parts.push('Alt')
    if (e.shiftKey) parts.push('Shift')
    if (e.metaKey) parts.push(metaAccelerator(os))   // Command on a Mac, Super (the Win key) elsewhere
    // A bare key would fire constantly while typing, so require a modifier.
    if (!parts.length) return

    const k = e.key.length === 1 ? e.key.toUpperCase() : e.key
    onChange([...parts, k].join('+'))
    setListening(false)
  }

  if (listening) {
    return (
      <>
        <div
          ref={field}
          className="set-recorder"
          tabIndex={0}
          role="textbox"
          aria-label="Press the new shortcut"
          onKeyDown={onKeyDown}
          onBlur={() => setListening(false)}
        >
          <span className="set-recorder__dot" />
          <span className="set-recorder__prompt">Press keys…</span>
          <span className="set-recorder__caret" />
        </div>
        {/* mousedown keeps focus in the field until the click lands */}
        <Button variant="ghost" onMouseDown={(e) => e.preventDefault()} onClick={() => setListening(false)}>Cancel</Button>
      </>
    )
  }

  return (
    <>
      {value ? <Keycaps accel={value} className="set-key" /> : <span className="set-desc">Not set</span>}
      <span className="set-sc__spacer">
        {failed && <span className="set-sc__failed">Taken by another app</span>}
      </span>
      <Button variant="ghost" className="set-btn32" onClick={() => setListening(true)}>
        {value ? 'Change' : 'Set'}
      </Button>
    </>
  )
}

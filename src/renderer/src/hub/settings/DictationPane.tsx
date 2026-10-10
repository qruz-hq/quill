import { useEffect, useState } from 'react'
import { Icon, type IconName } from '../../shared/icons'
import { Button } from '../../shared/ui'
import { SpectrumBars } from '../SpectrumBars'
import { Select, Toggle } from './controls'
import { has, usePlatform, words } from '../../shared/platform'
import { MonoLabel, PaneHeader, PROVIDER_NAME, STT_MODELS, type ModelRow, type PaneProps, type Prefs, type Update } from './shared'

type InputDevice = { id: number; uid: string; name: string; isDefault: boolean }

/** Name-based guess for the row glyph: the helper reports no transport. */
const glyphFor = (name: string): IconName =>
  /airpods|headphone|headset|buds|beats/i.test(name) ? 'headphones'
    : /usb|shure|yeti|rode|scarlett|focusrite|elgato/i.test(name) ? 'usb'
      : 'mic-input'

/** Settings, Dictation: Microphone tile (340) beside a column of tiles. */
export default function DictationPane({ prefs, update }: PaneProps): React.JSX.Element {
  const platform = usePlatform()
  // Without `insert` (Wayland) the result goes to the clipboard, not into the app.
  const typed = has(platform, 'insert')
  return (
    <div className="set-pane">
      <PaneHeader pane="dictation" />
      <div className="set-body">
        <MicTile prefs={prefs} update={update} />
        <div className="set-col">
          <div className="set-row">
            <TranscriptionTile prefs={prefs} />
            <section className="set-tile set-stat">
              <div className="set-tile__top">
                <MonoLabel>OUTPUT</MonoLabel>
                <Icon name="paste" className="set-ink2" />
              </div>
              <div className="set-stat__bottom">
                <span className="set-stat__value">Verbatim</span>
                <span className="set-stat__caption">
                  {prefs?.aiEnabled
                    ? `${typed ? 'Pasted' : 'Copied'} as transcribed, after AI cleanup fixes punctuation and casing.`
                    : `Whisper punctuates and drops filler, so text is ${typed ? 'pasted' : 'copied'} as transcribed.`}
                </span>
              </div>
            </section>
          </div>
          {/* Each exists only where the helper can do it: no dead switches. */}
          {has(platform, 'duck') && <VolumeTile prefs={prefs} update={update} />}
          {has(platform, 'calendar') && <CalendarTile prefs={prefs} update={update} />}
        </div>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- mic */

/**
 * Follows the macOS default unless a device is pinned. A pinned device that
 * is unplugged stays chosen, and dictation uses the default until it returns.
 */
function MicTile({ prefs, update }: { prefs: Prefs | null; update: Update }): React.JSX.Element {
  const [devices, setDevices] = useState<InputDevice[]>([])
  const [testing, setTesting] = useState(false)
  const [testError, setTestError] = useState('')
  const w = words(usePlatform().os)
  useEffect(() => {
    void window.flow.mic.devices().then(setDevices)
    const offDev = window.flow.mic.onDevices(setDevices)
    // The bars move while dictating, or during a short test started here.
    // The mic is never held open just because this pane is showing.
    const offTest = window.flow.mic.onTest((t) => {
      setTesting(t.state === 'started')
      setTestError(t.error ?? '')
    })
    return () => { offDev(); offTest(); window.flow.mic.test(false) }
  }, [])

  const pinned = prefs?.micUid ?? ''
  const current = devices.find((d) => d.isDefault)
  const chosen = pinned ? devices.find((d) => d.uid === pinned) : undefined
  const missing = !!pinned && !chosen
  const inUse = chosen ?? current
  const pick = (uid: string): void => { if (prefs) void update({ micUid: uid }) }

  return (
    <section className="set-tile set-mic">
      <div className="set-mic__head">
        <h3 className="set-title3">Microphone</h3>
        <p className="set-desc">
          {pinned
            ? 'Always records from the chosen device when it is connected.'
            : w.inputFollows}
        </p>
      </div>

      {missing && (
        <div className="set-notice set-notice--warn">
          <Icon name="warning" className="set-notice__icon" />
          <span className="set-notice__msg">
            The chosen microphone is disconnected, using {current?.name ?? 'the system default'}
          </span>
        </div>
      )}

      <div className="set-devices" role="radiogroup" aria-label="Microphone">
        <DeviceRow
          name="System default"
          detail={w.follows}
          selected={pinned === ''}
          onPick={() => pick('')}
        />
        {devices.map((d) => {
          const using = inUse?.uid === d.uid
          return (
            <DeviceRow
              key={d.uid}
              name={d.name}
              icon={glyphFor(d.name)}
              detail={`${d.isDefault ? w.systemDefault : 'Connected'}${using ? ' · in use now' : ''}`}
              detailTone={using ? 'success' : undefined}
              selected={pinned === d.uid}
              onPick={() => pick(d.uid)}
            />
          )
        })}
        {missing && (
          <DeviceRow
            name="Chosen microphone"
            detail="Disconnected · chosen device"
            detailTone="warn"
            selected
            onPick={() => pick(pinned)}
          />
        )}
      </div>

      <div className="set-level">
        <div className="set-level__head">
          <MonoLabel>INPUT LEVEL</MonoLabel>
          <span className="set-level__device">{inUse?.name ?? 'System default'}</span>
        </div>
        <SpectrumBars className="set-level__bars" barClassName="set-level__bar" />
        <div className="set-level__foot">
          <span className="set-level__hint" role="status">
            {testError || (testing ? 'Listening. Say something.' : 'Press Test to check your mic.')}
          </span>
          <Button variant="ghost" className="set-btn28" onClick={() => window.flow.mic.test(!testing)}>
            {testing ? 'Stop' : 'Test'}
          </Button>
        </div>
      </div>
    </section>
  )
}

/** "Device Row" (Pt9OA) / "Device Row / Selected" (f4b9z). */
function DeviceRow({ name, detail, detailTone, icon = 'mic-input', selected, onPick }: {
  name: string; detail: string; detailTone?: 'success' | 'warn'; icon?: IconName; selected: boolean; onPick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className={`set-device ${selected ? 'is-selected' : ''}`}
      onClick={onPick}
    >
      <span className="set-device__chip"><Icon name={icon} active={selected} /></span>
      <span className="set-device__text">
        <span className="set-device__name">{name}</span>
        <span className={`set-device__detail ${detailTone ? `is-${detailTone}` : ''}`}>{detail}</span>
      </span>
      <span className="set-device__radio" aria-hidden>{selected && <span className="set-device__dot" />}</span>
    </button>
  )
}

/* ------------------------------------------------------- transcription */

function TranscriptionTile({ prefs }: { prefs: Prefs | null }): React.JSX.Element {
  const [models, setModels] = useState<ModelRow[]>([])
  useEffect(() => {
    void window.flow.models.list().then((l) => setModels(l as ModelRow[]))
    return window.flow.models.onList((l) => setModels(l as ModelRow[]))
  }, [])
  const local = models.find((m) => m.id === prefs?.model && m.installed)
  const w = words(usePlatform().os)
  const cloud = prefs?.sttEngine === 'cloud'
  const provider = PROVIDER_NAME[prefs?.sttProvider ?? 'openai']
  const sttLabel = STT_MODELS[prefs?.sttProvider ?? 'openai'].find((m) => m.value === prefs?.sttModel)?.label.split(' · ')[0] ?? prefs?.sttModel

  return (
    <section className="set-tile set-stat">
      <div className="set-tile__top">
        <MonoLabel>TRANSCRIPTION</MonoLabel>
        <Icon name={cloud ? 'cloud' : 'chip'} className="set-ink2" />
      </div>
      <div className="set-stat__bottom">
        <span className="set-stat__value">{cloud ? 'In the cloud' : w.onDevice}</span>
        <span className="set-stat__caption">
          {!prefs ? '…'
            : cloud
              ? `${provider} ${sttLabel}. ${local ? `${local.label.replace(/\s*\(.*\)$/, '')} runs on ${w.device} if the upload fails.` : 'No local model to fall back on.'}`
              : local
                ? `Whisper ${local.label}, running on ${w.device}. Nothing is sent anywhere.`
                : 'No model installed yet. Download one under Speech models.'}
        </span>
      </div>
    </section>
  )
}

/* -------------------------------------------------------------- volume */

const DUCK_MAX = 60

function VolumeTile({ prefs, update }: { prefs: Prefs | null; update: Update }): React.JSX.Element {
  const on = prefs?.duckEnabled ?? true
  const level = prefs?.duckLevel ?? 15
  return (
    <section className="set-tile set-ctl">
      <div className="set-ctl__head">
        <div className="set-text">
          <span className="set-title">Lower volume while dictating</span>
          <p className="set-desc">Drops system audio so you can talk over music or a video, then puts it back where it was.</p>
        </div>
        <Toggle label="Lower volume while dictating" on={on} disabled={!prefs} onChange={(v) => void update({ duckEnabled: v })} />
      </div>
      {on && (
        <div className="set-ctl__line">
          <span className="set-ctl__label">Duck to</span>
          {/* "Track": Fill, Knob, Rest. The native range sits invisibly on top. */}
          <span className="set-slider" style={{ ['--f' as string]: level / DUCK_MAX }}>
            <span className="set-slider__fill" />
            <span className="set-slider__knob" />
            <span className="set-slider__rest" />
            <input
              className="set-slider__native"
              type="range" min={0} max={DUCK_MAX} step={5}
              value={level}
              disabled={!prefs}
              aria-label="Duck to"
              onChange={(e) => void update({ duckLevel: Number(e.target.value) })}
            />
          </span>
          <span className="set-ctl__value">{level === 0 ? 'Mute' : `${level}%`}</span>
        </div>
      )}
    </section>
  )
}

/* ------------------------------------------------------------ calendar */

type CalStatus = 'granted' | 'writeOnly' | 'denied' | 'notDetermined' | 'unknown'
type CalInfo = { id: string; title: string; source: string; color: string; isDefault: boolean }

/**
 * Todos -> Calendar. Turning it on asks macOS for access first; the toggle
 * only lands if access is granted, so it never sits "on" while doing nothing.
 */
function CalendarTile({ prefs, update }: { prefs: Prefs | null; update: Update }): React.JSX.Element {
  const [status, setStatus] = useState<CalStatus>('unknown')
  const [cals, setCals] = useState<CalInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const load = async (): Promise<void> => {
    const st = await window.flow.calendar.status()
    setStatus(st)
    if (st === 'granted') setCals(await window.flow.calendar.calendars())
  }
  useEffect(() => { void load() }, [])

  const enable = async (on: boolean): Promise<void> => {
    if (!on) { await update({ calSync: false }); return }
    setBusy(true)
    try {
      let st = status
      if (st !== 'granted') st = await window.flow.calendar.request()
      setStatus(st)
      if (st !== 'granted') return
      const list = await window.flow.calendar.calendars()
      setCals(list)
      const def = list.find((c) => c.isDefault)?.id ?? list[0]?.id ?? ''
      await update({ calSync: true, calId: prefs?.calId || def })
      const n = await window.flow.calendar.backfill()
      setNote(n ? `Added ${n} dated todo${n === 1 ? '' : 's'} to your calendar.` : null)
    } finally { setBusy(false) }
  }

  const denied = status === 'denied' || status === 'writeOnly'
  return (
    <section className="set-tile set-ctl">
      <div className="set-ctl__head">
        <div className="set-text">
          <span className="set-title">Add dated todos to Calendar</span>
          <p className="set-desc">
            Every todo with a date becomes an event. Edits and deletions follow it; done todos get a ✓ in the title.
          </p>
        </div>
        <Toggle label="Add dated todos to Calendar" on={!!prefs?.calSync} disabled={!prefs || busy} onChange={(v) => void enable(v)} />
      </div>
      {prefs?.calSync && (
        <div className="set-ctl__line">
          <span className="set-ctl__label set-fill">Calendar</span>
          <Select
            value={prefs.calId}
            options={cals.map((c) => ({ value: c.id, label: `${c.title} · ${c.source}` }))}
            onChange={(v) => void update({ calId: v })}
            label="Calendar"
            style={{ width: 220 }}
          />
        </div>
      )}
      {note && <p className="set-note">{note}</p>}
      {denied && (
        <div className="set-notice set-notice--error">
          <Icon name="error" className="set-notice__icon" />
          <span className="set-notice__msg">
            Calendar access is off for Quill. Allow it under Privacy &amp; Security › Calendars, then switch the toggle back on.
          </span>
          <Button variant="ghost" className="set-btn28" onClick={() => window.flow.calendar.openSettings()}>Open</Button>
        </div>
      )}
      {!denied && !prefs?.calSync && (
        <p className="set-note">Quill only writes, but macOS asks for full access so it can update its own events.</p>
      )}
    </section>
  )
}

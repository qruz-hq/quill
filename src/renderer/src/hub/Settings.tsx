import { useEffect, useState } from 'react'
import { GearIcon, MicIcon, HelpIcon, ChartIcon, TrashIcon, GlobeIcon, SearchIcon, WandIcon } from '../shared/icons'
import { LANGUAGES } from './languages'

type Pane = 'shortcuts' | 'general' | 'dictation' | 'languages' | 'models' | 'ai' | 'about'
type Prefs = {
  model: string; languages: string[]
  duckEnabled: boolean; duckLevel: number
  aiEnabled: boolean; aiModel: string; aiMinWords: number; aiDeadlineMs: number; aiFixMishearings: boolean
  sttEngine: 'local' | 'cloud'; sttProvider: 'openai' | 'elevenlabs'; sttModel: string
  sttStreaming: boolean; sttNoVerbatim: boolean
  holdKey: number; toggleShortcut: string; padShortcut: string; noteShortcut: string
}

const NAV: { key: Pane; label: string; Icon: typeof GearIcon }[] = [
  { key: 'shortcuts', label: 'Shortcuts', Icon: GearIcon },
  { key: 'general',   label: 'General',   Icon: GearIcon },
  { key: 'dictation', label: 'Dictation', Icon: MicIcon },
  { key: 'languages', label: 'Languages', Icon: GlobeIcon },
  { key: 'models',    label: 'Speech models', Icon: ChartIcon },
  { key: 'ai',        label: 'AI cleanup', Icon: WandIcon },
  { key: 'about',     label: 'About',     Icon: HelpIcon }
]

export default function Settings({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [pane, setPane] = useState<Pane>('shortcuts')
  const [version, setVersion] = useState('')
  const [prefs, setPrefs] = useState<Prefs | null>(null)

  useEffect(() => { void window.flow.settings.get().then(setPrefs) }, [])
  useEffect(() => { void window.flow.updates.check().then((u) => setVersion(u.current)) }, [])

  const update = async (patch: Partial<Prefs>): Promise<void> => {
    setPrefs((p) => (p ? { ...p, ...patch } : p))   // optimistic
    setPrefs(await window.flow.settings.set(patch))
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <>
      <div className="sheet__scrim" onClick={onClose} />
      <div className="sheet" role="dialog" aria-label="Settings">
        <nav className="sheet__rail">
          <div className="sheet__railLabel">Settings</div>
          {NAV.map(({ key, label, Icon }) => (
            <button
              key={key}
              className={`navitem navitem--sm ${pane === key ? 'is-active' : ''}`}
              onClick={() => setPane(key)}
            >
              <Icon className="navitem__icon" />
              <span>{label}</span>
            </button>
          ))}
          <div className="sheet__version">Quill v{version || "…"}</div>
        </nav>

        <div className="sheet__body">
          {pane === 'general' && (
            <>
              <h2 className="sheet__title">General</h2>
              <div className="rows">
                <Row title="Shortcuts" desc="Hold-to-talk and the global hotkeys are configured under Shortcuts.">
                  <span className="pill">See Shortcuts</span>
                </Row>
              </div>
            </>
          )}

          {pane === 'dictation' && (
            <>
              <h2 className="sheet__title">Dictation</h2>
              <div className="rows">
                <Row
                  title="Transcription"
                  desc={`Whisper ${prefs?.model ?? '…'}, running on this Mac. Nothing is sent anywhere.`}
                >
                  <span className="pill">On-device</span>
                </Row>
                <Row
                  title="Lower volume while dictating"
                  desc="Drops system audio so you can talk over music or a video, then puts it back where it was."
                >
                  <Toggle
                    on={prefs?.duckEnabled ?? true}
                    disabled={!prefs}
                    onChange={(v) => void update({ duckEnabled: v })}
                  />
                </Row>
                {prefs?.duckEnabled && (
                  <Row title="Duck to" desc="How much of the original volume to keep while you speak.">
                    <div className="ducklevel">
                      <input
                        type="range" min={0} max={60} step={5}
                        value={prefs.duckLevel}
                        onChange={(e) => void update({ duckLevel: Number(e.target.value) })}
                      />
                      <span>{prefs.duckLevel === 0 ? 'Mute' : `${prefs.duckLevel}%`}</span>
                    </div>
                  </Row>
                )}
                <Row
                  title="Output"
                  desc="Whisper already punctuates, capitalises and drops filler, so its text is pasted exactly as transcribed."
                >
                  <span className="pill">Verbatim</span>
                </Row>
              </div>
            </>
          )}

          {pane === 'languages' && (
            <Languages prefs={prefs} onSet={(codes) => void update({ languages: codes })} />
          )}

          {pane === 'models' && (
            <Models
              prefs={prefs}
              onSelect={(id) => void update({ model: id })}
              onEngine={(m) => update({ sttEngine: m })}
              onSttModel={(m) => update({ sttModel: m })}
              onProvider={(p, m) => update({ sttProvider: p, sttModel: m })}
              update={update}
            />
          )}

          {pane === 'shortcuts' && <Shortcuts prefs={prefs} update={update} />}

          {pane === 'ai' && <AiCleanup prefs={prefs} update={update} />}

          {pane === 'about' && (
            <>
              <h2 className="sheet__title">About</h2>
              <div className="rows">
                <Row title="Speech recognition" desc={`whisper.cpp · ggml-${prefs?.model ?? '—'} · Metal`}>
                  <span className="pill">On-device</span>
                </Row>
                <UpdateRow />
              </div>
            </>
          )}
        </div>
      </div>
    </>
  )
}

const HOLD_KEYS: { code: number; label: string; note: string }[] = [
  { code: 63, label: 'fn',        note: 'The globe key. Its normal action is suppressed while Quill runs.' },
  { code: 54, label: 'Right ⌘',   note: 'Left Command is untouched.' },
  { code: 61, label: 'Right ⌥',   note: 'Left Option is untouched.' },
  { code: 62, label: 'Right ⌃',   note: 'Left Control is untouched.' },
  { code: 60, label: 'Right ⇧',   note: 'Left Shift is untouched.' },
  { code: 57, label: 'Caps Lock', note: 'Caps Lock stops toggling case while held.' },
  { code: 0,  label: 'Off',       note: 'Use only the hotkeys below.' }
]

function Shortcuts({ prefs, update }: {
  prefs: Prefs | null; update: (p: Partial<Prefs>) => Promise<void>
}): React.JSX.Element {
  const [failed, setFailed] = useState<string[]>([])
  useEffect(() => window.flow.shortcuts.onFailed(setFailed), [])
  const hold = HOLD_KEYS.find((h) => h.code === (prefs?.holdKey ?? 63)) ?? HOLD_KEYS[0]

  return (
    <>
      <h2 className="sheet__title">Shortcuts</h2>
      <p className="sheet__sub">Hold to talk, or use a hotkey from anywhere.</p>

      {!!failed.length && (
        <p className="sheet__warn">
          Could not bind {failed.join(', ')} — another app already owns it. Pick a different combination.
        </p>
      )}

      <div className="rows">
        <Row title="Hold to talk" desc={hold.note + ' Hold to dictate; double-tap to keep it listening.'}>
          <select
            className="modelinput"
            value={prefs?.holdKey ?? 63}
            onChange={(e) => void update({ holdKey: Number(e.target.value) })}
          >
            {HOLD_KEYS.map((h) => <option key={h.code} value={h.code}>{h.label}</option>)}
          </select>
        </Row>
        <Row title="Start / stop dictation" desc="Works without Accessibility permission.">
          <KeyRecorder value={prefs?.toggleShortcut ?? ''} onChange={(v) => void update({ toggleShortcut: v })} />
        </Row>
        <Row title="Open Scratchpad" desc="Floating notepad, always one keystroke away.">
          <KeyRecorder value={prefs?.padShortcut ?? ''} onChange={(v) => void update({ padShortcut: v })} />
        </Row>
        <Row title="New voice note" desc="Records straight into a new Scratchpad note.">
          <KeyRecorder value={prefs?.noteShortcut ?? ''} onChange={(v) => void update({ noteShortcut: v })} />
        </Row>
      </div>

      <p className="sheet__note">
        Hold-to-talk needs Accessibility permission; the hotkeys above do not.
        Transforms stay on ⌥1–⌥9.
      </p>
    </>
  )
}

/** Captures a real key combination and stores it in Electron accelerator form. */
function KeyRecorder({ value, onChange }: {
  value: string; onChange: (v: string) => void
}): React.JSX.Element {
  const [listening, setListening] = useState(false)

  const onKeyDown = (e: React.KeyboardEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') { setListening(false); return }
    if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return   // modifier alone

    const parts: string[] = []
    if (e.ctrlKey) parts.push('Control')
    if (e.altKey) parts.push('Alt')
    if (e.shiftKey) parts.push('Shift')
    if (e.metaKey) parts.push('Command')
    // A bare key would fire constantly while typing, so require a modifier.
    if (!parts.length) return

    const k = e.key.length === 1 ? e.key.toUpperCase() : e.key
    onChange([...parts, k].join('+'))
    setListening(false)
  }

  return (
    <button
      className={`recorder ${listening ? 'is-listening' : ''}`}
      onClick={() => setListening((v) => !v)}
      onKeyDown={listening ? onKeyDown : undefined}
      onBlur={() => setListening(false)}
    >
      {listening ? 'Press keys…' : (value ? pretty(value) : 'Set')}
    </button>
  )
}

const SYM: Record<string, string> = { Control: '⌃', Alt: '⌥', Shift: '⇧', Command: '⌘' }
function pretty(accel: string): string {
  return accel.split('+').map((p) => SYM[p] ?? p).join(' ')
}

function AiCleanup({ prefs, update }: {
  prefs: Prefs | null; update: (p: Partial<Prefs>) => Promise<void>
}): React.JSX.Element {
  const [status, setStatus] = useState<{ hasKey: boolean; masked: string | null }>({ hasKey: false, masked: null })
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [custom, setCustom] = useState(false)

  const refresh = (): void => { void window.flow.cleanup.status().then(setStatus) }
  useEffect(refresh, [])

  // Populate the dropdown from what this key can actually reach.
  useEffect(() => {
    if (!status.hasKey) { setModels([]); return }
    void window.flow.cleanup.models().then((r) => setModels(r.models ?? []))
  }, [status.hasKey])

  const saveKey = async (): Promise<void> => {
    setBusy(true); setResult(null)
    const r = await window.flow.cleanup.setKey(draft)
    setBusy(false)
    if (!r.ok) { setResult({ ok: false, message: r.message ?? 'Could not store the key' }); return }
    setDraft('')
    refresh()
  }

  const test = async (): Promise<void> => {
    setBusy(true); setResult(null)
    setResult(await window.flow.cleanup.verify(prefs?.aiModel ?? 'gpt-5-mini'))
    setBusy(false)
  }

  return (
    <>
      <h2 className="sheet__title">AI cleanup</h2>
      <p className="sheet__sub">
        Optional. Uses your own OpenAI key to remove filler, format spoken lists and
        resolve self-corrections like “at 7 — no, at 6”.
      </p>

      <p className="sheet__warn">
        Your transcript text is sent to OpenAI when this is on. Audio never leaves this
        Mac — Whisper always runs locally. Turn it off and everything stays on-device.
      </p>

      <div className="rows">
        <Row title="Enable AI cleanup" desc={status.hasKey ? 'Runs automatically after each dictation.' : 'Add a key below to switch this on.'}>
          <Toggle
            on={(prefs?.aiEnabled ?? false) && status.hasKey}
            disabled={!prefs || !status.hasKey}
            onChange={(v) => void update({ aiEnabled: v })}
          />
        </Row>

        <Row title="OpenAI API key" desc={status.hasKey ? `Stored in a private file, readable only by your user · ${status.masked}` : 'Saved to a 0600 file in Application Support. OPENAI_API_KEY is picked up automatically if set.'}>
          {status.hasKey ? (
            <button
              className="btn btn--ghost"
              onClick={async () => { await window.flow.cleanup.clearKey(); setResult(null); refresh() }}
            >
              Remove
            </button>
          ) : (
            <div className="keyrow">
              <input
                type="password"
                placeholder="sk-…"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void saveKey() }}
              />
              <button className="btn btn--dark" disabled={!draft.trim() || busy} onClick={() => void saveKey()}>
                Save
              </button>
            </div>
          )}
        </Row>

        <Row
          title="Model"
          desc={
            status.hasKey
              ? models.length
                ? 'Listed live from your account. Cleanup is an easy task, so a small model is plenty.'
                : 'Could not list models — enter one by hand.'
              : 'Add a key to list the models your account can reach.'
          }
        >
          {custom || (status.hasKey && !models.length) ? (
            <div className="keyrow">
              <input
                className="modelinput"
                value={prefs?.aiModel ?? ''}
                onChange={(e) => void update({ aiModel: e.target.value })}
                placeholder="gpt-5-mini"
                autoFocus
              />
              {!!models.length && (
                <button className="btn btn--ghost" onClick={() => setCustom(false)}>List</button>
              )}
            </div>
          ) : (
            <select
              className="modelinput"
              value={prefs?.aiModel ?? ''}
              disabled={!status.hasKey}
              onChange={(e) => {
                if (e.target.value === '__custom__') { setCustom(true); return }
                void update({ aiModel: e.target.value })
              }}
            >
              {/* Keep the saved value selectable even if the account no longer lists it. */}
              {prefs?.aiModel && !models.includes(prefs.aiModel) && (
                <option value={prefs.aiModel}>{prefs.aiModel}</option>
              )}
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
              <option value="__custom__">Custom…</option>
            </select>
          )}
        </Row>
      </div>

      {status.hasKey && (
        <div className="testrow">
          <button className="btn btn--ghost" disabled={busy} onClick={() => void test()}>
            {busy ? 'Testing…' : 'Test connection'}
          </button>
          {result && (
            <span className={`testresult ${result.ok ? 'is-ok' : 'is-bad'}`}>
              {result.ok ? `✓ ${result.message}` : `✗ ${result.message}`}
            </span>
          )}
        </div>
      )}

      <p className="sheet__note">
        If the call fails, times out or you’re offline, Flow pastes the raw Whisper
        transcript instead — a dictation is never lost.
      </p>
      <p className="sheet__note">
        Test reports latency and token count, so you can compare models directly.
        Cleanup is a short task — a small non-reasoning model is usually both the
        cheapest and by far the fastest. Reasoning models think before answering,
        which is what makes them feel slow here.
      </p>
    </>
  )
}

function Languages({ prefs, onSet }: {
  prefs: Prefs | null; onSet: (codes: string[]) => void
}): React.JSX.Element {
  const [q, setQ] = useState('')
  const selected = prefs?.languages ?? ['en']
  const auto = selected.includes('auto')
  const englishOnlyModel = (prefs?.model ?? '').endsWith('.en')
  const needsMultilingual = englishOnlyModel && (auto || selected.some((c) => c !== 'en'))

  const toggle = (code: string): void => {
    const next = selected.includes(code)
      ? selected.filter((c) => c !== code)
      : [...selected.filter((c) => c !== 'auto'), code]
    onSet(next.length ? next : ['en'])   // never leave it empty
  }

  const shown = q
    ? LANGUAGES.filter((l) => (l.name + l.native + l.code).toLowerCase().includes(q.toLowerCase()))
    : LANGUAGES

  return (
    <>
      <div className="sheet__titleRow">
        <div>
          <h2 className="sheet__title">Languages</h2>
          <p className="sheet__sub">Pick every language you dictate in.</p>
        </div>
        <label className="autodetect">
          <span>Auto-detect</span>
          <button
            className={`toggle ${auto ? 'is-on' : ''}`}
            role="switch" aria-checked={auto}
            onClick={() => onSet(auto ? ['en'] : ['auto'])}
          >
            <span className="toggle__knob" />
          </button>
        </label>
      </div>

      {needsMultilingual && (
        <p className="sheet__warn">
          The selected model is English-only. Choose a multilingual model under
          Speech models, or everything will be transcribed as English.
        </p>
      )}
      {!auto && selected.length > 1 && (
        <p className="sheet__note sheet__note--tight">
          With more than one language, Flow detects which you spoke and snaps it to your
          selection. That adds about 200ms per dictation.
        </p>
      )}

      <div className="langsplit">
        <div>
          <div className="langsearch">
            <SearchIcon />
            <input placeholder="Search for any language" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className={`langgrid ${auto ? 'is-dim' : ''}`}>
            {shown.map((l) => (
              <button
                key={l.code}
                className={`lang ${selected.includes(l.code) ? 'is-on' : ''}`}
                onClick={() => toggle(l.code)}
              >
                <span className="lang__name">{l.name}</span>
                {l.native && <span className="lang__native">{l.native}</span>}
              </button>
            ))}
          </div>
        </div>

        <aside className="langsel">
          <div className="langsel__head">Selected</div>
          {auto ? (
            <p className="langsel__auto">Detecting from all 99 languages.</p>
          ) : (
            selected.map((code) => {
              const l = LANGUAGES.find((x) => x.code === code)
              return (
                <div key={code} className="langsel__row">
                  <span>{l ? l.name : code}{l?.native ? ` (${l.native})` : ''}</span>
                  <button
                    aria-label={`Remove ${l?.name ?? code}`}
                    disabled={selected.length === 1}
                    onClick={() => toggle(code)}
                  >
                    –
                  </button>
                </div>
              )
            })
          )}
        </aside>
      </div>
    </>
  )
}

type ModelRow = {
  id: string; label: string; bytes: number; wer: string; note: string
  multilingual?: boolean; quantised?: boolean; installed: boolean
}

function fmt(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`
}

function ElevenKeyRow(): React.JSX.Element {
  const [status, setStatus] = useState<{ hasKey: boolean; masked: string | null }>({ hasKey: false, masked: null })
  const [draft, setDraft] = useState('')
  const refresh = (): void => { void window.flow.eleven.status().then(setStatus) }
  useEffect(refresh, [])

  return (
    <Row
      title="ElevenLabs API key"
      desc={status.hasKey
        ? `Stored in a private file, readable only by your user · ${status.masked}`
        : 'Saved to a 0600 file. ELEVENLABS_API_KEY is picked up automatically if set.'}
    >
      {status.hasKey ? (
        <button className="btn btn--ghost" onClick={async () => { await window.flow.eleven.clearKey(); refresh() }}>
          Remove
        </button>
      ) : (
        <div className="keyrow">
          <input
            type="password" placeholder="sk_…" value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void window.flow.eleven.setKey(draft).then(() => { setDraft(''); refresh() }) }}
          />
          <button
            className="btn btn--dark" disabled={!draft.trim()}
            onClick={async () => { await window.flow.eleven.setKey(draft); setDraft(''); refresh() }}
          >
            Save
          </button>
        </div>
      )}
    </Row>
  )
}

function Models({ prefs, onSelect, onEngine, onSttModel, onProvider, update }: {
  prefs: Prefs | null
  onSelect: (id: string) => void
  onEngine: (m: 'local' | 'cloud') => Promise<void>
  onSttModel: (m: string) => Promise<void>
  onProvider: (p: 'openai' | 'elevenlabs', model: string) => Promise<void>
  update: (patch: Partial<Prefs>) => Promise<void>
}): React.JSX.Element {
  const [list, setList] = useState<ModelRow[]>([])
  const [progress, setProgress] = useState<Record<string, number>>({})
  const [error, setError] = useState<string | null>(null)

  const refresh = (): void => { void window.flow.models.list().then(setList as never) }
  useEffect(refresh, [])

  useEffect(() => {
    const offP = window.flow.models.onProgress(({ id, received, total }) =>
      setProgress((p) => ({ ...p, [id]: total ? received / total : 0 })))
    const offD = window.flow.models.onDone(({ id }) => {
      setProgress((p) => { const n = { ...p }; delete n[id]; return n })
      refresh()
    })
    const offL = window.flow.models.onList((l) => setList(l as ModelRow[]))
    const offE = window.flow.models.onError(({ message }) => {
      setError(message)
      setProgress({})
    })
    return () => { offP(); offD(); offL(); offE() }
  }, [])

  const download = async (id: string): Promise<void> => {
    setError(null)
    setProgress((p) => ({ ...p, [id]: 0 }))
    try { setList((await window.flow.models.download(id)) as ModelRow[]) }
    catch { /* surfaced via onError */ }
  }

  const anyInstalled = list.some((m) => m.installed)

  return (
    <>
      <h2 className="sheet__title">Speech models</h2>
      <div className="rows" style={{ marginBottom: 16 }}>
        <Row
          title="Where transcription runs"
          desc={
            prefs?.sttEngine === 'cloud'
              ? `Audio is uploaded to ${prefs?.sttProvider === 'elevenlabs' ? 'ElevenLabs' : 'OpenAI'}. No model is loaded, so Quill uses almost no memory.`
              : 'Runs on this Mac. Audio never leaves it, but the model stays in memory while in use.'
          }
        >
          <select
            className="modelinput"
            value={prefs?.sttEngine ?? 'local'}
            onChange={(e) => void onEngine(e.target.value as 'local' | 'cloud')}
          >
            <option value="local">On this Mac</option>
            <option value="cloud">In the cloud</option>
          </select>
        </Row>
        {prefs?.sttEngine === 'cloud' && (
          <>
            <Row title="Provider" desc="Both charge by audio length. Prices shown per hour of speech.">
              <select
                className="modelinput"
                value={prefs?.sttProvider ?? 'openai'}
                onChange={(e) => {
                  const p = e.target.value as 'openai' | 'elevenlabs'
                  // Each provider names its models differently; reset to a valid default.
                  void onProvider(p, p === 'elevenlabs' ? 'scribe_v2' : 'gpt-4o-mini-transcribe')
                }}
              >
                <option value="openai">OpenAI</option>
                <option value="elevenlabs">ElevenLabs</option>
              </select>
            </Row>

            <Row title="Transcription model" desc={
              prefs?.sttProvider === 'elevenlabs'
                ? 'Scribe bills per hour of audio.'
                : 'mini is a third of the price and was indistinguishable in my French testing.'
            }>
              <select
                className="modelinput"
                value={prefs?.sttModel ?? ''}
                onChange={(e) => void onSttModel(e.target.value)}
              >
                {prefs?.sttProvider === 'elevenlabs' ? (
                  <>
                    <option value="scribe_v2">scribe_v2 — $0.22/hr</option>
                    <option value="scribe_v1">scribe_v1</option>
                  </>
                ) : (
                  <>
                    <option value="gpt-4o-mini-transcribe">gpt-4o-mini-transcribe — $0.18/hr</option>
                    <option value="gpt-4o-transcribe">gpt-4o-transcribe — $0.36/hr</option>
                    <option value="whisper-1">whisper-1 — $0.36/hr</option>
                  </>
                )}
              </select>
            </Row>

            {prefs?.sttProvider === 'elevenlabs' && (
              <>
                <Row
                  title="Stream while you speak"
                  desc={
                    prefs?.sttStreaming
                      ? 'Uploads audio as you talk using scribe_v2_realtime, so only the tail is left when you let go. Saves roughly 400ms; the cleanup step after it is unchanged.'
                      : 'Uploads the recording once you let go. Turn on to send it as you speak instead.'
                  }
                >
                  <Toggle
                    on={prefs?.sttStreaming ?? false}
                    disabled={!prefs}
                    onChange={(v) => void update({ sttStreaming: v })}
                  />
                </Row>
                <Row
                  title="Drop filler words"
                  desc={
                    prefs?.sttModel === 'scribe_v1' && !prefs?.sttStreaming
                      ? 'Needs scribe_v2 — scribe_v1 ignores this.'
                      : 'Removes “um”, false starts and non-speech sounds before you ever see them.'
                  }
                >
                  <Toggle
                    on={prefs?.sttNoVerbatim ?? true}
                    disabled={!prefs}
                    onChange={(v) => void update({ sttNoVerbatim: v })}
                  />
                </Row>
                <ElevenKeyRow />
              </>
            )}
          </>
        )}
      </div>

      {prefs?.sttEngine === 'cloud' && (
        <p className="sheet__note sheet__note--tight">
          Your audio is sent to {prefs?.sttProvider === 'elevenlabs' ? 'ElevenLabs' : 'OpenAI'}. A local
          model is still used if the upload fails, so keep one installed below.
        </p>
      )}

      {prefs?.sttEngine === 'local' && !anyInstalled && (
        <p className="sheet__warn">
          No model installed yet — dictation won’t work until you download one. Base is the one to pick.
        </p>
      )}
      <div className="rows">
        {list.map((m) => {
          const pct = progress[m.id]
          const downloading = pct !== undefined
          const active = prefs?.model === m.id
          return (
            <div key={m.id} className={`row model ${active ? 'is-active' : ''}`}>
              <div className="row__text">
                <div className="row__title">
                  {m.label}
                  <span className="model__meta">{fmt(m.bytes)} · WER {m.wer}</span>
                  {m.multilingual && <span className="pill pill--sm">Multilingual</span>}
                  {m.quantised && <span className="pill pill--sm">Compressed</span>}
                  {active && m.installed && <span className="pill pill--sm pill--on">In use</span>}
                </div>
                <div className="row__desc">{m.note}</div>
                {downloading && (
                  <div className="bar"><div className="bar__fill" style={{ width: `${Math.round(pct * 100)}%` }} /></div>
                )}
              </div>
              <div className="row__control model__actions">
                {downloading ? (
                  <>
                    <span className="model__pct">{Math.round(pct * 100)}%</span>
                    <button className="btn btn--ghost" onClick={() => void window.flow.models.cancel(m.id)}>Cancel</button>
                  </>
                ) : m.installed ? (
                  <>
                    {!active && <button className="btn btn--dark" onClick={() => onSelect(m.id)}>Use</button>}
                    <button
                      className="iconbtn"
                      aria-label={`Remove ${m.label}`}
                      onClick={async () => setList((await window.flow.models.remove(m.id)) as ModelRow[])}
                    >
                      <TrashIcon />
                    </button>
                  </>
                ) : (
                  <button className="btn btn--dark" onClick={() => void download(m.id)}>Download</button>
                )}
              </div>
            </div>
          )
        })}
      </div>
      {error && <p className="sheet__warn">Download failed: {error}</p>}
      <p className="sheet__note">
        Models are downloaded only when you choose them, and stored in Application Support. Delete any you don’t use.
      </p>
    </>
  )
}

function Toggle({ on, disabled, onChange }: {
  on: boolean; disabled?: boolean; onChange: (v: boolean) => void
}): React.JSX.Element {
  return (
    <button
      className={`toggle ${on ? 'is-on' : ''}`}
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
    >
      <span className="toggle__knob" />
    </button>
  )
}

function UpdateRow(): React.JSX.Element {
  const [state, setState] = useState<{ current: string; latest?: string; newer: boolean } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => { void window.flow.updates.check().then(setState) }, [])

  return (
    <Row
      title="Version"
      desc={
        state
          ? state.newer
            ? `${state.current} — ${state.latest} is available`
            : `${state.current} — up to date`
          : 'Checking…'
      }
    >
      <button
        className="btn btn--ghost"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          await window.flow.updates.prompt()
          setState(await window.flow.updates.check())
          setBusy(false)
        }}
      >
        {busy ? 'Checking…' : 'Check now'}
      </button>
    </Row>
  )
}

function Row({ title, desc, children }: {
  title: string; desc: string; children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="row">
      <div className="row__text">
        <div className="row__title">{title}</div>
        <div className="row__desc">{desc}</div>
      </div>
      <div className="row__control">{children}</div>
    </div>
  )
}


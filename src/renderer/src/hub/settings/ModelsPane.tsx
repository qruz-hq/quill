import { useEffect, useState } from 'react'
import { BlurWords } from '../../shared/motion'
import { Icon } from '../../shared/icons'
import { Button, IconButton, Pill, SettingsGroup, SettingsRow } from '../../shared/ui'
import { Select, Toggle } from './controls'
import { usePlatform, words } from '../../shared/platform'
import {
  LIVE_BATCH_FALLBACK, MonoLabel, PaneHeader, PROVIDER_NAME, STT_MODELS, fmtBytes, streamKind,
  type ModelRow, type PaneProps, type Prefs
} from './shared'

/** Settings, Speech models (local) and Speech models · Cloud. */
export default function ModelsPane({ prefs, update }: PaneProps): React.JSX.Element {
  const [list, setList] = useState<ModelRow[]>([])
  const [progress, setProgress] = useState<Record<string, number>>({})
  const [error, setError] = useState<string | null>(null)

  const refresh = (): void => { void window.flow.models.list().then((l) => setList(l as ModelRow[])) }
  useEffect(refresh, [])

  const clearProgress = (id: string): void =>
    setProgress((p) => { if (!(id in p)) return p; const n = { ...p }; delete n[id]; return n })

  useEffect(() => {
    const offP = window.flow.models.onProgress(({ id, received, total }) =>
      setProgress((p) => ({ ...p, [id]: total ? received / total : 0 })))
    const offD = window.flow.models.onDone(({ id }) => {
      clearProgress(id)
      refresh()
    })
    const offL = window.flow.models.onList((l) => setList(l as ModelRow[]))
    const offE = window.flow.models.onError(({ message }) => {
      setError(message)
      setProgress({})
    })
    // A cancelled download reports neither done nor error.
    const offC = window.flow.models.onCancelled(({ id }) => clearProgress(id))
    return () => { offP(); offD(); offL(); offE(); offC() }
  }, [])

  const download = async (id: string): Promise<void> => {
    setError(null)
    setProgress((p) => ({ ...p, [id]: 0 }))
    try { setList((await window.flow.models.download(id)) as ModelRow[]) }
    catch { /* surfaced via onError */ }
    // However it ended (done, cancelled, failed), the row leaves its progress bar.
    finally { clearProgress(id) }
  }

  const w = words(usePlatform().os)
  const cloud = prefs?.sttEngine === 'cloud'
  const provider = prefs?.sttProvider ?? 'openai'
  const installed = list.filter((m) => m.installed)
  const active = installed.find((m) => m.id === prefs?.model)
  const eleven = cloud && provider === 'elevenlabs'
  // no_verbatim is only sent to Scribe v2 (transcribe.ts, stream.ts).
  const scribe2 = eleven && (prefs?.sttModel ?? '').startsWith('scribe_v2')
  const sttModel = prefs?.sttModel ?? ''
  const stream = streamKind(sttModel)
  const canStream = stream !== 'none'
  /** "whisper-1": the model's label without its price. */
  const modelName = STT_MODELS[provider].find((m) => m.value === sttModel)?.label.split(' · ')[0] ?? (sttModel || 'This model')

  return (
    <div className="set-pane">
      <PaneHeader pane="models" />
      <div className="set-body">
        <div className="set-col">
          <section className={`set-tile set-where ${cloud ? 'set-fillh' : ''}`}>
            <h3 className="set-title3">Where transcription runs</h3>
            <div className="set-where__options" role="radiogroup" aria-label="Where transcription runs">
              <EngineOption
                on={!cloud}
                icon="chip"
                title={w.onDevice}
                desc="Runs Whisper locally. Nothing is sent anywhere."
                onPick={() => void update({ sttEngine: 'local' })}
              />
              <EngineOption
                on={cloud}
                icon="cloud"
                title="In the cloud"
                desc={`Audio is uploaded to ${PROVIDER_NAME[provider]}. No model is loaded, so Quill uses almost no memory.`}
                onPick={() => void update({ sttEngine: 'cloud' })}
              />
            </div>
            {cloud && (
              <>
                <div className="set-fields set-fields--cloud">
                  <label className="set-field">
                    <span className="set-field__label">Provider</span>
                    <Select
                      className="set-fill"
                      value={provider}
                      label="Provider"
                      options={[{ value: 'openai', label: 'OpenAI' }, { value: 'elevenlabs', label: 'ElevenLabs' }]}
                      // Each provider names its models differently; reset to a valid default.
                      onChange={(v) => {
                        const p = v as 'openai' | 'elevenlabs'
                        void update({ sttProvider: p, sttModel: p === 'elevenlabs' ? 'scribe_v2' : 'gpt-4o-mini-transcribe' })
                      }}
                    />
                  </label>
                  <label className="set-field">
                    <span className="set-field__label">Transcription model</span>
                    <Select
                      className="set-fill"
                      value={prefs?.sttModel ?? ''}
                      label="Transcription model"
                      options={STT_MODELS[provider]}
                      onChange={(v) => void update({ sttModel: v })}
                    />
                  </label>
                </div>
                <p className="set-note">
                  {provider === 'elevenlabs'
                    ? 'Both providers charge by audio length; Scribe bills per hour of audio.'
                    : sttModel === 'gpt-live-transcribe'
                      ? `Shows words while you speak. With streaming off, or if the stream fails, the recording is sent as ${LIVE_BATCH_FALLBACK} instead.`
                      : 'Both providers charge by audio length. mini is a third of the price and was indistinguishable in testing.'}
                </p>
              </>
            )}
          </section>

          {!cloud && (
            <section className="set-tile set-local">
              <div className="set-local__head">
                <span className="set-icon40 set-icon40--lime"><Icon name="lock" size={20} /></span>
                <div className="set-text">
                  <h3 className="set-title3">Private by default</h3>
                  <p className="set-desc set-desc--13">Runs Whisper locally. Nothing is sent anywhere.</p>
                </div>
              </div>
              <div className="set-fields set-fields--local">
                <label className="set-field">
                  <span className="set-field__label">Model in use</span>
                  <Select
                    className="set-fill"
                    value={active?.id ?? ''}
                    label="Model in use"
                    disabled={!installed.length}
                    options={installed.length
                      ? installed.map((m) => ({ value: m.id, label: m.label }))
                      : [{ value: '', label: 'None installed' }]}
                    onChange={(v) => void update({ model: v })}
                  />
                </label>
                <div className="set-field">
                  {/* The model file's size. Quill does not measure memory, so it claims none. */}
                  <span className="set-field__label">Model size</span>
                  <span className="set-value">
                    <span className="set-value__amount">{active ? fmtBytes(active.bytes) : 'None'}</span>
                    <Icon name="gauge" className="set-value__icon" />
                  </span>
                </div>
              </div>
              <p className={`set-note ${installed.length ? '' : 'is-warn'}`}>
                {installed.length
                  ? 'Smaller models load faster and use less memory.'
                  : 'No model installed yet, so dictation won’t work until you download one. Base is the one to pick.'}
              </p>
              <div className="set-local__spacer" />
              <div className="set-local__foot">
                <Icon name="lock" />
                <span>Works offline.</span>
              </div>
            </section>
          )}

          {cloud && (
            <SettingsGroup className="set-group--14">
              <SettingsRow
                title="Stream while you speak"
                desc={!canStream
                  ? `${modelName} can’t take audio live. It gets the recording once you let go.`
                  : !prefs?.sttStreaming
                    ? 'Uploads the recording once you let go. Turn on to send it as you speak instead.'
                    : stream === 'live'
                      ? `Words appear as you speak. Audio is sent to ${PROVIDER_NAME[provider]} while you talk.`
                      : 'Audio is sent to OpenAI while you talk, so the text comes back sooner when you let go. For live words, pick gpt-live-transcribe.'}
              >
                <Toggle
                  label="Stream while you speak"
                  on={canStream && (prefs?.sttStreaming ?? false)}
                  disabled={!prefs || !canStream}
                  onChange={(v) => void update({ sttStreaming: v })}
                />
              </SettingsRow>
              <SettingsRow
                title="Drop filler words"
                desc={!eleven
                  ? 'Only with ElevenLabs Scribe v2.'
                  : prefs?.sttModel === 'scribe_v1'
                    ? 'Needs Scribe v2. Scribe v1 ignores this.'
                    : 'Removes “um”, false starts and non-speech sounds before you see them.'}
              >
                <Toggle
                  label="Drop filler words"
                  on={scribe2 && (prefs?.sttNoVerbatim ?? true)}
                  disabled={!prefs || !scribe2}
                  onChange={(v) => void update({ sttNoVerbatim: v })}
                />
              </SettingsRow>
            </SettingsGroup>
          )}
        </div>

        {cloud ? (
          <CloudTile prefs={prefs} />
        ) : (
          <section className="set-tile set-models">
            <div className="set-models__head">
              <MonoLabel>LOCAL MODELS</MonoLabel>
              <Pill small className="set-pill-mono">{installed.length} installed</Pill>
            </div>
            <div className="set-models__list">
              {list.map((m) => {
                const pct = progress[m.id]
                const downloading = pct !== undefined
                const inUse = prefs?.model === m.id && m.installed
                return (
                  <div key={m.id} className={`set-model ${inUse ? 'is-active' : ''}`}>
                    <div className="set-model__head">
                      <span className="set-model__name">{m.label}</span>
                      <span className="set-model__size">{fmtBytes(m.bytes)}</span>
                    </div>
                    <p className="set-model__desc">{m.note}</p>
                    <div className="set-model__actions">
                      {downloading ? (
                        <>
                          <span className="set-progress"><span className="set-progress__fill" style={{ width: `${Math.round(pct * 100)}%` }} /></span>
                          <span className="set-model__pct">{Math.round(pct * 100)}%</span>
                          <Button variant="ghost" className="set-btn28" onClick={() => { void window.flow.models.cancel(m.id); clearProgress(m.id) }}>Cancel</Button>
                        </>
                      ) : m.installed ? (
                        <>
                          {inUse
                            ? <span className="set-inuse">In use</span>
                            : <Button variant="ghost" className="set-btn28" onClick={() => void update({ model: m.id })}>Use</Button>}
                          <span className="set-model__spacer" />
                          <IconButton
                            icon="trash"
                            label={`Remove ${m.label}`}
                            className="set-btn28sq"
                            onClick={async () => setList((await window.flow.models.remove(m.id)) as ModelRow[])}
                          />
                        </>
                      ) : (
                        <Button variant="ghost" className="set-btn28" onClick={() => void download(m.id)}>Download</Button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
            <p className={`set-note ${error ? 'is-error' : ''}`}>
              {error ? `Download failed: ${error}` : `Models are downloaded only when you choose them, and stay on ${w.device}.`}
            </p>
          </section>
        )}
      </div>
    </div>
  )
}

function EngineOption({ on, icon, title, desc, onPick }: {
  on: boolean; icon: 'chip' | 'cloud'; title: string; desc: string; onPick: () => void
}): React.JSX.Element {
  return (
    <button type="button" role="radio" aria-checked={on} className={`set-option ${on ? 'is-on' : ''}`} onClick={onPick}>
      <span className="set-option__head">
        <span className="set-option__radio">{on && <span className="set-option__dot" />}</span>
        <Icon name={icon} className="set-option__icon" />
        <span className="set-option__title">{title}</span>
      </span>
      <BlurWords variant="block" initial={false} className="set-option__desc" text={desc} />
    </button>
  )
}

/** "Tile / Cloud": provider notice, API key (ElevenLabs), and the hidden-local-models empty state. */
function CloudTile({ prefs }: { prefs: Prefs | null }): React.JSX.Element {
  const provider = prefs?.sttProvider ?? 'openai'
  const name = PROVIDER_NAME[provider]
  const { os } = usePlatform()
  const w = words(os)
  // Windows has no file modes: the key sits in the user's own profile there.
  const saved = os === 'windows' ? 'Saved to a file in your user profile.' : 'Saved to a 0600 file.'
  return (
    <section className="set-tile set-models">
      <div className="set-models__head set-models__head--26">
        <MonoLabel>{name.toUpperCase()}</MonoLabel>
      </div>
      <div className="set-notice set-notice--warn set-notice--cloud">
        <Icon name="info" className="set-notice__icon" />
        <BlurWords
          variant="block"
          initial={false}
          className="set-notice__msg set-notice__msg--400"
          text={`Your audio is sent to ${name}. If the upload fails, Quill falls back to a model on ${w.device}.`}
        />
      </div>
      {provider === 'elevenlabs' ? (
        <KeyField
          label="ElevenLabs API key"
          placeholder="sk_…"
          status={() => window.flow.eleven.status()}
          save={(k) => window.flow.eleven.setKey(k)}
          clear={() => window.flow.eleven.clearKey()}
          note={(has) => has
            ? 'Stored in a private file, readable only by your user.'
            : `${saved} ELEVENLABS_API_KEY is picked up automatically if set.`}
        />
      ) : (
        <KeyField
          label="OpenAI API key"
          placeholder="sk-…"
          status={() => window.flow.cleanup.status()}
          save={(k) => window.flow.cleanup.setKey(k)}
          clear={() => window.flow.cleanup.clearKey()}
          note={(has) => has
            ? 'The same key AI cleanup uses. Stored in a private file, readable only by your user.'
            : 'Shared with AI cleanup. OPENAI_API_KEY is picked up automatically if set.'}
        />
      )}
      <div className="set-empty">
        <span className="set-icon40 set-icon40--pink"><Icon name="chip" size={20} /></span>
        <div className="set-empty__text">
          <span className="set-title">Local models are hidden</span>
          <span className="set-empty__desc">Pick {w.onDevice} to download or change a model.</span>
        </div>
      </div>
    </section>
  )
}

/** Masked key + Remove, or a password input + Save. */
export function KeyField({ label, placeholder, status, save, clear, note }: {
  label: string; placeholder: string
  status: () => Promise<{ hasKey: boolean; masked: string | null }>
  save: (k: string) => Promise<unknown>
  clear: () => Promise<unknown>
  note: (hasKey: boolean) => string
}): React.JSX.Element {
  const [st, setSt] = useState<{ hasKey: boolean; masked: string | null }>({ hasKey: false, masked: null })
  const [draft, setDraft] = useState('')
  const refresh = (): void => { void status().then(setSt) }
  useEffect(refresh, [])
  const commit = async (): Promise<void> => { if (!draft.trim()) return; await save(draft); setDraft(''); refresh() }

  return (
    <div className="set-field set-field--key">
      <span className="set-field__label">{label}</span>
      <div className="set-field__row">
        {st.hasKey ? (
          <>
            <span className="set-input set-fill">{st.masked}</span>
            <Button variant="ghost" onClick={async () => { await clear(); refresh() }}>Remove</Button>
          </>
        ) : (
          <>
            <input
              className="set-input set-fill"
              type="password"
              placeholder={placeholder}
              aria-label={label}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void commit() }}
            />
            <Button disabled={!draft.trim()} onClick={() => void commit()}>Save</Button>
          </>
        )}
      </div>
      <span className="set-note">{note(st.hasKey)}</span>
    </div>
  )
}

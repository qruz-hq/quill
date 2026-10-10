import { useEffect, useState } from 'react'
import { Icon } from '../../shared/icons'
import { Button, SettingsGroup, SettingsRow } from '../../shared/ui'
import { Select, Toggle } from './controls'
import { MonoLabel, PaneHeader, type PaneProps } from './shared'

/** Settings, AI cleanup: rows on the left, API key + How it works on the right. */
export default function AiPane({ prefs, update }: PaneProps): React.JSX.Element {
  const [status, setStatus] = useState<{ hasKey: boolean; masked: string | null }>({ hasKey: false, masked: null })
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [custom, setCustom] = useState(false)
  const [minWords, setMinWords] = useState<string | null>(null)

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

  const commitMinWords = (): void => {
    if (minWords === null) return
    const n = Math.max(0, Math.min(50, Math.round(Number(minWords.replace(/[^0-9]/g, '')) || 0)))
    setMinWords(null)
    void update({ aiMinWords: n })
  }

  const model = prefs?.aiModel ?? ''
  const options = [
    // Keep the saved value selectable even if the account no longer lists it.
    ...(model && !models.includes(model) ? [{ value: model, label: model }] : []),
    ...models.map((m) => ({ value: m, label: m })),
    { value: '__custom__', label: 'Custom…' }
  ]
  const seconds = ((prefs?.aiDeadlineMs ?? 2500) / 1000).toLocaleString()

  return (
    <div className="set-pane">
      <PaneHeader pane="ai" />
      <div className="set-body">
        <SettingsGroup className="set-group--fill">
          <SettingsRow
            title="Enable AI cleanup"
            desc={status.hasKey
              ? 'Runs automatically after each dictation.'
              : 'Add an OpenAI key to switch this on. Off, everything stays on-device.'}
          >
            <Toggle
              label="Enable AI cleanup"
              on={(prefs?.aiEnabled ?? false) && status.hasKey}
              disabled={!prefs || !status.hasKey}
              onChange={(v) => void update({ aiEnabled: v })}
            />
          </SettingsRow>
          <SettingsRow
            title="Model"
            desc={status.hasKey
              ? models.length
                ? 'mini is the cost-effective default; gpt-5-nano is cheaper still but was measurably worse.'
                : 'Could not list models. Enter one by hand.'
              : 'Add a key to list the models your account can reach.'}
          >
            {custom || (status.hasKey && !models.length) ? (
              <span className="set-ai__custom">
                <input
                  className="set-input set-input--150"
                  value={model}
                  aria-label="Model"
                  onChange={(e) => void update({ aiModel: e.target.value })}
                  placeholder="gpt-5-mini"
                  autoFocus={custom}
                />
                {!!models.length && <Button variant="ghost" className="set-btn32" onClick={() => setCustom(false)}>List</Button>}
              </span>
            ) : (
              <Select
                style={{ width: 150 }}
                value={model}
                options={options}
                label="Model"
                disabled={!status.hasKey}
                onChange={(v) => { if (v === '__custom__') setCustom(true); else void update({ aiModel: v }) }}
              />
            )}
          </SettingsRow>
          <SettingsRow
            title="Skip short dictations"
            desc="Under this many words, whisper’s own punctuation is enough and the round trip isn’t worth it."
          >
            <input
              className="set-input set-input--84"
              aria-label="Minimum words"
              value={minWords ?? `${prefs?.aiMinWords ?? 5} words`}
              disabled={!prefs}
              onFocus={() => setMinWords(String(prefs?.aiMinWords ?? 5))}
              onChange={(e) => setMinWords(e.target.value)}
              onBlur={commitMinWords}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
            />
          </SettingsRow>
          <SettingsRow
            title="Fix likely mis-hearings"
            desc="Lets the model swap a word for a sound-alike when the sentence makes no sense otherwise. Off by default: it changed words that were right."
          >
            <Toggle
              label="Fix likely mis-hearings"
              on={prefs?.aiFixMishearings ?? false}
              disabled={!prefs}
              onChange={(v) => void update({ aiFixMishearings: v })}
            />
          </SettingsRow>
        </SettingsGroup>

        <div className="set-col set-col--300">
          <section className="set-tile set-key">
            <div className="set-tile__top set-tile__top--16">
              <MonoLabel>OPENAI API KEY</MonoLabel>
              <Icon name="lock" className="set-ink2" />
            </div>
            {status.hasKey ? (
              <span className="set-input">{status.masked}</span>
            ) : (
              <input
                className="set-input"
                type="password"
                placeholder="sk-…"
                aria-label="OpenAI API key"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void saveKey() }}
              />
            )}
            <p className="set-key__caption">
              {status.hasKey
                ? 'Stored in a private file, readable only by your user.'
                : 'Saved to a 0600 file in Application Support. OPENAI_API_KEY is picked up automatically if set.'}
            </p>
            <div className="set-key__actions">
              {status.hasKey ? (
                <>
                  <Button className="set-btn32" disabled={busy} onClick={() => void test()}>{busy ? 'Testing…' : 'Test'}</Button>
                  <Button
                    variant="ghost"
                    className="set-btn32"
                    onClick={async () => { await window.flow.cleanup.clearKey(); setResult(null); refresh() }}
                  >
                    Remove
                  </Button>
                </>
              ) : (
                <Button className="set-btn32" disabled={!draft.trim() || busy} onClick={() => void saveKey()}>Save</Button>
              )}
            </div>
            {result && (
              <div className={`set-result ${result.ok ? 'is-ok' : 'is-bad'}`} role="status">
                <Icon name={result.ok ? 'check' : 'error'} />
                <span>{result.message}</span>
              </div>
            )}
          </section>

          <section className="set-tile set-how">
            <div className="set-how__top">
              <Icon name="info" size={20} />
              <MonoLabel className="set-mono--tangerine">HOW IT WORKS</MonoLabel>
            </div>
            <div className="set-how__example">
              <div className="set-how__said">book flights to lisbon then send marta the deck</div>
              <div className="set-how__pasted">{'• Book flights to Lisbon\n• Send Marta the deck'}</div>
            </div>
            <p className="set-how__body">
              Cleanup adds punctuation, fixes casing and turns a spoken list into bullets. It never rewrites what you
              said. If it can’t finish in {seconds}s, the raw transcript is pasted instead.
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}

import { Fragment, useEffect, useState } from 'react'
import { AppMark } from '../../shared/icons'
import { Button, Pill } from '../../shared/ui'
import { LANGUAGES } from '../languages'
import { MonoLabel, PaneHeader, PROVIDER_NAME, STT_MODELS, streamKind, type ModelRow, type PaneProps } from './shared'

type UpdateState = { current: string; latest?: string; newer: boolean }

/** Settings, About: lime Version tile beside the Speech recognition spec list. */
export default function AboutPane({ prefs, updates, onUpdates }: PaneProps & {
  updates: UpdateState | null; onUpdates: (u: UpdateState) => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [models, setModels] = useState<ModelRow[]>([])
  const [ai, setAi] = useState(false)
  useEffect(() => { void window.flow.models.list().then((l) => setModels(l as ModelRow[])) }, [])
  useEffect(() => { void window.flow.cleanup.status().then((s) => setAi(s.hasKey)) }, [])

  const cloud = prefs?.sttEngine === 'cloud'
  const provider = prefs?.sttProvider ?? 'openai'
  const local = models.find((m) => m.id === prefs?.model)
  const localSpec = local?.installed ? `${prefs?.model} · Metal` : 'None installed'
  const langs = prefs?.languages.includes('auto')
    ? 'Auto-detect'
    : (prefs?.languages ?? []).map((c) => LANGUAGES.find((l) => l.code === c)?.name ?? c).join(', ')

  const stream = streamKind(prefs?.sttModel ?? '')
  const specs: [string, string][] = cloud
    ? [
        ['Provider', PROVIDER_NAME[provider]],
        ['Model', STT_MODELS[provider].find((m) => m.value === prefs?.sttModel)?.label.split(' · ')[0] ?? prefs?.sttModel ?? 'Not set'],
        ['Fallback on this Mac', localSpec],
        ['Languages', langs],
        ...(stream !== 'none'
          ? [['Streaming', !prefs?.sttStreaming ? 'Off'
              : stream === 'live' ? 'Live words' : 'Early upload']] as [string, string][]
          : []),
        ['AI cleanup', prefs?.aiEnabled && ai ? `${prefs.aiModel} · OpenAI` : 'Off']
      ]
    : [
        ['Engine', 'whisper.cpp'],
        ['Model', local?.label ?? 'None installed'],
        ['File', local?.installed ? `ggml-${prefs?.model} · Metal` : 'None installed'],
        ['Languages', langs],
        ['AI cleanup', prefs?.aiEnabled && ai ? `${prefs.aiModel} · OpenAI` : 'Off']
      ]

  const check = async (): Promise<void> => {
    setBusy(true)
    await window.flow.updates.prompt()
    onUpdates(await window.flow.updates.check())
    setBusy(false)
  }

  return (
    <div className="set-pane">
      <PaneHeader pane="about" />
      <div className="set-body">
        <section className="set-tile set-version set-accent--lime">
          <div className="set-tile__top">
            <MonoLabel className="set-mono--ink">VERSION</MonoLabel>
            <AppMark size={20} />
          </div>
          <div className="set-version__bottom">
            <span className="set-version__value">{updates?.current || '…'}</span>
            <span className="set-version__caption">
              {!updates ? 'Checking…'
                : updates.newer ? `Quill ${updates.latest} is available.`
                  : `Quill ${updates.current}, you’re up to date.`}
            </span>
            <div className="set-version__actions">
              <Button className="set-version__btn" disabled={busy} onClick={() => void check()}>
                {busy ? 'Checking…' : updates?.newer ? 'Update' : 'Check for updates'}
              </Button>
            </div>
          </div>
        </section>

        <section className="set-tile set-specs-tile">
          <div className="set-tile__top">
            <MonoLabel>SPEECH RECOGNITION</MonoLabel>
            <Pill>{cloud ? 'Cloud' : 'On-device'}</Pill>
          </div>
          <div className="set-specs">
            {specs.map(([k, v], i) => (
              <Fragment key={k}>
                {i > 0 && <div className="set-specs__divider" aria-hidden />}
                <div className="set-spec">
                  <span className="set-spec__key">{k}</span>
                  <span className="set-spec__value">{v}</span>
                </div>
              </Fragment>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}

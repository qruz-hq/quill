import { useCallback, useEffect, useRef, useState } from 'react'
import { fmtBytes, type ModelRow } from '../settings/shared'

/* Setup step 3, "Speech model" (design.pen: Downloading Q3Vux, in the
   background lecqR, Failed QXz2d, Getting ready k6Tda). Everything shown comes
   from the settings and the model store: nothing here is a sample figure. */

export type ModelState =
  /** Settings and the model list are still on their way. */
  | 'checking'
  /** The selected local model is on disk. */
  | 'ready'
  /** Transcription runs in the cloud: no model is needed. */
  | 'cloud'
  | 'downloading'
  | 'failed'
  /** Not on disk and nothing is fetching it (cancelled, or setup was not asked to start it). */
  | 'idle'

export interface SpeechModel {
  state: ModelState
  /** Ready to dictate: installed, or the cloud is in use. */
  ready: boolean
  /** "Small": the catalog label without its "(compressed)" note. */
  name: string
  /** The model file's size in bytes, from the catalog. */
  bytes: number
  multilingual: boolean
  received: number
  total: number
  /** 0 to 100, whole. */
  percent: number
  start: () => void
  /** Stops the download and switches transcription to the cloud. */
  useCloud: () => Promise<void>
}

/**
 * The selected speech model, live. With `autoStart` the download begins as
 * soon as it is known to be missing (first-run setup); main keeps one download
 * per model however often it is asked, and carries on if this screen closes.
 */
export function useSpeechModel(autoStart: boolean): SpeechModel {
  const [engine, setEngine] = useState<'local' | 'cloud' | null>(null)
  const [id, setId] = useState('')
  const [list, setList] = useState<ModelRow[] | null>(null)
  const [job, setJob] = useState<{ state: 'downloading' | 'failed' | 'idle'; received: number; total: number }>(
    { state: 'idle', received: 0, total: 0 })
  const idRef = useRef(id)
  idRef.current = id
  const asked = useRef(false)

  useEffect(() => {
    const m = window.flow.models
    void window.flow.settings.get().then((s) => { setEngine(s.sttEngine); setId(s.model) })
    const refresh = (): void => { void m.list().then((l) => setList(l as ModelRow[])) }
    refresh()
    const offs = [
      m.onProgress((p) => {
        if (p.id === idRef.current) setJob({ state: 'downloading', received: p.received, total: p.total })
      }),
      m.onDone((d) => { if (d.id === idRef.current) refresh() }),
      m.onList((l) => setList(l as ModelRow[])),
      m.onError((e) => { if (e.id === idRef.current) setJob((j) => ({ ...j, state: 'failed' })) }),
      m.onCancelled((d) => { if (d.id === idRef.current) setJob({ state: 'idle', received: 0, total: 0 }) })
    ]
    return () => offs.forEach((off) => off())
  }, [])

  const row = list?.find((x) => x.id === id)
  const known = engine !== null && list !== null
  const installed = !!row?.installed
  const missing = known && engine === 'local' && !!row && !installed

  const start = useCallback((): void => {
    const which = idRef.current
    if (!which) return
    setJob((j) => ({ state: 'downloading', received: j.state === 'downloading' ? j.received : 0, total: j.total }))
    // A failure arrives on onError; the rejection only says the same thing again.
    void window.flow.models.download(which).catch(() => {})
  }, [])

  useEffect(() => {
    if (!autoStart || !missing || asked.current) return
    asked.current = true
    start()
  }, [autoStart, missing, start])

  const useCloud = useCallback(async (): Promise<void> => {
    const which = idRef.current
    if (which) void window.flow.models.cancel(which)
    await window.flow.settings.set({ sttEngine: 'cloud' })
    setEngine('cloud')
  }, [])

  const state: ModelState = !known ? 'checking'
    : engine === 'cloud' ? 'cloud'
      : installed || !row ? 'ready'
        // A download already running in main (started before this screen opened)
        // shows at once, before its next progress report.
        : job.state === 'idle' && row.downloading ? 'downloading'
          : job.state
  const bytes = row?.bytes ?? 0
  const total = job.total || bytes
  const received = Math.min(job.received, total)
  return {
    state,
    ready: state === 'ready' || state === 'cloud',
    name: (row?.label ?? id).replace(/\s*\(.*\)$/, ''),
    bytes,
    multilingual: !!row?.multilingual,
    received,
    total,
    percent: total ? Math.min(100, Math.round((received / total) * 100)) : 0,
    start,
    useCloud
  }
}

/** "Download" (fE38c / J4sxN): amount and percent over the 6 px bar. */
export function Download({ model, className }: { model: SpeechModel; className?: string }): React.JSX.Element {
  return (
    <div className={`ob-dl${className ? ' ' + className : ''}`}>
      <div className="ob-dl__meta">
        <span className="ob-dl__amount">{fmtBytes(model.received)} of {fmtBytes(model.total)}</span>
        <span className="ob-dl__pct">{model.percent}%</span>
      </div>
      <div
        className="ob-dl__bar"
        role="progressbar"
        aria-label={`Downloading ${model.name}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={model.percent}
      >
        <span className="ob-dl__fill" style={{ width: `${model.total ? (model.received / model.total) * 100 : 0}%` }} />
      </div>
    </div>
  )
}

/** "Tile / Try it" while the model is not there yet (vOoAl). */
export function GettingReady({ model }: { model: SpeechModel }): React.JSX.Element {
  const stopped = model.state === 'failed' || model.state === 'idle'
  return (
    <div className="ob-try__stage">
      <span className="ob-mono">ALMOST THERE</span>
      <p className="ob-try__title">
        {stopped ? 'The speech model isn’t here yet.' : 'Getting the speech model ready.'}
      </p>
      {!stopped && <Download model={model} className="ob-dl--tile" />}
      <p className="ob-try__hint">
        {stopped ? 'Open step 3 above to get it, or to use the cloud instead.' : 'You can try it as soon as this finishes.'}
      </p>
    </div>
  )
}

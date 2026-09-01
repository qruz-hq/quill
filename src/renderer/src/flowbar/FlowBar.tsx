import { useCallback, useEffect, useRef, useState } from 'react'
import { GlobeIcon, MicIcon, RecordIcon, NoteIcon, ChevronLeftIcon } from '../shared/icons'
import Waveform from './Waveform'

type Mode = 'idle' | 'expanded' | 'recording'
type Stage = 'idle' | 'transcribing' | 'polishing'

export default function FlowBar(): React.JSX.Element {
  const [mode, setModeState] = useState<Mode>('idle')
  const [error, setError] = useState<string | null>(null)
  const [stage, setStage] = useState<Stage>('idle')
  const recording = mode === 'recording'

  /* The window is resized to fit whatever the bar is showing, so the hover
     target is always real geometry rather than a click-through region. */
  const setMode = useCallback((next: Mode) => {
    setModeState(next)
    window.flow.bar.setMode(next)
  }, [])

  const recordingRef = useRef(recording)
  recordingRef.current = recording

  // Main owns dictation state so the fn hotkey, the button and the tray all
  // stay in sync; the bar just reflects it.
  useEffect(() => {
    return window.flow.dictation.onState((s) => {
      if (s === 'recording') { setStage('idle'); setMode('recording') }
    })
  }, [setMode])

  // The bar stays visible through transcribe/polish so the wait is legible,
  // then closes once the text has actually been inserted.
  useEffect(() => {
    return window.flow.dictation.onStage((next) => {
      setStage(next)
      if (next === 'idle') setMode('idle')
      else setMode('recording')
    })
  }, [setMode])

  useEffect(() => {
    const offError = window.flow.dictation.onError((msg) => {
      setError(msg)
      setStage('idle')          // an error must also stop the spinner
      setMode('expanded')
      setTimeout(() => setError(null), 6000)
    })
    return offError
  }, [])

  const toggleDictation = useCallback(async () => {
    if (recordingRef.current) await window.flow.dictation.stop()
    else await window.flow.dictation.start()
  }, [])

  // Global shortcut fires in main; the bar owns the state machine.
  useEffect(() => window.flow.dictation.onToggle(() => { void toggleDictation() }), [toggleDictation])

  // Esc cancels an in-flight dictation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && recordingRef.current) {
        window.flow.dictation.cancel()
        setMode('expanded')
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [setMode])

  return (
    <div
      className={`bar bar--${mode}`}
      onMouseEnter={() => { if (mode === 'idle') setMode('expanded') }}
      onMouseLeave={() => { if (mode === 'expanded') setMode('idle') }}
    >
      <div className="bar__shell">
        {error && <div className="rec__error">{error}</div>}
        {recording ? (
          <div className="rec">
            {stage === 'idle' ? (
              <button className="rec__pill" onClick={toggleDictation} aria-label="Stop dictation">
                <Waveform />
              </button>
            ) : (
              <div
                className="rec__pill rec__pill--busy"
                role="status"
                aria-label={stage === 'transcribing' ? 'Transcribing' : 'Polishing'}
              >
                <span className="spinner" aria-hidden />
              </div>
            )}
          </div>
        ) : (
          <>
            <span className="bar__collapse" aria-hidden><ChevronLeftIcon /></span>
            <div className="bar__stack">
              <BarButton label="Change language" keycap=""       onClick={() => {}}><GlobeIcon /></BarButton>
              <BarButton label="Dictate" keycap="fn" primary      onClick={toggleDictation}><MicIcon /></BarButton>
              <BarButton label="New note" keycap="Opt+M"          onClick={() => void window.flow.dictation.startVoiceNote()}><RecordIcon /></BarButton>
              <BarButton label="Scratchpad" keycap="⌥ Opt s"      onClick={() => window.flow.pad.open()}><NoteIcon /></BarButton>
            </div>
          </>
        )}
      </div>
      <div className="bar__sliver" aria-hidden />
    </div>
  )
}

function BarButton({ label, keycap, primary, onClick, children }: {
  label: string; keycap: string; primary?: boolean
  onClick: () => void; children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="barbtn__wrap">
      <span className="tooltip">
        {label}{keycap && <b className="tooltip__key">{keycap}</b>}
      </span>
      <button
        className={`barbtn ${primary ? 'barbtn--primary' : ''}`}
        onClick={onClick}
        aria-label={label}
      >
        {children}
      </button>
    </div>
  )
}

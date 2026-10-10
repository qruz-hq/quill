import './toggle.css'

export function Toggle({ on, disabled, onChange, label, className }: {
  on: boolean; disabled?: boolean; onChange: (v: boolean) => void
  /** Accessible name when no visible label is associated. */
  label?: string; className?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={['q-toggle', on && 'is-on', className].filter(Boolean).join(' ')}
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
    >
      <span className="q-toggle__knob" />
    </button>
  )
}

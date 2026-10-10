import type { CSSProperties } from 'react'
import { Icon } from '../icons'
import './select.css'

export type SelectOption = { value: string; label: string; disabled?: boolean }

/** Value + chevron field. Default width 200 (the Atoms node); override with `style={{ width }}`. */
export function Select({ value, options, onChange, disabled, label, className, style }: {
  value: string; options: SelectOption[]; onChange: (v: string) => void
  disabled?: boolean; label?: string; className?: string; style?: CSSProperties
}): React.JSX.Element {
  const current = options.find((o) => o.value === value)
  return (
    <span className={['q-select', disabled && 'is-disabled', className].filter(Boolean).join(' ')} style={style}>
      <span className="q-select__value">{current?.label ?? ''}</span>
      <Icon name="chevron-down" className="q-select__chev" />
      <select
        className="q-select__native"
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
      </select>
    </span>
  )
}

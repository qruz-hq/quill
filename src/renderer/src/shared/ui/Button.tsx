import type { ButtonHTMLAttributes } from 'react'
import { Icon, type IconName } from '../icons'
import './button.css'

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement>

export type ButtonVariant = 'primary' | 'accent' | 'ghost' | 'lime'

/**
 * Pill button. 36 high; `size="sm"` is the 30-high instance used inside banners.
 * `lime` is the Button / Primary shape on $lime with $lime-on ink (Todos "Add" cMgNf).
 */
export function Button({ variant = 'primary', size = 'md', className, type = 'button', ...rest }: BtnProps & {
  variant?: ButtonVariant; size?: 'md' | 'sm'
}): React.JSX.Element {
  const cls = ['q-btn', `q-btn--${variant}`, size === 'sm' && 'q-btn--sm', className].filter(Boolean).join(' ')
  return <button type={type} className={cls} {...rest} />
}

/** Round 32 (or 30) icon-only button. `label` is required: it is the accessible name. */
export function IconButton({ icon, label, size = 'md', active, className, type = 'button', ...rest }: Omit<BtnProps, 'children'> & {
  icon: IconName; label: string; size?: 'md' | 'sm'; active?: boolean
}): React.JSX.Element {
  const cls = ['q-iconbtn', size === 'sm' && 'q-iconbtn--sm', className].filter(Boolean).join(' ')
  return (
    <button type={type} className={cls} aria-label={label} title={label} {...rest}>
      <Icon name={icon} active={active} />
    </button>
  )
}

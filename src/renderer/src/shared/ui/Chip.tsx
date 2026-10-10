import type { HTMLAttributes, ReactNode } from 'react'
import { Icon, type IconName } from '../icons'
import './chip.css'

type SpanProps = HTMLAttributes<HTMLSpanElement>

/** Translucent chip for accent tiles and the Flow Bar (e.g. a snippet trigger "@addr"). */
export function Chip({ className, ...rest }: SpanProps): React.JSX.Element {
  return <span className={['q-chip', className].filter(Boolean).join(' ')} {...rest} />
}

export type StatusTone = 'granted' | 'missing' | 'checking'
const STATUS_ICON: Record<StatusTone, IconName> = { granted: 'check', missing: 'error', checking: 'hourglass' }

/** Permission state chip: check / error / hourglass at 16, tinted by tone. */
export function StatusChip({ tone, children, className, ...rest }: SpanProps & {
  tone: StatusTone; children: ReactNode
}): React.JSX.Element {
  return (
    <span className={['q-status', `q-status--${tone}`, className].filter(Boolean).join(' ')} {...rest}>
      <Icon name={STATUS_ICON[tone]} />
      <span>{children}</span>
    </span>
  )
}

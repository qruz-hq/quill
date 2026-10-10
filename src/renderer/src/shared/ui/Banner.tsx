import type { HTMLAttributes, ReactNode } from 'react'
import { Icon, type IconName } from '../icons'
import './banner.css'

export type BannerTone = 'permission' | 'error' | 'neutral'

/**
 * Pill banner: icon chip, message, then `actions` (siblings of the message,
 * e.g. <Button size="sm">Fix</Button> and <IconButton size="sm" icon="close"/>
 * or <Button size="sm" variant="ghost">Not now</Button>).
 */
export function Banner({ tone = 'permission', icon = 'lock', children, actions, className, ...rest }: HTMLAttributes<HTMLDivElement> & {
  tone?: BannerTone; icon?: IconName; actions?: ReactNode
}): React.JSX.Element {
  const cls = ['q-banner', tone !== 'permission' && `q-banner--${tone}`, className].filter(Boolean).join(' ')
  return (
    <div className={cls} role="status" {...rest}>
      <span className="q-banner__chip"><Icon name={icon} /></span>
      <span className="q-banner__msg">{children}</span>
      {actions}
    </div>
  )
}

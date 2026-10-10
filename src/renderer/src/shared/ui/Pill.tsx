import type { HTMLAttributes } from 'react'
import './pill.css'

type SpanProps = HTMLAttributes<HTMLSpanElement>

/** Static label pill ("On-device", "See Shortcuts"). `on` is the violet selected pill; `small` the 11px one. */
export function Pill({ on = false, small = false, className, ...rest }: SpanProps & {
  on?: boolean; small?: boolean
}): React.JSX.Element {
  const cls = ['q-pill', on && 'q-pill--on', small && 'q-pill--sm', className].filter(Boolean).join(' ')
  return <span className={cls} {...rest} />
}

/** Mono count badge ("12"). */
export function Badge({ tone = 'neutral', className, ...rest }: SpanProps & {
  /** `lime`: Todos Count (vaSxH), $lime-soft fill with $lime ink ($lime-on in light). */
  tone?: 'neutral' | 'lime'
}): React.JSX.Element {
  return <span className={['q-badge', tone !== 'neutral' && `q-badge--${tone}`, className].filter(Boolean).join(' ')} {...rest} />
}

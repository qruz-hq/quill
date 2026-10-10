import type { HTMLAttributes } from 'react'
import './bento.css'

/** The hub body under the title bar. Each screen renders exactly one as its root. */
export function Bento({ direction = 'vertical', className, ...rest }: HTMLAttributes<HTMLDivElement> & {
  /** Hub screens stack rows (vertical); Settings puts the pane list beside the pane (horizontal). */
  direction?: 'vertical' | 'horizontal'
}): React.JSX.Element {
  const cls = ['q-bento', direction === 'horizontal' && 'q-bento--horizontal', className].filter(Boolean).join(' ')
  return <div className={cls} {...rest} />
}

import type { HTMLAttributes, ReactNode } from 'react'
import { Icon, type IconName } from '../icons'
import './tile.css'

export type TileAccent = 'surface' | 'violet' | 'tangerine' | 'lime' | 'cyan' | 'pink'

type DivProps = HTMLAttributes<HTMLDivElement>

/**
 * A bento tile. `accent` picks the fill and the matching "-on" ink; every
 * child that uses currentColor (icons, text) follows the ink automatically.
 * `hero` is the larger Tile / Hero (radius-xl, padding 24).
 */
export function Tile({ accent = 'surface', hero = false, className, ...rest }: DivProps & {
  accent?: TileAccent; hero?: boolean
}): React.JSX.Element {
  const cls = ['q-tile', accent !== 'surface' && `q-tile--${accent}`, hero && 'q-tile--hero', className]
    .filter(Boolean).join(' ')
  return <div className={cls} {...rest} />
}

/**
 * "Top": mono label on the left, a 20 icon (or any node) on the right.
 * `after` sits beside the label in a label group (gap 10), e.g. the Transforms
 * hero's "Beta" chip. The row wraps instead of squeezing the label.
 */
export function TileTop({ label, icon, right, after, className, ...rest }: Omit<DivProps, 'children'> & {
  label: ReactNode; icon?: IconName; right?: ReactNode; after?: ReactNode
}): React.JSX.Element {
  const lab = <span className="q-tile__label">{label}</span>
  return (
    <div className={['q-tile__top', className].filter(Boolean).join(' ')} {...rest}>
      {after != null ? <span className="q-tile__label-group">{lab}{after}</span> : lab}
      {icon ? <Icon name={icon} size={20} className="q-tile__icon" /> : right}
    </div>
  )
}

/** "Bottom": big display value over a body-sm caption. */
export function TileStat({ value, caption, className, ...rest }: Omit<DivProps, 'children'> & {
  value: ReactNode; caption?: ReactNode
}): React.JSX.Element {
  return (
    <div className={['q-tile__stat', className].filter(Boolean).join(' ')} {...rest}>
      <span className="q-tile__value">{value}</span>
      {caption != null && <span className="q-tile__caption">{caption}</span>}
    </div>
  )
}

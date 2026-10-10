import type { HTMLAttributes } from 'react'
import './keycap.css'

/**
 * One key ("fn", "ctrl", "⌥"). Render one Keycap per key; group them with a flex gap.
 * `size="sm"` is the small instance (Flow Bar tooltip / notice keys, dialog esc,
 * Scratchpad key, Atoms "Open Scratchpad" keys): hugs its label, padding 2 7, label 11.
 */
export function Keycap({ size = 'md', className, ...rest }: HTMLAttributes<HTMLElement> & {
  size?: 'md' | 'sm'
}): React.JSX.Element {
  return <kbd className={['q-keycap', size === 'sm' && 'q-keycap--sm', className].filter(Boolean).join(' ')} {...rest} />
}

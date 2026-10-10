import { Icon } from '../shared/icons'
import { useSwapReveal } from './sniptfMotion'
import './snippets.css'

/**
 * "Example" (os8hs / fC5Ad): You say pill, then Quill types pill, on a pink tile.
 * `swap` re-reveals each text when it changes (the hero's most used snippet).
 * Leave it off where the text follows typing, as in the dialog.
 */
export function SnippetExample({ trigger, expansion, swap = false }: {
  trigger: string; expansion: string; swap?: boolean
}): React.JSX.Element {
  const line = expansion.split('\n')[0]
  const trig = useSwapReveal<HTMLSpanElement>(swap ? trigger : null)
  const exp = useSwapReveal<HTMLSpanElement>(swap ? line : null)
  return (
    <div className="snip-example">
      <span className="snip-example__say">
        <Icon name="microphone" size={16} active />
        <span ref={trig} className="snip-example__trigger">“{trigger}”</span>
      </span>
      <Icon name="arrow-right" size={16} className="snip-example__arrow" />
      <span className="snip-example__types">
        <span ref={exp} className="snip-example__expansion">{line}</span>
      </span>
    </div>
  )
}

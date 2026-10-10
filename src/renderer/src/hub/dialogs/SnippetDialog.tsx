import { useCallback, useState } from 'react'
import { Icon } from '../../shared/icons'
import { Button } from '../../shared/ui'
import { DialogFrame, EscHint, type DialogMotion } from './DialogFrame'
import { Press } from '../sniptfMotion'
import { SnippetExample } from '../SnippetExample'
import './snippet-dialog.css'

export type Snippet = {
  id: string; trigger: string; expansion: string; enabled: boolean
  /** Counted in main: lifetime uses, the last use, and one timestamp per use of the last 7 days. */
  uses?: number; lastUsedAt?: number; usedAt?: number[]
}

/** "Dialog, New snippet" (VnBia); the same frame edits an existing snippet. */
export default function SnippetDialog({ snippet, onClose, onSave, motion }: {
  snippet: Snippet; onClose: () => void; onSave: (s: Snippet) => void; motion?: DialogMotion
}): React.JSX.Element {
  const [trigger, setTrigger] = useState(snippet.trigger)
  const [expansion, setExpansion] = useState(snippet.expansion)
  const valid = !!trigger.trim() && !!expansion.trim()
  const save = useCallback(() => {
    if (valid) onSave({ ...snippet, trigger: trigger.trim(), expansion })
  }, [valid, snippet, trigger, expansion, onSave])

  return (
    <DialogFrame
      accent="pink"
      label="SNIPPETS"
      headline={snippet.id ? 'Edit snippet' : 'New snippet'}
      lead={<SnippetExample trigger={trigger.trim() || 'my email address'} expansion={expansion.trim() || 'you@example.com'} />}
      onClose={onClose}
      onSubmit={save}
      motion={motion}
      footer={<>
        <EscHint />
        <div className="dlg__actions">
          <Press><Button variant="ghost" onClick={onClose}>Cancel</Button></Press>
          <Press>
            <Button className="dlg__save" disabled={!valid} onClick={save}>
              {snippet.id ? 'Save changes' : 'Save snippet'}
            </Button>
          </Press>
        </div>
      </>}
    >
      <div className="dlg__tile snipdlg__form">
        <label className="dlg__field">
          <span className="dlg__label">WHEN I SAY</span>
          <span className="dlg__input snipdlg__say">
            <Icon name="microphone" size={16} className="snipdlg__mic" />
            <input
              value={trigger}
              onChange={(e) => setTrigger(e.target.value)}
              placeholder="my email address"
              autoFocus
            />
          </span>
          <span className="dlg__hint">Say it anywhere in a sentence: Quill swaps in the full text.</span>
        </label>
        <label className="dlg__field">
          <span className="dlg__label">QUILL TYPES</span>
          <span className="dlg__input snipdlg__area">
            <textarea value={expansion} onChange={(e) => setExpansion(e.target.value)} placeholder="you@example.com" />
          </span>
        </label>
      </div>
    </DialogFrame>
  )
}

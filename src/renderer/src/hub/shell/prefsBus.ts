/** The hub has two writers of `micUid` (the title-bar mic picker and
 *  Settings › Dictation). settings:set has no change broadcast, so each writer
 *  announces the saved prefs here and the other one follows. */
const EVT = 'quill:prefs'

export function emitPrefs(prefs: { micUid?: string }): void {
  window.dispatchEvent(new CustomEvent(EVT, { detail: prefs }))
}

export function onPrefs(cb: (prefs: { micUid?: string }) => void): () => void {
  const h = (e: Event): void => cb((e as CustomEvent).detail)
  window.addEventListener(EVT, h)
  return () => window.removeEventListener(EVT, h)
}

/** Hub toasts: any screen calls `showToast`, the one `<ToastHost>` in App shows it.
 *  One toast at a time: a new one replaces the one on screen (docs/MOTION.md §4.10). */
const EVT = 'quill:toast'

export function showToast(message: string): void {
  window.dispatchEvent(new CustomEvent(EVT, { detail: message }))
}

export function onToast(cb: (message: string) => void): () => void {
  const h = (e: Event): void => cb((e as CustomEvent).detail)
  window.addEventListener(EVT, h)
  return () => window.removeEventListener(EVT, h)
}

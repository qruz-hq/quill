/* Renderer-side copy of TransformStore.apply (src/main/transforms.ts), so the
   transform dialog and cards can preview an unsaved or edited rule live. The
   transforms:preview IPC only works on a saved transform with its saved
   config. Keep this in step with the main-process version. */

export type Kind = 'template' | 'bullets' | 'join' | 'case'
export type Transform = {
  id: string; name: string; description: string; slot: number; kind: Kind; config: string
  /** Times ⌥<slot> applied it, and when it last did (counted in main). */
  uses?: number; lastUsedAt?: number
}

/** One sample dictation per rule, shown as "You say" in the preview. */
export const SAMPLES: Record<Kind, string> = {
  template: 'We agreed to move the launch to the 14th and Marta sends the deck.',
  bullets: 'Book flights to Lisbon and send Marta the deck.',
  join: 'We met Tuesday, agreed the scope,\nand set Friday as the deadline.',
  case: 'could you please share the figures by thursday?'
}

export function applyTransform(t: Pick<Transform, 'kind' | 'config'>, text: string): string {
  switch (t.kind) {
    case 'template':
      return t.config.includes('{text}') ? t.config.replace(/\{text\}/g, text) : `${t.config}\n\n${text}`
    case 'join':
      return text.replace(/\s*\n+\s*/g, ' ').replace(/ {2,}/g, ' ').trim()
    case 'case':
      if (t.config === 'upper') return text.toUpperCase()
      if (t.config === 'lower') return text.toLowerCase()
      return titleCase(text)
    case 'bullets':
      return toBullets(text)
  }
}

const MINOR = new Set(['a','an','and','as','at','but','by','for','in','of','on','or','the','to','with'])

function titleCase(s: string): string {
  return s.split(/(\s+)/).map((w, i) => {
    const bare = w.toLowerCase()
    if (i > 0 && MINOR.has(bare.replace(/[^a-z]/g, ''))) return bare
    return w.replace(/^([a-z])/, (c) => c.toUpperCase())
  }).join('')
}

function toBullets(text: string): string {
  const trimmed = text.trim().replace(/[.]$/, '')
  const parts = trimmed
    .split(/,| and (?=[^,]*$)/i)
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length < 2) return text

  let lead = ''
  const first = parts[0]
  const m = first.match(/^(.*?\b(?:buy|get|need|want|grab|are|include|order|bring|do)\b)\s+(.+)$/i)
  if (m) { lead = m[1]; parts[0] = m[2] }

  const bullets = parts
    .map((p) => p.replace(/^(and|or)\s+/i, ''))
    .map((p) => `- ${p.charAt(0).toUpperCase()}${p.slice(1)}`)
    .join('\n')
  return lead ? `${lead}:\n${bullets}` : bullets
}

/** Slot n's accent, cycling the five tile accents (⌥1 lime, ⌥2 violet, …). */
export const ACCENTS = ['lime', 'violet', 'cyan', 'pink', 'tangerine'] as const
export type Accent = (typeof ACCENTS)[number]
export const slotAccent = (slot: number): Accent => ACCENTS[(Math.max(1, slot) - 1) % ACCENTS.length]

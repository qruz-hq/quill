import { app, shell, dialog, BrowserWindow } from 'electron'

const RELEASES_API = (repo: string): string => `https://api.github.com/repos/${repo}/releases/latest`

/**
 * Checks GitHub Releases and tells the user when a newer build exists.
 *
 * Deliberately notify-only rather than electron-updater: Squirrel.Mac verifies
 * the signature of a downloaded build before applying it, so an ad-hoc signed
 * app cannot update itself. Once the app is signed with a Developer ID, swap
 * this for autoUpdater — see docs/RELEASING.md.
 */
export type UpdateInfo = {
  current: string
  latest?: string
  url?: string
  notes?: string
  newer: boolean
}

export async function checkForUpdate(repo: string): Promise<UpdateInfo> {
  const current = app.getVersion()
  try {
    const res = await fetch(RELEASES_API(repo), {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'flow-updater' }
    })
    if (!res.ok) return { current, newer: false }
    const json = await res.json()
    const latest = String(json.tag_name ?? '').replace(/^v/, '')
    if (!latest) return { current, newer: false }
    return {
      current,
      latest,
      url: json.html_url,
      notes: typeof json.body === 'string' ? json.body : undefined,
      newer: isNewer(latest, current)
    }
  } catch {
    return { current, newer: false }
  }
}

/** Only ask once per launch, however often the periodic check runs. */
let askedThisLaunch = false

/**
 * Asks whether to update. A dialog rather than a notification because a
 * notification is easy to miss and offers no way to decline permanently.
 */
export async function promptIfNewer(
  repo: string,
  opts: { skippedVersion?: string; onSkip?: (v: string) => void; force?: boolean } = {}
): Promise<UpdateInfo> {
  const r = await checkForUpdate(repo)
  if (!r.newer || !r.url || !r.latest) return r
  if (!opts.force) {
    if (askedThisLaunch) return r
    if (opts.skippedVersion === r.latest) return r   // user asked not to be told again
  }
  askedThisLaunch = true

  // First line of the release notes, if it reads like prose rather than markup.
  const firstLine = (r.notes ?? '').split('\n').map((l) => l.trim())
    .find((l) => l && !l.startsWith('#') && !l.startsWith('```')) ?? ''

  const { response, checkboxChecked } = await dialog.showMessageBox(
    BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.isVisible()) ??
      (undefined as unknown as BrowserWindow),
    {
      type: 'info',
      title: 'Update available',
      message: `Quill ${r.latest} is available`,
      detail: `You are running ${r.current}.` + (firstLine ? `\n\n${firstLine}` : ''),
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
      checkboxLabel: `Skip version ${r.latest}`,
      checkboxChecked: false,
      noLink: true
    }
  )

  if (checkboxChecked && r.latest) opts.onSkip?.(r.latest)
  if (response === 0) void shell.openExternal(r.url)
  return r
}

/** Semver compare, tolerant of missing segments. */
function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

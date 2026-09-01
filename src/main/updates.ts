import { app, shell, Notification } from 'electron'

const RELEASES_API = (repo: string): string => `https://api.github.com/repos/${repo}/releases/latest`

/**
 * Checks GitHub Releases and tells the user when a newer build exists.
 *
 * Deliberately notify-only rather than electron-updater: Squirrel.Mac verifies
 * the signature of a downloaded build before applying it, so an ad-hoc signed
 * app cannot update itself. Once the app is signed with a Developer ID, swap
 * this for autoUpdater — see docs/RELEASING.md.
 */
export async function checkForUpdate(repo: string): Promise<{
  current: string
  latest?: string
  url?: string
  newer: boolean
}> {
  const current = app.getVersion()
  try {
    const res = await fetch(RELEASES_API(repo), {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'flow-updater' }
    })
    if (!res.ok) return { current, newer: false }
    const json = await res.json()
    const latest = String(json.tag_name ?? '').replace(/^v/, '')
    if (!latest) return { current, newer: false }
    return { current, latest, url: json.html_url, newer: isNewer(latest, current) }
  } catch {
    return { current, newer: false }
  }
}

export function notifyIfNewer(repo: string): void {
  void checkForUpdate(repo).then((r) => {
    if (!r.newer || !r.url) return
    const n = new Notification({
      title: `Flow ${r.latest} is available`,
      body: `You are on ${r.current}. Click to open the release.`
    })
    n.on('click', () => shell.openExternal(r.url!))
    n.show()
  })
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

import { app, shell, dialog, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'

const RELEASES_API = (repo: string): string => `https://api.github.com/repos/${repo}/releases/latest`

/**
 * Checks GitHub Releases and tells the user when a newer build exists.
 *
 * Where the app can replace itself, accepting downloads the update in the
 * background and offers a restart (electron-updater). That needs a packaged
 * app: on macOS one signed with a Developer ID, since Squirrel.Mac refuses
 * anything else, on Windows the installed build, on Linux the AppImage. Every
 * other case (dev, a deb install, a failed download) opens the release page.
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
      buttons: [canSelfUpdate() ? 'Update' : 'Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
      checkboxLabel: `Skip version ${r.latest}`,
      checkboxChecked: false,
      noLink: true
    }
  )

  if (checkboxChecked && r.latest) opts.onSkip?.(r.latest)
  if (response === 0) {
    if (canSelfUpdate()) void selfUpdate(r.latest, r.url)
    else void shell.openExternal(r.url)
  }
  return r
}

/** True when this build can download and apply an update by itself. */
function canSelfUpdate(): boolean {
  if (!app.isPackaged) return false
  if (process.platform === 'linux') return Boolean(process.env.APPIMAGE)
  return process.platform === 'darwin' || process.platform === 'win32'
}

let updating = false

/**
 * Downloads the update, then offers a restart. Declining leaves it to install
 * when the app next quits. Any failure falls back to the release page, so a
 * build that cannot verify the download still gets the user there.
 */
async function selfUpdate(version: string, url: string): Promise<void> {
  if (updating) return
  updating = true
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null
  try {
    const found = await autoUpdater.checkForUpdates()
    if (!found?.isUpdateAvailable) throw new Error('the update feed has no newer version')
    await autoUpdater.downloadUpdate()
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'Update ready',
      message: `Quill ${version} is ready to install`,
      detail: 'Restart now, or it installs the next time you quit Quill.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    })
    if (response === 0) autoUpdater.quitAndInstall()
  } catch (err) {
    console.error(`[updates] self-update failed: ${err instanceof Error ? err.message : String(err)}`)
    void shell.openExternal(url)
  } finally {
    updating = false
  }
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

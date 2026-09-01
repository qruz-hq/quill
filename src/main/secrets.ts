import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, chmodSync } from 'fs'

/**
 * API keys on disk, owner-read-only, like ~/.aws/credentials.
 *
 * Deliberately not the system keychain: safeStorage ties its keychain item to
 * the app's code signature, so every rebuild looked like a new app and macOS
 * demanded the login password on each launch.
 */
export class Secrets {
  constructor(private readonly name: string, private readonly envVar?: string) {}

  private get file(): string {
    const dir = app.getPath('userData')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return join(dir, `${this.name}.key`)
  }

  has(): boolean {
    return existsSync(this.file) || !!process.env[this.envVar ?? '']?.trim()
  }

  get(): string | null {
    if (existsSync(this.file)) {
      try {
        const k = readFileSync(this.file, 'utf8').trim()
        if (k) return k
      } catch { /* fall through to the env var */ }
    }
    return (this.envVar ? process.env[this.envVar]?.trim() : null) || null
  }

  set(plain: string): void {
    if (!plain.trim()) { this.clear(); return }
    writeFileSync(this.file, plain.trim(), { mode: 0o600 })
    chmodSync(this.file, 0o600)   // tighten if the file already existed
  }

  clear(): void {
    if (existsSync(this.file)) unlinkSync(this.file)
  }

  /** Safe to show in the UI — never the real value. */
  masked(): string | null {
    const k = this.get()
    return k ? `…${k.slice(-4)}` : null
  }
}

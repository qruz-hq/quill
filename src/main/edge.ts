import { screen, type BrowserWindow } from 'electron'

const TICK_MS = 50
const ZONE_PX = 4
const DWELL_MS = 350   // HOLD.dwell (docs/MOTION.md §4.12)
/** How long the cursor must be outside before the window closes. Stops a
 *  one-frame excursion past the border from slamming it shut. */
const LEAVE_MS = 300

type Handlers = {
  open: (cursor: { x: number; y: number }) => void
  close: () => void
  /** The cursor came back while the window was playing its exit. */
  reenter?: () => void
  log?: (line: string) => void
}

type Rect = { x: number; y: number; width: number; height: number }

/**
 * Watches for the cursor resting on the left edge of whichever display it is
 * on, and for it leaving the window once open.
 *
 * Polling rather than an event tap: Electron has no global mouse-move event,
 * and asking the Swift helper to forward every motion event over stdio would
 * be far more traffic than a 20Hz read of `getCursorScreenPoint`, which is a
 * single syscall.
 *
 * The dwell cancels the moment the cursor leaves the strip, so brushing the
 * edge on the way to the Dock or a menu does nothing. And once open, the
 * gutter between the screen edge and the window counts as inside, the
 * natural motion is to slide from the edge into the list, and that path
 * must not trip the close.
 */
export class EdgeDwell {
  private timer: ReturnType<typeof setInterval> | null = null
  private dwellSince: number | null = null
  private outsideSince: number | null = null
  /** Cleared on close; the cursor must leave the zone before it can re-trigger. */
  private armed = true
  private window: BrowserWindow | null = null
  private pinned = false
  private enabled = true
  /** Bounds the window just shrank from; still "inside" while the cursor rests in them. */
  private held: Rect | null = null
  /** The window is animating out (close handshake); coming back cancels it. */
  private closing = false
  /** The cursor has been outside since the exit began, so a return is a real re-entry. */
  private reenterArmed = false

  constructor(private readonly on: Handlers) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), TICK_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  setEnabled(v: boolean): void {
    this.enabled = v
    this.dwellSince = null
  }

  /** The window whose bounds define "inside" while it is open. */
  attach(win: BrowserWindow | null): void {
    this.window = win
    this.outsideSince = null
    this.held = null
    this.closing = false
    if (!win) this.armed = false
  }

  /**
   * The window is about to shrink (the date picker closed) and the cursor may
   * sit in the part that disappears. Those bounds keep counting as inside
   * until the cursor moves out of them or into the smaller window, so the
   * shrink by itself never reads as "the cursor left".
   */
  holdBounds(bounds: Rect): void {
    this.held = bounds
    this.outsideSince = null
  }

  /**
   * The exit began. A close from the leave check has the cursor outside
   * already; one from the close button has it on the panel, and that must not
   * count as coming back until it has left once.
   */
  beginClose(): void {
    this.closing = true
    this.reenterArmed = false
    this.outsideSince = null
  }

  /** The exit was called off (or finished without closing). */
  endClose(): void {
    this.closing = false
    this.outsideSince = null
  }

  setPinned(v: boolean): void {
    this.pinned = v
    this.outsideSince = null
  }

  get isPinned(): boolean {
    return this.pinned
  }

  /** Inside the window, or in the gutter between the screen edge and it. */
  private within(b: Rect, cursor: { x: number; y: number }, left: number): boolean {
    return cursor.x >= left && cursor.x <= b.x + b.width && cursor.y >= b.y && cursor.y <= b.y + b.height
  }

  private tick(): void {
    const cursor = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(cursor)
    const inZone = cursor.x >= display.bounds.x && cursor.x < display.bounds.x + ZONE_PX
    const win = this.window && !this.window.isDestroyed() ? this.window : null

    if (win) {
      if (this.closing) {
        if (!this.within(win.getBounds(), cursor, display.bounds.x)) { this.reenterArmed = true; return }
        if (!this.reenterArmed) return
        this.closing = false
        this.on.log?.(`[edge] cursor came back during the exit`)
        this.on.reenter?.()
        return
      }
      if (this.pinned) return
      // Until the window has actually been shown its bounds are not reliable,
      // and judging "outside" against them would close it 300ms after opening.
      if (!win.isVisible()) { this.outsideSince = null; return }
      if (this.within(win.getBounds(), cursor, display.bounds.x)) {
        this.held = null
        this.outsideSince = null
        return
      }
      if (this.held) {
        if (this.within(this.held, cursor, display.bounds.x)) { this.outsideSince = null; return }
        this.held = null
      }
      this.outsideSince ??= Date.now()
      if (Date.now() - this.outsideSince >= LEAVE_MS) {
        this.outsideSince = null
        this.on.log?.(`[edge] cursor left, closing`)
        this.on.close()
      }
      return
    }

    if (!this.enabled) return
    if (!inZone) { this.dwellSince = null; this.armed = true; return }
    if (!this.armed) return
    if (this.dwellSince === null) {
      this.dwellSince = Date.now()
      this.on.log?.(`[edge] entered zone at ${cursor.x},${cursor.y} on display ${display.id}`)
    }
    if (Date.now() - this.dwellSince >= DWELL_MS) {
      this.dwellSince = null
      this.armed = false
      this.on.log?.(`[edge] dwell fired`)
      this.on.open(cursor)
    }
  }
}

import { BrowserWindow, app, shell } from 'electron'
import path from 'path'
import { IPC } from '@shared/ipc'

/**
 * Window lifecycle manager.
 *
 * - Tracks every BrowserWindow with a stable windowId + kind.
 * - Main windows host the repo grid / tabbed terminal UI.
 * - Terminal windows host a single session (windows mode). On macOS they
 *   share a native tab group (`tabbingIdentifier`).
 * - broadcast() pushes main→renderer events to every window; the renderer
 *   filters by sessionId/windowId.
 */

interface TrackedWindow {
  id: string
  kind: 'main' | 'terminal'
  sessionId?: string
  win: BrowserWindow
}

const isDev = !app.isPackaged

class WindowManager {
  private windows = new Map<string, TrackedWindow>()

  create(kind: 'main' | 'terminal', sessionId?: string, title?: string): string {
    const isTerminal = kind === 'terminal'

    const win = new BrowserWindow({
      width: isTerminal ? 1100 : 1280,
      height: isTerminal ? 760 : 860,
      minWidth: 480,
      minHeight: 360,
      title: title ?? 'Delta-V',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      trafficLightPosition: { x: 12, y: 12 },
      // Native tabbing for terminal windows on macOS
      tabbingIdentifier: isTerminal ? 'deltav-terminal' : undefined,
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false
      }
    })

    const windowId = `win-${win.id}`
    const tracked: TrackedWindow = { id: windowId, kind, sessionId, win }
    this.windows.set(windowId, tracked)

    win.on('closed', () => this.windows.delete(windowId))

    // External links → system browser, never in-app navigation
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http://') || url.startsWith('https://')) {
        void shell.openExternal(url)
      }
      return { action: 'deny' }
    })

    if (isDev) {
      const params = new URLSearchParams()
      if (isTerminal && sessionId) params.set('sessionId', sessionId)
      if (isTerminal) params.set('windowId', windowId)
      const qs = params.size > 0 ? `?${params.toString()}` : ''
      void win.loadURL(`${process.env.ELECTRON_RENDERER_URL ?? 'http://localhost:5173'}${qs}`)
    } else {
      void win.loadFile(path.join(__dirname, '../renderer/index.html'), {
        query: isTerminal && sessionId ? { windowId, sessionId } : undefined
      })
    }

    return windowId
  }

  close(windowId: string): void {
    const tracked = this.windows.get(windowId)
    if (tracked && !tracked.win.isDestroyed()) tracked.win.close()
  }

  get(windowId: string): TrackedWindow | undefined {
    return this.windows.get(windowId)
  }

  bySession(sessionId: string): TrackedWindow | undefined {
    return [...this.windows.values()].find((w) => w.sessionId === sessionId)
  }

  all(): TrackedWindow[] {
    return [...this.windows.values()]
  }

  mainWindows(): TrackedWindow[] {
    return this.all().filter((w) => w.kind === 'main')
  }

  firstMainWindowId(): string | undefined {
    return this.mainWindows()[0]?.id
  }

  /**
   * Broadcast a main→renderer event to every window (all kinds).
   * Terminal events carry a sessionId so the renderer can filter.
   */
  broadcast(channel: string, payload: unknown): void {
    for (const tracked of this.windows.values()) {
      if (!tracked.win.isDestroyed()) {
        tracked.win.webContents.send(channel, payload)
      }
    }
  }

  broadcastToMain(channel: string, payload: unknown): void {
    for (const tracked of this.mainWindows()) {
      if (!tracked.win.isDestroyed()) {
        tracked.win.webContents.send(channel, payload)
      }
    }
  }

  /** A window requested a sidebar toggle — mirror to all windows. */
  toggleSidebar(): void {
    this.broadcast(IPC.windowToggleSidebar, {})
  }

  activeCount(): number {
    return this.windows.size
  }
}

export const windowManager = new WindowManager()

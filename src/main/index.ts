import { app, BrowserWindow } from 'electron'
import { agentService } from './agents'
import { registerIpcHandlers } from './ipc'
import { ptyManager } from './pty'
import { remoteBridge } from './remoteBridge'
import { scannerService } from './scanner'
import { settingsService } from './settings'
import { windowManager } from './windows'

/**
 * App entry: lifecycle, single-instance lock, quit-time PTY cleanup.
 */

// Prevent GPU issues in packaged builds on some Linux drivers
app.commandLine.appendSwitch('disable-gpu-sandbox')

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const main = windowManager.mainWindows()[0]
    if (main && !main.win.isDestroyed()) {
      if (main.win.isMinimized()) main.win.restore()
      main.win.focus()
    }
  })

  void app.whenReady().then(() => {
    // safeStorage requires the app to be ready; this also migrates any secret
    // env values still sitting in the plaintext settings file.
    settingsService.initSecrets()

    registerIpcHandlers()
    remoteBridge.attach()
    void remoteBridge.apply()

    // Warm caches: settings, roots, agents
    settingsService.get()
    scannerService.syncRoots()
    agentService.list()

    if (windowManager.activeCount() === 0) {
      windowManager.create('main')
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        windowManager.create('main')
      }
    })
  })

  // macOS: stay resident like standard apps; other platforms quit on last window
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  // Kill every PTY before the process dies — no orphaned agents
  let quitting = false
  app.on('before-quit', (e) => {
    if (quitting) return
    quitting = true
    e.preventDefault()
    void remoteBridge
      .stop()
      .catch(() => undefined)
      .then(() => ptyManager.killAll())
      .catch(() => undefined)
      .finally(() => app.quit())
  })

  process.on('exit', () => {
    // Hard fallback: SIGKILL any pids we still track
    for (const pid of ptyManager.livePids()) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // ignore
      }
    }
  })
}

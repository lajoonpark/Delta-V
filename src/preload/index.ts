import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import type { DeltaVApi } from '@shared/api'
import type { Result } from '@shared/types'

/**
 * Secure preload bridge.
 *
 * Exposes exactly one object on `window.deltav`, typed as `DeltaVApi`
 * (see src/shared/api.ts — the complete contract the renderer needs).
 *
 * contextIsolation is on, nodeIntegration is off — the renderer never
 * touches Node/Electron APIs directly. Every channel used here is handled
 * in src/main/ipc.ts; there is deliberately no generic `invoke(name, ...)`
 * escape hatch.
 *
 * Convention: invoke handlers on the main side return `Result<T>`; this
 * bridge unwraps them so renderer methods resolve to `T` and reject with
 * the error message on failure.
 */

// Whitelisted main→renderer event channels
const EVENT_CHANNELS = new Set<string>([
  IPC.terminalData,
  IPC.terminalExit,
  IPC.terminalTitle,
  IPC.terminalStatus,
  IPC.folderScanProgress,
  IPC.folderScanComplete,
  IPC.gridInvalidate,
  IPC.indexProgress,
  IPC.indexComplete,
  IPC.remoteStatusChanged
])

function on(channel: string, cb: (payload: unknown) => void): () => void {
  if (!EVENT_CHANNELS.has(channel)) {
    throw new Error(`[deltav] channel not whitelisted: ${channel}`)
  }
  const handler = (_e: Electron.IpcRendererEvent, payload: unknown): void => {
    try {
      cb(payload)
    } catch (err) {
      console.error(`[deltav] listener error on ${channel}:`, err)
    }
  }
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

/** Unwrap a main-process Result into data, or throw with its error message. */
function unwrap<T>(p: Promise<Result<T>>): Promise<T> {
  return p.then((r) => {
    if (r && typeof r === 'object' && 'ok' in (r as object)) {
      if (!r.ok) throw new Error(r.error ?? 'unknown error')
      return r.data as T
    }
    return r as unknown as T
  })
}

const api: DeltaVApi = {
  // ── settings ──────────────────────────────────────────────────────────
  getSettings: () => unwrap(ipcRenderer.invoke(IPC.settingsGet)),
  setSettings: (partial) => unwrap(ipcRenderer.invoke(IPC.settingsSet, partial)),
  resetSettings: () => unwrap(ipcRenderer.invoke(IPC.settingsReset)),

  // ── folders ───────────────────────────────────────────────────────────
  addFolders: () => unwrap(ipcRenderer.invoke(IPC.foldersAdd)),
  listFolders: () => unwrap(ipcRenderer.invoke(IPC.rootsList)),
  removeFolder: (rootFolderId) => unwrap(ipcRenderer.invoke(IPC.foldersRemove, rootFolderId)),
  scanFolder: (rootFolderId) =>
    unwrap(ipcRenderer.invoke(IPC.foldersScan, rootFolderId)).then(() => undefined),
  scanAllFolders: () => unwrap(ipcRenderer.invoke(IPC.foldersScan)).then(() => undefined),

  // ── agents ────────────────────────────────────────────────────────────
  listAgents: () => unwrap(ipcRenderer.invoke(IPC.agentsList)),
  addAgent: (payload) => unwrap(ipcRenderer.invoke(IPC.agentsAdd, payload)),
  updateAgent: (agent) => unwrap(ipcRenderer.invoke(IPC.agentsUpdate, agent)),
  deleteAgent: (agentId) => unwrap(ipcRenderer.invoke(IPC.agentsDelete, agentId)),
  toggleBuiltinAgent: (agentId, disabled) =>
    unwrap(ipcRenderer.invoke(IPC.agentsToggleBuiltin, agentId, disabled)),
  setAgentTabLabel: (agentId, label) =>
    unwrap(ipcRenderer.invoke(IPC.agentsSetTabLabel, agentId, label)),

  // ── repo tiles ────────────────────────────────────────────────────────
  listTiles: () => unwrap(ipcRenderer.invoke(IPC.tilesList)),

  // ── repo index ────────────────────────────────────────────────────────
  indexStatus: (repoTileId) => unwrap(ipcRenderer.invoke(IPC.indexStatus, repoTileId)),
  reindexRepo: (repoTileId) =>
    unwrap(ipcRenderer.invoke(IPC.indexReindex, repoTileId)).then(() => undefined),
  searchRepo: (req) => unwrap(ipcRenderer.invoke(IPC.indexSearch, req)),
  removeIndex: (repoTileId) => unwrap(ipcRenderer.invoke(IPC.indexRemove, repoTileId)),

  // ── terminal ──────────────────────────────────────────────────────────
  spawnTerminal: (req) => unwrap(ipcRenderer.invoke(IPC.terminalSpawn, req)),
  terminalInput: (sessionId, data) => ipcRenderer.send(IPC.terminalInput, sessionId, data),
  terminalResize: (sessionId, cols, rows) =>
    unwrap(ipcRenderer.invoke(IPC.terminalResize, sessionId, cols, rows)),
  killTerminal: (sessionId) => unwrap(ipcRenderer.invoke(IPC.terminalKill, sessionId)),
  listSessions: () => unwrap(ipcRenderer.invoke(IPC.terminalList)),

  // ── windows ───────────────────────────────────────────────────────────
  createWindow: (kind) => unwrap(ipcRenderer.invoke(IPC.windowCreate, kind)),
  closeWindow: (windowId) => unwrap(ipcRenderer.invoke(IPC.windowClose, windowId)),
  toggleSidebar: () => ipcRenderer.send(IPC.windowToggleSidebar),

  // ── remote ────────────────────────────────────────────────────
  getRemoteStatus: () => unwrap(ipcRenderer.invoke(IPC.remoteStatus)),
  configureRemote: (payload) => unwrap(ipcRenderer.invoke(IPC.remoteConfigure, payload)),
  regenerateRemoteToken: () => unwrap(ipcRenderer.invoke(IPC.remoteRegenerateToken)),

  // ── main → renderer events ────────────────────────────────────────────
  onTerminalData: (cb) =>
    on(IPC.terminalData, (p) =>
      cb(p as { sessionId: string; data: string })
    ),
  onTerminalExit: (cb) => on(IPC.terminalExit, (p) => cb(p as never)),
  onTerminalTitle: (cb) => on(IPC.terminalTitle, (p) => cb(p as never)),
  onTerminalStatus: (cb) => on(IPC.terminalStatus, (p) => cb(p as never)),
  onScanProgress: (cb) => on(IPC.folderScanProgress, (p) => cb(p as never)),
  onScanComplete: (cb) => on(IPC.folderScanComplete, (p) => cb(p as never)),
  onGridInvalidate: (cb) => on(IPC.gridInvalidate, () => cb()),
  onIndexProgress: (cb) => on(IPC.indexProgress, (p) => cb(p as never)),
  onIndexComplete: (cb) => on(IPC.indexComplete, (p) => cb(p as never)),
  onRemoteStatus: (cb) => on(IPC.remoteStatusChanged, (p) => cb(p as never))
}

contextBridge.exposeInMainWorld('deltav', api)

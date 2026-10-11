import type {
  AgentDefinition,
  AppSettings,
  NewAgentPayload,
  RepoIndexCompleteEvent,
  RepoIndexProgress,
  RepoIndexStatus,
  RepoSearchRequest,
  RepoSearchResponse,
  RepoTile,
  RootFolder,
  ScanProgress,
  ScanResult,
  SpawnRequest,
  SpawnResult,
  TerminalExitEvent,
  TerminalSessionInfo,
  TerminalStatusEvent,
  TerminalTitleEvent
} from './types'

/**
 * The typed API exposed to the renderer on `window.deltav`.
 *
 * This is the complete surface the UI (design agent) needs — nothing else
 * should be accessed. All methods return promises; all main→renderer events
 * are delivered through the `on*` subscription methods, which return an
 * unsubscribe function.
 */
export interface DeltaVApi {
  // ── settings ──────────────────────────────────────────────────────────
  /**
   * All settings. Secret custom-agent env values are returned as `SECRET_MASK`
   * (never the real value); `secretStorageEncrypted` reports whether the OS
   * encryption backend is available.
   */
  getSettings(): Promise<AppSettings>
  setSettings(partial: Partial<AppSettings>): Promise<AppSettings>
  resetSettings(): Promise<AppSettings>

  // ── root folders ──────────────────────────────────────────────────────
  /** Native folder picker (multi-select). Returns chosen folders, already added. */
  addFolders(): Promise<RootFolder[]>
  /** Returns currently configured root folders. */
  listFolders(): Promise<RootFolder[]>
  /** Remove a root folder by id. */
  removeFolder(rootFolderId: string): Promise<void>
  /** Rescan a root folder; children arrive via onScanComplete. */
  scanFolder(rootFolderId: string): Promise<void>
  /** Rescan all root folders. */
  scanAllFolders(): Promise<void>

  // ── agents ────────────────────────────────────────────────────────────
  /**
   * All agents. Custom-agent secret env values are masked (`SECRET_MASK`) and
   * listed in `secretKeys`; the real values never reach the renderer.
   */
  listAgents(): Promise<AgentDefinition[]>
  addAgent(payload: NewAgentPayload): Promise<AgentDefinition>
  updateAgent(agent: AgentDefinition): Promise<void>
  deleteAgent(agentId: string): Promise<void>
  /** enable/disable a built-in agent. builtin=true means disabled. */
  toggleBuiltinAgent(agentId: string, disabled: boolean): Promise<void>
  /** Change the letter(s) used as the default-tab-name prefix for any agent. */
  setAgentTabLabel(agentId: string, label: string): Promise<void>

  // ── repo tiles ────────────────────────────────────────────────────────
  /** All cached repo tiles (post-scan), sorted per settings.sortOrder. */
  listTiles(): Promise<RepoTile[]>

  // ── repo index (local LanceDB full-text index per repo) ───────────────
  /** Index status for one repo, or every known repo when omitted. */
  indexStatus(repoTileId?: string): Promise<RepoIndexStatus[]>
  /** Kick off (re)indexing of a repo in the background. */
  reindexRepo(repoTileId: string): Promise<void>
  /** Full-text search over a repo's indexed contents. */
  searchRepo(req: RepoSearchRequest): Promise<RepoSearchResponse>
  /** Drop a repo's index. */
  removeIndex(repoTileId: string): Promise<void>

  // ── terminal ──────────────────────────────────────────────────────────
  /** Spawn an agent terminal for a repo tile. Mode resolved per settings.windowMode. */
  spawnTerminal(req: SpawnRequest): Promise<SpawnResult>
  /** Write keystrokes from xterm.js into the PTY. */
  terminalInput(sessionId: string, data: string): void
  /** Apply a renderer fit() result to the PTY. */
  terminalResize(sessionId: string, cols: number, rows: number): Promise<void>
  /** Kill the PTY (SIGTERM → SIGKILL) and remove the session. */
  killTerminal(sessionId: string): Promise<void>
  /** All live sessions. */
  listSessions(): Promise<TerminalSessionInfo[]>

  // ── windows ───────────────────────────────────────────────────────────
  /** kind='terminal' opens a single-session window (windows mode). */
  createWindow(kind?: 'main' | 'terminal'): Promise<string>
  closeWindow(windowId: string): Promise<void>
  toggleSidebar(): void

  // ── main → renderer events ────────────────────────────────────────────
  /** Streaming PTY output. Write to xterm via term.write(data). */
  onTerminalData(cb: (e: { sessionId: string; data: string }) => void): () => void
  onTerminalExit(cb: (e: TerminalExitEvent) => void): () => void
  onTerminalTitle(cb: (e: TerminalTitleEvent) => void): () => void
  /**
   * Live boot state per session: 'booting' while a spawned agent has produced
   * zero output, 'stalled' after a no-output timeout, 'ready' on first output.
   * Use this to show/hide a "starting…" overlay over a blank terminal.
   */
  onTerminalStatus(cb: (e: TerminalStatusEvent) => void): () => void
  onScanProgress(cb: (e: ScanProgress) => void): () => void
  onScanComplete(cb: (e: ScanResult) => void): () => void
  /** Emitted when tiles/settings changed in another window — re-fetch. */
  onGridInvalidate(cb: () => void): () => void
  /** Background indexing progress for a repo (throttled). */
  onIndexProgress(cb: (e: RepoIndexProgress) => void): () => void
  /** Background indexing finished for a repo (success or failure). */
  onIndexComplete(cb: (e: RepoIndexCompleteEvent) => void): () => void
}

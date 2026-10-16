/**
 * Shared types — the single source of truth for the contract between
 * the Electron main process (backend) and the renderer (design agent's UI).
 */

// ── Settings ────────────────────────────────────────────────────────────────

export type SortOrder = 'recent' | 'alpha' | 'manual'
export type WindowMode = 'tabs' | 'windows' | 'both'
export type Theme = 'system' | 'light' | 'dark'

export interface AppSettings {
  rootFolders: string[]
  customAgents: CustomAgent[]
  sortOrder: SortOrder
  windowMode: WindowMode
  theme: Theme
  terminalFontSize: number
  terminalFontFamily: string
  disabledBuiltinAgents: string[]
  /** Local repo indexing (LanceDB full-text index per repo). */
  repoIndexEnabled: boolean
  /**
   * agentId → letter(s) used as the prefix in default tab names
   * (e.g. `K_deltav` for Kilo on the deltav repo). Empty/absent = built-in
   * default or first letter of the agent name.
   */
  agentTabLabels: Record<string, string>
  /**
   * When true (default), every spawned agent PTY inherits Delta-V's full
   * process environment. When false, only an allowlist of essential vars is
   * forwarded (PATH/HOME/TERM/LANG/XDG_*…), so secrets exported in the shell
   * that launched Delta-V do not leak into agents. Note: shell-mode agents
   * still spawn a login+interactive shell, which re-sources ~/.zprofile and
   * ~/.zshrc — so the tightening is strongest for direct (useShell: false)
   * spawns.
   */
  passLaunchEnvToAgents: boolean
  /**
   * Unified display order for agents (built-in + custom) as agent ids.
   * Applied by the main process to agent lists; ids missing from the array
   * keep their default relative order (built-ins in BUILTIN_AGENTS order,
   * then customs in creation order), unknown ids are ignored.
   */
  agentOrder: string[]
  /**
   * Sidebar toggle shortcut, normalized as `+`-joined parts (e.g. `mod+b`).
   * `mod` means ⌘ on macOS and Ctrl elsewhere. Recorded in Settings.
   */
  sidebarShortcut: string
  /**
   * Orbit-view launcher shortcut (default ⌘O). When sessions are open this
   * toggles the solar-system launcher overlay over the terminal; Esc returns.
   * Same normalized grammar as the sidebar shortcut.
   */
  orbitShortcut: string
  /**
   * Repo search shortcut (default ⌘K). Opens the solar-system view's fuzzy
   * search bar: planets filter as you type and the most likely repo is
   * auto-selected so Enter launches it. Same normalized grammar.
   */
  searchShortcut: string
  /**
   * Shortcut that instantly finishes any in-flight view transition (damped
   * zoom) instead of waiting it out. Same normalized grammar.
   */
  skipTransitionShortcut: string
  /**
   * View-transition duration in milliseconds (damped zooms). 0 disables
   * motion entirely (cuts straight to end states). Reduced-motion OS setting
   * also cuts to end states regardless of this value.
   */
  transitionDurationMs: number
  /**
   * Main-process-populated status (never persisted, ignored on update): true
   * when the OS provides an encryption backend for the secrets store. The
   * renderer uses it to warn when agent secrets are stored unencrypted.
   */
  secretStorageEncrypted?: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  rootFolders: [],
  customAgents: [],
  sortOrder: 'recent',
  windowMode: 'both',
  theme: 'system',
  terminalFontSize: 13,
  terminalFontFamily: 'Menlo, Consolas, monospace',
  disabledBuiltinAgents: [],
  repoIndexEnabled: true,
  agentTabLabels: {},
  passLaunchEnvToAgents: true,
  agentOrder: [],
  sidebarShortcut: 'mod+b',
  orbitShortcut: 'mod+o',
  searchShortcut: 'mod+k',
  skipTransitionShortcut: 'mod+shift+s',
  transitionDurationMs: 800
}

/** Default sidebar toggle: ⌘B on macOS, Ctrl+B elsewhere (`mod` = primary). */
export const DEFAULT_SIDEBAR_SHORTCUT = 'mod+b'
/** Default orbit-view launcher toggle: ⌘O on macOS, Ctrl+O elsewhere. */
export const DEFAULT_ORBIT_SHORTCUT = 'mod+o'
/** Default repo search: ⌘K on macOS, Ctrl+K elsewhere. */
export const DEFAULT_SEARCH_SHORTCUT = 'mod+k'
/** Default skip-transition combo: ⌘⇧S on macOS, Ctrl+Shift+S elsewhere. */
export const DEFAULT_SKIP_TRANSITION_SHORTCUT = 'mod+shift+s'
/** Default damped-zoom transition duration (ms). */
export const DEFAULT_TRANSITION_MS = 800

// ── Sidebar shortcut helpers ─────────────────────────────────────────────

/**
 * Normalized shortcut grammar: 1+ modifiers + one key, `+`-joined and
 * lowercase (e.g. `mod+b`, `mod+shift+p`). `mod` is the primary modifier
 * (⌘ on macOS, Ctrl elsewhere); `ctrl`/`meta` are the physical keys.
 */
export function normalizeShortcut(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const parts = input
    .split('+')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
  if (parts.length < 2) return null
  const key = parts[parts.length - 1]
  if (!/^[a-z0-9]$/.test(key) && !/^f([1-9]|1\d|2[0-4])$/.test(key)) return null
  const mods: string[] = []
  for (const raw of parts.slice(0, -1)) {
    const mod = canonicalShortcutMod(raw)
    if (!mod || mods.includes(mod)) return null
    mods.push(mod)
  }
  if (mods.length === 0) return null
  const order = ['mod', 'ctrl', 'meta', 'alt', 'shift']
  mods.sort((a, b) => order.indexOf(a) - order.indexOf(b))
  return [...mods, key].join('+')
}

function canonicalShortcutMod(part: string): string | null {
  switch (part) {
    case 'mod':
    case 'cmd':
    case 'command':
    case '⌘':
      return 'mod'
    case 'ctrl':
    case 'control':
    case '⌃':
      return 'ctrl'
    case 'meta':
    case 'win':
    case 'super':
      return 'meta'
    case 'alt':
    case 'option':
    case '⌥':
      return 'alt'
    case 'shift':
    case '⇧':
      return 'shift'
    default:
      return null
  }
}

export interface ShortcutEventLike {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/** Build a normalized shortcut from a keydown event (Settings recorder). */
export function shortcutFromEvent(e: ShortcutEventLike, isMac: boolean): string | null {
  const key = (e.key ?? '').toLowerCase()
  if (!key || ['meta', 'control', 'alt', 'shift'].includes(key)) return null
  if (!/^[a-z0-9]$/.test(key) && !/^f([1-9]|1\d|2[0-4])$/.test(key)) return null
  const mods: string[] = []
  if (isMac) {
    if (e.metaKey) mods.push('mod')
    if (e.ctrlKey) mods.push('ctrl')
  } else {
    if (e.ctrlKey) mods.push('mod')
    if (e.metaKey) mods.push('meta')
  }
  if (e.altKey) mods.push('alt')
  if (e.shiftKey) mods.push('shift')
  if (mods.length === 0) return null
  return normalizeShortcut([...mods, key].join('+'))
}

/** Exact-match a keydown event against a stored shortcut. */
export function shortcutMatches(
  e: ShortcutEventLike,
  shortcut: string,
  isMac: boolean
): boolean {
  const norm = normalizeShortcut(shortcut)
  if (!norm) return false
  const parts = norm.split('+')
  const key = parts[parts.length - 1]
  if ((e.key ?? '').toLowerCase() !== key) return false
  const mods = new Set(parts.slice(0, -1))
  const wantAlt = mods.has('alt')
  const wantShift = mods.has('shift')
  if (isMac) {
    if (e.metaKey !== (mods.has('mod') || mods.has('meta'))) return false
    if (e.ctrlKey !== mods.has('ctrl')) return false
  } else {
    if (e.ctrlKey !== (mods.has('mod') || mods.has('ctrl'))) return false
    if (e.metaKey !== mods.has('meta')) return false
  }
  if (e.altKey !== wantAlt || e.shiftKey !== wantShift) return false
  return true
}

/** Human-readable shortcut: `⌘B` on macOS, `Ctrl+B` elsewhere. */
export function formatShortcut(shortcut: string, isMac: boolean): string {
  const norm = normalizeShortcut(shortcut) ?? DEFAULT_SIDEBAR_SHORTCUT
  const parts = norm.split('+')
  const key = parts[parts.length - 1].toUpperCase()
  const mods = parts.slice(0, -1)
  if (isMac) {
    const sym: Record<string, string> = {
      mod: '⌘',
      ctrl: '⌃',
      meta: '⌘',
      alt: '⌥',
      shift: '⇧'
    }
    return mods.map((m) => sym[m] ?? m).join('') + key
  }
  const word: Record<string, string> = {
    mod: 'Ctrl',
    ctrl: 'Ctrl',
    meta: 'Win',
    alt: 'Alt',
    shift: 'Shift'
  }
  return [...mods.map((m) => word[m] ?? m), key].join('+')
}

// ── Secrets ───────────────────────────────────────────────────────────────────

/**
 * Placeholder shown in the env editor in place of a stored secret value.
 * A value equal to this string (for a secret-classified key) means "keep the
 * value already stored" rather than "store these bullets literally".
 */
export const SECRET_MASK = '••••••••••••'

/**
 * Heuristic: env keys that look like credentials are stored encrypted and are
 * never sent back to the renderer. Deliberately name-based so it needs no UI.
 */
export function isSecretKey(key: string): boolean {
  return /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|AUTH|PRIVATE)/i.test(key)
}

// ── Agents ──────────────────────────────────────────────────────────────────

export interface CustomAgent {
  id: string
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
  useShell: boolean
  workingDirOverride?: string
}

export interface AgentDefinition extends CustomAgent {
  builtin: boolean
  disabled?: boolean
  /**
   * Effective tab-label prefix used in default tab names (e.g. `K` for Kilo).
   * Order: explicit settings override (`agentTabLabels`) → built-in default →
   * first letter of the agent name. Set by the main process.
   */
  tabLabel: string
  /**
   * Names of env keys whose values live in the encrypted secrets store. The
   * corresponding `env` entries carry `SECRET_MASK` instead of the value —
   * secret values are never sent to the renderer. Set by the main process.
   */
  secretKeys?: string[]
}

export const BUILTIN_AGENTS: CustomAgent[] = [
  { id: 'kilo', name: 'Kilo CLI', command: 'kilo', args: [], useShell: true },
  { id: 'opencode', name: 'OpenCode', command: 'opencode', args: [], useShell: true },
  { id: 'pi', name: 'Pi Coding Agent', command: 'pi', args: [], useShell: true },
  { id: 'claude', name: 'Claude Code', command: 'claude', args: [], useShell: true },
  { id: 'aider', name: 'Aider', command: 'aider', args: [], useShell: true },
  { id: 'cursor', name: 'Cursor Agent', command: 'cursor-agent', args: [], useShell: true }
]

/** Default tab-label letters for the built-in agents (K = kilo, O = opencode, …). */
export const DEFAULT_TAB_LABELS: Record<string, string> = {
  kilo: 'K',
  opencode: 'O',
  pi: 'P',
  claude: 'C',
  aider: 'A',
  cursor: 'Cu'
}

/**
 * Resolve the tab-label prefix for an agent: explicit user override wins,
 * then the built-in default, then the first letter of the agent name.
 */
export function effectiveTabLabel(
  agentId: string,
  name: string,
  overrides: Record<string, string>
): string {
  const explicit = (overrides?.[agentId] ?? '').trim()
  if (explicit) return explicit
  const builtin = DEFAULT_TAB_LABELS[agentId]
  if (builtin) return builtin
  const first = (name ?? '').trim().charAt(0).toUpperCase()
  return first || '?'
}

// ── Repos / tiles ───────────────────────────────────────────────────────────

export interface RootFolder {
  id: string
  path: string
  name: string
}

export interface RepoTile {
  id: string
  name: string
  path: string
  parentRootId: string
  lastOpenedAt?: number
  openCount: number
}

export interface ScanProgress {
  rootId: string
  scanned: number
  total?: number
}

export interface ScanResult {
  rootId: string
  tiles: RepoTile[]
  error?: string
}

// ── Terminal sessions ───────────────────────────────────────────────────────

export interface TerminalSessionInfo {
  id: string
  repoTileId: string
  agentId: string
  title: string
  cwd: string
  createdAt: number
  /** Last known number of columns the renderer wrote to */
  cols: number
  rows: number
  /**
   * Live boot state as tracked by the main process
   * ('booting' → 'ready' on first output, or 'stalled' past a timeout).
   * Present on sessions returned by spawn/listSessions; renderer keeps its
   * own copy in state.bootStates[]. Sessions sent through the spinner
   * connection poll may read this to hydrate an overlay after a late attach.
   */
  status?: TerminalBootState
  /** User-renamed tab title (renderer-local); freezes live `title` updates. */
  customTitle?: string
}

export interface SpawnRequest {
  repoTileId: string
  agentId: string
  /** which window should own the terminal (tabs mode / new window) */
  mode?: 'tab' | 'window'
  windowId?: string
}

export interface SpawnResult {
  sessionId: string
  windowId: string
  title: string
}

export interface TerminalExitEvent {
  sessionId: string
  exitCode: number
  signal?: string
}

export interface TerminalTitleEvent {
  sessionId: string
  title: string
}

/**
 * Per-session boot state, driven by the main process:
 * - `booting` — PTY spawned, no output received yet (user-visible "starting…").
 * - `stalled` — still no output after `TERM_BOOT_STALL_MS` (show a nudge, not a full screen of panic).
 * - `ready`   — first output received for this session. Also the end state for
 *   sessions that are gone (exit is reported separately via terminal:exit).
 */
export type TerminalBootState = 'booting' | 'stalled' | 'ready'

export interface TerminalStatusEvent {
  sessionId: string
  status: TerminalBootState
}

// ── Repo indexing (LanceDB) ─────────────────────────────────────────────────

export type RepoIndexState = 'none' | 'queued' | 'indexing' | 'ready' | 'error'

/**
 * Per-repo index status. The UI shows this as a badge on the repo tile and in
 * the settings/index panel. `files`/`chunks` are 0 until the first index run.
 */
export interface RepoIndexStatus {
  repoTileId: string
  repoPath: string
  repoName: string
  state: RepoIndexState
  /** Files covered by the last completed index run. */
  files: number
  /** Searchable text chunks stored in LanceDB. */
  chunks: number
  /** Epoch ms of the last completed index run, if any. */
  indexedAt?: number
  /** Last error message when state === 'error'. */
  error?: string
}

export type IndexPhase = 'walk' | 'chunk' | 'write' | 'search-index'

export interface RepoIndexProgress {
  repoTileId: string
  phase: IndexPhase
  filesIndexed: number
  totalFiles: number
}

export interface RepoIndexCompleteEvent {
  repoTileId: string
  ok: boolean
  files: number
  chunks: number
  durationMs: number
  error?: string
}

export interface RepoSearchRequest {
  repoTileId: string
  /** Full-text query (terms ANDed; special characters are ignored). */
  query: string
  /** Max hits to return (default 20, hard cap 100). */
  limit?: number
  /** Restrict results to paths under this prefix (repo-relative). */
  pathPrefix?: string
}

export interface RepoSearchHit {
  /** Repo-relative file path. */
  path: string
  startLine: number
  endLine: number
  lang: string
  /** Relevance score (BM25, higher = better). 0 for fallback matches. */
  score: number
  /** Short excerpt of the matching chunk. */
  snippet: string
}

export interface RepoSearchResponse {
  repoTileId: string
  query: string
  hits: RepoSearchHit[]
  durationMs: number
  /** Present when the search fell back to plain substring matching. */
  fallback?: boolean
  error?: string
}

// ── Generic payloads ────────────────────────────────────────────────────────

export interface NewAgentPayload {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
  useShell: boolean
  workingDirOverride?: string
  /** Letter(s) used as the default-tab-name prefix for this agent (e.g. `K`). */
  tabLabel?: string
}

export interface Result<T = void> {
  ok: boolean
  data?: T
  error?: string
}

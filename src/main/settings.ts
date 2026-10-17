import { randomUUID } from 'crypto'
import Store from 'electron-store'
import {
  AppSettings,
  BUILTIN_AGENTS,
  CustomAgent,
  DEFAULT_ORBIT_SHORTCUT,
  DEFAULT_REMOTE_PORT,
  DEFAULT_SEARCH_SHORTCUT,
  DEFAULT_SETTINGS,
  DEFAULT_SIDEBAR_SHORTCUT,
  DEFAULT_SKIP_TRANSITION_SHORTCUT,
  DEFAULT_TRANSITION_MS,
  isSecretKey,
  normalizeShortcut,
  REMOTE_PORT_MAX,
  REMOTE_PORT_MIN,
  Result,
  SECRET_MASK
} from '@shared/types'
import { maskEnv, stripSecretKeys } from './agentEnv'
import { secretsService } from './secrets'

/**
 * Settings persistence backed by electron-store (JSON in userData).
 *
 * The schema is versioned; when new fields are added, bump SCHEMA_VERSION
 * and extend `migrations` so existing users upgrade transparently.
 */

const SCHEMA_VERSION = 8

type StoredSettings = AppSettings & { __schemaVersion: number }

const migrations: Record<number, (prev: Record<string, unknown>) => StoredSettings> = {
  // v1 → v2: added disabledBuiltinAgents
  1: (prev) => {
    const next = { ...DEFAULT_SETTINGS, ...(prev as object) } as StoredSettings
    next.disabledBuiltinAgents = []
    next.__schemaVersion = SCHEMA_VERSION
    return next
  },
  // v2 → v3: added repoIndexEnabled
  2: (prev) => {
    const next = { ...DEFAULT_SETTINGS, ...(prev as object) } as StoredSettings
    next.repoIndexEnabled = true
    next.__schemaVersion = SCHEMA_VERSION
    return next
  },
  // v3 → v4: added passLaunchEnvToAgents. Secret env values are moved out of
  // this plaintext file into the encrypted secrets store at startup — see
  // `initSecrets()`, which needs safeStorage (post-ready) so it can't run here.
  3: (prev) => {
    const next = { ...DEFAULT_SETTINGS, ...(prev as object) } as StoredSettings
    next.__schemaVersion = SCHEMA_VERSION
    return next
  },
  // v4 → v5: added agentOrder + sidebarShortcut
  4: (prev) => {
    const next = { ...DEFAULT_SETTINGS, ...(prev as object) } as StoredSettings
    next.agentOrder = []
    next.sidebarShortcut = DEFAULT_SIDEBAR_SHORTCUT
    next.__schemaVersion = SCHEMA_VERSION
    return next
  },
  // v5 → v6: added orbitShortcut + skipTransitionShortcut + transitionDurationMs
  5: (prev) => {
    const next = { ...DEFAULT_SETTINGS, ...(prev as object) } as StoredSettings
    next.orbitShortcut = DEFAULT_ORBIT_SHORTCUT
    next.skipTransitionShortcut = DEFAULT_SKIP_TRANSITION_SHORTCUT
    next.transitionDurationMs = DEFAULT_TRANSITION_MS
    next.__schemaVersion = SCHEMA_VERSION
    return next
  },
  // v6 → v7: added searchShortcut (repo search bar in the solar-system view)
  6: (prev) => {
    const next = { ...DEFAULT_SETTINGS, ...(prev as object) } as StoredSettings
    next.searchShortcut = DEFAULT_SEARCH_SHORTCUT
    next.__schemaVersion = SCHEMA_VERSION
    return next
  },
  // v7 → v8: added remoteEnabled + remotePort + remoteToken (Delta-V Remote)
  7: (prev) => {
    const next = { ...DEFAULT_SETTINGS, ...(prev as object) } as StoredSettings
    next.remoteEnabled = false
    next.remotePort = DEFAULT_REMOTE_PORT
    next.remoteToken = ''
    next.__schemaVersion = SCHEMA_VERSION
    return next
  }
}

function applyMigrations(raw: Record<string, unknown>): StoredSettings {
  let version = (raw.__schemaVersion as number) ?? 1
  let current = { ...raw }
  while (version < SCHEMA_VERSION) {
    const migrate = migrations[version]
    if (!migrate) break
    current = migrate(current) as unknown as Record<string, unknown>
    current.__schemaVersion = version + 1
    version++
  }
  // Fill any missing keys from defaults (forward-compatible)
  const merged: StoredSettings = { ...DEFAULT_SETTINGS, __schemaVersion: SCHEMA_VERSION, ...(current as object) }
  merged.__schemaVersion = SCHEMA_VERSION
  return merged
}

function validate(settings: AppSettings): string[] {
  const errors: string[] = []
  if (!Array.isArray(settings.rootFolders)) errors.push('rootFolders must be an array')
  if (!['recent', 'alpha', 'manual'].includes(settings.sortOrder))
    errors.push(`invalid sortOrder: ${String(settings.sortOrder)}`)
  if (!['tabs', 'windows', 'both'].includes(settings.windowMode))
    errors.push(`invalid windowMode: ${String(settings.windowMode)}`)
  if (!['system', 'light', 'dark'].includes(settings.theme))
    errors.push(`invalid theme: ${String(settings.theme)}`)
  if (
    typeof settings.terminalFontSize !== 'number' ||
    settings.terminalFontSize < 8 ||
    settings.terminalFontSize > 32
  )
    errors.push('terminalFontSize must be a number between 8 and 32')
  if (typeof settings.terminalFontFamily !== 'string')
    errors.push('terminalFontFamily must be a string')
  if (typeof settings.repoIndexEnabled !== 'boolean')
    errors.push('repoIndexEnabled must be a boolean')
  if (typeof settings.passLaunchEnvToAgents !== 'boolean')
    errors.push('passLaunchEnvToAgents must be a boolean')
  if (
    !settings.agentTabLabels ||
    typeof settings.agentTabLabels !== 'object' ||
    Array.isArray(settings.agentTabLabels)
  )
    errors.push('agentTabLabels must be an object')
  if (!Array.isArray(settings.agentOrder)) errors.push('agentOrder must be an array')
  if (typeof settings.sidebarShortcut !== 'string' || !normalizeShortcut(settings.sidebarShortcut))
    errors.push('sidebarShortcut must be a shortcut like mod+b')
  if (typeof settings.orbitShortcut !== 'string' || !normalizeShortcut(settings.orbitShortcut))
    errors.push('orbitShortcut must be a shortcut like mod+o')
  if (typeof settings.searchShortcut !== 'string' || !normalizeShortcut(settings.searchShortcut))
    errors.push('searchShortcut must be a shortcut like mod+k')
  if (
    typeof settings.skipTransitionShortcut !== 'string' ||
    !normalizeShortcut(settings.skipTransitionShortcut)
  )
    errors.push('skipTransitionShortcut must be a shortcut like mod+shift+s')
  if (
    typeof settings.transitionDurationMs !== 'number' ||
    settings.transitionDurationMs < 0 ||
    settings.transitionDurationMs > 2000
  )
    errors.push('transitionDurationMs must be a number between 0 and 2000')
  if (typeof settings.remoteEnabled !== 'boolean')
    errors.push('remoteEnabled must be a boolean')
  if (
    typeof settings.remotePort !== 'number' ||
    !Number.isInteger(settings.remotePort) ||
    settings.remotePort < REMOTE_PORT_MIN ||
    settings.remotePort > REMOTE_PORT_MAX
  )
    errors.push(`remotePort must be an integer between ${REMOTE_PORT_MIN} and ${REMOTE_PORT_MAX}`)
  if (typeof settings.remoteToken !== 'string')
    errors.push('remoteToken must be a string')
  return errors
}

function clampTransitionMs(value: unknown, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.max(0, Math.min(2000, Math.round(n)))
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of paths) {
    const norm = p.replace(/\/+$/, '')
    if (!seen.has(norm)) {
      seen.add(norm)
      out.push(norm)
    }
  }
  return out
}

const SETTING_KEYS: (keyof AppSettings)[] = [
  'rootFolders',
  'customAgents',
  'sortOrder',
  'windowMode',
  'theme',
  'terminalFontSize',
  'terminalFontFamily',
  'disabledBuiltinAgents',
  'repoIndexEnabled',
  'agentTabLabels',
  'passLaunchEnvToAgents',
  'agentOrder',
  'sidebarShortcut',
  'orbitShortcut',
  'searchShortcut',
  'skipTransitionShortcut',
  'transitionDurationMs'
]

class SettingsService {
  private store: Store<StoredSettings>
  private cache: StoredSettings

  constructor() {
    this.store = new Store<StoredSettings>({
      name: 'deltav-settings',
      defaults: { ...DEFAULT_SETTINGS, __schemaVersion: SCHEMA_VERSION } as StoredSettings
    })
    // Migrate + sanitize whatever is on disk
    this.cache = applyMigrations(this.store.store as unknown as Record<string, unknown>)
    this.cache.customAgents = this.sanitizeAgents(this.cache.customAgents)
    this.cache.rootFolders = dedupePaths(
      this.cache.rootFolders.filter((p) => typeof p === 'string' && p.length > 0)
    )
    this.cache.agentTabLabels = this.sanitizeLabels(this.cache.agentTabLabels)
    this.cache.agentOrder = this.sanitizeAgentOrder(this.cache.agentOrder)
    this.cache.sidebarShortcut =
      normalizeShortcut(this.cache.sidebarShortcut) ?? DEFAULT_SIDEBAR_SHORTCUT
    this.cache.orbitShortcut =
      normalizeShortcut(this.cache.orbitShortcut) ?? DEFAULT_ORBIT_SHORTCUT
    this.cache.searchShortcut =
      normalizeShortcut(this.cache.searchShortcut) ?? DEFAULT_SEARCH_SHORTCUT
    this.cache.skipTransitionShortcut =
      normalizeShortcut(this.cache.skipTransitionShortcut) ?? DEFAULT_SKIP_TRANSITION_SHORTCUT
    this.cache.transitionDurationMs = clampTransitionMs(
      this.cache.transitionDurationMs,
      DEFAULT_TRANSITION_MS
    )
    this.cache.remoteEnabled =
      typeof this.cache.remoteEnabled === 'boolean' ? this.cache.remoteEnabled : false
    this.cache.remotePort =
      typeof this.cache.remotePort === 'number' &&
      Number.isInteger(this.cache.remotePort) &&
      this.cache.remotePort >= REMOTE_PORT_MIN &&
      this.cache.remotePort <= REMOTE_PORT_MAX
        ? this.cache.remotePort
        : DEFAULT_REMOTE_PORT
    this.cache.remoteToken =
      typeof this.cache.remoteToken === 'string' ? this.cache.remoteToken : ''
    this.persist()
  }

  private sanitizeAgentOrder(order: unknown): string[] {
    if (!Array.isArray(order)) return []
    const seen = new Set<string>()
    const out: string[] = []
    for (const id of order) {
      if (typeof id === 'string' && id && !seen.has(id)) {
        seen.add(id)
        out.push(id)
      }
    }
    return out
  }

  private sanitizeLabels(labels: unknown): Record<string, string> {
    if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return {}
    const out: Record<string, string> = {}
    for (const [id, label] of Object.entries(labels as Record<string, unknown>)) {
      if (typeof label === 'string' && label.trim()) out[id] = label.trim()
    }
    return out
  }

  private sanitizeAgents(agents: unknown): CustomAgent[] {
    if (!Array.isArray(agents)) return []
    return agents
      .filter((a): a is CustomAgent => {
        const rec = a as Record<string, unknown>
        return (
          !!rec &&
          typeof rec.id === 'string' &&
          typeof rec.name === 'string' &&
          typeof rec.command === 'string'
        )
      })
      .map((a) => {
        const env = a.env && typeof a.env === 'object' && !Array.isArray(a.env)
          ? (a.env as Record<string, string>)
          : {}
        return {
          ...a,
          args: Array.isArray(a.args) ? a.args.map(String) : [],
          // Secret values live in the encrypted store, never in this plaintext
          // file. Before the store is ready (i.e. during construction) leave
          // the values in place so the post-ready migration can move them.
          env: secretsService.isInit() ? stripSecretKeys(env) : env,
          useShell: a.useShell !== false
        }
      })
  }

  /**
   * Bring up the encrypted secrets store and move any secret-classified env
   * values that are still sitting in this plaintext file into it. Call once,
   * after `app.whenReady()` (safeStorage cannot be used earlier).
   */
  initSecrets(): void {
    secretsService.init()
    this.migrateSecrets()
  }

  private migrateSecrets(): void {
    let changed = false
    const agents = this.cache.customAgents.map((a) => {
      const secretKeys = Object.keys(a.env ?? {}).filter(isSecretKey)
      if (secretKeys.length === 0) return a
      const merged = { ...secretsService.getAll(a.id) }
      for (const k of secretKeys) {
        const v = a.env?.[k]
        if (v !== undefined && v !== SECRET_MASK) merged[k] = v
      }
      secretsService.replaceAll(a.id, merged)
      changed = true
      return { ...a, env: stripSecretKeys(a.env) }
    })
    if (changed) {
      this.cache.customAgents = agents
      this.persist()
    }
  }

  /**
   * Renderer-facing settings: secret env values are replaced with `SECRET_MASK`
   * so they never cross IPC. `get()` stays raw for internal callers.
   */
  getRedacted(): AppSettings {
    const settings = this.get()
    return {
      ...settings,
      secretStorageEncrypted: secretsService.isEncryptionAvailable(),
      remoteToken: '',
      customAgents: settings.customAgents.map((a) => ({
        ...a,
        env: maskEnv(a.id, secretsService.isInit() ? a.env : stripSecretKeys(a.env))
      }))
    }
  }

  private persist(): void {
    this.store.set(this.cache)
  }

  get(): AppSettings {
    const { __schemaVersion, ...settings } = this.cache
    return settings
  }

  /** Merge a partial update. Unknown keys ignored; invalid values rejected. */
  update(partial: Partial<AppSettings>): Result<AppSettings> {
    const next: StoredSettings = { ...this.cache }
    for (const key of SETTING_KEYS) {
      if (key in partial) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(next as any)[key] = (partial as any)[key]
      }
    }
    if ('rootFolders' in partial) {
      next.rootFolders = dedupePaths(
        next.rootFolders.filter((p) => typeof p === 'string' && p.length > 0)
      )
    }
    next.customAgents = this.sanitizeAgents(next.customAgents)
    next.agentTabLabels = this.sanitizeLabels(next.agentTabLabels)
    next.agentOrder = this.sanitizeAgentOrder(next.agentOrder)
    if ('sidebarShortcut' in partial) {
      next.sidebarShortcut =
        normalizeShortcut(next.sidebarShortcut) ?? DEFAULT_SIDEBAR_SHORTCUT
    }
    if ('orbitShortcut' in partial) {
      next.orbitShortcut = normalizeShortcut(next.orbitShortcut) ?? DEFAULT_ORBIT_SHORTCUT
    }
    if ('searchShortcut' in partial) {
      next.searchShortcut = normalizeShortcut(next.searchShortcut) ?? DEFAULT_SEARCH_SHORTCUT
    }
    if ('skipTransitionShortcut' in partial) {
      next.skipTransitionShortcut =
        normalizeShortcut(next.skipTransitionShortcut) ?? DEFAULT_SKIP_TRANSITION_SHORTCUT
    }
    if ('transitionDurationMs' in partial) {
      next.transitionDurationMs = clampTransitionMs(
        next.transitionDurationMs,
        DEFAULT_TRANSITION_MS
      )
    }
    const errors = validate(next)
    if (errors.length > 0) {
      return { ok: false, error: errors.join('; ') }
    }
    this.cache = next
    this.persist()
    const { __schemaVersion: _, ...result } = this.cache
    return { ok: true, data: result }
  }

  /**
   * Update the Remote bridge settings (enabled/port only). The pairing token is
   * a main-process secret and is never set here — see ensureRemoteToken.
   */
  updateRemote(partial: { remoteEnabled?: boolean; remotePort?: number }): Result<AppSettings> {
    const next: StoredSettings = { ...this.cache }
    if ('remoteEnabled' in partial) {
      if (typeof partial.remoteEnabled !== 'boolean') {
        return { ok: false, error: 'remoteEnabled must be a boolean' }
      }
      next.remoteEnabled = partial.remoteEnabled
    }
    if ('remotePort' in partial) {
      const port = partial.remotePort
      if (
        typeof port !== 'number' ||
        !Number.isInteger(port) ||
        port < REMOTE_PORT_MIN ||
        port > REMOTE_PORT_MAX
      ) {
        return {
          ok: false,
          error: `Port must be an integer between ${REMOTE_PORT_MIN} and ${REMOTE_PORT_MAX}`
        }
      }
      next.remotePort = port
    }
    const errors = validate(next)
    if (errors.length > 0) {
      return { ok: false, error: errors.join('; ') }
    }
    this.cache = next
    this.persist()
    const { __schemaVersion: _, ...result } = this.cache
    return { ok: true, data: result }
  }

  /**
   * Return the pairing token, generating and persisting a fresh UUID when none
   * is stored yet (e.g. after a reset).
   */
  ensureRemoteToken(): string {
    if (this.cache.remoteToken) return this.cache.remoteToken
    this.cache.remoteToken = randomUUID()
    this.persist()
    return this.cache.remoteToken
  }

  /** Always mint a new pairing token and persist it (invalidates old pairings). */
  regenerateRemoteToken(): string {
    this.cache.remoteToken = randomUUID()
    this.persist()
    return this.cache.remoteToken
  }

  reset(): AppSettings {
    this.cache = { ...DEFAULT_SETTINGS, __schemaVersion: SCHEMA_VERSION }
    this.persist()
    const { __schemaVersion, ...settings } = this.cache
    return settings
  }

  isBuiltinDisabled(agentId: string): boolean {
    return this.cache.disabledBuiltinAgents.includes(agentId)
  }

  /** Merge a partial update. Unknown keys ignored; invalid values rejected. */
  setBuiltinDisabled(agentId: string, disabled: boolean): Result<AppSettings> {
    const set = new Set(this.cache.disabledBuiltinAgents)
    if (disabled) set.add(agentId)
    else set.delete(agentId)
    return this.update({ disabledBuiltinAgents: [...set] })
  }

  /** Absolute paths of all configured root folders. */
  rootFolderPaths(): string[] {
    return [...this.cache.rootFolders]
  }
}

export const settingsService = new SettingsService()
export { BUILTIN_AGENTS }

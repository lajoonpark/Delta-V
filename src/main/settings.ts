import Store from 'electron-store'
import {
  AppSettings,
  BUILTIN_AGENTS,
  CustomAgent,
  DEFAULT_SETTINGS,
  DEFAULT_SIDEBAR_SHORTCUT,
  isSecretKey,
  normalizeShortcut,
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

const SCHEMA_VERSION = 5

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
  return errors
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
  'sidebarShortcut'
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
    const errors = validate(next)
    if (errors.length > 0) {
      return { ok: false, error: errors.join('; ') }
    }
    this.cache = next
    this.persist()
    const { __schemaVersion: _, ...result } = this.cache
    return { ok: true, data: result }
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

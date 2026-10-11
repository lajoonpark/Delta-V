import { safeStorage } from 'electron'
import Store from 'electron-store'

/**
 * Encrypted store for custom-agent secret values (API keys, tokens…).
 *
 * Secret values are classified by key name (see `isSecretKey` in shared types)
 * and never leave the main process — the renderer only ever receives
 * `SECRET_MASK`. Backed by Electron's `safeStorage` (Keychain on macOS, DPAPI
 * on Windows, libsecret/kwallet on Linux) and persisted to
 * `deltav-secrets.json`.
 *
 * If the OS provides no encryption backend, values are stored unencrypted and
 * `isEncryptionAvailable()` reports false so the UI can warn the user rather
 * than silently pretending they are protected.
 *
 * This module deliberately imports nothing from settings/agents: settings
 * depends on it, so keeping it leaf-level avoids an import cycle.
 */

interface SecretsFile {
  encrypted: boolean
  data: string
}

type AgentSecrets = Record<string, string>
type SecretsMap = Record<string, AgentSecrets>

class SecretsService {
  private store: Store<SecretsFile> | undefined
  private map: SecretsMap = {}
  private ready = false
  private encryptionAvailable = false

  /**
   * Must be called once, after `app.whenReady()` — `safeStorage` throws if used
   * earlier. Safe to call more than once; later calls are no-ops.
   */
  init(): void {
    if (this.ready) return
    this.ready = true
    this.encryptionAvailable = safeStorage.isEncryptionAvailable()
    this.store = new Store<SecretsFile>({
      name: 'deltav-secrets',
      defaults: { encrypted: false, data: '' }
    })
    this.map = this.decode(this.store.store as SecretsFile)
  }

  isInit(): boolean {
    return this.ready
  }

  isEncryptionAvailable(): boolean {
    return this.encryptionAvailable
  }

  getAll(agentId: string): AgentSecrets {
    return { ...(this.map[agentId] ?? {}) }
  }

  keys(agentId: string): string[] {
    return Object.keys(this.map[agentId] ?? {})
  }

  /** Replace the full secret set for one agent (add/update/remove in one call). */
  replaceAll(agentId: string, secrets: AgentSecrets): void {
    if (!this.ready) return
    if (Object.keys(secrets).length === 0) delete this.map[agentId]
    else this.map[agentId] = { ...secrets }
    this.persist()
  }

  removeAgent(agentId: string): void {
    if (!this.ready) return
    if (delete this.map[agentId]) this.persist()
  }

  private decode(raw: SecretsFile): SecretsMap {
    if (!raw || typeof raw.data !== 'string' || raw.data.length === 0) return {}
    try {
      const json = raw.encrypted
        ? safeStorage.decryptString(Buffer.from(raw.data, 'base64'))
        : raw.data
      const parsed = JSON.parse(json)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as SecretsMap)
        : {}
    } catch {
      // Corrupt or undecryptable (e.g. OS keychain reset) — start empty rather
      // than crash the app.
      return {}
    }
  }

  private persist(): void {
    if (!this.store) return
    const json = JSON.stringify(this.map)
    if (this.encryptionAvailable) {
      this.store.set({ encrypted: true, data: safeStorage.encryptString(json).toString('base64') })
    } else {
      this.store.set({ encrypted: false, data: json })
    }
  }
}

export const secretsService = new SecretsService()

import type { DeltaVApi } from '@shared/api'

/**
 * Global augmentation so the renderer can call `window.deltav.*`
 * with full type safety. The design agent's UI code gets autocomplete
 * for the entire backend surface from this declaration.
 */
declare global {
  interface Window {
    deltav: DeltaVApi
  }
}

export {}

/**
 * Cross-view transition primitives: the layer cross-fade styles used by the
 * transitions that still move whole views (terminal ↔ stage, overlay open and
 * close). Orbit ↔ stage needs none of this — its camera dollies in-scene (see
 * art/cameraDolly.ts) and the layers only dissolve over a short handoff.
 *
 * Rects are viewport coordinates (top-left + diameter) and set each layer's
 * transform origin, so the zoom reads as pushing toward the focal point.
 */

import { shortcutMatches, type ShortcutEventLike } from '@shared/types'

export interface PlanetRect {
  x: number
  y: number
  size: number
}

// ── Layer cross-fade styles ─────────────────────────────────────────────
// Keyframes `layer-in` / `layer-out` live in styles/index.css; each layer
// animates opacity + a damped scale around the transition's focal point.

const LAYER_EASE = 'cubic-bezier(0.16, 1, 0.3, 1)'

export function layerEnterStyle(
  durationMs: number,
  fromScale: number,
  origin: PlanetRect
): React.CSSProperties {
  return {
    animation: `layer-in ${durationMs}ms ${LAYER_EASE} both`,
    transformOrigin: `${origin.x + origin.size / 2}px ${origin.y + origin.size / 2}px`,
    ['--layer-scale' as string]: String(fromScale)
  } as React.CSSProperties
}

export function layerExitStyle(
  durationMs: number,
  toScale: number,
  origin: PlanetRect
): React.CSSProperties {
  return {
    animation: `layer-out ${durationMs}ms ${LAYER_EASE} both`,
    transformOrigin: `${origin.x + origin.size / 2}px ${origin.y + origin.size / 2}px`,
    ['--layer-scale' as string]: String(toScale)
  } as React.CSSProperties
}


export interface LaunchSkipEvent extends ShortcutEventLike {
  repeat?: boolean
  isComposing?: boolean
  keyCode?: number
}

export interface LaunchSkipController {
  /** Feed window keyup events (arms Enter skip after the launching Enter key is released). */
  onKeyUp(e: { key: string; isComposing?: boolean; keyCode?: number }): void
  /**
   * Feed window keydown events during the launch transition:
   * - 'skip': cut straight to the terminal reveal (fresh Enter after keyup, or skipShortcut)
   * - 'consume': swallow the key so it cannot leak or dismiss (held Enter repeat, Escape)
   * - 'ignore': unrelated key or IME composition
   */
  onKeyDown(e: LaunchSkipEvent): 'skip' | 'consume' | 'ignore'
  /** True once a fresh Enter keydown is allowed to skip. */
  isEnterArmed(): boolean
}

export function createLaunchSkipController(opts: {
  triggeredByKey: boolean
  skipShortcut: string
  isMac: boolean
}): LaunchSkipController {
  let enterArmed = !opts.triggeredByKey
  return {
    onKeyUp(e) {
      if (e.isComposing || e.keyCode === 229) return
      if (e.key === 'Enter') enterArmed = true
    },
    onKeyDown(e) {
      if (e.isComposing || e.keyCode === 229) return 'ignore'
      if (shortcutMatches(e, opts.skipShortcut, opts.isMac)) {
        return e.repeat ? 'consume' : 'skip'
      }
      if (e.key === 'Enter') {
        return !e.repeat && enterArmed ? 'skip' : 'consume'
      }
      if (e.key === 'Escape') {
        return 'consume'
      }
      return 'ignore'
    },
    isEnterArmed() {
      return enterArmed
    }
  }
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import type { RepoTile } from '@shared/types'
import { formatShortcut, shortcutMatches } from '@shared/types'
import { useAppState } from '@renderer/state/AppProvider'
import { LeaderTicks } from './ui'
import { isMac } from '@renderer/hooks/useTheme'
import { fuzzyRepoScore } from '@renderer/lib/fuzzy'
import {
  orbitPoint,
  projectPoint,
  solveCallouts,
  SUN_RADIUS,
  type CalloutSmooth,
  type OrbitLayout
} from '@renderer/art/orbitLayout'
import { mountOrbitScene, type OrbitSceneHandle } from './orbitScene'

/**
 * Full-bleed solar-system launcher — a real 3D scene (see orbitScene.ts).
 * Repos are planets on Keplerian ellipses around a glowing sun: inner ones
 * swing around faster than outer ones, and every orbit compresses a little
 * near perihelion. Labels hang off ticked hairline leader-line callouts (JPL
 * schematic) whose screen geometry is re-solved every frame from the planets'
 * live positions — the plate column follows each planet's side, plates are
 * re-slotted so they never collide, and everything eases instead of snapping.
 *
 * - Home: replaces the repo grid. Overlay (sessions open): a launcher over the
 *   terminal — Esc returns.
 * - Mouse: hover a planet or its label to select (highlight follows the
 *   cursor), click to launch — same model as the lander stage.
 * - Keyboard: ⌘K (rebindable) opens the fuzzy search bar — planets drop away
 *   as you type and the most likely repo auto-selects, so Enter launches it.
 *   Typing anywhere opens the bar too; arrows move, Esc clears/backs out.
 *   Damped-zoom entrance is skippable (rebindable hotkey); reduced-motion cuts
 *   to the end. `instant` mounts at the end state when a cross-view transition
 *   owns the motion instead. During an orbit ↔ stage camera dolly the scene
 *   drives the motion (see orbitScene.cameraMove) and `chromeFade` dissolves
 *   the callouts and HUD so only the planet and starfield are left in frame.
 */

interface OrbitViewProps {
  /** Deterministic layout, computed by the window (it also needs the rects). */
  layout: OrbitLayout
  /** false while a modal (picker/settings) is open, so keys go to the modal. */
  keyboardActive: boolean
  /** Mount at the end state — a cross-view transition is animating the layer. */
  instant?: boolean
  /** Planet to select on mount (the one that carried the eye in). */
  selectedTileId?: string | null
  /** Live scene handle, so the window can drive the camera dolly + handoff. */
  handleRef?: { current: OrbitSceneHandle | null }
  /** Dissolve/reveal the DOM chrome while the scene's camera owns the move. */
  chromeFade?: { mode: 'out' | 'in'; totalMs: number } | null
  onSelect(tile: RepoTile): void
  /** Esc in overlay mode → return to the terminal (carrying the selection). */
  onDismiss(selectedTileId: string | null): void
}

const POP_EASE = 'cubic-bezier(0.16, 1, 0.3, 1)'
/** Minimum click/hover target (px) so distant planets stay grabbable. */
const MIN_HIT = 28

export function OrbitView({
  layout,
  keyboardActive,
  instant,
  selectedTileId,
  handleRef,
  chromeFade,
  onSelect,
  onDismiss
}: OrbitViewProps): React.ReactElement {
  const { settings } = useAppState()
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const sceneRef = useRef<OrbitSceneHandle | null>(null)
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [selected, setSelected] = useState(0)
  const [entered, setEntered] = useState(instant === true)
  const [skipped, setSkipped] = useState(false)

  const searchShortcut = settings?.searchShortcut ?? 'mod+k'
  const searchShortcutLabel = formatShortcut(searchShortcut, isMac)

  // ── Damped-zoom entrance (skippable; reduced-motion cuts to the end) ──
  const transitionMs = settings?.transitionDurationMs ?? 800
  const reduceMotion = useRef(false)
  useEffect(() => {
    reduceMotion.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }, [])
  useEffect(() => {
    if (instant || reduceMotion.current || transitionMs <= 0) {
      setEntered(true)
      return
    }
    const id = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(id)
  }, [transitionMs, instant])

  const skipTransition = useCallback(() => {
    setSkipped(true)
    setEntered(true)
    sceneRef.current?.skip()
  }, [])

  // ── Filter + selection ──
  // Fuzzy-ranked: a typo or stray space still keeps the repo, and the best
  // match sorts first so `selected = 0` is the one Enter should launch.
  const visible = useMemo(() => {
    const q = query.trim()
    if (!q) return layout.bodies
    return layout.bodies
      .map((b) => ({ b, score: fuzzyRepoScore(q, b.tile.name, b.tile.path) }))
      .filter((e): e is { b: (typeof layout.bodies)[number]; score: number } => e.score !== null)
      .sort((x, y) => y.score - x.score)
      .map((e) => e.b)
  }, [layout.bodies, query])

  useEffect(() => setSelected(0), [query])
  // Keep the carried-in planet selected when the view appears.
  useEffect(() => {
    if (!selectedTileId) return
    const idx = visible.findIndex((b) => b.tile.id === selectedTileId)
    if (idx >= 0) setSelected(idx)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTileId, layout.bodies])
  const sel = Math.min(selected, Math.max(0, visible.length - 1))

  // ── Keyboard model ──
  const move = useCallback((delta: number) => {
    setSelected((c) => {
      const n = visible.length
      if (n === 0) return 0
      return (c + delta + n * 2) % n
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible.length])

  /** Close the search bar and drop its filter (Esc, ⌘K again, or a launch). */
  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    setQuery('')
  }, [])

  /** Launch a repo, clearing the search so the system is whole when we return. */
  const launch = useCallback(
    (tile: RepoTile) => {
      closeSearch()
      onSelect(tile)
    },
    [closeSearch, onSelect]
  )

  useEffect(() => {
    if (!keyboardActive) return
    const onKey = (e: KeyboardEvent): void => {
      // ⌘K (rebindable): open the fuzzy repo search; again to close it.
      if (shortcutMatches(e, searchShortcut, isMac)) {
        e.preventDefault()
        if (searchOpen) closeSearch()
        else setSearchOpen(true)
        return
      }
      const skipHotkey = settings?.skipTransitionShortcut ?? 'mod+shift+s'
      if (shortcutMatches(e, skipHotkey, isMac)) {
        e.preventDefault()
        skipTransition()
        return
      }
      // While the search input owns the caret it handles text entry itself
      // (plus paste/selection); here we only drive navigation and dismissal.
      const typingInSearch = document.activeElement === searchInputRef.current
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault()
        move(1)
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault()
        move(-1)
      } else if (e.key === 'Enter') {
        const body = visible[sel]
        if (body) {
          e.preventDefault()
          launch(body.tile)
        }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        if (searchOpen) closeSearch()
        else if (query) setQuery('')
        else onDismiss(visible[sel]?.tile.id ?? null)
      } else if (!typingInSearch && e.key === 'Backspace') {
        e.preventDefault()
        setQuery((q) => q.slice(0, -1))
      } else if (!typingInSearch && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // Type-to-filter still works: the first key opens the bar and seeds it.
        e.preventDefault()
        setSearchOpen(true)
        setQuery((q) => q + e.key)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    keyboardActive,
    searchShortcut,
    settings?.skipTransitionShortcut,
    visible,
    sel,
    query,
    searchOpen,
    move,
    launch,
    closeSearch,
    onDismiss,
    skipTransition
  ])

  // Focus follows the search bar: the input while it's open, else the view, so
  // typed keys never fall through to the terminal behind it.
  useEffect(() => {
    if (!keyboardActive) return
    if (searchOpen) searchInputRef.current?.focus()
    else rootRef.current?.focus()
  }, [keyboardActive, searchOpen])

  // ── 3D scene mount (disposed with the view) ──
  const measured = layout.width > 0 && layout.height > 0
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !measured) return
    const handle = mountOrbitScene({
      canvas,
      width: layout.width,
      height: layout.height,
      bodies: layout.bodies,
      reducedMotion: reduceMotion.current
    })
    sceneRef.current = handle
    if (handleRef) handleRef.current = handle
    if (instant || reduceMotion.current) handle.skip()
    return () => {
      handle.dispose()
      sceneRef.current = null
      if (handleRef) handleRef.current = null
    }
    // Mount once; later layout changes flow through update() below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measured])

  useEffect(() => {
    if (measured) sceneRef.current?.update(layout.width, layout.height, layout.bodies)
  }, [layout, measured])

  // Filtered-out planets hide in the scene too.
  useEffect(() => {
    const mask: Record<string, boolean> = {}
    for (const b of layout.bodies) {
      mask[b.tile.id] = visible.some((v) => v.tile.id === b.tile.id)
    }
    sceneRef.current?.setVisible(mask)
  }, [visible, layout.bodies, measured])

  // ── DOM sync loop ──
  // The scene owns drift + spin; this loop projects each body's live orbit
  // elements into content pixels, parks the hit targets on their planets and
  // solves the callout plates (column, slot, leader line) from the live
  // positions so nothing overlaps or sweeps across the system. Bodies mutate
  // `cx`/`cy` in place so the view-transition rect registry always reads live
  // positions.
  const wrapRefs = useRef(new Map<string, HTMLButtonElement>())
  const lineRefs = useRef(new Map<string, SVGPolylineElement>())
  const leaderRefs = useRef(new Map<string, SVGGElement>())
  const labelRefs = useRef(new Map<string, HTMLButtonElement>())
  const selCircleRef = useRef<SVGCircleElement | null>(null)
  /** Per-tile callout smoothing state — survives layout object swaps. */
  const smoothRef = useRef(new Map<string, CalloutSmooth>())
  const live = useRef({ layout, visible, sel })
  live.current = { layout, visible, sel }

  const setWrap = useCallback((id: string, el: HTMLButtonElement | null) => {
    if (el) wrapRefs.current.set(id, el)
    else wrapRefs.current.delete(id)
  }, [])
  const setLine = useCallback((id: string, el: SVGPolylineElement | null) => {
    if (el) lineRefs.current.set(id, el)
    else lineRefs.current.delete(id)
  }, [])
  const setLeader = useCallback((id: string, el: SVGGElement | null) => {
    if (el) leaderRefs.current.set(id, el)
    else leaderRefs.current.delete(id)
  }, [])
  const setLabel = useCallback((id: string, el: HTMLButtonElement | null) => {
    if (el) labelRefs.current.set(id, el)
    else labelRefs.current.delete(id)
  }, [])

  useEffect(() => {
    let raf = 0
    let last = 0
    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick)
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016
      last = now
      const { layout: L, visible: vis, sel: s } = live.current

      for (const b of L.bodies) {
        const [wx, wz] = orbitPoint(b.a, b.ecc, b.peri, b.meanAnomaly)
        const p = projectPoint(L.width, L.height, wx, 0, wz)
        b.cx = p.x
        b.cy = p.y
        b.r = b.radius * p.scale

        const wrap = wrapRefs.current.get(b.tile.id)
        if (wrap) {
          const d = Math.max(MIN_HIT, b.r * 2)
          wrap.style.left = `${b.cx - d / 2}px`
          wrap.style.top = `${b.cy - d / 2}px`
          wrap.style.width = `${d}px`
          wrap.style.height = `${d}px`
          wrap.style.zIndex = String(100 + Math.round(b.cy))
        }
      }

      // Drop callout state for repos that left the scan.
      if (smoothRef.current.size !== L.bodies.length) {
        const ids = new Set(L.bodies.map((b) => b.tile.id))
        for (const id of [...smoothRef.current.keys()]) {
          if (!ids.has(id)) smoothRef.current.delete(id)
        }
      }

      const sun = projectPoint(L.width, L.height, 0, 0, 0)
      solveCallouts(vis, L.width, L.height, smoothRef.current, dt, {
        x: sun.x,
        y: sun.y,
        r: SUN_RADIUS * sun.scale
      })

      for (const b of vis) {
        const line = lineRefs.current.get(b.tile.id)
        if (line) {
          line.setAttribute(
            'points',
            `${b.startX},${b.startY} ${b.kneeX},${b.kneeY} ${b.endX},${b.endY}`
          )
        }
        const leader = leaderRefs.current.get(b.tile.id)
        if (leader) leader.style.opacity = b.leaderOpacity.toFixed(3)
        const label = labelRefs.current.get(b.tile.id)
        if (label) {
          label.style.top = `${b.endY}px`
          if (b.align === 'left') {
            label.style.left = `${b.labelX}px`
            label.style.right = 'auto'
          } else {
            label.style.left = 'auto'
            label.style.right = `${L.width - b.labelX}px`
          }
          label.style.opacity = b.labelOpacity.toFixed(3)
        }
      }

      const active = vis[s]
      const ringEl = selCircleRef.current
      if (ringEl && active) {
        ringEl.setAttribute('cx', String(active.cx))
        ringEl.setAttribute('cy', String(active.cy))
        ringEl.setAttribute('r', String(active.r + 8))
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  const duration = reduceMotion.current ? 0 : transitionMs
  const animating = !reduceMotion.current && duration > 0 && !skipped
  const wrapperStyle: React.CSSProperties = {
    transform: `scale(${entered ? 1 : 0.94})`,
    opacity: entered ? 1 : 0,
    transition: animating
      ? `transform ${duration}ms cubic-bezier(0.16,1,0.3,1), opacity ${duration}ms ease-out`
      : 'none'
  }

  // Leader lines + labels fade in on the planets' beat (the planets themselves
  // pop inside the 3D scene).
  const fadeStyle = (i: number): React.CSSProperties | undefined => {
    if (instant || reduceMotion.current) return undefined
    return {
      animation: `orbit-fade 700ms ${POP_EASE} both`,
      animationDelay: `${i * 90}ms`
    }
  }

  // Callouts + HUD dissolve while the scene's camera dives (or reveal as it
  // rises) — the move itself is driven inside orbitScene.
  const chromeStyle = ((): React.CSSProperties => {
    if (!chromeFade) return {}
    return chromeFade.mode === 'out'
      ? { animation: `chrome-out ${Math.round(chromeFade.totalMs * 0.35)}ms ease both` }
      : {
          animation: `chrome-in ${Math.round(chromeFade.totalMs * 0.65)}ms ease ${Math.round(
            chromeFade.totalMs * 0.35
          )}ms both`
        }
  })()

  const orbitShortcut = formatShortcut(settings?.orbitShortcut ?? 'mod+o', isMac)

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="absolute inset-0 overflow-hidden outline-none"
      style={{ background: 'var(--void)' }}
    >
      <div className="absolute inset-0" style={wrapperStyle}>
        {/* 3D solar system (sun, orbit lines, planets) */}
        <canvas ref={canvasRef} aria-hidden className="absolute inset-0 h-full w-full" />

        {/* Leader-line callouts + selection ring */}
        <div className="pointer-events-none absolute inset-0" style={{ zIndex: 2000, ...chromeStyle }}>
        <svg className="pointer-events-none absolute inset-0 h-full w-full" style={{ overflow: 'visible' }}>
          {visible.map((b, i) => {
            if (!b.hasPlate) return null
            const active = visible[sel]?.tile.id === b.tile.id
            const stroke = active ? 'var(--ember)' : 'var(--hairline)'
            return (
              <g key={b.tile.id} style={fadeStyle(i)}>
                <g
                  ref={(el) => setLeader(b.tile.id, el)}
                  stroke={stroke}
                  strokeWidth={active ? 1.4 : 1}
                >
                  <polyline
                    ref={(el) => setLine(b.tile.id, el)}
                    points={`${b.startX},${b.startY} ${b.kneeX},${b.kneeY} ${b.endX},${b.endY}`}
                    fill="none"
                  />
                  <LeaderTicks x0={b.kneeX} x1={b.endX} y={b.endY} />
                  <line x1={b.endX} y1={b.endY - 7} x2={b.endX} y2={b.endY + 7} strokeWidth={active ? 1.6 : 1} />
                </g>
              </g>
            )
          })}

          {/* Selection ring rides the chosen planet */}
          {visible[sel] && (
            <circle
              ref={selCircleRef}
              cx={visible[sel].cx}
              cy={visible[sel].cy}
              r={visible[sel].r + 8}
              fill="none"
              stroke="var(--ember)"
              strokeDasharray="3 5"
            />
          )}
        </svg>

        {/* Callout labels — hover selects, click launches. Dark plates keep them
            readable when a drifting planet passes beneath (reference look).
            The full-bleed wrapper carries the entrance fade; the plate itself
            is placed + faded live by the sync loop above. */}
        {visible.map((b, i) =>
          b.hasPlate ? (
            <div key={b.tile.id} className="pointer-events-none absolute inset-0" style={fadeStyle(i)}>
              <button
                type="button"
                aria-label={`Launch ${b.tile.name}`}
                ref={(el) => setLabel(b.tile.id, el)}
                onClick={() => launch(b.tile)}
                onMouseEnter={() => setSelected(i)}
                className="pointer-events-auto absolute select-none rounded-sm border px-2.5 py-1 text-left outline-none"
                style={{
                  top: b.endY,
                  ...(b.align === 'left' ? { left: b.labelX } : { right: layout.width - b.labelX }),
                  transform: 'translateY(-50%)',
                  textAlign: b.align === 'left' ? 'left' : 'right',
                  maxWidth: 240,
                  background: 'rgba(18,22,30,0.72)',
                  borderColor:
                    visible[sel]?.tile.id === b.tile.id
                      ? 'rgba(255,138,61,0.5)'
                      : 'rgba(42,52,66,0.6)',
                  zIndex: 2000
                }}
              >
                <div
                  className="truncate font-hud text-[11px] leading-tight tracking-[0.14em] uppercase"
                  style={{
                    color:
                      visible[sel]?.tile.id === b.tile.id ? 'var(--ember)' : 'var(--paper)'
                  }}
                >
                  {b.tile.name}
                </div>
                <div
                  className="truncate font-hud text-[9px] leading-tight tracking-[0.18em] uppercase"
                  style={{
                    color: visible[sel]?.tile.id === b.tile.id ? 'var(--ember)' : 'var(--muted)',
                    opacity: visible[sel]?.tile.id === b.tile.id ? 0.85 : 0.65
                  }}
                >
                  {b.tile.openCount}× · AU {b.au.toFixed(1)}
                </div>
              </button>
            </div>
          ) : null
        )}

        {/* HUD */}
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute left-6 top-5">
            <div
              className="font-display text-[15px] tracking-[0.32em]"
              style={{ color: 'var(--paper)' }}
            >
              DELTA-V
            </div>
            <div
              className="font-hud text-[9px] tracking-[0.34em] uppercase"
              style={{ color: 'var(--muted)' }}
            >
              Solar System · Repo Launcher
            </div>
          </div>

          {/* Search palette (⌘K) — planets drop away as you type and the most
              likely repo auto-selects, so Enter launches it. Outer div owns the
              centering (z-above the callout plates); inner owns the pop-in. */}
          {searchOpen && (
            <div
              className="pointer-events-auto absolute left-1/2 top-4 w-[min(560px,78vw)] -translate-x-1/2"
              style={{ zIndex: 3000 }}
            >
              <div className="animate-pop-in">
                <div
                  className="flex items-center gap-2.5 rounded-lg border px-3 py-2"
                  style={{
                    background: 'rgba(18,22,30,0.9)',
                    borderColor: 'rgba(255,138,61,0.55)',
                    boxShadow: '0 14px 44px rgba(0,0,0,0.5)',
                    backdropFilter: 'blur(6px)'
                  }}
                >
                  <Search size={15} style={{ color: 'var(--ember)' }} />
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search repos…"
                    aria-label="Search repositories"
                    spellCheck={false}
                    autoComplete="off"
                    autoCorrect="off"
                    className="min-w-0 flex-1 selectable bg-transparent font-hud text-[13px] tracking-[0.06em] outline-none placeholder:text-muted"
                    style={{ color: 'var(--paper)' }}
                  />
                  {query && (
                    <>
                      <span
                        className="shrink-0 font-hud text-[10px] tracking-[0.18em] uppercase"
                        style={{ color: 'var(--muted)' }}
                      >
                        {visible.length}/{layout.bodies.length}
                      </span>
                      <button
                        type="button"
                        aria-label="Clear search"
                        onClick={() => setQuery('')}
                        className="shrink-0 rounded p-0.5 outline-none"
                        style={{ color: 'var(--muted)' }}
                      >
                        <X size={13} />
                      </button>
                    </>
                  )}
                </div>
                <div className="mt-1.5 flex items-center justify-between px-1">
                  <span
                    className="truncate font-hud text-[10px] tracking-[0.16em] uppercase"
                    style={{ color: visible.length ? 'var(--muted)' : 'var(--ember)' }}
                  >
                    {visible.length
                      ? `↵ Launch · ${visible[sel]?.tile.name ?? ''}`
                      : 'No matching repos'}
                  </span>
                  <span
                    className="shrink-0 pl-3 font-hud text-[10px] tracking-[0.16em] uppercase"
                    style={{ color: 'var(--muted)' }}
                  >
                    ESC CLOSE
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Status readout */}
          <div className="absolute bottom-5 left-6 flex items-center gap-3">
            <div
              className="rounded-sm border px-2.5 py-1 font-hud text-[10px] tracking-[0.18em] uppercase"
              style={{
                borderColor: query ? 'var(--ember)' : 'var(--hairline)',
                color: query ? 'var(--ember)' : 'var(--muted)',
                background: 'rgba(18,22,30,0.6)'
              }}
            >
              {query ? `FILTER ${query}` : `${searchShortcutLabel} SEARCH`}
            </div>
            <div
              className="font-hud text-[10px] tracking-[0.18em] uppercase"
              style={{ color: 'var(--muted)' }}
            >
              {visible.length}/{layout.bodies.length} · HOVER SELECT · CLICK/↵ LAUNCH
            </div>
          </div>

          <div
            className="absolute bottom-5 right-6 font-hud text-[10px] tracking-[0.18em] uppercase"
            style={{ color: 'var(--muted)' }}
          >
            {settings ? `${orbitShortcut} TOGGLE` : ''}
            {' · '}ESC {keyboardActive ? 'BACK' : ''}
          </div>
        </div>
        </div>

        {/* Planet hit targets — hover selects, click launches */}
        {visible.map((b, i) => {
          return (
            <button
              key={b.tile.id}
              type="button"
              aria-label={`Launch ${b.tile.name}`}
              ref={(el) => setWrap(b.tile.id, el)}
              onMouseEnter={() => setSelected(i)}
              onClick={() => launch(b.tile)}
              className="absolute rounded-full outline-none"
              style={{
                left: b.cx - b.r,
                top: b.cy - b.r,
                width: Math.max(MIN_HIT, b.r * 2),
                height: Math.max(MIN_HIT, b.r * 2),
                zIndex: 100 + Math.round(b.cy)
              }}
            />
          )
        })}

      </div>
    </div>
  )
}

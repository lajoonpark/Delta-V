import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Plus, RefreshCw } from 'lucide-react'
import type { RepoTile } from '@shared/types'
import { shortcutMatches } from '@shared/types'
import { useAppActions, useAppState } from '@renderer/state/AppProvider'
import { useResolvedTheme, isMac } from '@renderer/hooks/useTheme'
import { TitleBar } from '@renderer/components/TitleBar'
import { Welcome } from '@renderer/components/RepoGrid'
import { ScanningBadge } from '@renderer/components/RepoTile'
import { LanderStage } from '@renderer/components/LanderStage'
import { SettingsDialog, type SettingsTab } from '@renderer/components/SettingsDialog'
import { Sidebar } from '@renderer/components/Sidebar'
import { TabBar } from '@renderer/components/TabBar'
import { OrbitView } from '@renderer/components/OrbitView'
import { TerminalPane } from './TerminalPane'
import { IconButton } from '@renderer/components/ui'
import { layoutOrbit, RING_AT_LAUNCHES } from '@renderer/art/orbitLayout'
import { layoutLanderStage } from '@renderer/art/landerLayout'
import {
  domPlanetRect,
  layerEnterStyle,
  layerExitStyle,
  runPlanetFlight,
  type FlightHandle,
  type PlanetRect
} from '@renderer/components/viewTransition'

/**
 * Main window: repo grid (or first-run welcome), switching to a
 * sidebar + tabbed-terminal layout once sessions are open.
 *
 * View changes run as one continuous camera move: a shared planet flies
 * between the views while the outgoing/incoming layers do a damped zoom
 * (see components/viewTransition.ts). Length = `transitionDurationMs`
 * (0 = cut), skippable via `skipTransitionShortcut`, and reduced-motion
 * always cuts to the end states.
 */

type ViewKey = 'orbit' | 'stage' | 'terminal'

type TransitionKind =
  | 'dive-to-stage'
  | 'rise-to-stage'
  | 'back-to-orbit'
  | 'land-to-terminal'
  | 'open-overlay'
  | 'close-overlay'

const VIEW_OF: Record<TransitionKind, { from: ViewKey; to: ViewKey }> = {
  'dive-to-stage': { from: 'orbit', to: 'stage' },
  'rise-to-stage': { from: 'terminal', to: 'stage' },
  'back-to-orbit': { from: 'stage', to: 'orbit' },
  'land-to-terminal': { from: 'stage', to: 'terminal' },
  'open-overlay': { from: 'terminal', to: 'orbit' },
  'close-overlay': { from: 'orbit', to: 'terminal' }
}

/** Damped zooms per direction: the outgoing layer moves, the incoming settles. */
const CHOREO: Record<TransitionKind, { outScale: number; inScale: number }> = {
  'dive-to-stage': { outScale: 1.9, inScale: 1.14 },
  'rise-to-stage': { outScale: 1.9, inScale: 1.14 },
  'back-to-orbit': { outScale: 0.62, inScale: 1.14 },
  'land-to-terminal': { outScale: 0.8, inScale: 1.06 },
  'open-overlay': { outScale: 0.85, inScale: 1.14 },
  'close-overlay': { outScale: 1.7, inScale: 1.06 }
}

interface ActiveTransition {
  kind: TransitionKind
  tile: RepoTile
  phase: 'pending' | 'running'
  rects: { from: PlanetRect; to: PlanetRect } | null
}

function centerRect(): PlanetRect {
  return { x: window.innerWidth / 2 - 8, y: window.innerHeight / 2 - 8, size: 16 }
}

export function MainWindow(): React.ReactElement {
  const { settings, roots, tiles, ready, sessions, scanning } = useAppState()
  const { addFolders, closeTab } = useAppActions()
  const dark = useResolvedTheme(settings)

  const [pickerTile, setPickerTile] = useState<RepoTile | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState<SettingsTab | null>(null)
  const [orbitOpen, setOrbitOpen] = useState(false)
  const [transition, setTransition] = useState<ActiveTransition | null>(null)
  const flightRef = useRef<FlightHandle | null>(null)
  const timerRef = useRef<number | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [contentBox, setContentBox] = useState({ left: 0, top: 0, width: 0, height: 0 })

  const hasSessions = sessions.length > 0
  const isScanning = Object.keys(scanning).length > 0
  const modalOpen = pickerTile !== null || settingsOpen !== null
  const transitionMs = settings?.transitionDurationMs ?? 800

  // Keep the active tab valid: prefer the current one, else the newest.
  useEffect(() => {
    setActiveId((cur) => {
      if (cur && sessions.some((s) => s.id === cur)) return cur
      return sessions.length > 0 ? sessions[sessions.length - 1].id : null
    })
  }, [sessions])

  // ── Content box measurement (below the title bar) — orbit rects live here ──
  useEffect(() => {
    const el = contentRef.current
    if (!ready || !el) return
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      setContentBox({ left: r.left, top: r.top, width: r.width, height: r.height })
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [ready])

  const orbitLayout = useMemo(
    () => layoutOrbit(tiles, contentBox.width, contentBox.height),
    [tiles, contentBox.width, contentBox.height]
  )

  // ── Shared-planet rects (viewport coordinates) ──
  const orbitRect = useCallback(
    (tileId: string): PlanetRect | null => {
      const b = orbitLayout.bodies.find((x) => x.tile.id === tileId)
      if (!b || contentBox.width <= 0) return null
      return { x: contentBox.left + b.cx - b.r, y: contentBox.top + b.cy - b.r, size: b.r * 2 }
    },
    [orbitLayout, contentBox]
  )

  const stageRect = useCallback((): PlanetRect => {
    const L = layoutLanderStage(1, window.innerWidth, window.innerHeight)
    return {
      x: L.planet.x - L.planet.radius,
      y: L.planet.y - L.planet.radius,
      size: L.planet.radius * 2
    }
  }, [])

  const resolveRects = useCallback(
    (kind: TransitionKind, tile: RepoTile): { from: PlanetRect; to: PlanetRect } | null => {
      const orbit = orbitRect(tile.id)
      const dom = domPlanetRect(tile.id)
      switch (kind) {
        case 'dive-to-stage':
          return orbit ? { from: orbit, to: stageRect() } : null
        case 'rise-to-stage':
          return dom ? { from: dom, to: stageRect() } : null
        case 'back-to-orbit':
          return orbit ? { from: stageRect(), to: orbit } : null
        case 'land-to-terminal':
          return dom ? { from: stageRect(), to: dom } : null
        case 'open-overlay':
          return dom && orbit ? { from: dom, to: orbit } : null
        case 'close-overlay':
          return orbit && dom ? { from: orbit, to: dom } : null
      }
    },
    [orbitRect, stageRect]
  )

  // ── Transition control ──
  const clearTimer = (): void => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  const skipTransition = useCallback(() => {
    clearTimer()
    flightRef.current?.skip()
    flightRef.current = null
    setTransition(null)
  }, [])

  const startTransition = useCallback(
    (kind: TransitionKind, tile: RepoTile | null) => {
      clearTimer()
      flightRef.current?.skip()
      flightRef.current = null
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      if (!tile || reduce || transitionMs <= 0) {
        // Motion off: cut straight to the end states.
        setTransition(null)
        return
      }
      setTransition({ kind, tile, phase: 'pending', rects: null })
    },
    [transitionMs]
  )

  const activeTile = ((): RepoTile | null => {
    const session = sessions.find((s) => s.id === activeId) ?? sessions[sessions.length - 1]
    return session ? (tiles.find((t) => t.id === session.repoTileId) ?? null) : null
  })()

  const openOverlay = (): void => {
    const tile = activeTile ?? tiles[0] ?? null
    setOrbitOpen(true)
    startTransition('open-overlay', tile)
  }

  const closeOverlay = (selectedTileId: string | null): void => {
    const tile = tiles.find((t) => t.id === selectedTileId) ?? activeTile
    setOrbitOpen(false)
    startTransition('close-overlay', tile)
  }

  // Run the flight + layer zooms once the layers have committed (so DOM rects
  // like the sidebar mini-planet are measurable before the flight starts).
  useEffect(() => {
    if (!transition || transition.phase !== 'pending') return
    let cancelled = false
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (cancelled) return
        const rects = resolveRects(transition.kind, transition.tile)
        setTransition({ ...transition, phase: 'running', rects })
        if (rects) {
          flightRef.current = runPlanetFlight({
            seed: transition.tile.name,
            ring: transition.tile.openCount >= RING_AT_LAUNCHES,
            from: rects.from,
            to: rects.to,
            durationMs: transitionMs
          })
        }
        clearTimer()
        timerRef.current = window.setTimeout(() => {
          flightRef.current = null
          setTransition(null)
        }, transitionMs)
      })
    )
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transition])

  useEffect(
    () => () => {
      clearTimer()
      flightRef.current?.skip()
    },
    []
  )

  // ── Global shortcuts: ⌘, settings · ⌘W close tab · sidebar/orbit/skip ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isMac ? e.metaKey : e.ctrlKey) {
        const key = e.key.toLowerCase()
        if (key === ',') {
          e.preventDefault()
          setSettingsOpen('general')
          return
        }
        if (key === 'w' && activeId) {
          e.preventDefault()
          setActiveId(null)
          void closeTab(activeId)
          return
        }
      }
      if (transition && shortcutMatches(e, settings?.skipTransitionShortcut ?? 'mod+shift+s', isMac)) {
        e.preventDefault()
        skipTransition()
        return
      }
      if (hasSessions && shortcutMatches(e, settings?.sidebarShortcut ?? 'mod+b', isMac)) {
        e.preventDefault()
        setSidebarCollapsed((c) => !c)
        return
      }
      // Orbit launcher: toggles the solar-system overlay over the terminal.
      // Ignored while the stage/settings modal owns the keys.
      if (hasSessions && !modalOpen && shortcutMatches(e, settings?.orbitShortcut ?? 'mod+o', isMac)) {
        e.preventDefault()
        if (orbitOpen) closeOverlay(null)
        else openOverlay()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeId,
    hasSessions,
    modalOpen,
    closeTab,
    transition,
    orbitOpen,
    skipTransition,
    settings?.sidebarShortcut,
    settings?.orbitShortcut,
    settings?.skipTransitionShortcut
  ])

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center bg-white dark:bg-zinc-950">
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </div>
    )
  }

  // ── View actions (each pairs the state change with its transition) ──
  const select = (tile: RepoTile): void => {
    startTransition(hasSessions ? 'rise-to-stage' : 'dive-to-stage', tile)
    setPickerTile(tile)
  }

  const closeStage = (reason: 'launch' | 'dismiss'): void => {
    const tile = pickerTile
    setPickerTile(null)
    if (!tile) return
    if (reason === 'launch') {
      // Land on the terminal the launch just spawned.
      setOrbitOpen(false)
      startTransition('land-to-terminal', tile)
    } else if (orbitOpen || !hasSessions) {
      startTransition('back-to-orbit', tile)
    } else {
      startTransition('land-to-terminal', tile)
    }
  }

  // ── Layer mounting + cross-fade styles ──
  const stageTile =
    pickerTile ?? (transition && VIEW_OF[transition.kind].from === 'stage' ? transition.tile : null)
  const mountTerminal =
    hasSessions ||
    (transition !== null &&
      (VIEW_OF[transition.kind].to === 'terminal' || VIEW_OF[transition.kind].from === 'terminal'))
  const mountOrbit =
    !hasSessions ||
    orbitOpen ||
    (transition !== null &&
      (VIEW_OF[transition.kind].to === 'orbit' || VIEW_OF[transition.kind].from === 'orbit'))
  const mountStage = stageTile !== null

  const styleFor = (view: ViewKey): React.CSSProperties | undefined => {
    if (!transition) return undefined
    const ends = VIEW_OF[transition.kind]
    if (transition.phase === 'pending') {
      return ends.to === view ? { opacity: 0 } : undefined
    }
    const choreo = CHOREO[transition.kind]
    const rects = transition.rects
    if (ends.from === view) {
      return layerExitStyle(transitionMs, choreo.outScale, rects?.from ?? centerRect())
    }
    if (ends.to === view) {
      return layerEnterStyle(transitionMs, choreo.inScale, rects?.to ?? centerRect())
    }
    return undefined
  }

  const showWelcome = roots.length === 0
  // Keys flow to the layer being transitioned to (the outgoing one stays inert).
  const incomingView = transition ? VIEW_OF[transition.kind].to : null

  return (
    <div className="flex h-full flex-col bg-zinc-50 dark:bg-zinc-950">
      <TitleBar onOpenSettings={() => setSettingsOpen('general')} />

      <div ref={contentRef} className="relative min-h-0 flex-1">
        {showWelcome ? (
          <Welcome onAddFolders={() => void addFolders()} />
        ) : (
          <>
            {mountTerminal && (
              <div className="flex h-full" style={styleFor('terminal')}>
                <Sidebar
                  collapsed={sidebarCollapsed}
                  onToggle={() => setSidebarCollapsed((c) => !c)}
                  onSelect={select}
                />
                <div className="flex min-w-0 flex-1 flex-col">
                  <TabBar activeId={activeId} onActivate={setActiveId} />
                  <TerminalPane activeId={activeId} dark={dark === 'dark'} />
                </div>
              </div>
            )}

            {mountOrbit && (
              <div className="absolute inset-0" style={styleFor('orbit')}>
                <OrbitView
                  layout={orbitLayout}
                  keyboardActive={!modalOpen && (transition === null || incomingView === 'orbit')}
                  instant={transition !== null}
                  selectedTileId={transition?.tile.id ?? null}
                  onSelect={select}
                  onDismiss={closeOverlay}
                />
              </div>
            )}

            {!hasSessions && (
              <div className="absolute right-4 top-4 z-10 flex items-center gap-1.5">
                {isScanning && <ScanningBadge />}
                <IconButton label="Add root folder" onClick={() => void addFolders()}>
                  <Plus size={14} />
                </IconButton>
                <IconButton label="Rescan folders" onClick={() => void window.deltav.scanAllFolders()}>
                  <RefreshCw size={14} className={isScanning ? 'animate-spin' : ''} />
                </IconButton>
              </div>
            )}
          </>
        )}

        {mountStage && stageTile && (
          <div className="fixed inset-0 z-50" style={styleFor('stage')}>
            <LanderStage
              tile={stageTile}
              keyboardActive={transition === null || incomingView === 'stage'}
              instant={transition !== null}
              onClose={closeStage}
              onManageAgents={() => {
                setPickerTile(null)
                setSettingsOpen('agents')
              }}
            />
          </div>
        )}
      </div>

      {settingsOpen && (
        <SettingsDialog initialTab={settingsOpen} onClose={() => setSettingsOpen(null)} />
      )}
    </div>
  )
}

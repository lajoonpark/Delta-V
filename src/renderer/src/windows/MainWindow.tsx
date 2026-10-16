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
import { layoutOrbit } from '@renderer/art/orbitLayout'
import { layoutLanderStage } from '@renderer/art/landerLayout'
import {
  LAUNCH_CINEMATIC_MS,
  LAUNCH_STAGE_UNMOUNT_MS,
  shouldPlayLaunchCinematic,
  type Frame
} from '@renderer/art/cameraDolly'
import {
  createLaunchSkipController,
  layerEnterStyle,
  layerExitStyle,
  type LaunchSkipController,
  type PlanetRect
} from '@renderer/components/viewTransition'
import type { OrbitSceneHandle } from '@renderer/components/orbitScene'
import type { LanderSceneHandle } from '@renderer/components/landerScene'

/**
 * Main window: repo grid (or first-run welcome), switching to a
 * sidebar + tabbed-terminal layout once sessions are open.
 *
 * View changes run as one continuous camera move. Orbit ↔ stage is a real
 * camera dolly: the orbit scene's camera pushes into the selected planet until
 * it fills the lander stage's planet rect (match-move — see
 * art/cameraDolly.ts), then the two scenes dissolve over a short handoff, and
 * the stage's landers deploy. Stage → orbit is the same move played out. The
 * layers themselves never scale or fly a sprite in these paths — the camera
 * does the work, so there is one planet, one lighting model, one focal point.
 *
 * Transitions that touch the terminal (or the ⌘O overlay) still do the damped
 * layer zoom (see components/viewTransition.ts) — a 3D planet must never
 * animate into the sidebar's flat mini-planets. Length =
 * `transitionDurationMs` (0 = cut), skippable via `skipTransitionShortcut`,
 * and reduced-motion always cuts to the end states.
 */

type ViewKey = 'orbit' | 'stage' | 'terminal'

type TransitionKind =
  | 'dive-to-stage'
  | 'rise-to-stage'
  | 'back-to-orbit'
  | 'open-overlay'
  | 'close-overlay'
  | 'launch-to-terminal'

const VIEW_OF: Record<TransitionKind, { from: ViewKey; to: ViewKey }> = {
  'dive-to-stage': { from: 'orbit', to: 'stage' },
  'rise-to-stage': { from: 'terminal', to: 'stage' },
  'back-to-orbit': { from: 'stage', to: 'orbit' },
  'open-overlay': { from: 'terminal', to: 'orbit' },
  'close-overlay': { from: 'orbit', to: 'terminal' },
  'launch-to-terminal': { from: 'stage', to: 'terminal' }
}

/** Damped zooms per direction: the outgoing layer moves, the incoming settles. */
const CHOREO: Record<TransitionKind, { outScale: number; inScale: number }> = {
  'dive-to-stage': { outScale: 1.9, inScale: 1.14 },
  'rise-to-stage': { outScale: 1.9, inScale: 1.14 },
  'back-to-orbit': { outScale: 0.62, inScale: 1.14 },
  'open-overlay': { outScale: 0.85, inScale: 1.14 },
  'close-overlay': { outScale: 1.7, inScale: 1.06 },
  'launch-to-terminal': { outScale: 1, inScale: 1 }
}

/**
 * Camera-dolly transitions: the orbit scene owns the motion and the layers
 * only cross-dissolve at the handoff (end of a dive / start of a rise).
 */
const DOLLY_KINDS = new Set<TransitionKind>(['dive-to-stage', 'back-to-orbit'])
/** Cross-fade window (ms) where the two planets already agree on screen. */
const HANDOFF_MS = 200

interface ActiveTransition {
  kind: TransitionKind
  tile: RepoTile
  phase: 'pending' | 'running'
  /** The stage layer joins late on a dive and leaves early on a rise. */
  stageVisible: boolean
  /** Destination of a launch-to-terminal cinematic (window HUD vs tab reveal). */
  launchMode?: 'tab' | 'window'
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
  /** Skip cut: mount/refresh the stage at its end state (no entrance). */
  const [stageInstant, setStageInstant] = useState(false)
  /** Error surfaced by the stage after a failed launch (restored on abort). */
  const [launchError, setLaunchError] = useState<string | null>(null)
  const timersRef = useRef<number[]>([])
  const contentRef = useRef<HTMLDivElement>(null)
  const [contentBox, setContentBox] = useState({ left: 0, top: 0, height: 0, width: 0 })

  const orbitSceneRef = useRef<OrbitSceneHandle | null>(null)
  const landerSceneRef = useRef<LanderSceneHandle | null>(null)
  /** Enter/shortcut skip controller for the launch-to-terminal cinematic. */
  const launchSkipRef = useRef<LaunchSkipController | null>(null)
  /** Spin phase sampled at the handoff so the stage starts on the same face. */
  const stageSpinRef = useRef(0)
  /** Bumped per transition so a stale scene callback can't end a newer one. */
  const runIdRef = useRef(0)

  const hasSessions = sessions.length > 0
  const isScanning = Object.keys(scanning).length > 0
  const modalOpen = pickerTile !== null || settingsOpen !== null
  const transitionMs = settings?.transitionDurationMs ?? 800
  const handoffMs = Math.min(HANDOFF_MS, transitionMs)

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

  const contentBoxRef = useRef(contentBox)
  contentBoxRef.current = contentBox

  const orbitLayout = useMemo(
    () => layoutOrbit(tiles, contentBox.width, contentBox.height),
    [tiles, contentBox.width, contentBox.height]
  )

  // ── The dive's target framing: the lander stage's planet rect, in the orbit
  //    canvas's own pixels. Re-read live so a resize mid-dolly re-solves. ──
  const stageFrame = useCallback((): Frame => {
    const L = layoutLanderStage(1, window.innerWidth, window.innerHeight)
    const box = contentBoxRef.current
    return {
      x: L.planet.x - L.planet.radius - box.left,
      y: L.planet.y - L.planet.radius - box.top,
      size: L.planet.radius * 2
    }
  }, [])

  // ── Transition control ──
  const clearTimers = (): void => {
    for (const id of timersRef.current) window.clearTimeout(id)
    timersRef.current = []
  }
  const pushTimer = (fn: () => void, ms: number): void => {
    timersRef.current.push(window.setTimeout(fn, ms))
  }

  const finishTransition = useCallback(() => {
    clearTimers()
    launchSkipRef.current = null
    setTransition(null)
  }, [])

  const skipTransition = useCallback(() => {
    clearTimers()
    runIdRef.current++
    const wasLaunch = launchSkipRef.current !== null || transition?.kind === 'launch-to-terminal'
    launchSkipRef.current = null
    if (wasLaunch) {
      // Cut straight to the reveal — no black! The stage has already unmounted
      // (or is about to); go straight to the spawned terminal.
      setPickerTile(null)
      setOrbitOpen(false)
      finishTransition()
      return
    }
    // Land the dolly on its end pose and the landers in their slots, then cut
    // straight to the end states. Scene callbacks fire once and are stale-
    // guarded, so this can safely call both paths.
    orbitSceneRef.current?.skipMove()
    landerSceneRef.current?.skip()
    setStageInstant(true)
    finishTransition()
  }, [finishTransition, transition])

  const startTransition = useCallback(
    (kind: TransitionKind, tile: RepoTile | null) => {
      clearTimers()
      runIdRef.current++
      orbitSceneRef.current?.skipMove()
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      if (!tile || reduce || transitionMs <= 0) {
        // Motion off: cut straight to the end states.
        setTransition(null)
        setStageInstant(false)
        return
      }
      setStageInstant(false)
      stageSpinRef.current = 0
      setTransition({
        kind,
        tile,
        phase: 'pending',
        // The stage joins at the handoff on a dive; everywhere else it is up
        // (or irrelevant) from the start.
        stageVisible: kind !== 'dive-to-stage'
      })
    },
    [transitionMs]
  )

  const startLaunchTransition = useCallback(
    (tile: RepoTile, mode: 'tab' | 'window', triggeredByKey: boolean): boolean => {
      clearTimers()
      runIdRef.current++
      orbitSceneRef.current?.skipMove()
      setLaunchError(null)
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      if (!shouldPlayLaunchCinematic(transitionMs, reduce)) {
        launchSkipRef.current = null
        setTransition(null)
        setStageInstant(false)
        return false
      }
      setPickerTile(null)
      setOrbitOpen(false)
      setStageInstant(false)
      launchSkipRef.current = createLaunchSkipController({
        triggeredByKey,
        skipShortcut: settings?.skipTransitionShortcut ?? 'mod+shift+s',
        isMac
      })
      setTransition({
        kind: 'launch-to-terminal',
        tile,
        phase: 'pending',
        stageVisible: true,
        launchMode: mode
      })
      return true
    },
    [transitionMs, settings?.skipTransitionShortcut]
  )

  const abortLaunchTransition = useCallback((tile: RepoTile, error: string) => {
    clearTimers()
    runIdRef.current++
    launchSkipRef.current = null
    setTransition(null)
    setStageInstant(true)
    setLaunchError(error)
    setPickerTile(tile)
  }, [])

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

  // Run the move once the layers have committed (so the orbit scene exists
  // before we ask it for a camera).
  useEffect(() => {
    if (!transition || transition.phase !== 'pending') return
    let cancelled = false
    const runId = runIdRef.current
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (cancelled || runId !== runIdRef.current) return
        const { kind, tile } = transition
        setTransition({ ...transition, phase: 'running' })

        if (kind === 'launch-to-terminal') {
          // Unmount the stage behind full black right before the curtain lifts.
          pushTimer(() => {
            if (runId !== runIdRef.current) return
            setTransition((t) =>
              t && runId === runIdRef.current ? { ...t, stageVisible: false } : t
            )
          }, LAUNCH_STAGE_UNMOUNT_MS)
          pushTimer(() => {
            if (runId === runIdRef.current) finishTransition()
          }, LAUNCH_CINEMATIC_MS)
        } else if (DOLLY_KINDS.has(kind)) {
          const scene = orbitSceneRef.current
          const mode = kind === 'dive-to-stage' ? 'dive' : 'rise'
          if (kind === 'back-to-orbit') {
            // Start the pull-out on the stage's face so the dissolve shows one
            // planet, not two half-rotated ones.
            const phase = landerSceneRef.current?.spinPhase()
            if (phase != null) scene?.setSpinPhase(tile.id, phase)
          }
          scene?.cameraMove({
            tileId: tile.id,
            getTarget: stageFrame,
            mode,
            durationMs: transitionMs,
            onDone: () => {
              if (runId === runIdRef.current) finishTransition()
            }
          })
          if (kind === 'dive-to-stage') {
            // The stage joins already framed at the same rect, and dissolves
            // in over the handoff while the dolly settles onto it.
            pushTimer(() => {
              if (runId !== runIdRef.current) return
              stageSpinRef.current = orbitSceneRef.current?.spinPhase(tile.id) ?? 0
              setTransition((t) => (t && runId === runIdRef.current ? { ...t, stageVisible: true } : t))
            }, Math.max(0, transitionMs - handoffMs))
          } else {
            // The stage dissolves over the handoff; the camera pulls out from
            // under it and reveals the chrome on the way.
            pushTimer(() => {
              if (runId !== runIdRef.current) return
              setTransition((t) => (t && runId === runIdRef.current ? { ...t, stageVisible: false } : t))
            }, handoffMs)
          }
          // Safety net: never hang if the scene can't run the move.
          pushTimer(() => {
            if (runId === runIdRef.current) finishTransition()
          }, transitionMs + 100)
        } else {
          pushTimer(() => {
            if (runId === runIdRef.current) finishTransition()
          }, transitionMs)
        }
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
      clearTimers()
      orbitSceneRef.current?.skipMove()
    },
    []
  )

  // ── Global shortcuts: ⌘, settings · ⌘W close tab · sidebar/orbit/skip ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (launchSkipRef.current) {
        const action = launchSkipRef.current.onKeyDown(e)
        if (action === 'skip') {
          e.preventDefault()
          skipTransition()
          return
        }
        if (action === 'consume') {
          e.preventDefault()
          return
        }
      }
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
    const onKeyUp = (e: KeyboardEvent): void => {
      launchSkipRef.current?.onKeyUp(e)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
    }
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
    setLaunchError(null)
    startTransition(hasSessions ? 'rise-to-stage' : 'dive-to-stage', tile)
    setPickerTile(tile)
  }

  const closeStage = (reason: 'launch' | 'dismiss'): void => {
    const tile = pickerTile
    setPickerTile(null)
    if (reason === 'launch') {
      // Land on the terminal the launch just spawned. Plain cut: the 3D stage
      // planet must never animate into the flat sidebar mini-planets — it just
      // disappears and the terminal is there.
      setOrbitOpen(false)
      return
    }
    if (orbitOpen || !hasSessions) {
      if (tile) startTransition('back-to-orbit', tile)
      return
    }
    // Dismiss to the terminal below — same cut (3D → flat never animates).
  }

  // ── Layer mounting + cross-fade styles ──
  const dollyActive = transition !== null && DOLLY_KINDS.has(transition.kind)
  const stageWanted =
    pickerTile ?? (transition && VIEW_OF[transition.kind].from === 'stage' ? transition.tile : null)
  const stageTile = stageWanted && (transition === null || transition.stageVisible) ? stageWanted : null
  const mountTerminal =
    hasSessions ||
    (transition !== null &&
      (transition.kind === 'launch-to-terminal'
        ? transition.launchMode === 'tab'
        : VIEW_OF[transition.kind].to === 'terminal' || VIEW_OF[transition.kind].from === 'terminal'))
  const mountOrbit =
    !hasSessions ||
    orbitOpen ||
    (transition !== null &&
      (VIEW_OF[transition.kind].to === 'orbit' || VIEW_OF[transition.kind].from === 'orbit'))
  const mountStage = stageTile !== null

  const styleFor = (view: ViewKey): React.CSSProperties | undefined => {
    if (!transition) return undefined
    if (transition.kind === 'launch-to-terminal') {
      // The 3D scene and the window-level black overlay own this transition;
      // the layers stay put and inert (no scale/zoom).
      return { pointerEvents: 'none' }
    }
    const ends = VIEW_OF[transition.kind]
    if (DOLLY_KINDS.has(transition.kind)) {
      // The orbit camera does the moving; the layers only dissolve over the
      // handoff and stay inert so a stray click can't re-trigger a launch.
      const inert: React.CSSProperties = { pointerEvents: 'none' }
      if (transition.kind === 'dive-to-stage') {
        // The stage joins at the handoff and dissolves up over the still frame.
        return view === 'stage'
          ? { ...inert, animation: `layer-fade-in ${handoffMs}ms ease both` }
          : inert
      }
      // back-to-orbit: the stage dissolves as the camera starts pulling out.
      return view === 'stage'
        ? { ...inert, animation: `layer-fade-out ${handoffMs}ms ease both` }
        : inert
    }
    if (transition.phase === 'pending') {
      return ends.to === view ? { opacity: 0 } : undefined
    }
    const choreo = CHOREO[transition.kind]
    if (ends.from === view) {
      return layerExitStyle(transitionMs, choreo.outScale, centerRect())
    }
    if (ends.to === view) {
      return layerEnterStyle(transitionMs, choreo.inScale, centerRect())
    }
    return undefined
  }

  const showWelcome = roots.length === 0
  // Keys flow to the layer being transitioned to (the outgoing one stays inert),
  // except mid-dolly where nothing should take input until the move lands.
  const incomingView = transition ? VIEW_OF[transition.kind].to : null
  const chromeFade = dollyActive
    ? {
        mode: (transition.kind === 'dive-to-stage' ? 'out' : 'in') as 'out' | 'in',
        totalMs: transitionMs
      }
    : null

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
                  keyboardActive={
                    !modalOpen && !dollyActive && (transition === null || incomingView === 'orbit')
                  }
                  instant={transition !== null}
                  selectedTileId={transition?.tile.id ?? null}
                  handleRef={orbitSceneRef}
                  chromeFade={chromeFade}
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
              keyboardActive={
                !dollyActive && (transition === null || incomingView === 'stage')
              }
              instant={transition !== null || stageInstant}
              initialSpin={stageSpinRef.current}
              entranceMs={stageInstant ? 0 : transitionMs}
              handleRef={landerSceneRef}
              initialError={launchError}
              onLaunchStart={({ mode, triggeredByKey }) =>
                startLaunchTransition(stageTile, mode, triggeredByKey)
              }
              onLaunchAbort={(err) => abortLaunchTransition(stageTile, err)}
              onClose={closeStage}
              onManageAgents={() => {
                setPickerTile(null)
                setSettingsOpen('agents')
              }}
            />
          </div>
        )}

        {transition?.kind === 'launch-to-terminal' && transition.phase === 'running' && (
          <div
            aria-hidden
            className="pointer-events-auto fixed inset-0 z-[60]"
            style={{
              background: '#000000',
              animation: `launch-black ${LAUNCH_CINEMATIC_MS}ms ease-in-out both`
            }}
          />
        )}
      </div>

      {settingsOpen && (
        <SettingsDialog initialTab={settingsOpen} onClose={() => setSettingsOpen(null)} />
      )}
    </div>
  )
}

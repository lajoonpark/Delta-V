import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentDefinition, RepoTile } from '@shared/types'
import { shortcutMatches } from '@shared/types'
import { useAppActions, useAppState } from '@renderer/state/AppProvider'
import { isMac } from '@renderer/hooks/useTheme'
import { layoutLanderStage } from '@renderer/art/landerLayout'
import { RING_AT_LAUNCHES } from '@renderer/art/orbitLayout'
import { mountLanderScene, type LanderSceneHandle } from './landerScene'
import { LeaderTicks } from './ui'

/**
 * Lander stage — full-screen takeover that replaces the agent picker. The
 * chosen planet spins at left; the repo's agents are seeded procedural landers
 * that fly up from it (three.js/WebGL mount, art from the 2D generators).
 *
 * - Keyboard: type-to-filter, arrows to move, Enter to launch (⌘/Ctrl-Enter
 *   forces a new window), Esc back. Flight is skippable (rebindable hotkey);
 *   reduced-motion cuts to the end state.
 * - Labels use the ticked hairline leader-line callout (JPL schematic).
 * - Launching spawns the terminal via the existing spawnTerminal flow +
 *   windowMode logic, then the stage unmounts.
 */

interface LanderStageProps {
  tile: RepoTile
  /** false while a cross-view transition is running against another layer. */
  keyboardActive?: boolean
  /** Mount at the end state — a cross-view transition is animating the layer. */
  instant?: boolean
  onClose(reason: 'launch' | 'dismiss'): void
  onManageAgents(): void
}

export function LanderStage({
  tile,
  keyboardActive = true,
  instant = false,
  onClose,
  onManageAgents
}: LanderStageProps): React.ReactElement {
  const { agents, settings } = useAppState()
  const { spawnTerminal } = useAppActions()
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sceneRef = useRef<LanderSceneHandle | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [entered, setEntered] = useState(instant)
  const [skipped, setSkipped] = useState(false)

  // Enabled agents in the user's saved order — one seeded lander each.
  const all = useMemo(() => agents.filter((a) => !a.disabled), [agents])
  const flat = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return all
    return all.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.command.toLowerCase().includes(q) ||
        (a.args ?? []).some((arg) => arg.toLowerCase().includes(q))
    )
  }, [all, query])
  useEffect(() => setSelected(0), [query])
  const sel = Math.min(selected, Math.max(0, flat.length - 1))

  const layout = useMemo(
    () => layoutLanderStage(all.length, size.width, size.height),
    [all.length, size.width, size.height]
  )
  const measured = size.width > 0 && size.height > 0

  const transitionMs = settings?.transitionDurationMs ?? 800
  const reduceMotion = useRef(false)
  useEffect(() => {
    reduceMotion.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }, [])

  // ── Measure the takeover ──
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setSize({ width: el.clientWidth, height: el.clientHeight })
    })
    ro.observe(el)
    setSize({ width: el.clientWidth, height: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  // ── 3D mount (on demand; disposed as soon as the stage closes) ──
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !measured) return
    const handle = mountLanderScene({
      canvas,
      layout,
      planetSeed: tile.name,
      ring: tile.openCount >= RING_AT_LAUNCHES,
      landerSeeds: all.map((a) => a.name),
      durationMs: reduceMotion.current ? 0 : transitionMs,
      reducedMotion: reduceMotion.current
    })
    sceneRef.current = handle
    return () => {
      handle.dispose()
      sceneRef.current = null
    }
    // Mount once per stage; later layout changes flow through update() below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tile.id, measured])

  useEffect(() => {
    if (measured) sceneRef.current?.update(layout)
  }, [layout, measured])

  useEffect(() => {
    sceneRef.current?.setSelection(flat.length > 0 ? all.indexOf(flat[sel]) : -1)
    const visible = new Set(flat)
    sceneRef.current?.setVisible(all.map((a) => visible.has(a)))
  }, [flat, all, sel, measured])

  // ── Launch (spawn flow + windowMode logic from the old picker) ──
  const launch = useCallback(
    async (agent: AgentDefinition, openInWindow: boolean): Promise<void> => {
      const windowMode = settings?.windowMode ?? 'both'
      const mode: 'tab' | 'window' =
        openInWindow || windowMode === 'windows' ? 'window' : 'tab'
      try {
        setError(null)
        await spawnTerminal({ repoTileId: tile.id, agentId: agent.id, mode }, tile)
        onClose('launch')
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [settings?.windowMode, spawnTerminal, tile, onClose]
  )

  // ── Flight entrance (skippable; reduced-motion cuts to the end) ──
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

  // ── Keyboard model ──
  const move = useCallback(
    (delta: number) => {
      setSelected(() => {
        const n = flat.length
        if (n === 0) return 0
        return (sel + delta + n * 2) % n
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [flat.length, sel]
  )

  useEffect(() => {
    if (!keyboardActive) return
    const onKey = (e: KeyboardEvent): void => {
      const skipHotkey = settings?.skipTransitionShortcut ?? 'mod+shift+s'
      if (shortcutMatches(e, skipHotkey, isMac)) {
        e.preventDefault()
        skipTransition()
        return
      }
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault()
        move(1)
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault()
        move(-1)
      } else if (e.key === 'Enter') {
        const agent = flat[sel]
        if (agent) {
          e.preventDefault()
          void launch(agent, e.metaKey || e.ctrlKey)
        }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        if (query) setQuery('')
        else onClose('dismiss')
      } else if (e.key === 'Backspace') {
        e.preventDefault()
        setQuery((q) => q.slice(0, -1))
      } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        setQuery((q) => q + e.key)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyboardActive, settings?.skipTransitionShortcut, flat, sel, query, move, launch, onClose, skipTransition])

  useEffect(() => {
    rootRef.current?.focus()
  }, [])

  const duration = reduceMotion.current ? 0 : transitionMs
  const animating = !reduceMotion.current && duration > 0 && !skipped
  const wrapperStyle: React.CSSProperties = {
    opacity: entered ? 1 : 0,
    transition: animating ? `opacity ${duration}ms ease-out` : 'none'
  }
  const hudLeft = isMac ? 78 : 24
  const visibleIds = useMemo(() => new Set(flat.map((a) => a.id)), [flat])
  const modeHint = `OPENS IN ${settings?.windowMode === 'windows' ? 'NEW WINDOW' : 'TAB'} · ${
    isMac ? '⌘' : 'CTRL'
  }-↵ NEW WINDOW`

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="fixed inset-0 z-50 overflow-hidden outline-none"
      style={{ background: 'var(--void)' }}
    >
      <div className="drag-region absolute inset-x-0 top-0 z-20 h-10" />
      <canvas ref={canvasRef} aria-hidden className="absolute inset-0 h-full w-full" />

      <div className="absolute inset-0" style={wrapperStyle}>
        {/* Planet + lander callouts (ticked hairline leader lines) */}
        <svg className="pointer-events-none absolute inset-0 h-full w-full" style={{ overflow: 'visible' }}>
          {/* Planet plate: straight run down from the bottom rim */}
          <g stroke="var(--hairline)" strokeWidth={1}>
            <line
              x1={layout.planet.x}
              y1={layout.planetCallout.startY}
              x2={layout.planet.x}
              y2={layout.planetCallout.endY}
            />
            {Array.from(
              { length: Math.floor((layout.planetCallout.endY - layout.planetCallout.startY) / 15) },
              (_, i) => {
                const y = layout.planetCallout.startY + (i + 1) * 15
                return <line key={i} x1={layout.planet.x - 3} y1={y} x2={layout.planet.x + 3} y2={y} />
              }
            )}
            <line
              x1={layout.planet.x - 7}
              y1={layout.planetCallout.endY}
              x2={layout.planet.x + 7}
              y2={layout.planetCallout.endY}
            />
          </g>

          {all.map((agent, i) => {
            const slot = layout.slots[i]
            if (!slot || !visibleIds.has(agent.id)) return null
            const active = flat[sel]?.id === agent.id
            return (
              <g key={agent.id} stroke={active ? 'var(--ember)' : 'var(--hairline)'} strokeWidth={active ? 1.4 : 1}>
                <polyline
                  points={`${slot.startX},${slot.startY} ${slot.kneeX},${slot.kneeY} ${slot.endX},${slot.endY}`}
                  fill="none"
                />
                <LeaderTicks x0={slot.kneeX} x1={slot.endX} y={slot.endY} />
                <line
                  x1={slot.endX}
                  y1={slot.endY - 7}
                  x2={slot.endX}
                  y2={slot.endY + 7}
                  strokeWidth={active ? 1.6 : 1}
                />
              </g>
            )
          })}
        </svg>

        {/* Planet plate */}
        <div
          className="absolute select-none"
          style={{
            left: layout.planet.x,
            top: layout.planetLabelY,
            transform: 'translateX(-50%)',
            textAlign: 'center'
          }}
        >
          <div
            className="font-display text-[13px] uppercase leading-tight tracking-[0.28em]"
            style={{ color: 'var(--paper)' }}
          >
            {tile.name}
          </div>
          <div
            className="max-w-[240px] truncate font-hud text-[9px] uppercase leading-tight tracking-[0.18em]"
            style={{ color: 'var(--muted)' }}
          >
            {tile.openCount}× · {tile.path}
          </div>
        </div>

        {/* Lander labels */}
        {all.map((agent, i) => {
          const slot = layout.slots[i]
          if (!slot) return null
          const visible = visibleIds.has(agent.id)
          const active = flat[sel]?.id === agent.id
          return (
            <button
              key={agent.id}
              type="button"
              onClick={(e) => void launch(agent, e.metaKey || e.ctrlKey)}
              onMouseEnter={() => {
                const idx = flat.findIndex((a) => a.id === agent.id)
                if (idx >= 0) setSelected(idx)
              }}
              className="absolute select-none text-left outline-none"
              style={{
                top: slot.endY,
                left: slot.labelX,
                transform: 'translateY(-50%)',
                opacity: visible ? 1 : 0,
                pointerEvents: visible ? 'auto' : 'none',
                transition: 'opacity 200ms ease'
              }}
            >
              <div
                className="font-hud text-[11px] uppercase leading-tight tracking-[0.14em]"
                style={{ color: active ? 'var(--ember)' : 'var(--paper)' }}
              >
                {agent.name}
              </div>
              <div
                className="font-hud text-[9px] uppercase leading-tight tracking-[0.18em]"
                style={{ color: active ? 'var(--ember)' : 'var(--muted)', opacity: active ? 0.85 : 0.65 }}
              >
                {agent.command}
                {agent.args && agent.args.length > 0 ? ` ${agent.args.join(' ')}` : ''}
              </div>
            </button>
          )
        })}

        {/* Sprite hit targets: hover selects, click launches */}
        {all.map((agent, i) => {
          const slot = layout.slots[i]
          if (!slot) return null
          const visible = visibleIds.has(agent.id)
          return (
            <button
              key={agent.id}
              type="button"
              aria-label={`Launch ${agent.name}`}
              onClick={(e) => void launch(agent, e.metaKey || e.ctrlKey)}
              onMouseEnter={() => {
                const idx = flat.findIndex((a) => a.id === agent.id)
                if (idx >= 0) setSelected(idx)
              }}
              className="absolute rounded-lg outline-none"
              style={{
                left: slot.x - slot.size / 2,
                top: slot.y - slot.size / 2,
                width: slot.size,
                height: slot.size,
                opacity: visible ? 1 : 0,
                pointerEvents: visible ? 'auto' : 'none'
              }}
            />
          )
        })}

        {/* HUD */}
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute top-5" style={{ left: hudLeft }}>
            <div className="font-display text-[15px] tracking-[0.32em]" style={{ color: 'var(--paper)' }}>
              DELTA-V
            </div>
            <div
              className="font-hud text-[9px] uppercase tracking-[0.34em]"
              style={{ color: 'var(--muted)' }}
            >
              Lander Stage · Deploy to {tile.name}
            </div>
          </div>

          <div className="absolute bottom-5 left-6 flex items-center gap-3">
            <div
              className="rounded-sm border px-2.5 py-1 font-hud text-[10px] uppercase tracking-[0.18em]"
              style={{
                borderColor: query ? 'var(--ember)' : 'var(--hairline)',
                color: query ? 'var(--ember)' : 'var(--muted)',
                background: 'rgba(18,22,30,0.6)'
              }}
            >
              {query ? `FILTER ${query}` : 'TYPE TO FILTER'}
            </div>
            <div
              className="font-hud text-[10px] uppercase tracking-[0.18em]"
              style={{ color: 'var(--muted)' }}
            >
              {flat.length}/{all.length} · ↑↓ MOVE · ↵ LAUNCH · ESC BACK
            </div>
          </div>

          <div className="absolute bottom-5 right-6 flex items-center gap-3">
            <div
              className="font-hud text-[10px] uppercase tracking-[0.18em]"
              style={{ color: 'var(--muted)' }}
            >
              {modeHint}
            </div>
            <button
              type="button"
              onClick={onManageAgents}
              className="pointer-events-auto rounded-sm border px-2.5 py-1 font-hud text-[10px] uppercase tracking-[0.18em]"
              style={{ borderColor: 'var(--hairline)', color: 'var(--muted)' }}
            >
              Manage Agents
            </button>
          </div>

          {all.length === 0 && (
            <div
              className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-sm border px-4 py-2 font-hud text-[10px] uppercase tracking-[0.18em]"
              style={{ borderColor: 'var(--hairline)', color: 'var(--muted)' }}
            >
              No agents configured
            </div>
          )}

          {error && (
            <div
              className="absolute bottom-14 left-1/2 -translate-x-1/2 rounded-sm border px-3 py-1.5 font-hud text-[10px]"
              style={{
                borderColor: 'rgba(255,90,90,0.5)',
                color: '#ff6b6b',
                background: 'rgba(18,22,30,0.8)'
              }}
            >
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

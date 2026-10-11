import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RepoTile } from '@shared/types'
import { formatShortcut, shortcutMatches } from '@shared/types'
import { useAppState } from '@renderer/state/AppProvider'
import { isMac } from '@renderer/hooks/useTheme'
import { renderPlanet } from '@renderer/art/planetGen'
import { layoutOrbit, RING_AT_LAUNCHES, type OrbitBody } from '@renderer/art/orbitLayout'

/**
 * Full-bleed solar-system launcher. Repos are planets on concentric orbits;
 * each is labelled by a ticked hairline leader-line callout (JPL schematic).
 *
 * - Home: replaces the repo grid. Overlay (sessions open): a launcher over the
 *   terminal — Esc returns. Orbit radius is layout only, not physics/3D.
 * - Keyboard: type-to-filter, arrows to move, Enter to launch. Damped-zoom
 *   entrance is skippable (rebindable hotkey); reduced-motion cuts to the end.
 */

interface OrbitViewProps {
  tiles: RepoTile[]
  /** false while a modal (picker/settings) is open, so keys go to the modal. */
  keyboardActive: boolean
  onSelect(tile: RepoTile): void
  /** Esc in overlay mode → return to the terminal. */
  onDismiss(): void
}

/** Per-planet canvas, drawn at dramatic orbit size (seeded like the sidebar). */
function OrbitPlanet({ seed, diameter, ring }: { seed: string; diameter: number; ring: boolean }): React.ReactElement {
  const ref = useRef<HTMLCanvasElement>(null)
  const d = Math.max(8, Math.round(diameter))
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(d * dpr)
    canvas.height = Math.round(d * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    renderPlanet(ctx, d, seed, { ring })
  }, [seed, d, ring])
  return <canvas ref={ref} aria-hidden style={{ width: d, height: d }} />
}

/** Small perpendicular ticks along the horizontal run of a leader line. */
function LeaderTicks({ body }: { body: OrbitBody }): React.ReactElement {
  const y = body.endY
  const x0 = body.kneeX
  const x1 = body.endX
  const dir = Math.sign(x1 - x0) || 1
  const len = Math.abs(x1 - x0)
  const step = 15
  const count = Math.floor(len / step)
  const ticks: React.ReactElement[] = []
  for (let i = 1; i <= count; i++) {
    const x = x0 + dir * i * step
    ticks.push(<line key={i} x1={x} y1={y - 3} x2={x} y2={y + 3} />)
  }
  return <>{ticks}</>
}

export function OrbitView({ tiles, keyboardActive, onSelect, onDismiss }: OrbitViewProps): React.ReactElement {
  const { settings } = useAppState()
  const rootRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const [entered, setEntered] = useState(false)
  const [skipped, setSkipped] = useState(false)

  // ── Measure the full-bleed container ──
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

  // ── Damped-zoom entrance (skippable; reduced-motion cuts to the end) ──
  const transitionMs = settings?.transitionDurationMs ?? 800
  const reduceMotion = useRef(false)
  useEffect(() => {
    reduceMotion.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }, [])
  useEffect(() => {
    if (reduceMotion.current || transitionMs <= 0) {
      setEntered(true)
      return
    }
    const id = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(id)
  }, [transitionMs])

  const skipTransition = useCallback(() => {
    setSkipped(true)
    setEntered(true)
  }, [])

  // ── Filter + selection ──
  const layout = useMemo(
    () => layoutOrbit(tiles, size.width, size.height),
    [tiles, size.width, size.height]
  )
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return layout.bodies
    return layout.bodies.filter(
      (b) => b.tile.name.toLowerCase().includes(q) || b.tile.path.toLowerCase().includes(q)
    )
  }, [layout.bodies, query])

  useEffect(() => setSelected(0), [query])
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
        const body = visible[sel]
        if (body) {
          e.preventDefault()
          onSelect(body.tile)
        }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        if (query) setQuery('')
        else onDismiss()
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
  }, [keyboardActive, settings?.skipTransitionShortcut, visible, sel, query, move, onSelect, onDismiss, skipTransition])

  // Focus the view so typed keys don't fall through to the terminal behind it.
  useEffect(() => {
    if (keyboardActive) rootRef.current?.focus()
  }, [keyboardActive])

  const duration = reduceMotion.current ? 0 : transitionMs
  const animating = !reduceMotion.current && duration > 0 && !skipped
  const wrapperStyle: React.CSSProperties = {
    transform: `scale(${entered ? 1 : 0.94})`,
    opacity: entered ? 1 : 0,
    transition: animating
      ? `transform ${duration}ms cubic-bezier(0.16,1,0.3,1), opacity ${duration}ms ease-out`
      : 'none'
  }

  const orbitShortcut = formatShortcut(settings?.orbitShortcut ?? 'mod+o', isMac)

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="absolute inset-0 overflow-hidden outline-none"
      style={{ background: 'var(--void)' }}
    >
      <div className="absolute inset-0" style={wrapperStyle}>
        {/* Orbit rings + leader-line callouts */}
        <svg className="absolute inset-0 h-full w-full" style={{ overflow: 'visible' }}>
          <defs>
            <radialGradient id="sun-glow">
              <stop offset="0%" stopColor="#FF8A3D" stopOpacity="0.9" />
              <stop offset="35%" stopColor="#FF8A3D" stopOpacity="0.25" />
              <stop offset="100%" stopColor="#FF8A3D" stopOpacity="0" />
            </radialGradient>
          </defs>

          {/* Sun */}
          <circle cx={layout.sunX} cy={layout.sunY} r={Math.min(size.width, size.height) * 0.16} fill="url(#sun-glow)" />
          <circle cx={layout.sunX} cy={layout.sunY} r={4} fill="#FF8A3D" />

          {/* Orbit rings (layout only) */}
          {layout.rings.map((r, i) => (
            <circle
              key={i}
              cx={layout.sunX}
              cy={layout.sunY}
              r={r}
              fill="none"
              stroke="var(--hairline)"
              strokeWidth={1}
              strokeDasharray="2 6"
              opacity={0.7}
            />
          ))}

          {/* Leader lines + ticks */}
          {visible.map((b) => {
            const active = visible[sel]?.tile.id === b.tile.id
            const stroke = active ? 'var(--ember)' : 'var(--hairline)'
            return (
              <g key={b.tile.id} stroke={stroke} strokeWidth={active ? 1.4 : 1}>
                <polyline
                  points={`${b.startX},${b.startY} ${b.kneeX},${b.kneeY} ${b.endX},${b.endY}`}
                  fill="none"
                />
                <LeaderTicks body={b} />
                <line x1={b.endX} y1={b.endY - 7} x2={b.endX} y2={b.endY + 7} strokeWidth={active ? 1.6 : 1} />
                {active && (
                  <circle cx={b.cx} cy={b.cy} r={b.r + 8} fill="none" strokeDasharray="3 5" />
                )}
              </g>
            )
          })}
        </svg>

        {/* Planets */}
        {visible.map((b) => {
          const active = visible[sel]?.tile.id === b.tile.id
          return (
            <div
              key={b.tile.id}
              className="absolute"
              style={{
                left: b.cx - b.r,
                top: b.cy - b.r,
                filter: active ? 'none' : 'saturate(0.85) brightness(0.92)',
                transition: 'filter 150ms ease'
              }}
            >
              <OrbitPlanet
                seed={b.tile.name}
                diameter={b.r * 2}
                ring={b.tile.openCount >= RING_AT_LAUNCHES}
              />
            </div>
          )
        })}

        {/* Callout labels */}
        {visible.map((b) => {
          const active = visible[sel]?.tile.id === b.tile.id
          const right = b.align === 'left'
          return (
            <div
              key={b.tile.id}
              className="absolute select-none"
              style={{
                top: b.endY,
                ...(right ? { left: b.labelX } : { right: size.width - b.labelX }),
                transform: 'translateY(-50%)',
                textAlign: right ? 'left' : 'right'
              }}
            >
              <div
                className="font-hud text-[11px] leading-tight tracking-[0.14em] uppercase"
                style={{ color: active ? 'var(--ember)' : 'var(--paper)' }}
              >
                {b.tile.name}
              </div>
              <div
                className="font-hud text-[9px] leading-tight tracking-[0.18em] uppercase"
                style={{ color: active ? 'var(--ember)' : 'var(--muted)', opacity: active ? 0.85 : 0.65 }}
              >
                {b.tile.openCount}× · {b.ring === 0 ? 'INNER' : `R${b.ring + 1}`}
              </div>
            </div>
          )
        })}

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

          {/* Filter readout (type-to-filter) */}
          <div className="absolute bottom-5 left-6 flex items-center gap-3">
            <div
              className="rounded-sm border px-2.5 py-1 font-hud text-[10px] tracking-[0.18em] uppercase"
              style={{
                borderColor: query ? 'var(--ember)' : 'var(--hairline)',
                color: query ? 'var(--ember)' : 'var(--muted)',
                background: 'rgba(18,22,30,0.6)'
              }}
            >
              {query ? `FILTER ${query}` : 'TYPE TO FILTER'}
            </div>
            <div
              className="font-hud text-[10px] tracking-[0.18em] uppercase"
              style={{ color: 'var(--muted)' }}
            >
              {visible.length}/{layout.bodies.length} · ←→ MOVE · ↵ LAUNCH
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
    </div>
  )
}

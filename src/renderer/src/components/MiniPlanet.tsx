import { useEffect, useRef } from 'react'
import { renderPlanet } from '@renderer/art/planetGen'

/** Sidebar planet growth band, log-scaled from the repo's open counter. */
export const PLANET_SCALE_MIN = 0.8
export const PLANET_SCALE_MAX = 1.3
/** Ring is earned at 50 launches, never random. */
export const RING_AT_LAUNCHES = 50

const MIN_PX = 24
const MAX_PX = 32
// Always draw at the 32px artwork tier so the earned ring survives the
// generator's tiny-canvas cutoff at every display size; growth is a pure
// bitmap scale of the same artwork.
const LOGICAL_PX = 32
const GROWTH_SATURATION = 150

export function sidebarPlanetScale(openCount: number): number {
  const t = Math.min(1, Math.log1p(Math.max(0, openCount)) / Math.log1p(GROWTH_SATURATION))
  return PLANET_SCALE_MIN + t * (PLANET_SCALE_MAX - PLANET_SCALE_MIN)
}

/** Mini-planet for a sidebar repo row, seeded from the repo name. */
export function MiniPlanet({
  seed,
  openCount,
  className
}: {
  seed: string
  openCount: number
  className?: string
}): React.ReactElement {
  const ref = useRef<HTMLCanvasElement>(null)
  const t = (sidebarPlanetScale(openCount) - PLANET_SCALE_MIN) / (PLANET_SCALE_MAX - PLANET_SCALE_MIN)
  const px = Math.round(MIN_PX + t * (MAX_PX - MIN_PX))

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const backing = Math.max(1, Math.round(px * (window.devicePixelRatio || 1)))
    canvas.width = backing
    canvas.height = backing
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const k = backing / LOGICAL_PX
    ctx.setTransform(k, 0, 0, k, 0, 0)
    renderPlanet(ctx, LOGICAL_PX, seed, { ring: openCount >= RING_AT_LAUNCHES })
  }, [seed, openCount, px])

  return (
    <canvas
      ref={ref}
      aria-hidden
      style={{ width: px, height: px }}
      className={className ?? 'shrink-0'}
    />
  )
}

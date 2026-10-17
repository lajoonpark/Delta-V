import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { RemoteSessionInfo } from '@shared/types'
import { remoteConnection, type Viewer } from './connection'

/** Imperative handle the session view uses for the "jump to latest" button. */
export interface RemoteTerminalHandle {
  jumpToBottom(): void
}

interface RemoteTerminalProps {
  session: RemoteSessionInfo
  /** Explicit px size from the user, or null for auto-fit. */
  fontSize: number | null
  onFollowingChange(following: boolean): void
  onGone(): void
}

// Copied verbatim from the desktop terminal so the mirror reads identically.
const DARK_THEME = {
  background: '#0c0c0f',
  foreground: '#e4e4e7',
  cursor: '#f59e0b',
  cursorAccent: '#0c0c0f',
  selectionBackground: '#27272a',
  black: '#18181b',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#facc15',
  blue: '#60a5fa',
  magenta: '#e879f9',
  cyan: '#22d3ee',
  white: '#e4e4e7',
  brightBlack: '#52525b',
  brightWhite: '#fafafa'
}

const MIN_FONT = 4
const MAX_AUTO_FONT = 18

/**
 * Read-only xterm.js mirror for one remote session.
 *
 * One Terminal per session id. The grid is always the session's cols×rows so
 * wrapping matches the desktop exactly; only the font size adapts. Vertical
 * touch gestures drive xterm's scrollback ourselves; horizontal pans are native.
 */
export const RemoteTerminal = forwardRef<RemoteTerminalHandle, RemoteTerminalProps>(
  function RemoteTerminal({ session, fontSize, onFollowingChange, onGone }, ref) {
    const wrapperRef = useRef<HTMLDivElement>(null)
    const termRef = useRef<Terminal | null>(null)
    const refitRef = useRef<() => void>(() => {})
    const jumpRef = useRef<() => void>(() => {})

    const fontSizeRef = useRef(fontSize)
    fontSizeRef.current = fontSize
    const followingRef = useRef(true)
    const onFollowingRef = useRef(onFollowingChange)
    onFollowingRef.current = onFollowingChange
    const onGoneRef = useRef(onGone)
    onGoneRef.current = onGone

    useImperativeHandle(ref, () => ({ jumpToBottom: () => jumpRef.current() }), [])

    useEffect(() => {
      const wrapper = wrapperRef.current
      if (!wrapper) return

      const term = new Terminal({
        cols: session.cols,
        rows: session.rows,
        scrollback: 10_000,
        disableStdin: true,
        cursorBlink: false,
        allowTransparency: false,
        fontFamily: 'Menlo, "SF Mono", ui-monospace, SFMono-Regular, Consolas, monospace',
        fontSize: fontSizeRef.current ?? 10,
        theme: DARK_THEME
      })
      termRef.current = term
      term.open(wrapper)

      // iOS: make the helper textarea inert so tapping never summons a keyboard.
      const ta = term.textarea
      if (ta) {
        ta.setAttribute('readonly', '')
        ta.inputMode = 'none'
        ta.tabIndex = -1
      }
      const onFocusIn = (e: FocusEvent): void => {
        const target = e.target as HTMLElement | null
        if (target && typeof target.blur === 'function') target.blur()
      }
      term.element?.addEventListener('focusin', onFocusIn)

      const screenEl = (): HTMLElement | null =>
        (term.element?.querySelector('.xterm-screen') as HTMLElement | null) ?? null

      const cellHeight = (): number => {
        const screen = screenEl()
        if (!screen || term.rows <= 0) return 0
        return screen.offsetHeight / term.rows
      }

      // ── Auto-fit: largest integer font size keeping cols×rows inside the wrapper.
      let fitting = false

      // ±1 correction loop, shared by the probe fit and the post-fit check.
      const nudge = (start: number): void => {
        const screen = screenEl()
        if (!screen) return
        const availW = wrapper.clientWidth
        const availH = wrapper.clientHeight
        if (availW <= 0 || availH <= 0) return
        let target = Math.max(MIN_FONT, Math.min(MAX_AUTO_FONT, start))
        term.options.fontSize = target
        for (let i = 0; i < 2; i++) {
          const ok = screen.offsetWidth <= availW && screen.offsetHeight <= availH
          if (!ok && target > MIN_FONT) {
            target -= 1
            term.options.fontSize = target
          } else if (ok && target < MAX_AUTO_FONT) {
            term.options.fontSize = target + 1
            if (screen.offsetWidth <= availW && screen.offsetHeight <= availH) target += 1
            else term.options.fontSize = target
          } else {
            break
          }
        }
      }

      const fit = (): void => {
        if (fontSizeRef.current !== null) return
        const screen = screenEl()
        if (!screen) return
        const availW = wrapper.clientWidth
        const availH = wrapper.clientHeight
        if (availW <= 0 || availH <= 0) return
        term.options.fontSize = 10
        const probeW = screen.offsetWidth
        const probeH = screen.offsetHeight
        if (probeW <= 0 || probeH <= 0) return
        const target = Math.floor(Math.min((availW * 10) / probeW, (availH * 10) / probeH))
        nudge(target)
      }

      // xterm can update .xterm-screen a frame after an option change; re-measure
      // once and apply the same ±1 correction without restarting from the probe.
      const verifyFit = (): void => {
        if (fontSizeRef.current !== null) return
        const screen = screenEl()
        if (!screen) return
        const availW = wrapper.clientWidth
        const availH = wrapper.clientHeight
        if (availW <= 0 || availH <= 0) return
        const current = term.options.fontSize
        if (current === undefined || screen.offsetHeight <= 0 || screen.offsetWidth <= 0) return
        const fits = screen.offsetWidth <= availW && screen.offsetHeight <= availH
        const est = Math.floor(
          Math.min((availW * current) / screen.offsetWidth, (availH * current) / screen.offsetHeight)
        )
        const best = Math.max(MIN_FONT, Math.min(MAX_AUTO_FONT, est))
        // Already fits at (within 1px of) the best integer size — leave it.
        if (fits && Math.abs(current - best) <= 1) return
        nudge(current)
      }

      let fitQueued = false
      let verifyPasses = 0
      const scheduleFit = (): void => {
        if (fitQueued) return
        fitQueued = true
        verifyPasses = 0
        requestAnimationFrame(() => {
          fitQueued = false
          if (fitting) return
          fitting = true
          try {
            fit()
          } finally {
            fitting = false
          }
          // One verification pass only, so this can't loop per scheduleFit call.
          if (verifyPasses >= 1) return
          verifyPasses += 1
          requestAnimationFrame(() => {
            if (fitting) return
            fitting = true
            try {
              verifyFit()
            } finally {
              fitting = false
            }
          })
        })
      }
      refitRef.current = scheduleFit

      const updateFollowing = (): void => {
        const buf = term.buffer.active
        const following = buf.viewportY >= buf.baseY
        if (following !== followingRef.current) {
          followingRef.current = following
          onFollowingRef.current(following)
        }
      }
      jumpRef.current = () => {
        term.scrollToBottom()
        updateFollowing()
      }

      const scrollOff = term.onScroll(updateFollowing)
      const parsedOff = term.onWriteParsed(updateFollowing)

      const viewer: Viewer = {
        reset(snapshot) {
          term.reset()
          term.resize(snapshot.cols, snapshot.rows)
          term.write(snapshot.data, () => {
            term.scrollToBottom()
            scheduleFit()
            updateFollowing()
          })
        },
        write(data) {
          term.write(data)
        },
        gone() {
          onGoneRef.current()
        }
      }
      const detach = remoteConnection.attachViewer(session.id, viewer)

      // ── Touch scrollback: vertical drags are ours, horizontal stays native.
      let flingRaf = 0
      let touchActive = false
      let axis: 'none' | 'v' | 'h' = 'none'
      let startX = 0
      let startY = 0
      let lastY = 0
      let lastT = 0
      let vPx = 0
      let remainder = 0

      const cancelFling = (): void => {
        if (flingRaf) cancelAnimationFrame(flingRaf)
        flingRaf = 0
      }

      const scrollByPx = (inc: number): void => {
        const ch = cellHeight()
        if (ch <= 0) return
        const raw = remainder - inc / ch
        const whole = raw < 0 ? Math.ceil(raw) : Math.floor(raw)
        remainder = raw - whole
        if (whole !== 0) {
          term.scrollLines(whole)
          updateFollowing()
        }
      }

      const startFling = (velocityPx: number, ch: number): void => {
        cancelFling()
        let v = velocityPx
        let rem = 0
        const step = (): void => {
          v *= 0.95
          const raw = -v / ch + rem
          const whole = raw < 0 ? Math.ceil(raw) : Math.floor(raw)
          rem = raw - whole
          if (whole !== 0) {
            term.scrollLines(whole)
            updateFollowing()
          }
          if (Math.abs(v) / ch < 0.05) {
            flingRaf = 0
            return
          }
          flingRaf = requestAnimationFrame(step)
        }
        flingRaf = requestAnimationFrame(step)
      }

      const onTouchStart = (e: TouchEvent): void => {
        cancelFling()
        if (e.touches.length !== 1) {
          touchActive = false
          return
        }
        const t = e.touches[0]
        touchActive = true
        axis = 'none'
        startX = t.clientX
        startY = t.clientY
        lastY = t.clientY
        lastT = e.timeStamp
        vPx = 0
        remainder = 0
      }

      const onTouchMove = (e: TouchEvent): void => {
        if (!touchActive || e.touches.length !== 1) return
        const t = e.touches[0]
        const dx = t.clientX - startX
        const dy = t.clientY - startY
        if (axis === 'none') {
          if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return
          axis = Math.abs(dy) >= Math.abs(dx) ? 'v' : 'h'
        }
        if (axis !== 'v') return
        e.preventDefault()
        e.stopPropagation()
        const inc = t.clientY - lastY
        scrollByPx(inc)
        const dt = Math.max(1, e.timeStamp - lastT)
        vPx = (inc / dt) * 16
        lastY = t.clientY
        lastT = e.timeStamp
      }

      const onTouchEnd = (): void => {
        if (!touchActive) return
        touchActive = false
        if (axis === 'v') {
          const ch = cellHeight()
          if (ch > 0 && Math.abs(vPx) > 2) startFling(vPx, ch)
        }
        axis = 'none'
      }

      wrapper.addEventListener('touchstart', onTouchStart, { capture: true, passive: false })
      wrapper.addEventListener('touchmove', onTouchMove, { capture: true, passive: false })
      wrapper.addEventListener('touchend', onTouchEnd, { capture: true })
      wrapper.addEventListener('touchcancel', onTouchEnd, { capture: true })

      // ── Refit on layout changes.
      const ro = new ResizeObserver(() => scheduleFit())
      ro.observe(wrapper)
      const onViewportChange = (): void => scheduleFit()
      window.addEventListener('orientationchange', onViewportChange)
      window.addEventListener('resize', onViewportChange)
      requestAnimationFrame(() => scheduleFit())

      return () => {
        cancelFling()
        detach()
        scrollOff.dispose()
        parsedOff.dispose()
        ro.disconnect()
        window.removeEventListener('orientationchange', onViewportChange)
        window.removeEventListener('resize', onViewportChange)
        wrapper.removeEventListener('touchstart', onTouchStart, { capture: true })
        wrapper.removeEventListener('touchmove', onTouchMove, { capture: true })
        wrapper.removeEventListener('touchend', onTouchEnd, { capture: true })
        wrapper.removeEventListener('touchcancel', onTouchEnd, { capture: true })
        term.element?.removeEventListener('focusin', onFocusIn)
        term.dispose()
        termRef.current = null
        refitRef.current = () => {}
        jumpRef.current = () => {}
        followingRef.current = true
      }
    }, [session.id])

    // Numeric font size: apply directly; the wrapper pans/scrolls to reveal the grid.
    useEffect(() => {
      const term = termRef.current
      if (!term) return
      if (fontSize !== null) term.options.fontSize = fontSize
      refitRef.current()
    }, [fontSize])

    // Desktop resize: keep the grid identical to the session's cols×rows.
    useEffect(() => {
      const term = termRef.current
      if (!term) return
      if (term.cols !== session.cols || term.rows !== session.rows) {
        term.resize(session.cols, session.rows)
        refitRef.current()
      }
    }, [session.cols, session.rows])

    return (
      <div
        ref={wrapperRef}
        className="h-full w-full touch-pan-x overflow-auto bg-[#0c0c0f]"
      />
    )
  }
)

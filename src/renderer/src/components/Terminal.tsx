import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import type { TerminalSessionInfo } from '@shared/types'
import { useAppActions } from '@renderer/state/AppProvider'
import { isMac } from '@renderer/hooks/useTheme'
import '@xterm/xterm/css/xterm.css'

/**
 * xterm.js wrapper for one PTY session.
 *
 * - Data: renderer keystrokes → main (terminalInput); PTY output → xterm.
 *   Output that arrives before mount is replayed from the provider buffer.
 * - Fit: ResizeObserver + activation changes → fit() → pty resize via IPC.
 * - Stays mounted while its tab is hidden so scrollback survives; hidden
 *   terminals are refit on activation.
 * - Cmd/Ctrl+C / V copy-paste with selection awareness.
 */

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

const LIGHT_THEME = {
  background: '#ffffff',
  foreground: '#27272a',
  cursor: '#b45309',
  cursorAccent: '#ffffff',
  selectionBackground: '#d4d4d8',
  black: '#18181b',
  red: '#dc2626',
  green: '#16a34a',
  yellow: '#ca8a04',
  blue: '#2563eb',
  magenta: '#c026d3',
  cyan: '#0891b2',
  white: '#e4e4e7',
  brightBlack: '#71717a',
  brightWhite: '#fafafa'
}

interface TerminalViewProps {
  session: TerminalSessionInfo
  active: boolean
  fontSize: number
  fontFamily: string
  dark: boolean
  onExit?(exitCode: number): void
}

export function TerminalView({
  session,
  active,
  fontSize,
  fontFamily,
  dark,
  onExit
}: TerminalViewProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const { drainOutput, noteSessionPainted } = useAppActions()
  const onExitRef = useRef(onExit)
  onExitRef.current = onExit

  // Create once per session
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      fontSize,
      fontFamily,
      scrollback: 10_000,
      cursorBlink: true,
      macOptionIsMeta: true,
      allowTransparency: false,
      theme: dark ? DARK_THEME : LIGHT_THEME
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri)))
    term.open(container)
    termRef.current = term
    fitRef.current = fit

    // Replay any PTY output that arrived before mount (banner, prompt…)
    const replay = drainOutput(session.id)
    if (replay) term.write(replay)

    // ── Boot-overlay dismissal ───────────────────────────────────────────
    // Keep the "starting…" pill up until this session has actually painted
    // visible content on screen. Main's 'ready' status fires on the first
    // byte of PTY output, which is often pure escape sequences (alt-screen
    // enter, clear) that arrive seconds before a TUI like kilo paints any
    // glyphs — gating on real content avoids dropping the spinner onto a
    // blank terminal. We check the visible buffer rows after every parsed
    // write plus a light poll as a safety net, stopping at the first
    // non-blank line.
    let painted = false
    let poll: number | undefined
    const checkPainted = (): void => {
      if (painted) return
      const buff = term.buffer.active
      const start = Math.max(0, buff.length - term.rows)
      for (let y = start; y < buff.length; y++) {
        const line = buff.getLine(y)
        if (!line || line.isWrapped) continue
        if (line.translateToString(true).trim().length > 0) {
          painted = true
          if (poll !== undefined) clearInterval(poll)
          noteSessionPainted(session.id)
          return
        }
      }
    }
    poll = window.setInterval(checkPainted, 150)
    checkPainted()
    const parsedOff = term.onWriteParsed(checkPainted)

    const offs = [
      window.deltav.onTerminalData(({ sessionId, data }) => {
        if (sessionId === session.id) term.write(data)
      }),
      window.deltav.onTerminalExit(({ sessionId, exitCode }) => {
        if (sessionId === session.id) {
          if (poll !== undefined) clearInterval(poll)
          onExitRef.current?.(exitCode)
        }
      }),
      term.onData((data) => window.deltav.terminalInput(session.id, data))
    ]

    // Copy/paste with selection awareness (terminal-first, then default)
    term.attachCustomKeyEventHandler((e): boolean => {
      const meta = isMac ? e.metaKey : e.ctrlKey && !e.shiftKey
      if (meta && e.type === 'keydown' && e.key === 'c' && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection())
        return false
      }
      if (meta && e.type === 'keydown' && e.key === 'v') {
        void navigator.clipboard
          .readText()
          .then((text) => text && term.paste(text))
          .catch(() => undefined)
        return false
      }
      return true
    })

    const refit = (): void => {
      const t = termRef.current
      const f = fitRef.current
      if (!t || !f) return
      try {
        f.fit()
      } catch {
        return // zero-size container (hidden tab)
      }
      window.deltav.terminalResize(session.id, t.cols, t.rows).catch(() => undefined)
    }

    const ro = new ResizeObserver(() => refit())
    ro.observe(container)

    // Late container sizing (fonts, layout settles)
    requestAnimationFrame(refit)

    return () => {
      offs.forEach((off) => (typeof off === 'function' ? off() : off.dispose()))
      if (poll !== undefined) clearInterval(poll)
      parsedOff.dispose()
      ro.disconnect()
      term.dispose()
      if (termRef.current === term) termRef.current = null
      fitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id])

  // Live font/theme updates
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontSize = fontSize
    term.options.fontFamily = fontFamily
    term.options.theme = dark ? DARK_THEME : LIGHT_THEME
    try {
      fitRef.current?.fit()
    } catch {
      // hidden
    }
    window.deltav.terminalResize(session.id, term.cols, term.rows).catch(() => undefined)
  }, [fontSize, fontFamily, dark, session.id])

  // Refit when the tab becomes visible again
  useEffect(() => {
    if (!active) return
    const raf = requestAnimationFrame(() => {
      const term = termRef.current
      const fit = fitRef.current
      if (!term || !fit) return
      try {
        fit.fit()
      } catch {
        return
      }
      window.deltav.terminalResize(session.id, term.cols, term.rows).catch(() => undefined)
      term.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [active, session.id])

  return (
    // visibility (not display) keeps layout size so xterm can open and fit
    // correctly even while its tab is in the background.
    <div
      ref={containerRef}
      className={`selectable absolute inset-0 [&_.xterm]:h-full [&_.xterm]:p-2 ${
        active ? 'visible' : 'invisible pointer-events-none'
      }`}
    />
  )
}

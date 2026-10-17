import { useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowDown,
  ChevronLeft,
  Eye,
  EyeOff,
  Loader2,
  Type,
  X
} from 'lucide-react'
import type { RemoteSessionInfo } from '@shared/types'
import { useRemoteState } from './useRemoteState'
import { useWakeLock } from './useWakeLock'
import { SessionStatusChip } from './SessionList'
import { RemoteTerminal, type RemoteTerminalHandle } from './RemoteTerminal'
import { repoName } from './format'

const FONT_KEY = 'deltav.remote.fontSize'

// Dismissed exit banners, keyed by session id. Module-level so resync/remount
// never re-shows a banner the user already closed.
const dismissedExits = new Set<string>()

function readFontSize(): number | null {
  try {
    const raw = localStorage.getItem(FONT_KEY)
    if (!raw || raw === 'auto') return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

/** One session: header chrome plus the read-only terminal and its overlays. */
export function SessionView({
  sessionId,
  onBack
}: {
  sessionId: string
  onBack(): void
}): React.ReactElement {
  const { sessions } = useRemoteState()
  const session = sessions.find((s) => s.id === sessionId)
  const wake = useWakeLock()

  const [showFont, setShowFont] = useState(false)
  const [fontSize, setFontSize] = useState<number | null>(readFontSize)
  const [following, setFollowing] = useState(true)
  const [gone, setGone] = useState(false)
  const [dismissed, setDismissed] = useState(() => dismissedExits.has(sessionId))
  const termRef = useRef<RemoteTerminalHandle>(null)

  // Keep the last known session so a purged session can still render its terminal.
  const lastRef = useRef<RemoteSessionInfo | null>(null)
  if (session) lastRef.current = session
  const active = session ?? lastRef.current

  const setFont = (value: number | null): void => {
    setFontSize(value)
    try {
      localStorage.setItem(FONT_KEY, value === null ? 'auto' : String(value))
    } catch {
      // storage unavailable — font stays in-memory only
    }
  }

  if (!active) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm text-muted">This session is no longer available.</p>
        <button
          type="button"
          onClick={onBack}
          className="min-h-11 rounded-xl border border-hairline bg-hull px-4 text-sm text-paper"
        >
          Back to sessions
        </button>
      </div>
    )
  }

  const exit = active.exit
  const showBanner = !dismissed && (exit !== undefined || gone)
  const wakeTitle =
    wake.method === 'video'
      ? "Keeps the screen on (compatibility mode — this page isn't HTTPS)"
      : 'Keeps the screen on'

  // Three distinct wake states: needs a tap, on, or failed but still enabled.
  const wakeLabel = wake.needsTap
    ? 'Tap to keep screen on'
    : wake.enabled
      ? wake.active
        ? 'Screen will stay on'
        : 'Keep-awake could not start — tap to retry'
      : wakeTitle
  const wakeTone = wake.needsTap
    ? 'text-accent'
    : wake.enabled
      ? wake.active
        ? 'text-accent'
        : 'text-accent-dim'
      : 'text-muted'

  const dismissBanner = (): void => {
    dismissedExits.add(sessionId)
    setDismissed(true)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="sticky top-0 z-20 shrink-0 border-b border-hairline bg-hull/95 backdrop-blur">
        <div className="flex items-center gap-1 px-1 py-1">
          <button
            type="button"
            aria-label="Back"
            onClick={onBack}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-paper active:bg-hairline"
          >
            <ChevronLeft size={22} />
          </button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-paper">{active.title}</p>
            <p className="truncate text-xs text-muted">
              {active.agentName ?? active.agentId} · {repoName(active.cwd)}
            </p>
          </div>
          <SessionStatusChip session={active} />
          {wake.method !== 'none' && (
            <button
              type="button"
              aria-pressed={wake.enabled}
              title={wakeLabel}
              aria-label={wakeLabel}
              onClick={() => void wake.toggle()}
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl active:bg-hairline ${wakeTone}`}
            >
              {wake.enabled ? <Eye size={18} /> : <EyeOff size={18} />}
            </button>
          )}
          <button
            type="button"
            aria-label="Font size"
            aria-pressed={showFont}
            onClick={() => setShowFont((v) => !v)}
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl active:bg-hairline ${
              showFont ? 'text-accent' : 'text-muted'
            }`}
          >
            <Type size={18} />
          </button>
        </div>

        {showFont && (
          <div className="flex items-center gap-3 border-t border-hairline px-3 py-2">
            <input
              type="range"
              min={4}
              max={20}
              step={1}
              value={fontSize ?? 10}
              onChange={(e) => setFont(Number(e.target.value))}
              aria-label="Terminal font size"
              className="h-11 flex-1 accent-accent"
            />
            <button
              type="button"
              onClick={() => setFont(null)}
              aria-pressed={fontSize === null}
              className={`min-h-9 rounded-lg border px-3 text-xs ${
                fontSize === null ? 'border-accent text-accent' : 'border-hairline text-muted'
              }`}
            >
              Auto
            </button>
            <span className="w-12 text-right text-xs tabular-nums text-muted">
              {fontSize === null ? 'auto' : `${fontSize}px`}
            </span>
          </div>
        )}

        {wake.needsTap && (
          <p className="border-t border-hairline px-3 py-1.5 text-[11px] text-accent">Tap to keep screen on</p>
        )}
        {wake.method === 'none' && (
          <p className="border-t border-hairline px-3 py-1.5 text-[11px] text-muted">
            Keep-awake isn't supported in this browser
          </p>
        )}
      </header>

      <div className="relative min-h-0 flex-1 bg-[#0c0c0f]">
        <RemoteTerminal
          ref={termRef}
          session={active}
          fontSize={fontSize}
          onFollowingChange={setFollowing}
          onGone={() => setGone(true)}
        />

        {!exit && !gone && active.status === 'booting' && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <div className="flex items-center gap-2 rounded-full border border-hairline bg-hull/85 px-4 py-2 text-xs text-muted backdrop-blur">
              <Loader2 size={13} className="animate-spin text-accent" />
              Starting…
            </div>
          </div>
        )}
        {!exit && !gone && active.status === 'stalled' && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <div className="flex items-center gap-2 rounded-full border border-accent/40 bg-hull/85 px-4 py-2 text-xs text-accent backdrop-blur">
              <AlertTriangle size={13} />
              Agent hasn't printed anything yet
            </div>
          </div>
        )}

        {showBanner && (
          <div className="absolute inset-x-2 top-2 z-30 flex items-start gap-2 rounded-xl border border-hairline bg-hull/95 px-3 py-2 text-xs text-paper shadow-overlay backdrop-blur">
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-accent" />
            <span className="flex-1">
              {exit
                ? `Session exited (exit code ${exit.exitCode})${exit.signal ? ` · signal ${exit.signal}` : ''}`
                : 'Session ended'}
            </span>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={dismissBanner}
              className="-mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted active:text-paper"
            >
              <X size={14} />
            </button>
          </div>
        )}

        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center pb-3">
          {following ? (
            <span className="rounded-full bg-hull/70 px-3 py-1 text-[11px] text-muted backdrop-blur">
              ● Following
            </span>
          ) : (
            <button
              type="button"
              onClick={() => termRef.current?.jumpToBottom()}
              className="pointer-events-auto flex min-h-11 items-center gap-1.5 rounded-full bg-accent px-4 text-sm font-medium text-void shadow-overlay active:bg-accent-dim"
            >
              <ArrowDown size={16} />
              Jump to latest
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

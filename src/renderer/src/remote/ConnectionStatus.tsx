import { Loader2, RefreshCw, WifiOff } from 'lucide-react'
import { remoteConnection } from './connection'
import { useRemoteState } from './useRemoteState'

/** Small transient pill shown while the connection is re-establishing. */
export function ReconnectingPill(): React.ReactElement | null {
  const { showPill } = useRemoteState()
  if (!showPill) return null
  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-30 flex justify-center">
      <div className="flex items-center gap-2 rounded-full border border-hairline bg-hull/95 px-3 py-1.5 text-xs text-muted shadow-overlay backdrop-blur">
        <Loader2 size={13} className="animate-spin text-accent" />
        Reconnecting…
      </div>
    </div>
  )
}

/** Opaque full-screen outage overlay so a frozen terminal is never mistaken for live. */
export function UnreachableOverlay(): React.ReactElement | null {
  const { phase, attempt } = useRemoteState()
  if (phase !== 'unreachable') return null
  return (
    <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-4 bg-void/95 px-8 text-center backdrop-blur-sm">
      <WifiOff size={40} className="text-accent" />
      <h2 className="text-lg font-semibold text-paper">Can't reach Delta-V — retrying</h2>
      <p className="max-w-xs text-sm leading-relaxed text-muted">
        Is your computer awake and on the same Wi-Fi? Delta-V must be running with Remote enabled.
      </p>
      <button
        type="button"
        onClick={() => remoteConnection.retryNow()}
        className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-accent px-6 text-sm font-medium text-void active:bg-accent-dim"
      >
        <RefreshCw size={16} />
        Retry
      </button>
      <p className="text-xs text-muted">Retry attempts: {attempt}</p>
    </div>
  )
}

/** Full-screen splash shown on first connect, before any session data exists. */
export function ConnectingSplash(): React.ReactElement {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-void text-paper">
      <Loader2 size={32} className="animate-spin text-accent" />
      <p className="text-sm text-muted">Connecting to Delta-V…</p>
    </div>
  )
}

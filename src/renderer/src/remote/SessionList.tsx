import { useEffect, useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import type { RemoteSessionInfo } from '@shared/types'
import { remoteConnection, type ConnectionPhase } from './connection'
import { useRemoteState } from './useRemoteState'
import { relativeTime, repoName } from './format'

/** Status chip shared by the list cards and the session header. */
export function SessionStatusChip({ session }: { session: RemoteSessionInfo }): React.ReactElement {
  const base = 'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]'
  if (session.exit) {
    return (
      <span className={`${base} border-hairline text-muted`}>
        <span className="h-1.5 w-1.5 rounded-full bg-muted" />
        Exited ({session.exit.exitCode})
      </span>
    )
  }
  const status = session.status ?? 'ready'
  if (status === 'booting') {
    return (
      <span className={`${base} border-hairline text-muted`}>
        <Loader2 size={12} className="animate-spin" />
        Starting
      </span>
    )
  }
  if (status === 'stalled') {
    return (
      <span className={`${base} border-accent/40 text-accent`}>
        <AlertTriangle size={12} />
        No output yet
      </span>
    )
  }
  return (
    <span className={`${base} border-emerald-500/40 text-emerald-400`}>
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
      Live
    </span>
  )
}

function phaseDot(phase: ConnectionPhase): string {
  switch (phase) {
    case 'live':
      return 'bg-emerald-400 animate-pulse'
    case 'connecting':
    case 'reconnecting':
      return 'bg-accent'
    case 'unreachable':
      return 'bg-ember'
    default:
      return 'bg-muted'
  }
}

/** Session list: header with phase dot and unpair, then one card per session. */
export function SessionList({ onOpen }: { onOpen(id: string): void }): React.ReactElement {
  const { sessions, phase } = useRemoteState()
  const [now, setNow] = useState(() => Date.now())

  // "started Xs ago" lines only need a coarse tick.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  const unpair = (): void => {
    if (window.confirm('Unpair this phone? You will need to scan the QR code again.')) {
      remoteConnection.unpair()
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-hairline px-4 pb-3 pt-3">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${phaseDot(phase)}`} aria-hidden />
          <h1 className="text-base font-semibold text-paper">Delta-V Remote</h1>
        </div>
        <button
          type="button"
          onClick={unpair}
          className="-mr-2 flex min-h-11 items-center rounded-lg px-3 text-sm text-muted active:text-paper"
        >
          Unpair
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-4 py-3">
        {sessions.length === 0 ? (
          <div className="flex flex-col items-center gap-1 px-6 pt-16 text-center">
            <p className="text-sm font-medium text-paper">No active sessions</p>
            <p className="text-xs text-muted">Start an agent in Delta-V and it will appear here.</p>
          </div>
        ) : (
          sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              onClick={() => onOpen(session.id)}
              className={`flex min-h-[72px] w-full items-center gap-3 rounded-2xl border border-hairline bg-hull px-3 py-2.5 text-left active:bg-hull/70 ${
                session.exit ? 'opacity-60' : ''
              }`}
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-hairline bg-void font-mono text-sm uppercase text-paper">
                {session.tabLabel ?? session.agentId.slice(0, 2)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-paper">{session.title}</span>
                <span className="block truncate text-xs text-muted">
                  {session.agentName ?? session.agentId} · {repoName(session.cwd)}
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-muted">
                  started {relativeTime(session.createdAt, now)} · {session.cols}×{session.rows}
                </span>
              </span>
              <SessionStatusChip session={session} />
            </button>
          ))
        )}
      </div>
    </div>
  )
}

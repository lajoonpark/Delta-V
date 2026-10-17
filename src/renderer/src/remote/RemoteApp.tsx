import { useEffect, useState } from 'react'
import { remoteConnection } from './connection'
import { useRemoteState } from './useRemoteState'
import { PairingScreen } from './PairingScreen'
import { SessionList } from './SessionList'
import { SessionView } from './SessionView'
import { ConnectingSplash, ReconnectingPill, UnreachableOverlay } from './ConnectionStatus'

/**
 * Root of the read-only remote mirror. Owns the in-memory "which session am I
 * viewing" state and wires it to browser history so iOS edge-swipe returns to
 * the list. The pairing token never touches the URL.
 */
export default function RemoteApp(): React.ReactElement {
  const state = useRemoteState()
  const [viewing, setViewing] = useState<string | null>(null)

  useEffect(() => {
    remoteConnection.start()
  }, [])

  useEffect(() => {
    const onPop = (e: PopStateEvent): void => {
      const next = (e.state as { s?: string } | null)?.s ?? null
      setViewing(next)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const open = (id: string): void => {
    window.history.pushState({ s: id }, '')
    setViewing(id)
  }

  let content: React.ReactElement
  if (state.phase === 'pairing') {
    content = <PairingScreen />
  } else if (state.phase === 'connecting' && state.sessions.length === 0) {
    content = <ConnectingSplash />
  } else if (viewing) {
    content = <SessionView key={viewing} sessionId={viewing} onBack={() => window.history.back()} />
  } else {
    content = <SessionList onOpen={open} />
  }

  return (
    <div className="relative flex h-dvh flex-col overflow-hidden bg-void pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)] text-paper">
      {content}
      <ReconnectingPill />
      <UnreachableOverlay />
    </div>
  )
}

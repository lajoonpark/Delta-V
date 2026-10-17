import { useSyncExternalStore } from 'react'
import { remoteConnection, type ConnectionState } from './connection'

// Module-level, referentially stable wrappers so useSyncExternalStore never
// resubscribes between renders.
const subscribe = (listener: () => void): (() => void) => remoteConnection.subscribe(listener)
const getSnapshot = (): ConnectionState => remoteConnection.getState()

/** Subscribe a component to the remote connection's state. */
export function useRemoteState(): ConnectionState {
  return useSyncExternalStore(subscribe, getSnapshot)
}

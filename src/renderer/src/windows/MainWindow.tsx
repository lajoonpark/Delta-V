import { useEffect, useState } from 'react'
import { Plus, RefreshCw } from 'lucide-react'
import type { RepoTile } from '@shared/types'
import { shortcutMatches } from '@shared/types'
import { useAppActions, useAppState } from '@renderer/state/AppProvider'
import { useResolvedTheme, isMac } from '@renderer/hooks/useTheme'
import { TitleBar } from '@renderer/components/TitleBar'
import { Welcome } from '@renderer/components/RepoGrid'
import { ScanningBadge } from '@renderer/components/RepoTile'
import { LanderStage } from '@renderer/components/LanderStage'
import { SettingsDialog, type SettingsTab } from '@renderer/components/SettingsDialog'
import { Sidebar } from '@renderer/components/Sidebar'
import { TabBar } from '@renderer/components/TabBar'
import { OrbitView } from '@renderer/components/OrbitView'
import { TerminalPane } from './TerminalPane'
import { IconButton } from '@renderer/components/ui'

/**
 * Main window: repo grid (or first-run welcome), switching to a
 * sidebar + tabbed-terminal layout once sessions are open.
 */
export function MainWindow(): React.ReactElement {
  const { settings, roots, tiles, ready, sessions, scanning } = useAppState()
  const { addFolders, closeTab } = useAppActions()
  const dark = useResolvedTheme(settings)

  const [pickerTile, setPickerTile] = useState<RepoTile | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState<SettingsTab | null>(null)
  const [orbitOpen, setOrbitOpen] = useState(false)

  const hasSessions = sessions.length > 0
  const isScanning = Object.keys(scanning).length > 0
  const modalOpen = pickerTile !== null || settingsOpen !== null

  // Keep the active tab valid: prefer the current one, else the newest.
  useEffect(() => {
    setActiveId((cur) => {
      if (cur && sessions.some((s) => s.id === cur)) return cur
      return sessions.length > 0 ? sessions[sessions.length - 1].id : null
    })
  }, [sessions])

  // Global shortcuts: ⌘, settings · ⌘W close tab · sidebar toggle (rebindable in Settings)
  // Fixed shortcuts win over the rebindable one (e.g. recording ⌘W keeps closing tabs).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isMac ? e.metaKey : e.ctrlKey) {
        const key = e.key.toLowerCase()
        if (key === ',') {
          e.preventDefault()
          setSettingsOpen('general')
          return
        }
        if (key === 'w' && activeId) {
          e.preventDefault()
          setActiveId(null)
          void closeTab(activeId)
          return
        }
      }
      if (hasSessions && shortcutMatches(e, settings?.sidebarShortcut ?? 'mod+b', isMac)) {
        e.preventDefault()
        setSidebarCollapsed((c) => !c)
        return
      }
      // Orbit launcher: toggles the solar-system overlay over the terminal.
      if (hasSessions && shortcutMatches(e, settings?.orbitShortcut ?? 'mod+o', isMac)) {
        e.preventDefault()
        setOrbitOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeId, hasSessions, closeTab, settings?.sidebarShortcut, settings?.orbitShortcut])

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center bg-white dark:bg-zinc-950">
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </div>
    )
  }

  const select = (tile: RepoTile): void => setPickerTile(tile)
  const showWelcome = roots.length === 0

  return (
    <div className="flex h-full flex-col bg-zinc-50 dark:bg-zinc-950">
      <TitleBar onOpenSettings={() => setSettingsOpen('general')} />

      {showWelcome ? (
        <Welcome onAddFolders={() => void addFolders()} />
      ) : hasSessions ? (
        <div className="relative flex min-h-0 flex-1">
          <Sidebar
            collapsed={sidebarCollapsed}
            onToggle={() => setSidebarCollapsed((c) => !c)}
            onSelect={select}
          />
          <div className="flex min-w-0 flex-1 flex-col">
            <TabBar activeId={activeId} onActivate={setActiveId} />
            <TerminalPane activeId={activeId} dark={dark === 'dark'} />
          </div>
          {orbitOpen && (
            <OrbitView
              tiles={tiles}
              keyboardActive={!modalOpen}
              onSelect={select}
              onDismiss={() => setOrbitOpen(false)}
            />
          )}
        </div>
      ) : (
        <div className="relative min-h-0 flex-1">
          <OrbitView
            tiles={tiles}
            keyboardActive={!modalOpen}
            onSelect={select}
            onDismiss={() => setOrbitOpen(false)}
          />
          <div className="absolute right-4 top-4 z-10 flex items-center gap-1.5">
            {isScanning && <ScanningBadge />}
            <IconButton label="Add root folder" onClick={() => void addFolders()}>
              <Plus size={14} />
            </IconButton>
            <IconButton label="Rescan folders" onClick={() => void window.deltav.scanAllFolders()}>
              <RefreshCw size={14} className={isScanning ? 'animate-spin' : ''} />
            </IconButton>
          </div>
        </div>
      )}

      {pickerTile && (
        <LanderStage
          tile={pickerTile}
          onClose={() => setPickerTile(null)}
          onManageAgents={() => {
            setPickerTile(null)
            setSettingsOpen('agents')
          }}
        />
      )}

      {settingsOpen && (
        <SettingsDialog initialTab={settingsOpen} onClose={() => setSettingsOpen(null)} />
      )}
    </div>
  )
}

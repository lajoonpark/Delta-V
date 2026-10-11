import { useEffect, useState } from 'react'
import { Plus, RefreshCw } from 'lucide-react'
import type { RepoTile } from '@shared/types'
import { shortcutMatches } from '@shared/types'
import { useAppActions, useAppState } from '@renderer/state/AppProvider'
import { useResolvedTheme, isMac } from '@renderer/hooks/useTheme'
import { TitleBar } from '@renderer/components/TitleBar'
import { RepoGrid, Welcome } from '@renderer/components/RepoGrid'
import { ScanningBadge } from '@renderer/components/RepoTile'
import { AgentPicker } from '@renderer/components/AgentPicker'
import { SettingsDialog, type SettingsTab } from '@renderer/components/SettingsDialog'
import { Sidebar } from '@renderer/components/Sidebar'
import { TabBar } from '@renderer/components/TabBar'
import { TerminalPane } from './TerminalPane'
import { IconButton } from '@renderer/components/ui'

/**
 * Main window: repo grid (or first-run welcome), switching to a
 * sidebar + tabbed-terminal layout once sessions are open.
 */
export function MainWindow(): React.ReactElement {
  const { settings, roots, tiles, indexStatuses, ready, sessions, scanning } = useAppState()
  const { addFolders, closeTab } = useAppActions()
  const dark = useResolvedTheme(settings)

  const [pickerTile, setPickerTile] = useState<RepoTile | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState<SettingsTab | null>(null)

  const hasSessions = sessions.length > 0
  const isScanning = Object.keys(scanning).length > 0

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
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeId, hasSessions, closeTab, settings?.sidebarShortcut])

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
        <div className="flex min-h-0 flex-1">
          <Sidebar
            collapsed={sidebarCollapsed}
            onToggle={() => setSidebarCollapsed((c) => !c)}
            onSelect={select}
          />
          <div className="flex min-w-0 flex-1 flex-col">
            <TabBar activeId={activeId} onActivate={setActiveId} />
            <TerminalPane activeId={activeId} dark={dark === 'dark'} />
          </div>
        </div>
      ) : (
        <>
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-zinc-200/70 px-4 dark:border-zinc-800/70">
            <span className="text-[13px] font-semibold text-zinc-700 dark:text-zinc-200">
              Repositories
            </span>
            <span className="rounded-full bg-zinc-200/70 px-2 py-0.5 text-[10px] font-medium tabular-nums text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
              {tiles.length}
            </span>
            {isScanning && <ScanningBadge />}
            <span className="flex-1" />
            <IconButton label="Add root folder" onClick={() => void addFolders()}>
              <Plus size={14} />
            </IconButton>
            <IconButton label="Rescan folders" onClick={() => void window.deltav.scanAllFolders()}>
              <RefreshCw size={14} className={isScanning ? 'animate-spin' : ''} />
            </IconButton>
          </div>
          <RepoGrid
            tiles={tiles}
            indexStatuses={indexStatuses}
            scanning={isScanning}
            onSelect={select}
          />
        </>
      )}

      {pickerTile && (
        <AgentPicker
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

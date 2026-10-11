import { PanelLeftClose, Plus, RefreshCw } from 'lucide-react'
import { useMemo } from 'react'
import type { RepoTile as RepoTileData } from '@shared/types'
import { formatShortcut } from '@shared/types'
import { useAppActions, useAppState } from '@renderer/state/AppProvider'
import { isMac } from '@renderer/hooks/useTheme'
import { Button, IconButton, Segmented } from './ui'
import { useTileFilter } from './RepoGrid'
import { RepoTile, ScanningBadge } from './RepoTile'

/**
 * Collapsible left sidebar shown in tabbed mode — the repo grid lives here
 * so users can launch more sessions while terminals are open.
 */
export function Sidebar({
  collapsed,
  onToggle,
  onSelect
}: {
  collapsed: boolean
  onToggle(): void
  onSelect(tile: RepoTileData, openInWindow: boolean): void
}): React.ReactElement {
  const { tiles, indexStatuses, scanning, settings, roots, sessions } = useAppState()
  const { addFolders, updateSettings } = useAppActions()
  const [filtered, query, setQuery] = useTileFilter(tiles)
  const isScanning = Object.keys(scanning).length > 0
  // Repos that currently have at least one open session → green "open" tick
  const openIds = useMemo(() => new Set(sessions.map((s) => s.repoTileId)), [sessions])
  const sidebarHint = `Toggle sidebar (${formatShortcut(settings?.sidebarShortcut ?? 'mod+b', isMac)})`

  if (collapsed) {
    return (
      <aside className="flex w-11 shrink-0 flex-col items-center gap-2 border-r border-zinc-200/80 bg-zinc-50/60 py-2 dark:border-zinc-800/80 dark:bg-zinc-950/60">
        <IconButton label={`Show repositories — ${sidebarHint}`} onClick={onToggle}>
          <PanelLeftClose size={15} className="rotate-180" />
        </IconButton>
      </aside>
    )
  }

  return (
    <aside className="flex w-[300px] shrink-0 flex-col border-r border-zinc-200/80 bg-zinc-50/60 dark:border-zinc-800/80 dark:bg-zinc-950/60">
      <div className="flex items-center justify-between gap-2 px-3 pt-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="truncate text-[11px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
            Repositories
          </h2>
          {isScanning && <ScanningBadge />}
        </div>
        <IconButton label={`Hide sidebar — ${sidebarHint}`} onClick={onToggle}>
          <PanelLeftClose size={15} />
        </IconButton>
      </div>

      <div className="flex items-center gap-1.5 px-3 py-2">
        <Segmented
          size="sm"
          value={settings?.sortOrder ?? 'recent'}
          options={[
            { value: 'recent', label: 'Recent' },
            { value: 'alpha', label: 'A–Z' }
          ]}
          onChange={(order) => void updateSettings({ sortOrder: order })}
        />
        <span className="flex-1" />
        <IconButton label="Rescan folders" onClick={() => void window.deltav.scanAllFolders()}>
          <RefreshCw size={13} className={isScanning ? 'animate-spin' : ''} />
        </IconButton>
        <IconButton label="Add root folder" onClick={() => void addFolders()}>
          <Plus size={14} />
        </IconButton>
      </div>

      {roots.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
          <p className="text-xs leading-relaxed text-zinc-400">
            Add a root folder to see your repositories here.
          </p>
          <Button variant="primary" className="h-7 px-2.5 text-xs" onClick={() => void addFolders()}>
            <Plus size={12} />
            Add folder
          </Button>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter…"
            spellCheck={false}
            className="no-drag selectable mb-1.5 h-7 w-full rounded-md border border-zinc-200 bg-white px-2.5 text-xs text-zinc-700 placeholder:text-zinc-400 focus:border-accent focus:outline-none dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200 dark:placeholder:text-zinc-500"
          />
          {filtered.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-zinc-400">
              {query ? 'No matches.' : 'No repos found.'}
            </p>
          ) : (
            <div className="flex flex-col gap-0.5">
              {filtered.map((tile) => (
                <RepoTile
                  key={tile.id}
                  tile={tile}
                  indexStatus={indexStatuses[tile.id]}
                  isOpen={openIds.has(tile.id)}
                  onSelect={onSelect}
                  compact
                />
              ))}
            </div>
          )}
        </div>
      )}
    </aside>
  )
}

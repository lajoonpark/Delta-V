import { AlertTriangle, Check, Clock, Folder, Loader2, RefreshCw, Search } from 'lucide-react'
import type { RepoIndexStatus, RepoTile } from '@shared/types'
import { relativeTime } from './ui'
import { MiniPlanet } from './MiniPlanet'

/**
 * Repo tiles. Two variants: 'grid' (main view cards) and 'row'
 * (compact list rows for the sidebar). A small status dot reflects the
 * repo's LanceDB index state; click anywhere to open the agent picker.
 */

export function IndexDot({
  status,
  open
}: {
  status?: RepoIndexStatus
  /** Repo currently has at least one open session in this window */
  open?: boolean
}): React.ReactElement | null {
  // The emerald tick means "currently open": it must appear when a tab
  // is open for this repo and disappear as soon as the last one closes.
  // It is deliberately NOT coupled to the index's ready state, which is
  // persistent on disk and would otherwise leave a stale tick behind.
  const openTick = open ? (
    <span title="Currently open" className="inline-flex">
      <Check size={11} className="text-emerald-500" strokeWidth={3} />
    </span>
  ) : null

  if (!status) return openTick
  switch (status.state) {
    case 'indexing':
    case 'queued':
      return (
        <span title="Indexing…" className="inline-flex">
          <Loader2 size={11} className="animate-spin text-accent" />
        </span>
      )
    case 'ready':
      return openTick
    case 'error':
      return (
        <span
          title={status.error ? `Index error: ${status.error}` : 'Index error'}
          className="inline-flex"
        >
          <AlertTriangle size={11} className="text-red-500" />
        </span>
      )
    default:
      return openTick
  }
}

interface TileProps {
  tile: RepoTile
  indexStatus?: RepoIndexStatus
  isOpen?: boolean
  onSelect(tile: RepoTile, openInWindow: boolean): void
  compact?: boolean
}

export function RepoTile({
  tile,
  indexStatus,
  isOpen,
  onSelect,
  compact
}: TileProps): React.ReactElement {
  const opened = relativeTime(tile.lastOpenedAt)

  if (compact) {
    return (
      <button
        type="button"
        title={`${tile.name}\n${tile.path}`}
        onClick={(e) => onSelect(tile, e.metaKey || e.ctrlKey)}
        className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800/80"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center">
          <MiniPlanet id={tile.id} seed={tile.name} openCount={tile.openCount} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-zinc-800 dark:text-zinc-100">
            {tile.name}
          </span>
          {opened && (
            <span className="block text-[10px] text-zinc-400 dark:text-zinc-500">
              opened {opened}
            </span>
          )}
        </span>
        <IndexDot status={indexStatus} open={isOpen} />
      </button>
    )
  }

  return (
    <button
      type="button"
      title={`${tile.name}\n${tile.path}`}
      onClick={(e) => onSelect(tile, e.metaKey || e.ctrlKey)}
      className={[
        'group relative flex min-w-0 flex-col rounded-xl border p-3.5 text-left shadow-tile transition-all',
        'border-zinc-200 bg-white hover:-translate-y-0.5 hover:border-accent/60 hover:shadow-tile-hover',
        'dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-accent/50 dark:hover:bg-zinc-800/80'
      ].join(' ')}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-b from-amber-50 to-amber-100 text-amber-600 ring-1 ring-amber-200/60 dark:from-amber-950/40 dark:to-amber-900/30 dark:text-amber-400 dark:ring-amber-900/50">
          <Folder size={17} strokeWidth={2} />
        </span>
        <span className="flex items-center gap-1.5 pt-1">
          <IndexDot status={indexStatus} open={isOpen} />
        </span>
      </div>

      <span className="mt-3 block min-w-0 break-words text-sm font-semibold leading-snug text-zinc-800 [overflow-wrap:anywhere] dark:text-zinc-100">
        {tile.name}
      </span>
      <span className="mt-0.5 block min-w-0 break-words text-[11px] leading-snug text-zinc-400 [overflow-wrap:anywhere] dark:text-zinc-500">
        {tile.path}
      </span>

      <span className="mt-2.5 flex min-w-0 items-center gap-1.5 text-[10px] text-zinc-400 dark:text-zinc-500">
        {opened ? (
          <>
            <Clock size={10} />
            {opened}
            {tile.openCount > 1 && (
              <span className="ml-auto tabular-nums">
                {tile.openCount}×
              </span>
            )}
          </>
        ) : (
          <>
            <Search size={10} className="opacity-0" />
            <span>Never opened</span>
          </>
        )}
      </span>
    </button>
  )
}

/** Small "rescan" affordance used by the toolbar while a scan runs. */
export function ScanningBadge(): React.ReactElement {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-accent/10 px-2.5 py-1 text-[11px] font-medium text-accent-dim dark:text-accent-soft">
      <RefreshCw size={11} className="animate-spin" />
      Scanning…
    </span>
  )
}

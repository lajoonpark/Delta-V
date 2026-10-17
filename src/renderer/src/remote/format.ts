/** Last non-empty path segment of a cwd, splitting on both / and \. */
export function repoName(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter((p) => p.length > 0)
  return parts.length > 0 ? parts[parts.length - 1] : cwd
}

/** Compact "just now" / "5m ago" / "2h ago" / "3d ago" label. */
export function relativeTime(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts)
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.floor(hr / 24)
  return `${d}d ago`
}

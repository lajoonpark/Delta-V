/** What the caller should do with a live terminal:data chunk. */
export type LiveAction =
  | { kind: 'write'; data: string }
  | { kind: 'skip' }
  | { kind: 'resync' }
  | { kind: 'wait' }

/**
 * Tracks how much PTY output a viewer has seen so live chunks can be spliced
 * onto a snapshot without duplicating or dropping data.
 */
export class ViewerSync {
  /** Next expected output offset, or null when not synced. */
  private end: number | null = null

  /** Becomes "not synced" (no snapshot applied yet). */
  reset(): void {
    this.end = null
  }

  /** Synced; the next expected output offset is `end`. */
  applySnapshot(end: number): void {
    this.end = end
  }

  get synced(): boolean {
    return this.end !== null
  }

  /** Feed a live terminal:data chunk (`offset` = UTF-16 units emitted before it). */
  live(offset: number, data: string): LiveAction {
    if (this.end === null) return { kind: 'wait' }
    const len = data.length
    if (offset + len <= this.end) return { kind: 'skip' }
    if (offset > this.end) return { kind: 'resync' }
    if (offset === this.end) {
      this.end = offset + len
      return { kind: 'write', data }
    }
    const rest = data.slice(this.end - offset)
    this.end = offset + len
    return { kind: 'write', data: rest }
  }
}

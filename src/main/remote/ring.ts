/**
 * Pure output ring buffer + terminal mode tracker for the Remote mirror.
 * No Electron imports: this module is also exercised by the standalone check
 * script (tools/remote-bridge-check.ts).
 */

/** UTF-16 code units retained per session. */
export const RING_CAP = 256 * 1024

const RIS = '\x1bc'
const MODE_RE = /\x1b\[\?([\d;]+)([hl])/g

/**
 * Tracks the terminal modes a viewer must restore when a ring snapshot starts
 * mid-stream (alt screen, hidden cursor, autowrap). Sequences split across
 * chunks are caught by re-scanning the previous chunk's tail (16 chars).
 */
export class ModeTracker {
  private alt = false
  private cursorVisible: boolean | undefined = undefined
  private autowrap: boolean | undefined = undefined
  private tail = ''

  feed(chunk: string): void {
    const scan = this.tail + chunk
    let i = 0
    while (i < scan.length) {
      const ris = scan.indexOf(RIS, i)
      MODE_RE.lastIndex = i
      const m = MODE_RE.exec(scan)
      const modeIdx = m ? m.index : -1
      if (ris === -1 && modeIdx === -1) break
      if (ris !== -1 && (modeIdx === -1 || ris < modeIdx)) {
        // RIS (full reset) → back to defaults
        this.alt = false
        this.cursorVisible = undefined
        this.autowrap = undefined
        i = ris + RIS.length
      } else if (m) {
        this.applyParams(m[1], m[2])
        i = m.index + m[0].length
      }
    }
    this.tail = chunk.slice(-16)
  }

  private applyParams(params: string, final: string): void {
    const on = final === 'h'
    for (const p of params.split(';')) {
      switch (p) {
        case '1049':
        case '1047':
        case '47':
          this.alt = on
          break
        case '25':
          this.cursorVisible = on
          break
        case '7':
          this.autowrap = on
          break
      }
    }
  }

  /** Escape prefix that restores the currently tracked modes. */
  prefix(): string {
    return (
      (this.alt ? '\x1b[?1049h' : '') +
      (this.cursorVisible === false ? '\x1b[?25l' : '') +
      (this.autowrap === false ? '\x1b[?7l' : '')
    )
  }
}

/**
 * Bounded FIFO of raw PTY output. Chunks are dropped whole from the oldest end
 * until the retained size fits `cap`; a lone oversized chunk keeps its last
 * `cap` chars. `end` is the total number of chars ever appended.
 */
export class OutputRing {
  private chunks: string[] = []
  private size = 0
  private total = 0
  private dropped = false
  private modes = new ModeTracker()

  constructor(private cap = RING_CAP) {}

  /** Returns the offset (total chars appended BEFORE this chunk). */
  append(data: string): number {
    const offset = this.total
    this.total += data.length
    if (data.length > 0) {
      this.chunks.push(data)
      this.size += data.length
      this.modes.feed(data)
      this.trim()
    }
    return offset
  }

  private trim(): void {
    while (this.size > this.cap && this.chunks.length > 1) {
      const removed = this.chunks.shift() as string
      this.size -= removed.length
      this.dropped = true
    }
    if (this.size > this.cap && this.chunks.length === 1) {
      const only = this.chunks[0]
      this.chunks[0] = only.slice(only.length - this.cap)
      this.size = this.chunks[0].length
      this.dropped = true
    }
  }

  /** Total chars ever appended. */
  get end(): number {
    return this.total
  }

  /** True once any output was dropped. */
  get truncated(): boolean {
    return this.dropped
  }

  snapshot(): { data: string; end: number; truncated: boolean } {
    const data =
      (this.dropped ? '\x1b[0m' + this.modes.prefix() : '') + this.chunks.join('')
    return { data, end: this.total, truncated: this.dropped }
  }
}

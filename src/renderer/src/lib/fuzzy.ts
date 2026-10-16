/**
 * Tiny fuzzy matcher for the solar-system repo search (⌘K).
 *
 * Two signals are combined so a small typo or spacing slip never drops a repo
 * from the list:
 *
 *  - Subsequence scoring over an alphanumeric-only "compact" view of the text.
 *    Spacing and punctuation are ignored, so `delta v`, `delta-v` and `deltav`
 *    all match the repo `delta-v`, and abbreviations like `dlev` match too.
 *    Matches are rewarded for landing consecutively, on a word/segment
 *    boundary (start, after a separator, or a camelCase hump) or at the very
 *    start of the text.
 *
 *  - A Damerau–Levenshtein (optimal string alignment) similarity fallback for
 *    substitutions and transpositions a subsequence can't see — e.g. `dleta`
 *    still matches `delta-v`. This only kicks in for queries of a few
 *    characters or more so short queries stay strict.
 *
 * Pure and dependency-free. Scores are only meaningful relative to each other
 * (higher = more likely), which is all the caller needs to auto-select the top
 * hit and order the list.
 */

export interface FuzzyMatch {
  /** Relevance, higher is better. Always > 0 for a returned match. */
  score: number
}

/** One searchable character plus whether it starts a word/segment. */
interface Char {
  ch: string
  boundary: boolean
}

// Scoring weights (arbitrary units; only the ratios matter).
const MATCH = 16
const BONUS_BOUNDARY = 8
const BONUS_FIRST = 6
const BONUS_CONSECUTIVE = 6
const GAP = 2
const LEAD_GAP = 1
const TRAIL_GAP = 1
/** Edit-similarity matches are capped here so any real match outranks them. */
const EDIT_SCALE = 100
/** Keep edit-distance matches only at/above this similarity and query length. */
const EDIT_MIN_SIMILARITY = 0.65
const EDIT_MIN_QUERY = 3

const NEG = -1e9

const isAlnum = (ch: string): boolean => /[a-z0-9]/.test(ch)

/** Lowercased alphanumeric-only view of `text` (spacing/punctuation removed). */
function compact(text: string): string {
  let out = ''
  for (const raw of text) {
    const lower = raw.toLowerCase()
    if (isAlnum(lower)) out += lower
  }
  return out
}

/**
 * Split `text` into lowercased alphanumeric chars, flagging each as a
 * word/segment boundary (first char, char after a separator, or a camelCase
 * hump) so boundary matches can be rewarded.
 */
function analyze(text: string): Char[] {
  const out: Char[] = []
  let prevWasSeparator = true
  let prevWasLower = false
  for (const raw of text) {
    const lower = raw.toLowerCase()
    if (!isAlnum(lower)) {
      prevWasSeparator = true
      prevWasLower = false
      continue
    }
    const isUpper = raw >= 'A' && raw <= 'Z'
    const isLower = lower >= 'a' && lower <= 'z'
    out.push({ ch: lower, boundary: prevWasSeparator || (isUpper && prevWasLower) })
    prevWasSeparator = false
    prevWasLower = isLower
  }
  return out
}

/**
 * Best subsequence score of `query` (already compacted, lowercased) in
 * `target`, or null when the query is not a subsequence. DP over target
 * positions: `prev[j]` is the best score with query[i-1] matched at j, and a
 * running maximum carries the cheapest gap penalty forward in O(q·t).
 */
function subsequenceScore(query: string, target: Char[]): number | null {
  const m = query.length
  const n = target.length
  if (m === 0) return 0
  if (m > n) return null

  let prev = new Array<number>(n).fill(NEG)
  let cur = new Array<number>(n).fill(NEG)

  for (let i = 0; i < m; i++) {
    const q = query[i]
    // bestNonConsec = max over k <= j-1 of (prev[k] - GAP * (j-1-k)).
    let bestNonConsec = NEG
    for (let j = 0; j < n; j++) {
      if (i > 0 && j > 0) {
        bestNonConsec = Math.max(prev[j - 1], bestNonConsec - GAP)
      }
      if (target[j].ch !== q) {
        cur[j] = NEG
        continue
      }
      const boundary = target[j].boundary ? BONUS_BOUNDARY : 0
      if (i === 0) {
        cur[j] = MATCH + boundary + (j === 0 ? BONUS_FIRST : 0) - LEAD_GAP * j
      } else {
        let s = NEG
        if (bestNonConsec > NEG) s = bestNonConsec + MATCH + boundary
        if (j > 0 && prev[j - 1] > NEG) {
          s = Math.max(s, prev[j - 1] + MATCH + boundary + BONUS_CONSECUTIVE)
        }
        cur[j] = s
      }
    }
    const swap = prev
    prev = cur
    cur = swap
    cur.fill(NEG)
  }

  // Prefer tighter matches: a small penalty for target characters left over
  // after the last matched char, so an exact match beats a longer string that
  // merely starts with it (`delta-v` outranks `delta-verse`).
  let best = NEG
  for (let j = 0; j < n; j++) {
    const s = prev[j] - TRAIL_GAP * (n - 1 - j)
    if (s > best) best = s
  }
  return best <= NEG / 2 ? null : best
}

/** Optimal string alignment distance (Damerau–Levenshtein, no full lookback). */
function osaDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m

  let prev2 = new Array<number>(n + 1).fill(0)
  let prev = new Array<number>(n + 1)
  let cur = new Array<number>(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j

  for (let i = 1; i <= m; i++) {
    cur[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let val = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        val = Math.min(val, prev2[j - 2] + 1)
      }
      cur[j] = val
    }
    const swap = prev2
    prev2 = prev
    prev = cur
    cur = swap
  }
  return prev[n]
}

/**
 * Typo-tolerant score (0..EDIT_SCALE) for a compact query against the whole
 * text and each of its tokens, or null when nothing is close enough. Comparing
 * against tokens lets `dleta` match the `delta` segment of a long path.
 */
function editScore(queryCompact: string, text: string): number | null {
  if (queryCompact.length < EDIT_MIN_QUERY) return null
  const candidates = [compact(text), ...text.split(/[^a-zA-Z0-9]+/).map(compact)]
  let best = 0
  for (const candidate of candidates) {
    if (!candidate) continue
    const dist = osaDistance(queryCompact, candidate)
    const similarity = 1 - dist / Math.max(queryCompact.length, candidate.length)
    if (similarity > best) best = similarity
  }
  return best >= EDIT_MIN_SIMILARITY ? best * EDIT_SCALE : null
}

/**
 * Score how well `query` matches `text`. Returns null when it does not match
 * (so the caller can drop it), or a positive relevance score otherwise.
 * An empty query matches everything with score 0.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.trim()
  if (!q) return { score: 0 }
  const queryCompact = compact(q)
  if (!queryCompact) return { score: 0 }

  const sub = subsequenceScore(queryCompact, analyze(text))
  const edit = editScore(queryCompact, text)
  const best = Math.max(sub ?? NEG, edit ?? NEG)
  return best <= NEG / 2 ? null : { score: best }
}

/**
 * Relevance of a repo against a query: the better of its name and path, with
 * a small nudge toward name matches (the path usually repeats the name, so
 * without this a deep path could outrank the repo you actually named).
 */
export function fuzzyRepoScore(query: string, name: string, path: string): number | null {
  const nameMatch = fuzzyMatch(query, name)
  const pathMatch = fuzzyMatch(query, path)
  if (!nameMatch && !pathMatch) return null
  const nameScore = nameMatch ? nameMatch.score + 10 : NEG
  const pathScore = pathMatch ? pathMatch.score : NEG
  // Tiny length tie-break: among near-equal hits (e.g. two repos that differ
  // only by a typo) the shorter name is the likelier target.
  return Math.max(nameScore, pathScore) - name.length * 0.001
}

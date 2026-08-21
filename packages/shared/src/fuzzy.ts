/**
 * Ordered case-insensitive subsequence matching, shared by the `/` command
 * menu and the `@` file menu.
 *
 * Ranking follows what deepseek-harness's command menu settled on: prefixes
 * first, then matches on separator boundaries, then adjacent characters, with
 * shorter gaps and shorter targets breaking ties. Plain substring matching
 * ranks `git-commit` above `gc` for the query `gc`, which is the wrong answer
 * for a command palette.
 */

const SEPARATORS = new Set(['/', '\\', '-', '_', '.', ' ', ':'])

/** Higher is better. Returns null when `query` is not a subsequence of `target`. */
export function fuzzyScore(query: string, target: string): number | null {
  if (query === '') return 0

  const q = query.toLowerCase()
  const t = target.toLowerCase()
  if (q.length > t.length) return null

  let score = 0
  let qi = 0
  let lastMatch = -1

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue

    if (ti === 0) score += 100
    else if (SEPARATORS.has(t[ti - 1]!)) score += 60
    else if (lastMatch === ti - 1) score += 40
    else score += 10

    // Gap penalty, capped so one far-away match cannot dominate the score.
    score -= Math.min(lastMatch >= 0 ? ti - lastMatch - 1 : ti, 20)

    lastMatch = ti
    qi++
  }

  if (qi < q.length) return null
  if (t.startsWith(q)) score += 200
  return score - t.length * 0.1
}

/** Sorts by descending score, dropping non-matches. Ties keep input order. */
export function fuzzyFilter<T>(query: string, items: readonly T[], key: (item: T) => string): T[] {
  const scored: { item: T; score: number; index: number }[] = []
  for (const [index, item] of items.entries()) {
    const score = fuzzyScore(query, key(item))
    if (score !== null) scored.push({ item, score, index })
  }
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).map((entry) => entry.item)
}

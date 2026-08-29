/**
 * Fractional ranking for manual ordering.
 *
 * Kanban columns need a stable order that survives a drag without renumbering every
 * card - renumbering means rewriting every note in the column, which in a vault means
 * a git diff touching fifty files because someone moved one card.
 *
 * Instead each card holds a short string key, and inserting between two cards mints a
 * key that sorts between them. Only the moved card's file is written.
 *
 * This is the fractional-indexing midpoint algorithm over a lowercase a-z alphabet.
 * It rests on one invariant: **a key never ends with the minimum digit `a`**. Without
 * it the pair ("m", "ma") has no midpoint expressible in this alphabet, and a naive
 * implementation happily returns "mam" - which sorts *after* "ma", silently corrupting
 * the column order. Every key this module mints upholds the invariant.
 */

const DIGITS = 'abcdefghijklmnopqrstuvwxyz'
const MIN_DIGIT = 'a'

/**
 * A key that sorts strictly between `before` and `after`. Either may be undefined for
 * an open end. Inputs must be keys this module produced (lowercase, not ending in `a`).
 */
export function rankBetween(before: string | undefined, after: string | undefined): string {
  const lower = before ?? ''
  const upper = after

  if (upper !== undefined && lower >= upper) {
    // A reversed or equal pair means the caller lost track of its own order. Appending
    // beats returning a key that would corrupt the column.
    return midpoint(lower > upper ? lower : upper, undefined)
  }

  return midpoint(lower, upper)
}

function midpoint(lower: string, upper: string | undefined): string {
  if (upper !== undefined) {
    // Keep the shared prefix and solve the smaller problem beneath it. Padding the
    // shorter side with the minimum digit is what makes "a" vs "ab" tractable.
    let shared = 0
    while ((lower[shared] ?? MIN_DIGIT) === upper[shared]) shared++
    if (shared > 0) {
      return upper.slice(0, shared) + midpoint(lower.slice(shared), upper.slice(shared))
    }
  }

  const digitLower = lower ? DIGITS.indexOf(lower[0] as string) : 0
  const digitUpper = upper !== undefined ? DIGITS.indexOf(upper[0] as string) : DIGITS.length

  // Room between the two digits: take the middle one and stop.
  if (digitUpper - digitLower > 1) {
    return DIGITS[Math.round((digitLower + digitUpper) / 2)] as string
  }

  // Digits are adjacent. If the upper bound has depth, borrowing its first digit alone
  // already lands below it.
  if (upper !== undefined && upper.length > 1) {
    return upper.slice(0, 1)
  }

  // Otherwise keep the lower bound's digit and go one level deeper.
  return (DIGITS[digitLower] as string) + midpoint(lower.slice(1), undefined)
}

/** Evenly spaced starting keys for a column that has never been ordered by hand. */
export function initialRanks(count: number): string[] {
  const out: string[] = []
  let previous: string | undefined
  for (let i = 0; i < count; i++) {
    previous = rankBetween(previous, undefined)
    out.push(previous)
  }
  return out
}

/** Sort comparator: ranked items first in rank order, unranked last by title. */
export function byRank<T extends { rank?: string; title: string }>(a: T, b: T): number {
  if (a.rank && b.rank) return a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0
  if (a.rank) return -1
  if (b.rank) return 1
  return a.title.localeCompare(b.title)
}

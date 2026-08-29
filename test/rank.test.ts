import { describe, expect, it } from 'vitest'
import { byRank, initialRanks, rankBetween } from '../src/store/rank'

describe('rankBetween', () => {
  it('mints a key that sorts between its neighbours', () => {
    const mid = rankBetween('a', 'b')
    expect(mid > 'a').toBe(true)
    expect(mid < 'b').toBe(true)
  })

  it('handles an open lower end', () => {
    const first = rankBetween(undefined, 'm')
    expect(first < 'm').toBe(true)
  })

  it('handles an open upper end', () => {
    const last = rankBetween('m', undefined)
    expect(last > 'm').toBe(true)
  })

  it('keeps finding room after repeated insertions at the same point', () => {
    let low = 'a'
    const high = 'b'
    for (let i = 0; i < 50; i++) {
      const mid = rankBetween(low, high)
      expect(mid > low).toBe(true)
      expect(mid < high).toBe(true)
      low = mid
    }
  })

  it('never returns a key equal to a neighbour', () => {
    // Every pair here is made of legal keys: none ends in the minimum digit, which is
    // the invariant the algorithm depends on. ("m", "ma") is unreachable by design.
    for (const [a, b] of [
      ['ab', 'b'],
      ['az', 'b'],
      ['mn', 'n']
    ] as const) {
      const mid = rankBetween(a, b)
      expect(mid).not.toBe(a)
      expect(mid).not.toBe(b)
      expect(mid > a && mid < b).toBe(true)
    }
  })

  it('produces strictly increasing initial keys', () => {
    const ranks = initialRanks(10)
    const sorted = [...ranks].sort()
    expect(ranks).toEqual(sorted)
    expect(new Set(ranks).size).toBe(10)
  })
})

describe('byRank', () => {
  it('puts unranked items last, ordered by title', () => {
    const items = [
      { title: 'zeta', rank: undefined },
      { title: 'alpha', rank: undefined },
      { title: 'ranked', rank: 'm' }
    ]
    expect(items.sort(byRank).map((i) => i.title)).toEqual(['ranked', 'alpha', 'zeta'])
  })
})

describe('rankBetween invariants', () => {
  it('never mints a key ending in the minimum digit', () => {
    // That invariant is what makes ("m", "ma") impossible to reach in the first place.
    let low: string | undefined
    for (let i = 0; i < 200; i++) {
      low = rankBetween(low, undefined)
      expect(low.endsWith('a')).toBe(false)
    }
  })

  it('survives a randomized sequence of insertions', () => {
    let keys = initialRanks(5)
    for (let step = 0; step < 300; step++) {
      const at = Math.floor(Math.random() * (keys.length + 1))
      const mid = rankBetween(keys[at - 1], keys[at])
      keys = [...keys.slice(0, at), mid, ...keys.slice(at)]
      const sorted = [...keys].sort()
      expect(keys).toEqual(sorted)
      expect(new Set(keys).size).toBe(keys.length)
    }
  })
})

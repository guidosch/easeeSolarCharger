/**
 * Fairness between users competing for the same surplus (T104, FR-024, ladder rule 6).
 *
 * The draw is **seeded from the cycle ID**, so it is random across cycles but identical on replay.
 * A weighted-random fairness rule that is not seeded and recorded is not debuggable — the
 * constitution says so outright — and it would make SC-010's byte-identical replay impossible.
 */

/** xmur3: a string hash with good avalanche, used only to seed the generator below. */
function hashSeed(seed: string): () => number {
  let h = 1779033703 ^ seed.length
  for (let i = 0; i < seed.length; i += 1) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    h ^= h >>> 16
    return h >>> 0
  }
}

/** mulberry32: small, fast, and — the only property that matters here — reproducible. */
export function seededRandom(seed: string): () => number {
  let state = hashSeed(seed)()
  return () => {
    state |= 0
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Weight inversely proportional to solar energy already received.
 *
 * `1 / (1 + kWh)` rather than `1 / kWh`: a user who has received nothing gets a finite weight
 * instead of an infinite one, and the curve flattens as totals grow, so the advantage of being
 * under-served shrinks rather than compounding.
 */
export function fairnessWeight(solarKwhReceived: number): number {
  return 1 / (1 + Math.max(0, solarKwhReceived))
}

export type DrawCandidate<T> = {
  item: T
  /** `null` for an orphaned charger with no mapped user; it draws the weight of a fresh user. */
  userId: string | null
}

/**
 * Orders candidates by repeated weighted draw without replacement.
 *
 * The *order* is the allocation priority: the surplus is then handed out greedily down the list, so
 * a user who is under-served is more likely to be served first — and, when the surplus stretches to
 * several chargers, they are all served anyway (FR-024's "MAY split").
 */
export function drawOrder<T>(
  candidates: DrawCandidate<T>[],
  fairness: Record<string, { solarKwhReceived: number }>,
  randomSeed: string,
): T[] {
  if (candidates.length <= 1) return candidates.map((c) => c.item)

  const random = seededRandom(randomSeed)
  const pool = candidates.map((candidate) => ({
    ...candidate,
    weight: fairnessWeight(
      candidate.userId === null ? 0 : (fairness[candidate.userId]?.solarKwhReceived ?? 0),
    ),
  }))

  const ordered: T[] = []
  while (pool.length > 0) {
    const total = pool.reduce((sum, c) => sum + c.weight, 0)
    let ticket = random() * total
    let index = pool.length - 1
    for (let i = 0; i < pool.length; i += 1) {
      ticket -= pool[i]?.weight ?? 0
      if (ticket <= 0) {
        index = i
        break
      }
    }
    const [picked] = pool.splice(index, 1)
    if (picked) ordered.push(picked.item)
  }
  return ordered
}

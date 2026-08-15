import { describe, expect, it } from 'vitest'
import { decide } from '../src/decide.js'
import { drawOrder, fairnessWeight, seededRandom } from '../src/fairness.js'
import type { CycleInputs } from '../src/types.js'
import { makeCharger, makeInputs } from './support/inputs.js'

/** T102 — the seeded weighted draw (FR-024, ladder rule 6). */

describe('fairnessWeight', () => {
  it('favours the under-served without ever reaching infinity', () => {
    expect(fairnessWeight(0)).toBe(1)
    expect(fairnessWeight(9)).toBeCloseTo(0.1, 6)
    expect(fairnessWeight(0)).toBeGreaterThan(fairnessWeight(50))
  })

  it('flattens as totals grow, so an early lead does not compound', () => {
    const earlyGap = fairnessWeight(0) - fairnessWeight(10)
    const laterGap = fairnessWeight(100) - fairnessWeight(110)
    expect(laterGap).toBeLessThan(earlyGap)
  })
})

describe('seededRandom', () => {
  it('is identical for the same seed and different for another', () => {
    const a = seededRandom('2026-06-15T10:30:00Z')
    const b = seededRandom('2026-06-15T10:30:00Z')
    const c = seededRandom('2026-06-15T10:35:00Z')

    const first = [a(), a(), a()]
    expect([b(), b(), b()]).toEqual(first)
    expect([c(), c(), c()]).not.toEqual(first)
  })

  it('is uniform enough to be a fair draw', () => {
    const random = seededRandom('seed')
    const buckets = [0, 0, 0, 0]
    for (let i = 0; i < 4000; i += 1) {
      const bucket = Math.floor(random() * 4)
      buckets[bucket] = (buckets[bucket] ?? 0) + 1
    }
    for (const count of buckets) expect(count).toBeGreaterThan(800)
  })
})

describe('drawOrder', () => {
  const fairness = {
    U_served: { solarKwhReceived: 100 },
    U_starved: { solarKwhReceived: 0 },
  }

  it('picks the under-served user first far more often over 100 cycles', () => {
    let starvedFirst = 0
    for (let cycle = 0; cycle < 100; cycle += 1) {
      const order = drawOrder(
        [
          { item: 'served', userId: 'U_served' },
          { item: 'starved', userId: 'U_starved' },
        ],
        fairness,
        `2026-06-15T10:${String(cycle).padStart(2, '0')}:00Z`,
      )
      if (order[0] === 'starved') starvedFirst += 1
    }
    // Weights are 1/101 against 1, so the starved user should win almost every draw — but not
    // *every* one, or it would be a sort rather than a draw.
    expect(starvedFirst).toBeGreaterThan(90)
    expect(starvedFirst).toBeLessThanOrEqual(100)
  })

  it('gives the same order for the same seed', () => {
    const once = drawOrder(
      [
        { item: 'a', userId: 'U_served' },
        { item: 'b', userId: 'U_starved' },
        { item: 'c', userId: null },
      ],
      fairness,
      'fixed-seed',
    )
    const twice = drawOrder(
      [
        { item: 'a', userId: 'U_served' },
        { item: 'b', userId: 'U_starved' },
        { item: 'c', userId: null },
      ],
      fairness,
      'fixed-seed',
    )
    expect(twice).toEqual(once)
  })

  it('returns every candidate exactly once', () => {
    const order = drawOrder(
      ['a', 'b', 'c', 'd'].map((item) => ({ item, userId: `U_${item}` })),
      {},
      'seed',
    )
    expect([...order].sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('does not draw at all for a single candidate', () => {
    expect(drawOrder([{ item: 'only', userId: 'U1' }], fairness, 'seed')).toEqual(['only'])
  })
})

/** Three chargers, and enough surplus for one and a half of them. */
function contested(overrides: Partial<CycleInputs> = {}): CycleInputs {
  return makeInputs({
    now: '2026-06-15T12:30:00+02:00',
    cycleId: '2026-06-15T10:30:00Z',
    randomSeed: '2026-06-15T10:30:00Z',
    seasonMode: 'solar',
    tariffWindow: 'low',
    daylight: true,
    surplus: {
      rawKw: 12,
      smoothedKw: 12,
      observedAt: '2026-06-15T10:27:00Z',
      ageMinutes: 3,
      quality: 'fresh',
    },
    fairness: {
      U1: { solarKwhReceived: 80 },
      U2: { solarKwhReceived: 0 },
      U3: { solarKwhReceived: 40 },
    },
    chargers: ['U1', 'U2', 'U3'].map((userId, i) =>
      makeCharger({
        chargerId: `EH${i + 1}`,
        lotNumber: `A0${i + 1}`,
        userId,
        consecutiveAboveFloor: 2,
        target: { energyKwh: 40, deadline: '2026-06-17T18:00:00+02:00', deliveredKwh: 0 },
      }),
    ),
    ...overrides,
  })
}

describe('ladder rule 6 in decide()', () => {
  it('names the losers rather than leaving them looking like there was no sun', () => {
    const result = decide(contested())

    const served = result.decisions.filter((d) => d.reason === 'solar_surplus')
    const notSelected = result.decisions.filter((d) => d.reason === 'fairness_not_selected')

    expect(served.length).toBeGreaterThanOrEqual(1)
    expect(notSelected.length).toBeGreaterThanOrEqual(1)
    expect(served.length + notSelected.length).toBe(3)
    expect(notSelected.every((d) => d.ladderRule === 6 && d.targetCurrentA === 0)).toBe(true)
  })

  it('splits the surplus across chargers when every share still clears the floor (FR-024)', () => {
    // 20 kW is 28.8 A, comfortably three shares above the 6 A floor.
    const result = decide(
      contested({
        surplus: {
          rawKw: 20,
          smoothedKw: 20,
          observedAt: '2026-06-15T10:27:00Z',
          ageMinutes: 3,
          quality: 'fresh',
        },
      }),
    )

    const served = result.decisions.filter((d) => d.targetCurrentA >= 6)
    expect(served.length).toBeGreaterThanOrEqual(2)
    expect(result.decisions.filter((d) => d.reason === 'fairness_not_selected')).toHaveLength(
      3 - served.length,
    )
  })

  it('distributes across users over many cycles rather than always picking the same charger', () => {
    const winners = new Map<string, number>()
    for (let cycle = 0; cycle < 60; cycle += 1) {
      const seed = `2026-06-15T10:${String(cycle).padStart(2, '0')}:00Z`
      const result = decide(contested({ randomSeed: seed, cycleId: seed }))
      for (const decision of result.decisions) {
        if (decision.reason === 'solar_surplus') {
          winners.set(decision.chargerId, (winners.get(decision.chargerId) ?? 0) + 1)
        }
      }
    }
    // All three appear, and the user with no solar so far appears most.
    expect(winners.size).toBe(3)
    expect(winners.get('EH2') ?? 0).toBeGreaterThan(winners.get('EH1') ?? 0)
  })

  it('does not call it a fairness loss when there was no surplus for anyone', () => {
    const result = decide(
      contested({
        surplus: {
          rawKw: 1,
          smoothedKw: 1,
          observedAt: '2026-06-15T10:27:00Z',
          ageMinutes: 3,
          quality: 'fresh',
        },
      }),
    )
    expect(result.decisions.every((d) => d.reason !== 'fairness_not_selected')).toBe(true)
    expect(result.decisions.every((d) => d.reason === 'awaiting_surplus')).toBe(true)
  })
})

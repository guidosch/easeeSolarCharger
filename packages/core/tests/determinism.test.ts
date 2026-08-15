import { describe, expect, it } from 'vitest'
import { decide } from '../src/decide.js'
import type { CycleInputs } from '../src/types.js'
import { makeCharger, makeInputs } from './support/inputs.js'

/**
 * T103 — contract invariant 3: `decide(x)` is referentially transparent.
 *
 * This is the property SC-010 rests on. It is only achievable because `now` and `randomSeed` are
 * *fields of the input*: a core that read the wall clock or a random source could not be replayed,
 * and the fairness draw is exactly the place that temptation arises.
 */

function contestedInputs(): CycleInputs {
  return makeInputs({
    now: '2026-06-15T12:30:00+02:00',
    cycleId: '2026-06-15T10:30:00Z',
    randomSeed: '2026-06-15T10:30:00Z',
    seasonMode: 'solar',
    tariffWindow: 'low',
    daylight: true,
    surplus: {
      rawKw: 12.4,
      smoothedKw: 11.8,
      observedAt: '2026-06-15T10:27:00Z',
      ageMinutes: 3,
      quality: 'fresh',
    },
    forecast: {
      cloudCoverRestOfTodayPct: 70,
      cloudCoverTomorrowPct: 20,
      deferRecommended: true,
      fetchedAt: '2026-06-15T06:00:00Z',
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
        line: i === 2 ? 'L2' : 'L1',
        phases: i === 1 ? 1 : 3,
        maxCurrentA: i === 1 ? 32 : 16,
        consecutiveAboveFloor: i,
        opMode: i === 2 ? 6 : 3,
        commandedCurrentA: i === 0 ? 12 : 0,
        target: { energyKwh: 40 - i * 5, deadline: '2026-06-17T18:00:00+02:00', deliveredKwh: i },
      }),
    ),
  })
}

describe('decide is referentially transparent', () => {
  it('gives a deeply equal result when called twice, including a contested fairness draw', () => {
    const inputs = contestedInputs()

    const first = decide(inputs)
    const second = decide(inputs)

    expect(second).toEqual(first)
    // Deep equality is not enough on its own — the recorded corpus is compared as JSON, so the
    // serialised form has to match byte for byte too (SC-010).
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it('does not depend on the object identity of its input', () => {
    const first = decide(contestedInputs())
    const second = decide(JSON.parse(JSON.stringify(contestedInputs())) as CycleInputs)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it('does not mutate its input', () => {
    const inputs = contestedInputs()
    const before = JSON.stringify(inputs)
    decide(inputs)
    expect(JSON.stringify(inputs)).toBe(before)
  })

  it('depends on randomSeed and not on cycleId', () => {
    const base = contestedInputs()

    // The cycle id is carried into the output but must not influence the draw.
    expect(decide({ ...base, cycleId: 'a-different-id' }).decisions).toEqual(decide(base).decisions)

    // A charger already drawing solar keeps its place (the allocation is sticky), so the seed can
    // only decide anything when the field is genuinely open — hence no incumbent here.
    const openField: CycleInputs = {
      ...base,
      chargers: base.chargers.map((charger) => ({ ...charger, commandedCurrentA: 0 })),
    }

    // The draw is *weighted*, so a heavily favoured candidate wins under most seeds — the seed has
    // to be able to change the outcome, not change it every time.
    const outcomes = new Set(
      Array.from({ length: 25 }, (_, i) =>
        JSON.stringify(decide({ ...openField, randomSeed: `seed-${i}` }).decisions),
      ),
    )
    expect(outcomes.size).toBeGreaterThan(1)
  })

  it('is sticky: an incumbent keeps its share whatever the seed says', () => {
    const base = contestedInputs()
    const outcomes = new Set(
      Array.from({ length: 25 }, (_, i) =>
        JSON.stringify(decide({ ...base, randomSeed: `seed-${i}` }).decisions),
      ),
    )
    // EH1 is already charging in this fixture, so every seed produces the same allocation — which
    // is what stops a contested charger being switched on and off every five minutes.
    expect(outcomes.size).toBe(1)
  })

  it('is stable across repeated evaluation', () => {
    const inputs = contestedInputs()
    const expected = JSON.stringify(decide(inputs))
    for (let i = 0; i < 200; i += 1) {
      expect(JSON.stringify(decide(inputs))).toBe(expected)
    }
  })
})

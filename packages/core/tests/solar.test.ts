import { describe, expect, it } from 'vitest'
import { decide } from '../src/decide.js'
import type { CycleInputs } from '../src/types.js'
import { decisionFor, makeCharger, makeInputs } from './support/inputs.js'

/**
 * T073 — ladder rule 5, solar self-consumption.
 *
 * The rules that matter here are the two that are easy to get backwards: surplus below the
 * modulation floor means *wait*, not a grid top-up (FR-020); and a high-price window bans grid
 * import, not charging, so solar is still spent during one (FR-019).
 */

const SUMMER_MIDDAY = '2026-06-15T12:30:00+02:00'

/** A summer cycle with a usable surplus reading and a target with plenty of time. */
function solarInputs(overrides: Partial<CycleInputs> = {}): CycleInputs {
  return makeInputs({
    now: SUMMER_MIDDAY,
    cycleId: '2026-06-15T10:30:00Z',
    seasonMode: 'solar',
    tariffWindow: 'low',
    daylight: true,
    surplus: {
      rawKw: 8,
      smoothedKw: 8,
      observedAt: '2026-06-15T10:27:00Z',
      ageMinutes: 3,
      quality: 'fresh',
    },
    chargers: [
      makeCharger({
        target: { energyKwh: 30, deadline: '2026-06-17T18:00:00+02:00', deliveredKwh: 0 },
        // Already past the start hysteresis, so these tests are about allocation, not delay.
        consecutiveAboveFloor: 2,
      }),
    ],
    ...overrides,
  })
}

describe('ladder rule 5 — spending the surplus', () => {
  it('allocates the available surplus to a charger with an open target', () => {
    const decision = decisionFor(decide(solarInputs()), 'EH100001')

    // 8 kW three-phase is 11.5 A; whole amps only, and never above the charger maximum.
    expect(decision.reason).toBe('solar_surplus')
    expect(decision.ladderRule).toBe(5)
    expect(decision.targetCurrentA).toBe(11)
    expect(decision.attribution).toBe('solar')
  })

  it('caps the allocation at the charger maximum however much sun there is', () => {
    const decision = decisionFor(
      decide(
        solarInputs({
          surplus: {
            rawKw: 40,
            smoothedKw: 40,
            observedAt: '2026-06-15T10:27:00Z',
            ageMinutes: 3,
            quality: 'fresh',
          },
        }),
      ),
      'EH100001',
    )
    expect(decision.targetCurrentA).toBe(16)
    expect(decision.reason).toBe('solar_surplus')
  })

  it('waits rather than topping up from the grid below the modulation floor (FR-020)', () => {
    // 5.5 A of surplus. Taking a 6 A grid top-up to reach the floor is exactly what FR-020 forbids.
    const decision = decisionFor(
      decide(
        solarInputs({
          surplus: {
            rawKw: 3.8,
            smoothedKw: 3.8,
            observedAt: '2026-06-15T10:27:00Z',
            ageMinutes: 3,
            quality: 'fresh',
          },
        }),
      ),
      'EH100001',
    )
    expect(decision.targetCurrentA).toBe(0)
    expect(decision.reason).toBe('awaiting_surplus')
    expect(decision.attribution).toBe('none')
  })

  it('spends surplus during a high-price window, because the ban is on import (FR-019)', () => {
    const decision = decisionFor(
      decide(solarInputs({ tariffWindow: 'high', now: '2026-06-15T12:00:00+02:00' })),
      'EH100001',
    )
    expect(decision.reason).toBe('solar_surplus')
    expect(decision.ladderRule).toBe(5)
    expect(decision.targetCurrentA).toBeGreaterThan(0)
    expect(decision.attribution).toBe('solar')
  })

  it('blocks a high-price cycle with no usable surplus', () => {
    const decision = decisionFor(
      decide(
        solarInputs({
          tariffWindow: 'high',
          surplus: {
            rawKw: -2,
            smoothedKw: -2,
            observedAt: '2026-06-15T10:27:00Z',
            ageMinutes: 3,
            quality: 'fresh',
          },
        }),
      ),
      'EH100001',
    )
    expect(decision.reason).toBe('high_price_blocked')
    expect(decision.ladderRule).toBe(3)
    expect(decision.targetCurrentA).toBe(0)
  })

  it('shares surplus across chargers when each share clears the floor', () => {
    const inputs = solarInputs({
      surplus: {
        rawKw: 20,
        smoothedKw: 20,
        observedAt: '2026-06-15T10:27:00Z',
        ageMinutes: 3,
        quality: 'fresh',
      },
      chargers: [
        makeCharger({
          chargerId: 'EH1',
          lotNumber: 'A01',
          userId: 'U1',
          consecutiveAboveFloor: 2,
          target: { energyKwh: 30, deadline: '2026-06-17T18:00:00+02:00', deliveredKwh: 0 },
        }),
        makeCharger({
          chargerId: 'EH2',
          lotNumber: 'A02',
          userId: 'U2',
          consecutiveAboveFloor: 2,
          target: { energyKwh: 30, deadline: '2026-06-17T18:00:00+02:00', deliveredKwh: 0 },
        }),
      ],
    })

    const result = decide(inputs)
    const currents = result.decisions.map((d) => d.targetCurrentA)

    expect(currents.every((a) => a >= 6)).toBe(true)
    expect(currents.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(29) // 20 kW ≈ 28.9 A
    expect(result.decisions.every((d) => d.reason === 'solar_surplus')).toBe(true)
  })
})

describe('ladder rule 5 — when it must not run at all', () => {
  it('never yields solar_surplus on an unusable reading (staleness)', () => {
    const decision = decisionFor(
      decide(
        solarInputs({
          surplus: {
            rawKw: null,
            smoothedKw: null,
            observedAt: '2026-06-15T09:00:00Z',
            ageMinutes: 90,
            quality: 'unusable',
          },
        }),
      ),
      'EH100001',
    )
    expect(decision.reason).not.toBe('solar_surplus')
  })

  it('skips rules 5 and 6 entirely in the winter window (FR-023)', () => {
    const result = decide(
      solarInputs({
        seasonMode: 'winter',
        now: '2026-01-15T12:30:00+01:00',
        cycleId: '2026-01-15T11:30:00Z',
      }),
    )
    expect(result.decisions.every((d) => d.reason !== 'solar_surplus')).toBe(true)
    expect(result.notes.join(' ')).toContain('winter')
  })

  it('does not start on a single good cycle — two are needed (research R2)', () => {
    const decision = decisionFor(
      decide(
        solarInputs({
          chargers: [
            makeCharger({
              consecutiveAboveFloor: 0,
              commandedCurrentA: 0,
              target: { energyKwh: 30, deadline: '2026-06-17T18:00:00+02:00', deliveredKwh: 0 },
            }),
          ],
        }),
      ),
      'EH100001',
    )
    expect(decision.targetCurrentA).toBe(0)
    expect(decision.reason).toBe('awaiting_surplus')
  })

  it('does not stop on a single bad cycle either', () => {
    const decision = decisionFor(
      decide(
        solarInputs({
          surplus: {
            rawKw: 2,
            smoothedKw: 2,
            observedAt: '2026-06-15T10:27:00Z',
            ageMinutes: 3,
            quality: 'fresh',
          },
          chargers: [
            makeCharger({
              commandedCurrentA: 12,
              consecutiveBelowFloor: 0,
              opMode: 3,
              target: { energyKwh: 30, deadline: '2026-06-17T18:00:00+02:00', deliveredKwh: 0 },
            }),
          ],
        }),
      ),
      'EH100001',
    )
    // The passing-cloud case: hold the previous setpoint for one more cycle.
    expect(decision.targetCurrentA).toBe(12)
    expect(decision.reason).toBe('solar_surplus')
  })

  it('stops after the second consecutive cycle below the floor', () => {
    const decision = decisionFor(
      decide(
        solarInputs({
          surplus: {
            rawKw: 2,
            smoothedKw: 2,
            observedAt: '2026-06-15T10:27:00Z',
            ageMinutes: 3,
            quality: 'fresh',
          },
          chargers: [
            makeCharger({
              commandedCurrentA: 12,
              consecutiveBelowFloor: 1,
              opMode: 3,
              target: { energyKwh: 30, deadline: '2026-06-17T18:00:00+02:00', deliveredKwh: 0 },
            }),
          ],
        }),
      ),
      'EH100001',
    )
    expect(decision.targetCurrentA).toBe(0)
    expect(decision.reason).toBe('below_modulation_floor')
  })
})

describe('deferral to tomorrow (FR-022, research R4)', () => {
  const farDeadline = { energyKwh: 30, deadline: '2026-06-18T18:00:00+02:00', deliveredKwh: 0 }

  it('records a deferral when tomorrow is sunnier and the deadline is far away', () => {
    const decision = decisionFor(
      decide(
        solarInputs({
          surplus: {
            rawKw: 1,
            smoothedKw: 1,
            observedAt: '2026-06-15T10:27:00Z',
            ageMinutes: 3,
            quality: 'fresh',
          },
          forecast: {
            cloudCoverRestOfTodayPct: 85,
            cloudCoverTomorrowPct: 20,
            deferRecommended: true,
            fetchedAt: '2026-06-15T06:00:00Z',
          },
          chargers: [makeCharger({ target: farDeadline, consecutiveAboveFloor: 2 })],
        }),
      ),
      'EH100001',
    )
    expect(decision.reason).toBe('deferred_to_tomorrow')
    expect(decision.targetCurrentA).toBe(0)
  })

  it('never defers a deadline less than 24 hours away', () => {
    const decision = decisionFor(
      decide(
        solarInputs({
          surplus: {
            rawKw: 1,
            smoothedKw: 1,
            observedAt: '2026-06-15T10:27:00Z',
            ageMinutes: 3,
            quality: 'fresh',
          },
          forecast: {
            cloudCoverRestOfTodayPct: 85,
            cloudCoverTomorrowPct: 20,
            deferRecommended: true,
            fetchedAt: '2026-06-15T06:00:00Z',
          },
          chargers: [
            makeCharger({
              target: { energyKwh: 10, deadline: '2026-06-16T08:00:00+02:00', deliveredKwh: 0 },
              consecutiveAboveFloor: 2,
            }),
          ],
        }),
      ),
      'EH100001',
    )
    expect(decision.reason).not.toBe('deferred_to_tomorrow')
  })

  it('treats a missing forecast as no deferral, never as one (FR-044)', () => {
    const decision = decisionFor(
      decide(
        solarInputs({
          forecast: null,
          surplus: {
            rawKw: 1,
            smoothedKw: 1,
            observedAt: '2026-06-15T10:27:00Z',
            ageMinutes: 3,
            quality: 'fresh',
          },
          chargers: [makeCharger({ target: farDeadline, consecutiveAboveFloor: 2 })],
        }),
      ),
      'EH100001',
    )
    expect(decision.reason).not.toBe('deferred_to_tomorrow')
  })

  it('never defers a target that is no longer comfortably reachable', () => {
    // On a 16 A three-phase charger this guard is unreachable in practice: any deadline more than
    // 24 hours away leaves ~20 hours of low-price time, which covers the 100 kWh slider maximum
    // several times over. It bites on a weak charger — here 6 A single-phase, about 1.4 kW — which
    // is exactly the case where deferring a day would cost the deadline.
    const decision = decisionFor(
      decide(
        solarInputs({
          now: '2026-06-15T22:00:00+02:00',
          surplus: {
            rawKw: null,
            smoothedKw: null,
            observedAt: null,
            ageMinutes: null,
            quality: 'unusable',
          },
          forecast: {
            cloudCoverRestOfTodayPct: 85,
            cloudCoverTomorrowPct: 20,
            deferRecommended: true,
            fetchedAt: '2026-06-15T18:00:00Z',
          },
          chargers: [
            makeCharger({
              phases: 1,
              maxCurrentA: 6,
              target: { energyKwh: 90, deadline: '2026-06-17T04:00:00+02:00', deliveredKwh: 0 },
            }),
          ],
        }),
      ),
      'EH100001',
    )
    expect(decision.reason).not.toBe('deferred_to_tomorrow')
    expect(decision.reason).toBe('deadline_fallback')
  })
})

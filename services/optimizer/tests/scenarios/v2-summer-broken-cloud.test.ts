import { describe, expect, it } from 'vitest'
import { decisionsFor, replay } from './support.js'

/**
 * Quickstart **V2** — solar tracking and hysteresis (US2, T087).
 *
 * The assertion that matters is the **setpoint change count**, not the delivered energy. A
 * controller with no smoothing would deliver roughly the same kWh on this day while starting and
 * stopping every few minutes — and "some cars might get upset if the current is changed too
 * frequently" (research R5). Oscillation is the failure this scenario exists to catch.
 */
describe('V2 — summer-broken-cloud', () => {
  const result = replay('summer-broken-cloud')

  it('charges from surplus and attributes it to solar', () => {
    const decisions = decisionsFor(result, 'A01')
    const solar = decisions.filter((d) => d.reason === 'solar_surplus')

    expect(solar.length).toBeGreaterThan(20)
    expect(solar.every((d) => d.attribution === 'solar')).toBe(true)
    expect(solar.every((d) => d.ladderRule === 5)).toBe(true)
  })

  it('meets both targets entirely from the sun, with no grid import at all', () => {
    for (const lotNumber of ['A01', 'A02']) {
      const outcome = result.outcomes[lotNumber]
      expect(outcome?.targetMet).toBe(true)
      expect(outcome?.gridKwh).toBe(0)
      expect(outcome?.solarKwh).toBeGreaterThan(0)
    }
  })

  it('never starts or stops a charger more than once in fifteen minutes', () => {
    for (const lotNumber of ['A01', 'A02']) {
      const instants = result.outcomes[lotNumber]?.startStopInstants ?? []
      for (let i = 1; i < instants.length; i += 1) {
        const gapMinutes =
          (Date.parse(instants[i] ?? '') - Date.parse(instants[i - 1] ?? '')) / 60_000
        expect(gapMinutes).toBeGreaterThanOrEqual(15)
      }
    }
  })

  it('keeps the setpoint change count low across a day of broken cloud', () => {
    // 181 cycles, six hours of it with the surplus sawtoothing across the modulation floor. Without
    // the EWMA, the ±1 A deadband and the two-cycle hysteresis this number is in the dozens.
    for (const lotNumber of ['A01', 'A02']) {
      expect(result.outcomes[lotNumber]?.setpointChanges).toBeLessThanOrEqual(12)
    }
  })

  it('never takes a grid top-up to reach the modulation floor (FR-020)', () => {
    const decisions = decisionsFor(result, 'A01')
    const topUps = decisions.filter(
      (d) =>
        d.attribution === 'grid' && d.reason !== 'deadline_fallback' && d.reason !== 'override',
    )
    expect(topUps).toHaveLength(0)
  })

  it('waits rather than charging when the surplus is below the floor', () => {
    const waiting = decisionsFor(result, 'A01').filter((d) => d.reason === 'awaiting_surplus')
    expect(waiting.length).toBeGreaterThan(0)
    expect(waiting.every((d) => d.targetCurrentA === 0)).toBe(true)
  })
})

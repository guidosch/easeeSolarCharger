import { describe, expect, it } from 'vitest'
import { cycleAt, decisionFor, decisionsFor, replay } from './support.js'

/**
 * Quickstart **V1** — deadline met without solar (US1, T069).
 *
 * The scenario exists to prove the one thing the constitution changed in v2.0.0: a deadline does
 * not license grid import during a high-price window.
 */
describe('V1 — winter-overcast', () => {
  const result = replay('winter-overcast')

  it('blocks grid import in both high-price windows (FR-018, ladder rule 3)', () => {
    for (const instant of ['2026-01-15T12:00:00+01:00', '2026-01-15T19:00:00+01:00']) {
      const decision = decisionFor(cycleAt(result, instant), 'A01')
      expect(decision.reason).toBe('high_price_blocked')
      expect(decision.ladderRule).toBe(3)
      expect(decision.targetCurrentA).toBe(0)
      expect(decision.attribution).toBe('none')
    }
  })

  it('charges from low-price grid at 22:00 (FR-021, ladder rule 4)', () => {
    const cycle = cycleAt(result, '2026-01-15T22:00:00+01:00')
    for (const lotNumber of ['A01', 'B01']) {
      const decision = decisionFor(cycle, lotNumber)
      expect(decision.reason).toBe('deadline_fallback')
      expect(decision.ladderRule).toBe(4)
      expect(decision.targetCurrentA).toBe(16)
      expect(decision.attribution).toBe('grid')
    }
  })

  it('delivers the requested energy before the deadline', () => {
    for (const lotNumber of ['A01', 'B01']) {
      const outcome = result.outcomes[lotNumber]
      expect(outcome?.targetMet).toBe(true)
      expect(outcome?.deliveredKwh).toBeGreaterThanOrEqual(outcome?.targetEnergyKwh ?? 0)
    }
  })

  it('draws no grid energy at all during the high-price windows (SC-004)', () => {
    const importing = result.cycles.filter((cycle) =>
      cycle.decision.decisions.some(
        (d) =>
          d.targetCurrentA > 0 && d.attribution === 'grid' && cycle.inputs.tariffWindow === 'high',
      ),
    )
    expect(importing).toHaveLength(0)
  })

  it('attributes every kWh to the grid, because the winter window has no solar mode', () => {
    const outcome = result.outcomes['A01']
    expect(outcome?.solarKwh).toBe(0)
    expect(outcome?.gridKwh).toBeGreaterThan(0)
    expect(decisionsFor(result, 'A01').every((d) => d.reason !== 'solar_surplus')).toBe(true)
  })

  it('does not oscillate: the charger starts and stops only at window boundaries', () => {
    // Two high-price windows in the day means at most a handful of transitions; anything more
    // would be the deadband or the ladder flapping.
    expect(result.outcomes['A01']?.startStopInstants.length).toBeLessThanOrEqual(6)
  })
})

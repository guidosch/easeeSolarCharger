import { describe, expect, it } from 'vitest'
import { decisionsFor, replay } from './support.js'

/**
 * Quickstart **V3** — stale and missing surplus (US2, FR-016, FR-044, T088).
 *
 * The provider goes away at 11:00 and never comes back. Three things must hold: the reading ages
 * out to `unusable` rather than becoming zero, no decision claims solar after that, and the
 * deadline is still met from low-price grid energy — with no cycle failing.
 */
describe('V3 — summer-solaredge-outage', () => {
  const result = replay('summer-solaredge-outage')
  const OUTAGE_AT = Date.parse('2026-06-15T11:00:00+02:00')

  it('walks the reading fresh → stale → unusable rather than to zero (FR-016)', () => {
    const qualities = result.cycles.map((c) => c.inputs.surplus.quality)
    expect(qualities).toContain('fresh')
    expect(qualities).toContain('stale')
    expect(qualities).toContain('unusable')

    // The decisive property: at no point is a missing reading reported as a surplus of zero.
    const zeroed = result.cycles.filter(
      (c) => c.inputs.surplus.quality === 'unusable' && c.inputs.surplus.smoothedKw === 0,
    )
    expect(zeroed).toHaveLength(0)
  })

  it('reaches unusable within the staleness cutoff of the outage', () => {
    const firstUnusable = result.cycles.find(
      (c) => Date.parse(c.cycleId) > OUTAGE_AT && c.inputs.surplus.quality === 'unusable',
    )
    expect(firstUnusable).toBeDefined()
    const minutes = (Date.parse(firstUnusable?.cycleId ?? '') - OUTAGE_AT) / 60_000
    // 15-minute cutoff plus at most one cycle of rounding.
    expect(minutes).toBeLessThanOrEqual(20)
  })

  it('claims no solar once the reading is unusable', () => {
    const afterUnusable = result.cycles.filter((c) => c.inputs.surplus.quality === 'unusable')
    expect(afterUnusable.length).toBeGreaterThan(50)
    for (const cycle of afterUnusable) {
      for (const decision of cycle.decision.decisions) {
        expect(decision.reason).not.toBe('solar_surplus')
        expect(decision.attribution).not.toBe('solar')
      }
    }
  })

  it('keeps charging under the deadline rule and still meets the target (FR-044, SC-015)', () => {
    const fallbacks = decisionsFor(result, 'A01').filter((d) => d.reason === 'deadline_fallback')
    expect(fallbacks.length).toBeGreaterThan(0)
    expect(fallbacks.every((d) => d.ladderRule === 4 && d.attribution === 'grid')).toBe(true)

    const outcome = result.outcomes['A01']
    expect(outcome?.targetMet).toBe(true)
    expect(outcome?.solarKwh).toBeGreaterThan(0) // the morning, before the outage
    expect(outcome?.gridKwh).toBeGreaterThan(0) // the rest of the day
  })

  it('still refuses to import during the high-price windows', () => {
    const importingAtHighPrice = result.cycles.filter(
      (c) =>
        c.inputs.tariffWindow === 'high' &&
        c.decision.decisions.some((d) => d.attribution === 'grid' && d.targetCurrentA > 0),
    )
    expect(importingAtHighPrice).toHaveLength(0)
  })

  it('produces a decision for every charger on every cycle — no cycle fails', () => {
    for (const cycle of result.cycles) {
      expect(cycle.decision.decisions).toHaveLength(cycle.inputs.chargers.length)
    }
  })

  it('does not oscillate once it falls back to the grid (FR-017)', () => {
    const instants = result.outcomes['A01']?.startStopInstants ?? []
    for (let i = 1; i < instants.length; i += 1) {
      const gapMinutes =
        (Date.parse(instants[i] ?? '') - Date.parse(instants[i - 1] ?? '')) / 60_000
      expect(gapMinutes).toBeGreaterThanOrEqual(15)
    }
  })

  it('records why, on every degraded cycle', () => {
    const degraded = result.cycles.filter((c) => c.inputs.surplus.quality === 'unusable')
    for (const cycle of degraded.slice(0, 5)) {
      expect(cycle.decision.notes.join(' ')).toMatch(/deadline-only|not zero surplus/i)
    }
  })
})

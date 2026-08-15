import { describe, expect, it } from 'vitest'
import { CYCLE_MINUTES } from '@app/core'
import { replay } from './support.js'

/**
 * Quickstart **V10** — the write budget on a busy day (T134, Principle VI, SC-012).
 *
 * A busy day is the right test: research R8's figure assumes fifteen active chargers, and this is
 * the scenario that would break it if snapshotting or the target flush ever regressed to per-cycle.
 */
describe('V10 — summer-busy', () => {
  const result = replay('summer-busy')
  const FIXED_WRITES_PER_CYCLE = 3 // the cycle record, the lease, the batched charger mirror
  const cyclesPerDay = (24 * 60) / CYCLE_MINUTES

  it('stays inside the 2,000 writes/day design budget when extrapolated to a full day', () => {
    const uncovered = Math.max(0, cyclesPerDay - result.cycles.length)
    const perDay = result.firestoreWrites + uncovered * FIXED_WRITES_PER_CYCLE

    expect(perDay).toBeLessThanOrEqual(2000)
    // And well inside Firestore's free allowance, which is the point of the budget.
    expect(perDay / 20_000).toBeLessThan(0.15)
  })

  it('is nowhere near the cost of writing per charger per cycle (FR-046)', () => {
    const activeChargers = 15
    const perChargerPerCycle = cyclesPerDay * activeChargers
    const uncovered = Math.max(0, cyclesPerDay - result.cycles.length)
    const actual = result.firestoreWrites + uncovered * FIXED_WRITES_PER_CYCLE

    // ~4,300 versus ~1,950: the rule is worth roughly half the free allowance a month.
    expect(actual).toBeLessThan(perChargerPerCycle / 2)
  })

  it('still serves fifteen cars from the sun on that day', () => {
    const outcomes = Object.values(result.outcomes)
    expect(outcomes).toHaveLength(15)
    expect(outcomes.every((o) => o.targetMet)).toBe(true)
    expect(outcomes.every((o) => o.gridKwh === 0)).toBe(true)
  })

  it('does not achieve the budget by simply not charging', () => {
    const totalKwh = Object.values(result.outcomes).reduce((sum, o) => sum + o.deliveredKwh, 0)
    expect(totalKwh).toBeGreaterThan(350)
  })
})

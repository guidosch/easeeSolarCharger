import { decide } from '@app/core'
import { describe, expect, it } from 'vitest'
import { decisionsFor, replay } from './support.js'

/**
 * Quickstart **V5** — fairness and determinism (US5, SC-010, T108).
 *
 * Three identical targets and a PV curve that peaks at enough for one and a half of them. What is
 * being asserted is *distribution*: a first-come allocation would concentrate the whole day's sun
 * on whichever charger happens to sort first, and nobody would ever notice from the energy totals
 * alone until a neighbour complained.
 */
describe('V5 — summer-three-competitors', () => {
  const result = replay('summer-three-competitors')
  const lots = ['A01', 'A02', 'A03']

  it('spreads the sun across all three users rather than concentrating it', () => {
    const solar = lots.map((lot) => result.outcomes[lot]?.solarKwh ?? 0)
    const most = Math.max(...solar)
    const least = Math.min(...solar)

    expect(least).toBeGreaterThan(0)
    // SC-007: no user gets more than twice the share of another with a comparable target.
    expect(most / least).toBeLessThan(2)
  })

  it('meets every target, entirely from solar', () => {
    for (const lot of lots) {
      const outcome = result.outcomes[lot]
      expect(outcome?.targetMet).toBe(true)
      expect(outcome?.gridKwh).toBe(0)
    }
  })

  it('names the users who lost a contested cycle (ladder rule 6)', () => {
    const notSelected = result.cycles.flatMap((c) =>
      c.decision.decisions.filter((d) => d.reason === 'fairness_not_selected'),
    )
    expect(notSelected.length).toBeGreaterThan(0)
    expect(notSelected.every((d) => d.ladderRule === 6 && d.targetCurrentA === 0)).toBe(true)
  })

  it('serves more than one charger when the surplus stretches to it (FR-024)', () => {
    const splitCycles = result.cycles.filter(
      (c) => c.decision.decisions.filter((d) => d.reason === 'solar_surplus').length > 1,
    )
    expect(splitCycles.length).toBeGreaterThan(0)
    for (const cycle of splitCycles.slice(0, 20)) {
      for (const decision of cycle.decision.decisions) {
        // A split share is still a real share: never below the modulation floor.
        expect(decision.targetCurrentA === 0 || decision.targetCurrentA >= 6).toBe(true)
      }
    }
  })

  it('replays every cycle byte-identically (SC-010)', () => {
    // The same assertion `pnpm test:determinism` makes over the whole corpus, kept here so a
    // fairness change cannot go green in CI without this scenario noticing.
    for (const cycle of result.cycles) {
      expect(JSON.stringify(decide(cycle.inputs))).toBe(JSON.stringify(cycle.decision))
    }
  })

  it('records the seed that produced each draw, so it can be re-run', () => {
    for (const cycle of result.cycles.slice(0, 10)) {
      expect(cycle.inputs.randomSeed).toBeTruthy()
      expect(cycle.inputs.fairness).toBeDefined()
    }
  })

  it('does not oscillate while sharing', () => {
    for (const lot of lots) {
      const instants = result.outcomes[lot]?.startStopInstants ?? []
      for (let i = 1; i < instants.length; i += 1) {
        const gap = (Date.parse(instants[i] ?? '') - Date.parse(instants[i - 1] ?? '')) / 60_000
        expect(gap).toBeGreaterThanOrEqual(15)
      }
    }
  })

  it('keeps every decision explainable by a ladder rule or a plain state', () => {
    const decisions = lots.flatMap((lot) => decisionsFor(result, lot))
    for (const decision of decisions) {
      if (decision.targetCurrentA > 0) expect(decision.ladderRule).not.toBeNull()
    }
  })
})

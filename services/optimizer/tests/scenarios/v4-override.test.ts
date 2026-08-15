import { describe, expect, it } from 'vitest'
import { cycleAt, decisionFor, decisionsFor, replay } from './support.js'

/**
 * Quickstart **V4** — charge now (US4, T101).
 *
 * The override is the only mechanism in the system permitted to import during a high-price window,
 * and this is the scenario that proves it does so *only* when the user asked for it.
 */
describe('V4 — summer-override', () => {
  const result = replay('summer-override')

  it('charges at maximum inside the high-price window with no surplus', () => {
    const decision = decisionFor(cycleAt(result, '2026-06-10T12:15:00+02:00'), 'A01')

    expect(decision.reason).toBe('override')
    expect(decision.ladderRule).toBe(2)
    expect(decision.targetCurrentA).toBe(16)
  })

  it('would have been blocked without it, at the very same minute', () => {
    // 11:30 is inside the same high-price window, before the driver pressed the button.
    const before = decisionFor(cycleAt(result, '2026-06-10T11:30:00+02:00'), 'A01')
    expect(before.reason).toBe('high_price_blocked')
    expect(before.targetCurrentA).toBe(0)
  })

  it('is the only thing that ever imports during a high-price window', () => {
    const importsAtHighPrice = result.cycles.flatMap((cycle) =>
      cycle.inputs.tariffWindow === 'high'
        ? cycle.decision.decisions.filter((d) => d.targetCurrentA > 0)
        : [],
    )
    expect(importsAtHighPrice.length).toBeGreaterThan(0)
    expect(importsAtHighPrice.every((d) => d.reason === 'override')).toBe(true)
  })

  it('stops when the car is unplugged', () => {
    // The car leaves at 13:30; from then on there is nothing to command, override or not.
    const after = decisionFor(cycleAt(result, '2026-06-10T13:45:00+02:00'), 'A01')
    expect(after.reason).toBe('not_plugged_in')
    expect(after.targetCurrentA).toBe(0)
  })

  it('never asks for more than the charger maximum', () => {
    const overrides = decisionsFor(result, 'A01').filter((d) => d.reason === 'override')
    expect(overrides.length).toBeGreaterThan(0)
    expect(overrides.every((d) => d.targetCurrentA <= 16)).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import { replay } from './support.js'

/**
 * Quickstart **V7**, replay half (T133) — the plug-in reset as a whole evening.
 *
 * `services/optimizer/tests/plug-in-reset.test.ts` asserts the read-back classification against the
 * emulator; this asserts the consequence that a user would notice, which is that the car actually
 * charges after being plugged in.
 */
describe('V7 — plug-in-reset', () => {
  const result = replay('plug-in-reset')
  const PLUGGED_IN_AT = Date.parse('2026-01-20T19:00:00+01:00')

  it('commands nothing while the car is away', () => {
    const before = result.cycles.filter((c) => Date.parse(c.cycleId) < PLUGGED_IN_AT)
    expect(before.length).toBeGreaterThan(0)
    expect(before.every((c) => c.decision.decisions[0]?.reason === 'not_plugged_in')).toBe(true)
  })

  it('does not charge on the plug-in cycle itself, because 19:00 is a high-price window', () => {
    // The car arrives at 19:00, inside 18:00–20:00. A reset setpoint is not a reason to import.
    const firstAfter = result.cycles.find((c) => Date.parse(c.cycleId) >= PLUGGED_IN_AT)
    expect(firstAfter?.decision.decisions[0]?.reason).toBe('high_price_blocked')
    expect(firstAfter?.decision.decisions[0]?.targetCurrentA).toBe(0)
  })

  it('charges on the first cycle after the window closes, despite the reset setpoint', () => {
    const firstLowPrice = result.cycles.find(
      (c) => Date.parse(c.cycleId) >= Date.parse('2026-01-20T20:00:00+01:00'),
    )
    expect(firstLowPrice?.decision.decisions[0]?.targetCurrentA).toBe(16)
    expect(firstLowPrice?.decision.decisions[0]?.reason).toBe('deadline_fallback')
  })

  it('delivers energy after the plug-in — the reset did not silently strand the car', () => {
    const outcome = result.outcomes['A01']
    expect(outcome?.deliveredKwh).toBeGreaterThan(0)
    // 19:00 to 23:30 is 4.5 hours, of which 19:00–20:00 is high-price: about 3.5 h at 11.09 kW.
    expect(outcome?.deliveredKwh).toBeGreaterThan(30)
  })

  it('still refuses the 19:00–20:00 high-price window right after the plug-in', () => {
    const inWindow = result.cycles.filter(
      (c) => c.inputs.tariffWindow === 'high' && Date.parse(c.cycleId) >= PLUGGED_IN_AT,
    )
    expect(inWindow.length).toBeGreaterThan(0)
    expect(inWindow.every((c) => c.decision.decisions[0]?.targetCurrentA === 0)).toBe(true)
  })
})

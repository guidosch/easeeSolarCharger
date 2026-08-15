import { describe, expect, it } from 'vitest'
import { DEFAULT_SCHEDULER_CONFIG as config } from '../src/config.js'
import { isReachable } from '../src/reachability.js'

/**
 * T047 — reachability is evaluated *within* the price policy (Principle II): only remaining
 * low-price time counts, because a high-price window is not time this system may spend.
 */

const capability = { maxCurrentA: 16, phases: 3 as const }

describe('isReachable', () => {
  it('is reachable with plenty of low-price time', () => {
    const result = isReachable(
      { energyKwh: 20, deadline: '2026-01-16T07:00:00+01:00', deliveredKwh: 0 },
      '2026-01-15T22:00:00+01:00',
      config,
      capability,
    )
    expect(result.state).toBe('reachable')
    expect(result.expectedShortfallKwh).toBe(0)
  })

  it('is at risk once the margin over the remaining low-price time is thin', () => {
    // 20 kWh needs ~1.80 h at 11.09 kW. Two hours left is a margin of 1.11, under the 1.25 required.
    const result = isReachable(
      { energyKwh: 20, deadline: '2026-01-15T07:00:00+01:00', deliveredKwh: 0 },
      '2026-01-15T05:00:00+01:00',
      config,
      capability,
    )
    expect(result.state).toBe('at_risk')
    expect(result.expectedShortfallKwh).toBe(0)
  })

  it('is unreachable when the remaining low-price time cannot deliver the energy', () => {
    const result = isReachable(
      { energyKwh: 20, deadline: '2026-01-15T06:00:00+01:00', deliveredKwh: 0 },
      '2026-01-15T05:00:00+01:00',
      config,
      capability,
    )
    expect(result.state).toBe('unreachable')
    // One hour at 11.088 kW leaves 20 − 11.088 ≈ 8.9 kWh short.
    expect(result.expectedShortfallKwh).toBeCloseTo(8.91, 2)
  })

  it('counts only low-price time, so a high-price window shortens the runway', () => {
    // 17:00 → 21:00 is four hours, but 18:00–20:00 is high-price, leaving two usable hours.
    const straddling = isReachable(
      { energyKwh: 30, deadline: '2026-01-15T21:00:00+01:00', deliveredKwh: 0 },
      '2026-01-15T17:00:00+01:00',
      config,
      capability,
    )
    expect(straddling.state).toBe('unreachable')
    // 2 h × 11.088 kW = 22.18 kWh deliverable, so ~7.8 kWh short.
    expect(straddling.expectedShortfallKwh).toBeCloseTo(7.82, 2)
  })

  it('counts energy already delivered', () => {
    const result = isReachable(
      { energyKwh: 20, deadline: '2026-01-15T06:00:00+01:00', deliveredKwh: 15 },
      '2026-01-15T05:00:00+01:00',
      config,
      capability,
    )
    expect(result.state).toBe('reachable')
  })

  it('treats a met target as reachable rather than as a special case elsewhere', () => {
    const result = isReachable(
      { energyKwh: 20, deadline: '2026-01-15T05:01:00+01:00', deliveredKwh: 20 },
      '2026-01-15T05:00:00+01:00',
      config,
      capability,
    )
    expect(result.state).toBe('reachable')
    expect(result.expectedShortfallKwh).toBe(0)
  })

  it('reports a passed deadline as unreachable with the full remaining energy', () => {
    const result = isReachable(
      { energyKwh: 20, deadline: '2026-01-15T04:00:00+01:00', deliveredKwh: 6 },
      '2026-01-15T05:00:00+01:00',
      config,
      capability,
    )
    expect(result.state).toBe('unreachable')
    expect(result.expectedShortfallKwh).toBe(14)
  })

  it('is harder to satisfy on a single-phase charger, which is the physics not a policy', () => {
    const singlePhase = isReachable(
      { energyKwh: 20, deadline: '2026-01-15T07:00:00+01:00', deliveredKwh: 0 },
      '2026-01-15T05:00:00+01:00',
      config,
      { maxCurrentA: 16, phases: 1 },
    )
    expect(singlePhase.state).toBe('unreachable')
  })
})

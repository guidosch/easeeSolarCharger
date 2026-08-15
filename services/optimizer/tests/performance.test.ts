import { decide } from '@app/core'
import type { ChargerInput, CycleInputs } from '@app/core'
import { DEFAULT_LINE_LIMITS, DEFAULT_SCHEDULER_CONFIG } from '@app/core'
import { describe, expect, it } from 'vitest'

/**
 * T139 — the performance goal.
 *
 * The plan budgets **90 seconds** for a full cycle: thirty charger reads, one surplus read, the
 * decision and the resulting writes. That has to fit inside the four-minute lease and the
 * five-minute cadence.
 *
 * What is measured here is the part this repository controls end to end — the decision itself.
 * The provider reads dominate the wall clock and are bounded separately, by the per-request timeout
 * (8–10 s) and the bounded retry in `packages/adapters/src/http/client.ts`; the write spreading is
 * bounded by the 20/min token bucket. This test exists to make sure `decide()` is not the thing
 * that blows the budget, which it very nearly was: reachability walks the remaining low-price time
 * one cycle at a time, and it used to do that twice per charger.
 */

const NOW = '2026-06-15T12:30:00+02:00'

function thirtyChargers(): ChargerInput[] {
  return Array.from({ length: 30 }, (_, i) => ({
    chargerId: `EH${100001 + i}`,
    lotNumber: `${i < 15 ? 'A' : 'B'}${String((i % 15) + 1).padStart(2, '0')}`,
    userId: `U${1001 + i}`,
    line: i < 15 ? ('L1' as const) : ('L2' as const),
    phases: 3 as const,
    maxCurrentA: 16,
    opMode: 3 as const,
    deliveredCurrentA: 10,
    dynamicChargerCurrentA: 10,
    commandedCurrentA: 10,
    totalPowerKw: 6.9,
    sessionEnergyKwh: 5,
    observedAt: NOW,
    overrideActive: false,
    consecutiveAboveFloor: 2,
    consecutiveBelowFloor: 0,
    // A deadline two days out is the worst case for the low-price walk.
    target: { energyKwh: 40, deadline: '2026-06-17T18:00:00+02:00', deliveredKwh: 5 },
  }))
}

const inputs: CycleInputs = {
  cycleId: '2026-06-15T10:30:00Z',
  now: NOW,
  schedulerVersion: 'perf',
  randomSeed: '2026-06-15T10:30:00Z',
  surplus: {
    rawKw: 60,
    smoothedKw: 60,
    observedAt: '2026-06-15T10:27:00Z',
    ageMinutes: 3,
    quality: 'fresh',
  },
  gridExportKw: 60,
  ownChargingKw: 0,
  daylight: true,
  seasonMode: 'solar',
  tariffWindow: 'low',
  forecast: null,
  chargers: thirtyChargers(),
  fairness: Object.fromEntries(
    Array.from({ length: 30 }, (_, i) => [`U${1001 + i}`, { solarKwhReceived: i }]),
  ),
  lineLimits: { ...DEFAULT_LINE_LIMITS },
  config: DEFAULT_SCHEDULER_CONFIG,
}

describe('decide() at full scale', () => {
  it('decides for thirty chargers well inside the cycle budget', () => {
    decide(inputs) // warm the tz formatter cache, as a running service would be

    const startedAt = performance.now()
    const runs = 20
    for (let i = 0; i < runs; i += 1) decide(inputs)
    const perDecision = (performance.now() - startedAt) / runs

    // A tenth of the 90-second budget would already be too much for the pure part.
    expect(perDecision).toBeLessThan(500)
    console.log(`decide() over 30 chargers: ${perDecision.toFixed(1)} ms`)
  })

  it('produces one decision per charger and respects the line limits at that scale', () => {
    const result = decide(inputs)
    expect(result.decisions).toHaveLength(30)

    const perLine = { L1: 0, L2: 0 }
    result.decisions.forEach((decision, index) => {
      const charger = inputs.chargers[index]
      if (charger) perLine[charger.line] += decision.targetCurrentA
    })
    expect(perLine.L1).toBeLessThanOrEqual(DEFAULT_LINE_LIMITS.L1)
    expect(perLine.L2).toBeLessThanOrEqual(DEFAULT_LINE_LIMITS.L2)
    expect(perLine.L1 + perLine.L2).toBeLessThanOrEqual(DEFAULT_LINE_LIMITS.total)
  })
})

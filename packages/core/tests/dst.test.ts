import { describe, expect, it } from 'vitest'
import { DEFAULT_SCHEDULER_CONFIG as config } from '../src/config.js'
import { decide } from '../src/decide.js'
import { isReachable } from '../src/reachability.js'
import { lowPriceMinutesBetween, seasonModeAt, tariffWindowAt, zonedParts } from '../src/tariff.js'
import { decisionFor, makeCharger, makeInputs } from './support/inputs.js'

/**
 * `pnpm test:dst` — full cycles across both daylight-saving transitions (T132, FR-025, SC-014,
 * quickstart V6).
 *
 * `tariff.test.ts` covers the calendar in isolation; this file runs the *decision* across the two
 * days, because the failure mode that matters is not a wrong hour — it is a car that misses its
 * deadline, or a high-price window applied for the wrong wall-clock hour, on one of two days a year
 * when nobody is watching.
 *
 * 2026-10-25: clocks go back at 03:00 local, so 02:00–03:00 happens twice and the day is 25 hours.
 * 2027-03-28: clocks go forward at 02:00 local, so 02:00–03:00 never happens and the day is 23.
 */

const LONG_DAY_START = '2026-10-25T00:00:00+02:00' // still CEST
const LONG_DAY_END = '2026-10-26T00:00:00+01:00' // CET
const SHORT_DAY_START = '2027-03-28T00:00:00+01:00' // still CET
const SHORT_DAY_END = '2027-03-29T00:00:00+02:00' // CEST

/** Walks a day in five-minute cycles and runs the real decision at each one. */
function runDay(startIso: string, endIso: string, chargerOverrides = {}) {
  const results: {
    at: string
    localHour: number
    tariff: 'low' | 'high'
    currentA: number
    reason: string
  }[] = []
  const start = Date.parse(startIso)
  const end = Date.parse(endIso)

  let deliveredKwh = 0
  for (let t = start; t < end; t += 5 * 60_000) {
    const now = new Date(t).toISOString()
    const inputs = makeInputs({
      now,
      cycleId: now,
      randomSeed: now,
      seasonMode: seasonModeAt(now, config),
      tariffWindow: tariffWindowAt(now, config),
      chargers: [
        makeCharger({
          opMode: 3,
          target: { energyKwh: 60, deadline: endIso, deliveredKwh },
          ...chargerOverrides,
        }),
      ],
    })
    const decision = decisionFor(decide(inputs), 'EH100001')
    if (decision.targetCurrentA > 0) deliveredKwh += decision.expectedKwhThisCycle

    results.push({
      at: now,
      localHour: zonedParts(t, config.timezone).hour,
      tariff: inputs.tariffWindow,
      currentA: decision.targetCurrentA,
      reason: decision.reason,
    })
  }
  return { results, deliveredKwh }
}

describe('2026-10-25 — the day with a doubled hour', () => {
  const { results, deliveredKwh } = runDay(LONG_DAY_START, LONG_DAY_END)

  it('runs 25 hours of cycles', () => {
    expect(results).toHaveLength((25 * 60) / 5)
  })

  it('applies the high-price windows to the correct wall-clock hours', () => {
    for (const cycle of results) {
      const inHighWindow =
        (cycle.localHour >= 11 && cycle.localHour < 13) ||
        (cycle.localHour >= 18 && cycle.localHour < 20)
      expect(cycle.tariff).toBe(inHighWindow ? 'high' : 'low')
    }
  })

  it('never imports during a high-price window, including in the doubled hour', () => {
    const imports = results.filter((c) => c.tariff === 'high' && c.currentA > 0)
    expect(imports).toHaveLength(0)
  })

  it('charges through the doubled 02:00 hour exactly as through any other low-price hour', () => {
    const doubled = results.filter((c) => c.localHour === 2)
    // Two hours of five-minute cycles, because the hour really does happen twice.
    expect(doubled).toHaveLength(24)
    expect(doubled.every((c) => c.tariff === 'low')).toBe(true)
  })

  it('delivers the target without double-counting the extra hour', () => {
    expect(deliveredKwh).toBeGreaterThanOrEqual(60)
    // 25 hours minus 4 high-price hours at 11.088 kW is ~233 kWh of headroom; the target is 60.
    expect(deliveredKwh).toBeLessThan(70)
  })
})

describe('2027-03-28 — the day with a missing hour', () => {
  const { results, deliveredKwh } = runDay(SHORT_DAY_START, SHORT_DAY_END)

  it('runs 23 hours of cycles', () => {
    expect(results).toHaveLength((23 * 60) / 5)
  })

  it('never lands on the local hour that does not exist', () => {
    expect(results.some((c) => c.localHour === 2)).toBe(false)
    expect(results.some((c) => c.localHour === 1)).toBe(true)
    expect(results.some((c) => c.localHour === 3)).toBe(true)
  })

  it('applies the high-price windows to the correct wall-clock hours', () => {
    for (const cycle of results) {
      const inHighWindow =
        (cycle.localHour >= 11 && cycle.localHour < 13) ||
        (cycle.localHour >= 18 && cycle.localHour < 20)
      expect(cycle.tariff).toBe(inHighWindow ? 'high' : 'low')
    }
  })

  it('still meets a deadline on the shorter day', () => {
    expect(deliveredKwh).toBeGreaterThanOrEqual(60)
  })
})

describe('reachability across a transition', () => {
  it('counts one hour fewer on the short day than the long one, for the same wall-clock window', () => {
    // Both windows are "midnight to midnight" in local time; only one of them is 24 hours long.
    const longDay = lowPriceMinutesBetween(LONG_DAY_START, LONG_DAY_END, config)
    const shortDay = lowPriceMinutesBetween(SHORT_DAY_START, SHORT_DAY_END, config)
    expect(longDay - shortDay).toBe(120)
  })

  it('does not report a target as unreachable because of a clock change', () => {
    const overTheLongNight = isReachable(
      { energyKwh: 40, deadline: '2026-10-25T08:00:00+01:00', deliveredKwh: 0 },
      '2026-10-24T22:00:00+02:00',
      config,
      { maxCurrentA: 16, phases: 3 },
    )
    expect(overTheLongNight.state).toBe('reachable')

    const overTheShortNight = isReachable(
      { energyKwh: 40, deadline: '2027-03-28T08:00:00+02:00', deliveredKwh: 0 },
      '2027-03-27T22:00:00+01:00',
      config,
      { maxCurrentA: 16, phases: 3 },
    )
    expect(overTheShortNight.state).toBe('reachable')
  })
})

describe('the winter-window boundary is evaluated in local time', () => {
  it('flips at local midnight on 1 October, not at UTC midnight', () => {
    // 30 September 23:30 local is already 21:30 UTC — a UTC comparison would call it October.
    expect(seasonModeAt('2026-09-30T23:30:00+02:00', config)).toBe('solar')
    expect(seasonModeAt('2026-10-01T00:30:00+02:00', config)).toBe('winter')
  })

  it('flips back at local midnight on 1 March', () => {
    expect(seasonModeAt('2027-02-28T23:30:00+01:00', config)).toBe('winter')
    expect(seasonModeAt('2027-03-01T00:30:00+01:00', config)).toBe('solar')
  })
})

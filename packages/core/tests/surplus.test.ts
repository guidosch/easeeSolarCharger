import { describe, expect, it } from 'vitest'
import { DEFAULT_SCHEDULER_CONFIG as config } from '../src/config.js'
import {
  classifyQuality,
  ewma,
  mayStart,
  mustStop,
  nextHysteresis,
  surplusRawKw,
  withinDeadband,
} from '../src/surplus.js'

/** T072 — the anti-oscillation machinery (research R2, FR-015 to FR-017). */

describe('surplusRawKw — own charging is added back (FR-015)', () => {
  it('measures available surplus, not unused surplus', () => {
    // Exporting 2 kW while our own cars draw 8 kW means 10 kW of PV is available to us.
    expect(surplusRawKw(2, 8)).toBe(10)
  })

  it('goes negative when the house draws more than the array produces', () => {
    expect(surplusRawKw(-3, 0)).toBe(-3)
  })

  it('is what stops the optimizer chasing its own tail', () => {
    // Without the add-back, ramping from 0 to 8 kW would take the signal from 10 to 2 and ramp
    // straight back down again.
    const beforeRamp = surplusRawKw(10, 0)
    const afterRamp = surplusRawKw(2, 8)
    expect(afterRamp).toBe(beforeRamp)
  })
})

describe('ewma at α = 0.4', () => {
  it('starts at the first reading rather than at zero', () => {
    expect(ewma(null, 7.5, config.ewmaAlpha)).toBe(7.5)
  })

  it('moves 40% of the way to each new reading', () => {
    expect(ewma(10, 5, config.ewmaAlpha)).toBe(8)
    expect(ewma(8, 5, config.ewmaAlpha)).toBe(6.8)
  })

  it('leaves less than a third of a one-cycle spike behind', () => {
    const baseline = 4
    const spike = 14
    let smoothed = ewma(null, baseline, config.ewmaAlpha)
    smoothed = ewma(smoothed, spike, config.ewmaAlpha) // a heat pump starting, say
    smoothed = ewma(smoothed, baseline, config.ewmaAlpha)

    const residual = smoothed - baseline
    expect(residual).toBeLessThan((spike - baseline) / 3)
    expect(residual).toBeGreaterThan(0) // damped, not erased — a real ramp must still get through
  })

  it('converges on a sustained change within about three cycles', () => {
    let smoothed = 0
    for (let i = 0; i < 3; i += 1) smoothed = ewma(smoothed, 10, config.ewmaAlpha)
    expect(smoothed).toBeGreaterThan(7)
  })
})

describe('classifyQuality — fresh → stale → unusable at the 15-minute cutoff (FR-016)', () => {
  it.each([
    [0, 'fresh'],
    [5, 'fresh'],
    [6, 'stale'],
    [15, 'stale'],
    [16, 'unusable'],
    [120, 'unusable'],
  ])('at %i minutes old it is %s', (ageMinutes, expected) => {
    expect(classifyQuality(ageMinutes, config)).toBe(expected)
  })

  it('treats no reading at all as unusable, never as fresh zero', () => {
    expect(classifyQuality(null, config)).toBe('unusable')
  })
})

describe('withinDeadband — ±1 A', () => {
  it('holds the setpoint for a sub-amp move', () => {
    expect(withinDeadband(12, 12.4, config)).toBe(true)
    expect(withinDeadband(12, 11.5, config)).toBe(true)
  })

  it('rewrites at a full amp', () => {
    expect(withinDeadband(12, 13, config)).toBe(false)
    expect(withinDeadband(12, 11, config)).toBe(false)
  })

  it('always rewrites a stop', () => {
    expect(withinDeadband(6, 0, config)).toBe(false)
  })
})

describe('start/stop hysteresis — two cycles each way', () => {
  const zero = { consecutiveAboveFloor: 0, consecutiveBelowFloor: 0 }

  it('needs two consecutive cycles above the floor before starting', () => {
    expect(mayStart(zero, config)).toBe(false)

    const afterOne = nextHysteresis(zero, true)
    expect(afterOne.consecutiveAboveFloor).toBe(1)
    expect(mayStart(afterOne, config)).toBe(true)
  })

  it('needs two consecutive cycles below the floor before stopping', () => {
    expect(mustStop(zero, config)).toBe(false)

    const afterOne = nextHysteresis(zero, false)
    expect(afterOne.consecutiveBelowFloor).toBe(1)
    expect(mustStop(afterOne, config)).toBe(true)
  })

  it('resets the opposite counter, so a single good cycle does not accumulate towards a stop', () => {
    let counters = nextHysteresis(zero, false)
    counters = nextHysteresis(counters, true)
    expect(counters.consecutiveBelowFloor).toBe(0)
    expect(counters.consecutiveAboveFloor).toBe(1)
  })

  it('does not stop a session for a single cloudy cycle', () => {
    // The passing-cloud case: one cycle below the floor, then back above.
    let counters = { consecutiveAboveFloor: 5, consecutiveBelowFloor: 0 }
    counters = nextHysteresis(counters, false)
    expect(mustStop({ ...counters, consecutiveBelowFloor: 0 }, config)).toBe(false)
  })
})

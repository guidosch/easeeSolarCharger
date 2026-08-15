import { describe, expect, it } from 'vitest'
import { DEFAULT_SCHEDULER_CONFIG as config } from '../src/config.js'
import {
  earliestFeasibleDeadline,
  isDaylight,
  lowPriceMinutesBetween,
  seasonModeAt,
  tariffWindowAt,
  zonedParts,
} from '../src/tariff.js'

const ZURICH = config.timezone

describe('tariffWindowAt — high-price window boundaries (FR-018)', () => {
  it('treats 11:00 as high and 13:00 as low', () => {
    expect(tariffWindowAt('2026-01-15T10:59:59+01:00', config)).toBe('low')
    expect(tariffWindowAt('2026-01-15T11:00:00+01:00', config)).toBe('high')
    expect(tariffWindowAt('2026-01-15T12:59:59+01:00', config)).toBe('high')
    expect(tariffWindowAt('2026-01-15T13:00:00+01:00', config)).toBe('low')
  })

  it('treats 18:00 as high and 20:00 as low', () => {
    expect(tariffWindowAt('2026-01-15T17:59:59+01:00', config)).toBe('low')
    expect(tariffWindowAt('2026-01-15T18:00:00+01:00', config)).toBe('high')
    expect(tariffWindowAt('2026-01-15T19:59:59+01:00', config)).toBe('high')
    expect(tariffWindowAt('2026-01-15T20:00:00+01:00', config)).toBe('low')
  })

  it('applies the windows to local wall-clock time, not UTC', () => {
    // Summer: 11:00 Europe/Zurich is 09:00Z. Reading these windows in UTC would put the whole
    // high-price block two hours early and import at peak tariff every day of the summer.
    expect(tariffWindowAt('2026-06-10T09:00:00Z', config)).toBe('high')
    expect(tariffWindowAt('2026-06-10T11:00:00Z', config)).toBe('low')
  })
})

describe('seasonModeAt — winter window boundaries (FR-023)', () => {
  it('starts on 1 October', () => {
    expect(seasonModeAt('2026-09-30T23:59:00+02:00', config)).toBe('solar')
    expect(seasonModeAt('2026-10-01T00:00:00+02:00', config)).toBe('winter')
  })

  it('ends after February, including in a leap year', () => {
    expect(seasonModeAt('2027-02-28T12:00:00+01:00', config)).toBe('winter')
    expect(seasonModeAt('2028-02-29T12:00:00+01:00', config)).toBe('winter')
    expect(seasonModeAt('2027-03-01T00:00:00+01:00', config)).toBe('solar')
  })
})

describe('DST transitions (FR-025, SC-014)', () => {
  it('2026-10-25: the local hour 02 happens twice', () => {
    // 00:30Z is 02:30 CEST; 01:30Z is 02:30 CET. Same wall clock, different instants.
    const first = zonedParts(Date.parse('2026-10-25T00:30:00Z'), ZURICH)
    const second = zonedParts(Date.parse('2026-10-25T01:30:00Z'), ZURICH)
    expect(first.hour).toBe(2)
    expect(second.hour).toBe(2)
    expect(first.day).toBe(25)
    expect(second.day).toBe(25)
  })

  it('2027-03-28: the local hour 02 never happens', () => {
    const start = Date.parse('2027-03-28T00:00:00+01:00')
    const hours = new Set<number>()
    for (let t = start; t < start + 23 * 3_600_000; t += 5 * 60_000) {
      hours.add(zonedParts(t, ZURICH).hour)
    }
    expect(hours.has(1)).toBe(true)
    expect(hours.has(3)).toBe(true)
    expect(hours.has(2)).toBe(false)
  })

  it('counts the doubled hour once per real hour on the long day', () => {
    // 2026-10-25 is 25 hours long; four of them are high-price, so 21 h = 1260 min are low-price.
    const minutes = lowPriceMinutesBetween(
      '2026-10-25T00:00:00+02:00',
      '2026-10-26T00:00:00+01:00',
      config,
    )
    expect(minutes).toBe(1260)
  })

  it('does not invent the missing hour on the short day', () => {
    // 2027-03-28 is 23 hours long: 19 h = 1140 min are low-price.
    const minutes = lowPriceMinutesBetween(
      '2027-03-28T00:00:00+01:00',
      '2027-03-29T00:00:00+02:00',
      config,
    )
    expect(minutes).toBe(1140)
  })
})

describe('lowPriceMinutesBetween', () => {
  it('is zero for a window entirely inside a high-price block', () => {
    expect(
      lowPriceMinutesBetween('2026-01-15T11:05:00+01:00', '2026-01-15T12:55:00+01:00', config),
    ).toBe(0)
  })

  it('counts only the low-price part of a straddling window', () => {
    // 12:00 → 14:00 local: the first hour is high-price, the second is not.
    expect(
      lowPriceMinutesBetween('2026-01-15T12:00:00+01:00', '2026-01-15T14:00:00+01:00', config),
    ).toBe(60)
  })

  it('is zero when the deadline is in the past', () => {
    expect(
      lowPriceMinutesBetween('2026-01-15T14:00:00+01:00', '2026-01-15T12:00:00+01:00', config),
    ).toBe(0)
  })
})

describe('earliestFeasibleDeadline (FR-007)', () => {
  it('is one cycle of latency plus one low-price cycle when the price is already low', () => {
    expect(earliestFeasibleDeadline('2026-01-15T22:00:00+01:00', config)).toBe(
      new Date(Date.parse('2026-01-15T22:10:00+01:00')).toISOString(),
    )
  })

  it('skips past a high-price window rather than proposing a deadline inside it', () => {
    const proposed = earliestFeasibleDeadline('2026-01-15T11:30:00+01:00', config)
    expect(tariffWindowAt(proposed, config)).toBe('low')
    expect(Date.parse(proposed)).toBeGreaterThan(Date.parse('2026-01-15T13:00:00+01:00'))
  })
})

describe('isDaylight — the SolarEdge gate (FR-045, research R3)', () => {
  const lat = 47.3769
  const lon = 8.5417

  it('is true at midday and false at night in midsummer', () => {
    expect(isDaylight('2026-06-21T12:00:00+02:00', lat, lon)).toBe(true)
    expect(isDaylight('2026-06-21T02:00:00+02:00', lat, lon)).toBe(false)
  })

  it('is true at midday and false in the early evening in midwinter', () => {
    expect(isDaylight('2026-12-21T12:00:00+01:00', lat, lon)).toBe(true)
    expect(isDaylight('2026-12-21T18:00:00+01:00', lat, lon)).toBe(false)
    expect(isDaylight('2026-12-21T07:00:00+01:00', lat, lon)).toBe(false)
  })

  it('keeps the worst-case daily call count inside the SolarEdge budget', () => {
    // R3's 192 calls/day rests on the longest day being under 16 hours of daylight.
    const start = Date.parse('2026-06-21T00:00:00Z')
    let cycles = 0
    for (let t = start; t < start + 24 * 3_600_000; t += 5 * 60_000) {
      if (isDaylight(new Date(t).toISOString(), lat, lon)) cycles += 1
    }
    expect(cycles).toBeLessThanOrEqual(192)
  })
})

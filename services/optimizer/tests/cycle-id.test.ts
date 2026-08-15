import { describe, expect, it } from 'vitest'
import { cycleIdFor } from '../src/index.js'

/**
 * The scheduled instant, derived (FR-050).
 *
 * Cloud Scheduler cannot template the instant into the request body, so the optimizer floors the
 * clock to the cadence. Every delivery of the same scheduled run — including a retry, and including
 * two instances that started seconds apart — must land on the same key, or "at-least-once delivery
 * changes nothing" quietly stops being true.
 */
describe('cycleIdFor', () => {
  it('uses an explicit cycleId when one is given', () => {
    expect(cycleIdFor('2026-06-15T10:30:00Z', Date.parse('2026-06-15T10:31:12Z'))).toBe(
      '2026-06-15T10:30:00Z',
    )
  })

  it('floors the clock to the five-minute cadence', () => {
    expect(cycleIdFor(undefined, Date.parse('2026-06-15T10:32:47.812Z'))).toBe(
      '2026-06-15T10:30:00.000Z',
    )
  })

  it('gives the same key for every moment within one scheduled cycle', () => {
    const keys = new Set(
      ['10:30:00.000Z', '10:31:00.000Z', '10:34:59.999Z'].map((t) =>
        cycleIdFor(undefined, Date.parse(`2026-06-15T${t}`)),
      ),
    )
    expect(keys.size).toBe(1)
  })

  it('treats the scheduler placeholder as "derive it"', () => {
    expect(cycleIdFor('__SCHEDULED_INSTANT__', Date.parse('2026-06-15T10:32:00Z'))).toBe(
      '2026-06-15T10:30:00.000Z',
    )
  })
})

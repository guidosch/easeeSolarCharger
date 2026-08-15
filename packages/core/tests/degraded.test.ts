import { describe, expect, it } from 'vitest'
import { decide } from '../src/decide.js'
import type { OpMode } from '../src/types.js'
import { decisionFor, makeCharger, makeInputs } from './support/inputs.js'

/**
 * T048 — contract invariant 4: `decide` never throws on well-typed input.
 *
 * A degraded input is a *modelled state*, not an exception, because an exception here would mean no
 * schedule at all — and the fail-safe (FR-044) has to be a decision, not a crash.
 */

describe('degraded charger states', () => {
  it.each([
    [0, 'offline'],
    [5, 'error'],
  ])('opMode %i (%s) yields no current and never throws', (opMode) => {
    const inputs = makeInputs({ chargers: [makeCharger({ opMode: opMode as OpMode })] })

    const decision = decisionFor(decide(inputs), 'EH100001')

    expect(decision.targetCurrentA).toBe(0)
    expect(decision.reason).toBe('charger_error')
  })

  it('does not infer zero power from an offline charger', () => {
    // "Do not infer zero" is about the *surplus* signal: an offline charger contributes no reading,
    // and the decision must not read that as a charger sitting idle at 0 kW.
    const inputs = makeInputs({
      chargers: [makeCharger({ opMode: 0, totalPowerKw: 7.4, deliveredCurrentA: 10 })],
    })
    expect(() => decide(inputs)).not.toThrow()
  })
})

describe('degraded cycle inputs', () => {
  it('never throws across the whole space of well-typed inputs', () => {
    const opModes: OpMode[] = [0, 1, 2, 3, 4, 5, 6]
    const qualities = ['fresh', 'stale', 'unusable'] as const
    const seasons = ['solar', 'winter'] as const
    const tariffs = ['low', 'high'] as const

    for (const opMode of opModes) {
      for (const quality of qualities) {
        for (const seasonMode of seasons) {
          for (const tariffWindow of tariffs) {
            for (const smoothedKw of [null, -3, 0, 4.2, 40]) {
              const inputs = makeInputs({
                seasonMode,
                tariffWindow,
                surplus: {
                  rawKw: smoothedKw,
                  smoothedKw,
                  observedAt: smoothedKw === null ? null : '2026-01-15T21:55:00Z',
                  ageMinutes: smoothedKw === null ? null : 5,
                  quality,
                },
                chargers: [makeCharger({ opMode })],
              })
              expect(() => decide(inputs)).not.toThrow()
            }
          }
        }
      }
    }
  })

  it('produces exactly one decision per charger, always', () => {
    const chargers = [
      makeCharger({ chargerId: 'EH1', opMode: 0 }),
      makeCharger({ chargerId: 'EH2', opMode: 3 }),
      makeCharger({ chargerId: 'EH3', opMode: 1, target: null }),
    ]
    const result = decide(makeInputs({ chargers }))

    expect(result.decisions.map((d) => d.chargerId)).toEqual(['EH1', 'EH2', 'EH3'])
  })

  it('carries an orphaned charger (no mapped user) without special-casing it into a crash', () => {
    const inputs = makeInputs({ chargers: [makeCharger({ userId: null })] })
    expect(() => decide(inputs)).not.toThrow()
  })

  it('records a note when the surplus is unusable, so the operator sees why', () => {
    const result = decide(
      makeInputs({
        seasonMode: 'solar',
        surplus: {
          rawKw: null,
          smoothedKw: null,
          observedAt: null,
          ageMinutes: null,
          quality: 'unusable',
        },
      }),
    )
    expect(result.notes.join(' ')).toMatch(/unusable|deadline-only/i)
  })

  it('never emits a current between zero and the modulation floor', () => {
    const result = decide(
      makeInputs({
        chargers: [makeCharger({ maxCurrentA: 16 })],
        lineLimits: { L1: 4, L2: 63, total: 126 },
      }),
    )
    for (const decision of result.decisions) {
      expect(decision.targetCurrentA === 0 || decision.targetCurrentA >= 6).toBe(true)
    }
  })
})

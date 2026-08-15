import { describe, expect, it } from 'vitest'
import { decide } from '../src/decide.js'
import { decisionFor, makeCharger, makeInputs } from './support/inputs.js'

/**
 * T096 — ladder rule 2, the "charge now" override (FR-032).
 *
 * The override beats everything below it, including the high-price rule — that is the whole point,
 * and it is the one place the constitution permits importing at peak tariff. What it does *not*
 * beat is rule 1: it can never raise a limit the external load management set.
 */

const HIGH_PRICE_NOON = '2026-06-10T12:15:00+02:00'

describe('the override beats the rules below it', () => {
  it('charges at maximum inside a high-price window with no surplus', () => {
    const inputs = makeInputs({
      now: HIGH_PRICE_NOON,
      seasonMode: 'solar',
      tariffWindow: 'high',
      daylight: true,
      surplus: {
        rawKw: -2,
        smoothedKw: -2,
        observedAt: '2026-06-10T10:12:00Z',
        ageMinutes: 3,
        quality: 'fresh',
      },
      chargers: [makeCharger({ overrideActive: true })],
    })

    const decision = decisionFor(decide(inputs), 'EH100001')

    expect(decision.targetCurrentA).toBe(16)
    expect(decision.reason).toBe('override')
    expect(decision.ladderRule).toBe(2)
    expect(decision.attribution).toBe('grid')
  })

  it('charges even with no target set at all', () => {
    const decision = decisionFor(
      decide(
        makeInputs({
          now: HIGH_PRICE_NOON,
          tariffWindow: 'high',
          chargers: [makeCharger({ overrideActive: true, target: null })],
        }),
      ),
      'EH100001',
    )
    // "Charge now" means now, whether or not a deadline was ever declared.
    expect(decision.reason).toBe('override')
    expect(decision.targetCurrentA).toBe(16)
  })

  it('beats a deferral and a waiting-for-surplus state', () => {
    const decision = decisionFor(
      decide(
        makeInputs({
          now: '2026-06-10T14:00:00+02:00',
          seasonMode: 'solar',
          tariffWindow: 'low',
          surplus: {
            rawKw: 1,
            smoothedKw: 1,
            observedAt: '2026-06-10T11:57:00Z',
            ageMinutes: 3,
            quality: 'fresh',
          },
          forecast: {
            cloudCoverRestOfTodayPct: 90,
            cloudCoverTomorrowPct: 10,
            deferRecommended: true,
            fetchedAt: '2026-06-10T06:00:00Z',
          },
          chargers: [
            makeCharger({
              overrideActive: true,
              target: { energyKwh: 20, deadline: '2026-06-13T18:00:00+02:00', deliveredKwh: 0 },
            }),
          ],
        }),
      ),
      'EH100001',
    )
    expect(decision.reason).toBe('override')
  })
})

describe('the override does not beat rule 1', () => {
  it('never asks for more than the charger’s own maximum', () => {
    const decision = decisionFor(
      decide(
        makeInputs({
          tariffWindow: 'high',
          chargers: [makeCharger({ overrideActive: true, maxCurrentA: 10 })],
        }),
      ),
      'EH100001',
    )
    expect(decision.targetCurrentA).toBe(10)
  })

  it('is trimmed by the per-line headroom like any other decision', () => {
    const result = decide(
      makeInputs({
        tariffWindow: 'high',
        lineLimits: { L1: 20, L2: 63, total: 126 },
        chargers: [
          makeCharger({ chargerId: 'EH1', lotNumber: 'A01', userId: 'U1', overrideActive: true }),
          makeCharger({ chargerId: 'EH2', lotNumber: 'A02', userId: 'U2', overrideActive: true }),
        ],
      }),
    )

    const total = result.decisions.reduce((sum, d) => sum + d.targetCurrentA, 0)
    expect(total).toBeLessThanOrEqual(20)
    // The second charger cannot be given a modulatable share, so it waits rather than being told
    // to draw 4 A it cannot deliver.
    expect(result.decisions.map((d) => d.targetCurrentA).sort()).toEqual([0, 16])
  })
})

describe('the override does not apply where charging is impossible', () => {
  it.each([
    [1, 'not_plugged_in'],
    [5, 'charger_error'],
    [0, 'charger_error'],
  ])('opMode %i still reports %s', (opMode, reason) => {
    const decision = decisionFor(
      decide(
        makeInputs({
          chargers: [makeCharger({ overrideActive: true, opMode: opMode as 0 | 1 | 5 })],
        }),
      ),
      'EH100001',
    )
    expect(decision.reason).toBe(reason)
    expect(decision.targetCurrentA).toBe(0)
  })

  it('stops once the target has been delivered', () => {
    const decision = decisionFor(
      decide(
        makeInputs({
          chargers: [
            makeCharger({
              overrideActive: true,
              target: { energyKwh: 20, deadline: '2026-01-16T07:00:00+01:00', deliveredKwh: 20 },
            }),
          ],
        }),
      ),
      'EH100001',
    )
    expect(decision.reason).toBe('target_met')
    expect(decision.targetCurrentA).toBe(0)
  })
})

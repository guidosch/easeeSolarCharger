import { describe, expect, it } from 'vitest'
import { decide } from '../src/decide.js'
import { decisionFor, makeCharger, makeInputs } from './support/inputs.js'

/**
 * T046 — the Principle I precedence ladder.
 *
 * The high-price-versus-deadline conflict is the one the constitution singles out, because v1.0.0
 * resolved it the other way: a deadline does **not** license importing at peak tariff.
 */

describe('ladder rule 3 — no grid import during a high-price window (FR-018)', () => {
  it('refuses to charge from the grid even when the deadline is close', () => {
    const inputs = makeInputs({
      now: '2026-01-15T12:00:00+01:00',
      tariffWindow: 'high',
      chargers: [
        makeCharger({
          // Two hours to deliver 20 kWh: unreachable, and still not a licence to import.
          target: { energyKwh: 20, deadline: '2026-01-15T14:00:00+01:00', deliveredKwh: 0 },
        }),
      ],
    })

    const decision = decisionFor(decide(inputs), 'EH100001')

    expect(decision.targetCurrentA).toBe(0)
    expect(decision.reason).toBe('high_price_blocked')
    expect(decision.ladderRule).toBe(3)
    expect(decision.attribution).toBe('none')
  })

  it('applies to both high-price windows', () => {
    for (const now of ['2026-01-15T11:30:00+01:00', '2026-01-15T19:00:00+01:00']) {
      const decision = decisionFor(decide(makeInputs({ now, tariffWindow: 'high' })), 'EH100001')
      expect(decision.reason).toBe('high_price_blocked')
      expect(decision.ladderRule).toBe(3)
    }
  })
})

describe('ladder rule 4 — the deadline fallback at low price (FR-021)', () => {
  it('charges from the grid for an at-risk target in a low-price window', () => {
    const inputs = makeInputs({
      now: '2026-01-15T05:00:00+01:00',
      tariffWindow: 'low',
      seasonMode: 'solar',
      chargers: [
        makeCharger({
          // 20 kWh needs ~1.8 h at 16 A three-phase; two hours left is inside the risk margin.
          target: { energyKwh: 20, deadline: '2026-01-15T07:00:00+01:00', deliveredKwh: 0 },
        }),
      ],
    })

    const decision = decisionFor(decide(inputs), 'EH100001')

    expect(decision.reason).toBe('deadline_fallback')
    expect(decision.ladderRule).toBe(4)
    expect(decision.targetCurrentA).toBe(16)
    expect(decision.attribution).toBe('grid')
    expect(decision.reachability.state).not.toBe('reachable')
  })

  it('does not import in summer while the target is still comfortably reachable', () => {
    // Waiting has an upside in solar mode: the surplus may yet arrive (FR-020).
    const inputs = makeInputs({
      now: '2026-06-15T22:00:00+02:00',
      seasonMode: 'solar',
      tariffWindow: 'low',
      chargers: [
        makeCharger({
          target: { energyKwh: 5, deadline: '2026-06-17T18:00:00+02:00', deliveredKwh: 0 },
        }),
      ],
    })

    const decision = decisionFor(decide(inputs), 'EH100001')

    expect(decision.targetCurrentA).toBe(0)
    expect(decision.reason).toBe('awaiting_surplus')
    expect(decision.reachability.state).toBe('reachable')
  })

  it('charges on any low-price cycle in the winter window, where waiting has no upside', () => {
    // FR-023: between 1 October and the end of February scheduling is purely deadline-driven.
    // This is quickstart V1 at 22:00 on a January night.
    const decision = decisionFor(decide(makeInputs({ seasonMode: 'winter' })), 'EH100001')

    expect(decision.reason).toBe('deadline_fallback')
    expect(decision.ladderRule).toBe(4)
    expect(decision.targetCurrentA).toBe(16)
    expect(decision.attribution).toBe('grid')
  })
})

describe('ladder rule 1 — the advisory per-line headroom', () => {
  it('caps this system’s own commanded sum at the line rating', () => {
    const chargers = Array.from({ length: 6 }, (_, i) =>
      makeCharger({
        chargerId: `EH10000${i + 1}`,
        lotNumber: `A0${i + 1}`,
        userId: `U100${i + 1}`,
        line: 'L1',
      }),
    )
    const inputs = makeInputs({ chargers, lineLimits: { L1: 63, L2: 63, total: 126 } })

    const result = decide(inputs)
    const commandedOnL1 = result.decisions.reduce((sum, d) => sum + d.targetCurrentA, 0)

    expect(commandedOnL1).toBeLessThanOrEqual(63)
    // Six chargers wanting 16 A each is 96 A; three fit fully, the fourth is trimmed to the floor.
    expect(result.decisions.filter((d) => d.targetCurrentA > 0).length).toBeGreaterThan(0)
    const trimmed = result.decisions.find((d) => d.ladderRule === 1)
    expect(trimmed).toBeDefined()
  })

  it('never raises a charger above its own maximum', () => {
    const inputs = makeInputs({
      chargers: [makeCharger({ maxCurrentA: 10 })],
      lineLimits: { L1: 63, L2: 63, total: 126 },
    })
    expect(decisionFor(decide(inputs), 'EH100001').targetCurrentA).toBe(10)
  })

  it('leaves a charger off rather than commanding below the modulation floor', () => {
    const chargers = [
      makeCharger({ chargerId: 'EH1', lotNumber: 'A01', userId: 'U1' }),
      makeCharger({ chargerId: 'EH2', lotNumber: 'A02', userId: 'U2' }),
    ]
    const inputs = makeInputs({ chargers, lineLimits: { L1: 20, L2: 63, total: 126 } })

    const result = decide(inputs)

    // 20 A of headroom serves one charger at 16 A; the 4 A left is below the 6 A floor.
    expect(result.decisions.map((d) => d.targetCurrentA).sort()).toEqual([0, 16])
    const off = result.decisions.find((d) => d.targetCurrentA === 0)
    expect(off?.reason).toBe('below_modulation_floor')
    expect(off?.ladderRule).toBe(1)
  })
})

describe('non-charging states', () => {
  it.each([
    ['no target', { target: null }, 'no_target'],
    ['unplugged', { opMode: 1 as const }, 'not_plugged_in'],
    ['charger error', { opMode: 5 as const }, 'charger_error'],
    ['offline', { opMode: 0 as const }, 'charger_error'],
    [
      'target already met',
      { target: { energyKwh: 20, deadline: '2026-01-16T07:00:00+01:00', deliveredKwh: 20 } },
      'target_met',
    ],
  ])('%s yields no current and the matching reason', (_label, overrides, reason) => {
    const decision = decisionFor(
      decide(makeInputs({ chargers: [makeCharger(overrides)] })),
      'EH100001',
    )
    expect(decision.targetCurrentA).toBe(0)
    expect(decision.reason).toBe(reason)
    expect(decision.ladderRule).toBeNull()
  })
})

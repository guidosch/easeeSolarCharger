import { DEFAULT_LINE_LIMITS, DEFAULT_SCHEDULER_CONFIG } from '../../src/config.js'
import type { ChargerInput, CycleInputs } from '../../src/types.js'

/** Builders, so each test states only the fact it is about. */

export const NOW = '2026-01-15T22:00:00+01:00'

export function makeCharger(overrides: Partial<ChargerInput> = {}): ChargerInput {
  return {
    chargerId: 'EH100001',
    lotNumber: 'A01',
    userId: 'U1001',
    line: 'L1',
    phases: 3,
    maxCurrentA: 16,
    opMode: 3,
    deliveredCurrentA: 0,
    dynamicChargerCurrentA: 0,
    commandedCurrentA: 0,
    totalPowerKw: 0,
    sessionEnergyKwh: 0,
    observedAt: NOW,
    overrideActive: false,
    consecutiveAboveFloor: 0,
    consecutiveBelowFloor: 0,
    target: { energyKwh: 20, deadline: '2026-01-16T07:00:00+01:00', deliveredKwh: 0 },
    ...overrides,
  }
}

export function makeInputs(overrides: Partial<CycleInputs> = {}): CycleInputs {
  return {
    cycleId: '2026-01-15T21:00:00Z',
    now: NOW,
    schedulerVersion: 'test-1',
    randomSeed: '2026-01-15T21:00:00Z',
    surplus: {
      rawKw: null,
      smoothedKw: null,
      observedAt: null,
      ageMinutes: null,
      quality: 'unusable',
    },
    gridExportKw: null,
    ownChargingKw: 0,
    daylight: false,
    seasonMode: 'winter',
    tariffWindow: 'low',
    forecast: null,
    chargers: [makeCharger()],
    fairness: {},
    lineLimits: { ...DEFAULT_LINE_LIMITS },
    config: DEFAULT_SCHEDULER_CONFIG,
    ...overrides,
  }
}

export function decisionFor<T extends { chargerId: string }>(
  result: { decisions: T[] },
  chargerId: string,
): T {
  const found = result.decisions.find((d) => d.chargerId === chargerId)
  if (!found) throw new Error(`no decision recorded for ${chargerId}`)
  return found
}

import { ChargersRepo, ParkingLotsRepo, emptyChargerDoc } from '@app/adapters'
import type { ChargerDoc, ChargerObservation, ParkingLotDoc, Result } from '@app/adapters'
import { createLogger } from '@app/shared'
import { testDb } from '../../../../tests/support/emulator.js'
import type { CycleDeps, SitePower } from '../../src/ports.js'

/** Builds `CycleDeps` against the emulator, with the providers driven from a plain object. */
export type FakeWorld = {
  observations: Map<string, ChargerObservation>
  written: { chargerId: string; amps: number }[]
  surplus?: SitePower
}

export const LOT: ParkingLotDoc = {
  lotNumber: 'A01',
  chargerId: 'EH100001',
  serialNumber: 'SN500001',
  easeeUserId: 'U1001',
  line: 'L1',
  phases: 3,
  maxCurrentA: 16,
}

export function observation(overrides: Partial<ChargerObservation> = {}): ChargerObservation {
  return {
    opMode: 3,
    deliveredCurrentA: 16,
    dynamicCurrentA: 16,
    totalPowerKw: 11.09,
    sessionEnergyKwh: 10,
    lifetimeEnergyKwh: 1000,
    reasonForNoCurrent: 0,
    cableLocked: true,
    observedAt: '2026-06-10T11:30:00Z',
    ...overrides,
  }
}

export function buildTestCycleDeps(world: FakeWorld, nowMs: number): CycleDeps {
  const db = testDb()
  return {
    db,
    logger: createLogger({ component: 'optimizer', correlationId: 'test', sink: () => {} }),
    now: () => nowMs,
    sleep: async () => {},
    schedulerVersion: 'test-1',
    site: { latitude: 47.3769, longitude: 8.5417 },
    chargers: {
      read: async (serialNumber: string): Promise<Result<ChargerObservation>> => {
        const found = world.observations.get(serialNumber)
        if (!found) {
          return {
            ok: false,
            error: {
              kind: 'network',
              provider: 'easee',
              message: `no fixture for ${serialNumber}`,
            },
          }
        }
        return { ok: true, value: found }
      },
    },
    setpoints: {
      write: async (chargerId: string, amps: number) => {
        world.written.push({ chargerId, amps })
        return { ok: true as const, value: { dynamicChargerCurrent: amps } }
      },
      msUntilNextWrite: () => 0,
    },
    surplus: {
      read: async (): Promise<Result<SitePower>> =>
        world.surplus
          ? { ok: true, value: world.surplus }
          : {
              ok: false,
              error: {
                kind: 'gated',
                provider: 'solaredge',
                message: 'no surplus in this fixture',
              },
            },
    },
    forecast: {
      read: async () => ({
        ok: false as const,
        error: { kind: 'gated' as const, provider: 'openweather' as const, message: 'not used' },
      }),
    },
    stats: {
      easee: { calls: 0, errors: 0, rateLimited: 0, budgetRemaining: 100 },
      solaredge: { calls: 0, errors: 0, rateLimited: 0, budgetRemaining: 300 },
      openweather: { calls: 0, errors: 0, rateLimited: 0, budgetRemaining: 4 },
    },
    instanceId: 'test-instance',
  }
}

export async function seedCharger(
  deps: CycleDeps,
  lot: ParkingLotDoc,
  overrides: Partial<ChargerDoc> = {},
): Promise<void> {
  await new ParkingLotsRepo(deps.db).upsert(lot)
  await new ChargersRepo(deps.db).upsert({
    ...emptyChargerDoc({
      chargerId: lot.chargerId,
      lotNumber: lot.lotNumber,
      line: lot.line,
      phases: lot.phases,
      maxCurrentA: lot.maxCurrentA,
    }),
    ...overrides,
  })
}

import { ParkingLotsRepo, emptyChargerDoc, ChargersRepo } from '@app/adapters'
import type { ChargerDoc, ParkingLotDoc } from '@app/adapters'
import { createLogger, loadEnv } from '@app/shared'
import { buildApiDeps } from '../../src/context.js'
import type { ApiDeps } from '../../src/context.js'
import { createApiApp } from '../../src/index.js'
import { EaseeTokenVerifier } from '../../src/middleware/easeeAuth.js'
import { TEST_AUDIENCE, TEST_ISSUER, testJwks } from '../../../../tests/support/tokens.js'
import { testDb } from '../../../../tests/support/emulator.js'

/** Builds the real app against the emulator, with a verifier primed from a test JWKS. */
export function buildTestApi(nowMs = Date.now()): {
  app: ReturnType<typeof createApiApp>
  deps: ApiDeps
} {
  const db = testDb()
  const verifier = new EaseeTokenVerifier({
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
    jwksUrl: 'https://example.invalid/never-fetched',
    now: () => nowMs,
    fetchImpl: (async () => {
      throw new Error('a test must never reach the network')
    }) as typeof globalThis.fetch,
  })
  verifier.primeFromJwks(testJwks(), 60 * 60_000)

  const deps = buildApiDeps({
    env: loadEnv({
      GOOGLE_CLOUD_PROJECT: 'easee-solar-charger',
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 's3cret',
    }),
    db,
    now: () => nowMs,
    verifier,
    logger: createLogger({ component: 'api', correlationId: 'test', sink: () => {} }),
  })

  return { app: createApiApp(deps), deps }
}

export const LOT_A01: ParkingLotDoc = {
  lotNumber: 'A01',
  chargerId: 'EH100001',
  serialNumber: 'SN500001',
  easeeUserId: 'U1001',
  line: 'L1',
  phases: 3,
  maxCurrentA: 16,
}

export const LOT_B01: ParkingLotDoc = {
  lotNumber: 'B01',
  chargerId: 'EH100016',
  serialNumber: 'SN500016',
  easeeUserId: 'U1001',
  line: 'L2',
  phases: 3,
  maxCurrentA: 16,
}

export const LOT_A02: ParkingLotDoc = {
  lotNumber: 'A02',
  chargerId: 'EH100002',
  serialNumber: 'SN500002',
  easeeUserId: 'U1002',
  line: 'L1',
  phases: 3,
  maxCurrentA: 16,
}

export async function seedLots(deps: ApiDeps, lots: ParkingLotDoc[]): Promise<void> {
  const parkingLots = new ParkingLotsRepo(deps.db)
  const chargers = new ChargersRepo(deps.db)
  for (const lot of lots) {
    await parkingLots.upsert(lot)
    await chargers.upsert(
      emptyChargerDoc({
        chargerId: lot.chargerId,
        lotNumber: lot.lotNumber,
        line: lot.line,
        phases: lot.phases,
        maxCurrentA: lot.maxCurrentA,
      }),
    )
  }
}

export async function patchCharger(
  deps: ApiDeps,
  chargerId: string,
  fields: Partial<ChargerDoc>,
): Promise<void> {
  await new ChargersRepo(deps.db).patch(chargerId, fields)
}

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ParkingLotsRepo, emptyChargerDoc, getDb, ChargersRepo } from '@app/adapters'
import type { ParkingLotDoc } from '@app/adapters'
import { loadEnv } from '@app/shared'

/**
 * `pnpm seed:lots` — loads the operator's parking-lot ↔ user mapping (T044).
 *
 * This is the only data the system does not produce itself: everything else (chargers' live state,
 * targets, sessions, cycles) is created by the running system. The mapping is also the sole basis
 * for authorization (FR-003), which is why it is operator data and survives `DELETE /me`.
 */
const DEFAULT_FIXTURE = fileURLToPath(new URL('../fixtures/parking-lots.json', import.meta.url))

async function main(): Promise<void> {
  const path = process.argv[2] ?? DEFAULT_FIXTURE
  const env = loadEnv()
  const lots = JSON.parse(readFileSync(path, 'utf8')) as ParkingLotDoc[]

  const db = getDb(env.GOOGLE_CLOUD_PROJECT)
  const parkingLots = new ParkingLotsRepo(db)
  const chargers = new ChargersRepo(db)

  let orphaned = 0
  for (const lot of lots) {
    await parkingLots.upsert(lot)
    if (!lot.easeeUserId) orphaned += 1

    // Seed the live mirror so the admin view lists all 30 chargers before the first cycle runs
    // (FR-040), rather than only those that happen to have answered a poll.
    const existing = await chargers.byId(lot.chargerId)
    if (!existing) {
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

  console.log(
    `seeded ${lots.length} parking lots from ${path}` +
      (orphaned > 0 ? ` (${orphaned} with no user — shown as orphaned in the admin view)` : ''),
  )
}

main().catch((error: unknown) => {
  console.error('seed:lots failed:', error)
  process.exitCode = 1
})

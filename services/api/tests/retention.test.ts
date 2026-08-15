import {
  ChargerEventsRepo,
  ChargerSnapshotsRepo,
  CyclesRepo,
  RETENTION_DAYS,
  expiresAtFrom,
} from '@app/adapters'
import type { CycleDoc } from '@app/adapters'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearFirestore, noEmulator, testDb } from '../../../tests/support/emulator.js'

/**
 * T121 — one-month retention of monitoring data (FR-047, US6 scenario 6).
 *
 * A Firestore TTL policy deletes *within 24 hours* of the expiry timestamp rather than at it, so
 * what can be asserted here is the thing the system actually controls: every growing collection
 * carries an `expiresAt` one month out, on the right field, of the right type. Without that field
 * the TTL policy in `infra/firestore/ttl-policies.md` has nothing to act on and the data is kept
 * forever.
 */
describe.skipIf(await noEmulator())('monitoring data retention', () => {
  const db = testDb()
  const at = '2026-06-15T12:00:00.000Z'

  beforeEach(async () => {
    await clearFirestore()
  })

  const expectedExpiry = Date.parse(at) + RETENTION_DAYS * 24 * 3_600_000

  it('stamps a cycle record with an expiry one month out', async () => {
    const doc: CycleDoc = {
      cycleId: at,
      startedAt: at,
      finishedAt: at,
      outcome: 'completed',
      durationMs: 100,
      inputs: null,
      decisions: [],
      readBack: [],
      providerCalls: {
        easee: { calls: 0, errors: 0, rateLimited: 0, budgetRemaining: 0 },
        solaredge: { calls: 0, errors: 0, rateLimited: 0, budgetRemaining: 0 },
        openweather: { calls: 0, errors: 0, rateLimited: 0, budgetRemaining: 0 },
      },
      notes: [],
      surplusAllocatedKw: 0,
      schedulerVersion: '1.0.0',
      correlationId: 'c',
      firestoreWrites: 1,
      expiresAt: expiresAtFrom(at),
    }
    await new CyclesRepo(db).write(doc)

    const stored = await db.collection('cycles').doc(at).get()
    const expiresAt = stored.get('expiresAt') as { toMillis(): number }
    expect(expiresAt.toMillis()).toBe(expectedExpiry)
  })

  it('stamps charger events', async () => {
    await new ChargerEventsRepo(db).append([
      { type: 'plugged_in', chargerId: 'EH100001', lotNumber: 'A01', at },
    ])

    const stored = await db.collection('chargerEvents').get()
    const expiresAt = stored.docs[0]?.get('expiresAt') as { toMillis(): number }
    expect(expiresAt.toMillis()).toBe(expectedExpiry)
  })

  it('stamps charger snapshots', async () => {
    await new ChargerSnapshotsRepo(db).writeMany([
      {
        chargerId: 'EH100001',
        lotNumber: 'A01',
        opMode: 3,
        outputCurrentA: 16,
        commandedCurrentA: 16,
        totalPowerKw: 11.09,
        sessionEnergyKwh: 4,
        observedAt: at,
      },
    ])

    const stored = await db.collection('chargerSnapshots').get()
    const expiresAt = stored.docs[0]?.get('expiresAt') as { toMillis(): number }
    expect(expiresAt.toMillis()).toBe(expectedExpiry)
  })

  it('marks data written a month ago as already expired, so the TTL policy will collect it', async () => {
    const old = '2026-04-01T12:00:00.000Z'
    await new ChargerEventsRepo(db).append([
      { type: 'unplugged', chargerId: 'EH100001', lotNumber: 'A01', at: old },
    ])

    const stored = await db.collection('chargerEvents').get()
    const expiresAt = stored.docs[0]?.get('expiresAt') as { toMillis(): number }
    expect(expiresAt.toMillis()).toBeLessThan(Date.parse(at))
  })

  it('overwrites rather than appends a snapshot for the same charger-minute', async () => {
    const snapshot = {
      chargerId: 'EH100001',
      lotNumber: 'A01',
      opMode: 3 as const,
      outputCurrentA: 16,
      commandedCurrentA: 16,
      totalPowerKw: 11.09,
      sessionEnergyKwh: 4,
      observedAt: at,
    }
    await new ChargerSnapshotsRepo(db).writeMany([snapshot])
    await new ChargerSnapshotsRepo(db).writeMany([{ ...snapshot, sessionEnergyKwh: 5 }])

    const stored = await db.collection('chargerSnapshots').get()
    // A repeated cycle must not double the stored volume (Principle VI).
    expect(stored.size).toBe(1)
    expect(stored.docs[0]?.get('sessionEnergyKwh')).toBe(5)
  })
})

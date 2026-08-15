import { CyclesRepo, LeaseRepo } from '@app/adapters'
import type { Result } from '@app/adapters'
import { createLogger } from '@app/shared'
import type { Firestore } from 'firebase-admin/firestore'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { runCycle } from '../src/cycle.js'
import type { CycleDeps } from '../src/ports.js'
import { clearFirestore, noEmulator, testDb } from '../../../tests/support/emulator.js'

/**
 * T040 / quickstart V8 — the two properties Cloud Scheduler's at-least-once delivery demands:
 * overlapping cycles do not both run (FR-026), and a repeated delivery changes nothing (FR-050).
 */

const CYCLE_ID = '2026-08-14T14:35:00Z'
const NOW = Date.parse(CYCLE_ID)

function depsFor(db: Firestore, instanceId: string): CycleDeps {
  const silent = createLogger({
    component: 'optimizer',
    correlationId: 'test',
    sink: () => {},
  })
  const gated = <T>(provider: 'easee' | 'solaredge' | 'openweather'): Result<T> => ({
    ok: false,
    error: { kind: 'gated', provider, message: 'provider not exercised by this test' },
  })
  return {
    db,
    logger: silent,
    now: () => NOW,
    sleep: async () => {},
    schedulerVersion: 'test-1',
    site: { latitude: 47.3769, longitude: 8.5417 },
    chargers: { read: async () => gated('easee') },
    setpoints: { write: async () => gated('easee'), msUntilNextWrite: () => 0 },
    // A working surplus reading, so these tests fail only for lease or idempotency reasons.
    surplus: {
      read: async () => ({
        ok: true as const,
        value: { gridExportKw: 6, loadKw: 3, pvKw: 9, observedAt: new Date(NOW).toISOString() },
      }),
    },
    forecast: { read: async () => gated('openweather') },
    stats: {
      easee: { calls: 0, errors: 0, rateLimited: 0, budgetRemaining: 100 },
      solaredge: { calls: 0, errors: 0, rateLimited: 0, budgetRemaining: 300 },
      openweather: { calls: 0, errors: 0, rateLimited: 0, budgetRemaining: 4 },
    },
    instanceId,
  }
}

describe.skipIf(await noEmulator())('single flight and idempotency', () => {
  const db = testDb()

  beforeEach(async () => {
    await clearFirestore()
  })

  afterAll(async () => {
    await clearFirestore()
  })

  it('lets exactly one of two overlapping cycles acquire the lease', async () => {
    const leases = new LeaseRepo(db)
    const nowIso = new Date(NOW).toISOString()

    const [first, second] = await Promise.all([
      leases.acquire('instance-a', nowIso),
      leases.acquire('instance-b', nowIso),
    ])

    const acquired = [first, second].filter((r) => r.acquired)
    expect(acquired).toHaveLength(1)
  })

  it('records the loser as skipped_locked and reports it as a success to Cloud Scheduler', async () => {
    const leases = new LeaseRepo(db)
    await leases.acquire('instance-a', new Date(NOW).toISOString())

    const result = await runCycle(depsFor(db, 'instance-b'), CYCLE_ID)

    expect(result.outcome).toBe('skipped_locked')
    const recorded = await new CyclesRepo(db).byId(CYCLE_ID)
    expect(recorded?.outcome).toBe('skipped_locked')
    expect(recorded?.notes[0]).toContain('instance-a')
  })

  it('releases the lease when the cycle finishes, so the next cycle is not blocked', async () => {
    await runCycle(depsFor(db, 'instance-a'), CYCLE_ID)
    expect(await new LeaseRepo(db).isHeld(new Date(NOW).toISOString())).toBe(false)
  })

  it('does not hold the lease after a failing cycle', async () => {
    const deps = depsFor(db, 'instance-a')
    const exploding: CycleDeps = {
      ...deps,
      db: new Proxy(db, {
        get(target, property, receiver) {
          if (property === 'collection') {
            return (name: string) => {
              if (name === 'cycles') throw new Error('simulated Firestore outage')
              return Reflect.get(target, property, receiver).call(target, name)
            }
          }
          return Reflect.get(target, property, receiver)
        },
      }) as Firestore,
    }

    await expect(runCycle(exploding, CYCLE_ID)).rejects.toThrow('simulated Firestore outage')
    expect(await new LeaseRepo(db).isHeld(new Date(NOW).toISOString())).toBe(false)
  })

  it('makes a repeated delivery of the same cycleId a no-op (FR-050)', async () => {
    const first = await runCycle(depsFor(db, 'instance-a'), CYCLE_ID)
    expect(first.outcome).toBe('completed')

    const before = await new CyclesRepo(db).byId(CYCLE_ID)
    const second = await runCycle(depsFor(db, 'instance-b'), CYCLE_ID)
    const after = await new CyclesRepo(db).byId(CYCLE_ID)

    expect(second.notes).toContain('idempotent replay of an already-recorded cycle')
    expect(after).toEqual(before)
  })

  it('lets a later cycle run once an expired lease is found', async () => {
    const leases = new LeaseRepo(db)
    // A lease acquired five minutes ago has expired: a crashed instance cannot deadlock the system.
    await leases.acquire('crashed-instance', new Date(NOW - 5 * 60_000).toISOString())

    const result = await runCycle(depsFor(db, 'instance-b'), CYCLE_ID)

    expect(result.outcome).toBe('completed')
  })
})

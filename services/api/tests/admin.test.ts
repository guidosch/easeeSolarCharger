import { CyclesRepo, SessionsRepo, expiresAtFrom } from '@app/adapters'
import type { CycleDoc, SessionDoc } from '@app/adapters'
import type {
  AdminChargerView,
  AdminCycleSummary,
  AdminHealth,
  AdminSessionView,
  TraceEntry,
} from '@app/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearFirestore, noEmulator } from '../../../tests/support/emulator.js'
import { LOT_A01, LOT_A02, buildTestApi, seedLots } from './support/app.js'

/**
 * T122 — the admin surface (US6).
 *
 * The scenario that matters is SC-009: an operator answers "why did charger A01 not charge between
 * 14:00 and 15:00?" from the recorded trail alone, without reading a log or asking a developer.
 */

const NOW = Date.parse('2026-06-15T15:10:00+02:00')
const ADMIN = { authorization: `Basic ${Buffer.from('admin:s3cret').toString('base64')}` }

function cycle(atIso: string, overrides: Partial<CycleDoc> = {}): CycleDoc {
  return {
    cycleId: atIso,
    startedAt: atIso,
    finishedAt: atIso,
    outcome: 'completed',
    durationMs: 4210,
    inputs: null,
    decisions: [
      {
        chargerId: LOT_A01.chargerId,
        targetCurrentA: 0,
        reason: 'high_price_blocked',
        ladderRule: 3,
        expectedKwhThisCycle: 0,
        attribution: 'none',
        reachability: { state: 'reachable', expectedShortfallKwh: 0 },
      },
    ],
    readBack: [
      {
        chargerId: LOT_A01.chargerId,
        commandedCurrentA: 0,
        deliveredCurrentA: 0,
        dynamicChargerCurrentA: 0,
        discrepancy: 'none',
      },
    ],
    providerCalls: {
      easee: { calls: 30, errors: 0, rateLimited: 0, budgetRemaining: 70 },
      solaredge: { calls: 1, errors: 0, rateLimited: 0, budgetRemaining: 163 },
      openweather: { calls: 0, errors: 0, rateLimited: 0, budgetRemaining: 3 },
    },
    notes: [],
    surplusAllocatedKw: 0,
    schedulerVersion: '1.0.0',
    correlationId: 'cycle-test',
    firestoreWrites: 12,
    expiresAt: expiresAtFrom(atIso),
    ...overrides,
  }
}

describe.skipIf(await noEmulator())('the admin surface is closed by default', () => {
  const { app } = buildTestApi(NOW)

  it.each([
    '/api/admin/cycles',
    '/api/admin/chargers',
    '/api/admin/providers',
    '/api/admin/sessions',
    '/api/admin/health',
    '/api/admin/chargers/A01/trace',
  ])('refuses %s without a credential (US6 scenario 5)', async (path) => {
    const response = await app.request(path)
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain('Basic')
  })

  it('refuses a wrong password', async () => {
    const wrong = { authorization: `Basic ${Buffer.from('admin:wrong').toString('base64')}` }
    expect((await app.request('/api/admin/health', { headers: wrong })).status).toBe(401)
  })

  it('refuses a user bearer token — the two surfaces do not share credentials', async () => {
    const response = await app.request('/api/admin/health', {
      headers: { authorization: 'Bearer some.user.token' },
    })
    expect(response.status).toBe(401)
  })
})

describe.skipIf(await noEmulator())('admin views', () => {
  const { app, deps } = buildTestApi(NOW)
  const cycles = new CyclesRepo(deps.db)

  beforeEach(async () => {
    await clearFirestore()
    await seedLots(deps, [LOT_A01, LOT_A02])
  })

  it('lists recent cycles with their outcome and provider budget (FR-039)', async () => {
    await cycles.write(cycle('2026-06-15T12:00:00.000Z'))
    await cycles.write(cycle('2026-06-15T12:05:00.000Z', { outcome: 'degraded' }))

    const response = await app.request('/api/admin/cycles', { headers: ADMIN })
    const summaries = (await response.json()) as AdminCycleSummary[]

    expect(response.status).toBe(200)
    expect(summaries.map((s) => s.outcome)).toEqual(['degraded', 'completed'])
    expect(summaries[0]?.providerCalls.solaredge.budgetRemaining).toBe(163)
  })

  it('returns the complete record for one cycle, copyable into a fixture (SC-010)', async () => {
    await cycles.write(cycle('2026-06-15T12:00:00.000Z'))

    const response = await app.request('/api/admin/cycles/2026-06-15T12:00:00.000Z', {
      headers: ADMIN,
    })
    const record = (await response.json()) as CycleDoc

    expect(record.decisions[0]?.ladderRule).toBe(3)
    expect(record.correlationId).toBe('cycle-test')
    expect(record.readBack).toHaveLength(1)
  })

  it('lists the ten most recent sessions across all users, newest first', async () => {
    const sessions = new SessionsRepo(deps.db)
    const session = (userId: string, n: number): SessionDoc => ({
      sessionId: `s_${n}`,
      userId,
      chargerId: LOT_A01.chargerId,
      lotNumber: LOT_A01.lotNumber,
      startedAt: `2026-06-${String(n).padStart(2, '0')}T08:00:00Z`,
      endedAt: `2026-06-${String(n).padStart(2, '0')}T12:00:00Z`,
      energyKwh: 10,
      solarKwh: 7,
      gridKwh: 3,
      targetEnergyKwh: 10,
      deadline: null,
      targetMet: true,
      endReason: 'target_reached',
      overrideUsed: false,
      sessionEnergyAtStartKwh: 0,
    })
    // Two users, twelve sessions interleaved between them: the newest ten must win regardless of owner.
    for (let n = 1; n <= 12; n += 1) await sessions.open(session(n % 2 ? 'U1001' : 'U1002', n))
    await deps.repos.users.touch({
      userId: 'U1001',
      email: 'one@example.com',
      lotNumbers: [LOT_A01.lotNumber],
      nowIso: new Date(NOW).toISOString(),
    })

    const response = await app.request('/api/admin/sessions', { headers: ADMIN })
    const views = (await response.json()) as AdminSessionView[]

    expect(response.status).toBe(200)
    expect(views.map((v) => v.sessionId)).toEqual(
      [12, 11, 10, 9, 8, 7, 6, 5, 4, 3].map((n) => `s_${n}`),
    )
    expect(views.find((v) => v.sessionId === 's_11')?.user).toEqual({
      userId: 'U1001',
      email: 'one@example.com',
    })
    expect(views.find((v) => v.sessionId === 's_12')?.user).toEqual({ userId: 'U1002' })
    expect(views[0]).not.toHaveProperty('sessionEnergyAtStartKwh')
  })

  it('lists every charger, including one with no target and one that is orphaned (FR-040)', async () => {
    await seedLots(deps, [{ ...LOT_A02, lotNumber: 'B15', chargerId: 'EH100030', easeeUserId: '' }])

    const response = await app.request('/api/admin/chargers', { headers: ADMIN })
    const chargers = (await response.json()) as AdminChargerView[]

    expect(chargers.length).toBeGreaterThanOrEqual(3)
    const orphan = chargers.find((c) => c.lotNumber === 'B15')
    expect(orphan?.orphaned).toBe(true)
    expect(orphan?.user).toBeNull()
    expect(chargers.every((c) => c.target === null)).toBe(true)
  })

  it('makes a read-back discrepancy visible rather than hiding it (US6 scenario 3)', async () => {
    await deps.repos.chargers.patch(LOT_A01.chargerId, {
      opMode: 3,
      commandedCurrentA: 16,
      outputCurrentA: 6,
      dynamicChargerCurrentA: 16,
      discrepancy: 'capped',
    })

    const chargers = (await (
      await app.request('/api/admin/chargers', { headers: ADMIN })
    ).json()) as AdminChargerView[]
    const charger = chargers.find((c) => c.lotNumber === 'A01')

    expect(charger?.discrepancy).toBe('capped')
    expect(charger?.commandedCurrentA).toBe(16)
    expect(charger?.deliveredCurrentA).toBe(6)
  })

  it('answers "why did A01 not charge between 14:00 and 15:00" from the trail alone (SC-009)', async () => {
    for (const minute of [0, 5, 10]) {
      await cycles.write(cycle(`2026-06-15T12:${String(minute).padStart(2, '0')}:00.000Z`))
    }

    const response = await app.request(
      '/api/admin/chargers/A01/trace?from=2026-06-15T12:00:00.000Z&to=2026-06-15T13:00:00.000Z',
      { headers: ADMIN },
    )
    const trace = (await response.json()) as TraceEntry[]

    expect(trace).toHaveLength(3)
    // The whole answer, in one field per row: rule 3, the high-price rule.
    expect(trace.every((row) => row.ladderRule === 3)).toBe(true)
    expect(trace.every((row) => row.reason === 'high_price_blocked')).toBe(true)
    expect(trace.every((row) => row.targetCurrentA === 0)).toBe(true)
  })

  it('reports provider health over the last 24 hours (FR-041)', async () => {
    await cycles.write(cycle('2026-06-15T12:00:00.000Z'))
    await cycles.write(
      cycle('2026-06-15T12:05:00.000Z', {
        outcome: 'degraded',
        notes: ['surplus read failed (timeout)'],
        providerCalls: {
          easee: { calls: 30, errors: 0, rateLimited: 0, budgetRemaining: 70 },
          solaredge: { calls: 1, errors: 1, rateLimited: 1, budgetRemaining: 162 },
          openweather: { calls: 0, errors: 0, rateLimited: 0, budgetRemaining: 3 },
        },
      }),
    )

    const health = (await (
      await app.request('/api/admin/providers', { headers: ADMIN })
    ).json()) as {
      provider: string
      callsLast24h: number
      errors: number
      rateLimited: number
      daylightGateOpen: boolean | null
    }[]

    const solaredge = health.find((p) => p.provider === 'solaredge')
    expect(solaredge?.callsLast24h).toBe(2)
    expect(solaredge?.errors).toBe(1)
    expect(solaredge?.rateLimited).toBe(1)
    expect(solaredge?.daylightGateOpen).toBe(true) // mid-June afternoon
    expect(health.find((p) => p.provider === 'easee')?.daylightGateOpen).toBeNull()
  })

  it('keeps the write budget observable (Principle VI)', async () => {
    await cycles.write(cycle('2026-06-15T12:00:00.000Z'))
    await cycles.write(cycle('2026-06-15T12:05:00.000Z'))

    const health = (await (
      await app.request('/api/admin/health', { headers: ADMIN })
    ).json()) as AdminHealth

    expect(health.firestoreWritesToday).toBe(24)
    expect(health.lastCycle?.outcome).toBe('completed')
    expect(health.leaseHeld).toBe(false)
    expect(health.consecutiveFailures).toBe(0)
  })

  it('counts only the current run of failures, not historical ones', async () => {
    await cycles.write(cycle('2026-06-15T12:00:00.000Z', { outcome: 'failed' }))
    await cycles.write(cycle('2026-06-15T12:05:00.000Z', { outcome: 'completed' }))
    await cycles.write(cycle('2026-06-15T12:10:00.000Z', { outcome: 'failed' }))

    const health = (await (
      await app.request('/api/admin/health', { headers: ADMIN })
    ).json()) as AdminHealth

    expect(health.consecutiveFailures).toBe(1)
  })
})

import { FairnessRepo, SessionsRepo } from '@app/adapters'
import type { TargetDoc } from '@app/adapters'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearFirestore, noEmulator } from '../../../tests/support/emulator.js'
import { bearer } from '../../../tests/support/tokens.js'
import { LOT_A01, LOT_B01, buildTestApi, seedLots } from './support/app.js'

/**
 * T123 / quickstart **V9** — delete all my data (US7, FR-048, SC-013).
 *
 * The assertion that matters is the sweeping one: after the deletion, **no document in any
 * collection references the userId**. A test that checked three known collections would pass
 * happily on the day a fourth was added.
 */

const NOW = Date.parse('2026-06-16T10:00:00+02:00')
const USER = 'U1001'

/** Every collection this system writes, so a new one cannot quietly escape the sweep. */
const COLLECTIONS = [
  'parkingLots',
  'chargers',
  'users',
  'chargerSnapshots',
  'chargerEvents',
  'cycles',
  'fairness',
  'locks',
  'providerTokens',
]

describe.skipIf(await noEmulator())('DELETE /api/me', () => {
  const { app, deps } = buildTestApi(NOW)

  const target = (targetId: string): TargetDoc => ({
    targetId,
    userId: USER,
    chargerId: LOT_A01.chargerId,
    lotNumber: LOT_A01.lotNumber,
    energyKwh: 20,
    deadline: '2026-06-17T07:00:00+02:00',
    status: 'open',
    deliveredKwh: 4,
    deliveredSolarKwh: 4,
    deliveredGridKwh: 0,
    reachability: {
      state: 'reachable',
      expectedShortfallKwh: 0,
      evaluatedAt: '2026-06-16T09:00:00Z',
    },
    createdAt: '2026-06-16T08:00:00Z',
    closedAt: null,
  })

  beforeEach(async () => {
    await clearFirestore()
    await seedLots(deps, [LOT_A01, LOT_B01])

    await deps.repos.users.touch({
      userId: USER,
      email: 'user@example.com',
      lotNumbers: ['A01', 'B01'],
      nowIso: '2026-06-16T08:00:00Z',
    })
    await deps.repos.targets.createSuperseding(target('t_open'))
    await new SessionsRepo(deps.db).open({
      sessionId: 's_1',
      userId: USER,
      chargerId: LOT_A01.chargerId,
      lotNumber: LOT_A01.lotNumber,
      startedAt: '2026-06-15T18:00:00Z',
      endedAt: '2026-06-16T05:00:00Z',
      energyKwh: 20,
      solarKwh: 14,
      gridKwh: 6,
      targetEnergyKwh: 20,
      deadline: '2026-06-16T07:00:00+02:00',
      targetMet: true,
      endReason: 'target_reached',
      overrideUsed: false,
      sessionEnergyAtStartKwh: 0,
    })
    await new FairnessRepo(deps.db).addSolar(USER, 14, 'cycle-1', '2026-06-16T05:00:00Z')
    await deps.repos.chargers.setOverride(LOT_A01.chargerId, true, '2026-06-16T09:30:00Z')
  })

  const deleteMe = (body: unknown = { confirm: 'DELETE' }) =>
    app.request('/api/me', {
      method: 'DELETE',
      headers: { ...bearer(USER), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('requires an explicit confirmation', async () => {
    expect((await deleteMe({})).status).toBe(400)
    expect((await deleteMe({ confirm: 'yes' })).status).toBe(400)
    expect(await deps.repos.users.byId(USER)).not.toBeNull()
  })

  it('leaves no document in any collection referencing the user', async () => {
    expect((await deleteMe()).status).toBe(204)

    for (const collection of COLLECTIONS) {
      const snapshot = await deps.db.collection(collection).get()
      for (const doc of snapshot.docs) {
        const serialised = JSON.stringify(doc.data())
        if (collection === 'parkingLots') continue // operator data, checked separately below
        expect(serialised).not.toContain(USER)
      }
    }

    // Subcollections go with the user document.
    const targets = await deps.db.collectionGroup('targets').get()
    const sessions = await deps.db.collectionGroup('sessions').get()
    expect(targets.empty).toBe(true)
    expect(sessions.empty).toBe(true)
  })

  it('removes the fairness ledger entry', async () => {
    await deleteMe()
    expect(await deps.db.collection('fairness').doc(USER).get()).toMatchObject({ exists: false })
  })

  it('cancels the open target and clears the override (US7 scenario 3)', async () => {
    await deleteMe()

    const charger = await deps.repos.chargers.byId(LOT_A01.chargerId)
    expect(charger?.overrideActive).toBe(false)
    expect(charger?.activeSessionId).toBeNull()
    expect(charger?.activeTargetPath).toBeNull()
  })

  it('leaves parkingLots untouched, because it is operator data', async () => {
    await deleteMe()

    const lots = await deps.repos.parkingLots.listAll()
    expect(lots).toHaveLength(2)
    // The mapping still names the user — deleting it would orphan a charger nobody could drive.
    expect(lots.every((lot) => lot.easeeUserId === USER)).toBe(true)
  })

  it('lets the user sign in again as a fresh user (US7 scenario 2)', async () => {
    await deleteMe()

    const response = await app.request('/api/chargers', { headers: bearer(USER) })

    expect(response.status).toBe(200)
    const chargers = (await response.json()) as { target: unknown }[]
    expect(chargers).toHaveLength(2)
    expect(chargers.every((c) => c.target === null)).toBe(true)
  })

  it('completes well inside the one-minute bound (SC-013)', async () => {
    const startedAt = Date.now()
    expect((await deleteMe()).status).toBe(204)
    expect(Date.now() - startedAt).toBeLessThan(60_000)
  })

  it('is a no-op the second time rather than an error', async () => {
    expect((await deleteMe()).status).toBe(204)
    expect((await deleteMe()).status).toBe(204)
  })
})

import { beforeEach, describe, expect, it } from 'vitest'
import { clearFirestore, noEmulator } from '../../../tests/support/emulator.js'
import { bearer, mintToken } from '../../../tests/support/tokens.js'
import { LOT_A01, LOT_A02, buildTestApi, seedLots } from './support/app.js'

/**
 * T064 — the target routes against the emulator.
 *
 * These are the rules a user notices when they are wrong: a target that silently replaced another,
 * a deadline accepted that could never be met, a charger someone else can drive.
 */

const NOW = Date.parse('2026-01-15T22:00:00+01:00')

describe.skipIf(await noEmulator())('POST /api/chargers/:lotNumber/target', () => {
  const { app, deps } = buildTestApi(NOW)

  beforeEach(async () => {
    await clearFirestore()
    await seedLots(deps, [LOT_A01, LOT_A02])
  })

  const setTarget = (lotNumber: string, body: unknown, userId = 'U1001') =>
    app.request(`/api/chargers/${lotNumber}/target`, {
      method: 'POST',
      headers: { ...bearer(userId), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('records a reachable target', async () => {
    const response = await setTarget('A01', {
      energyKwh: 20,
      deadline: '2026-01-16T07:00:00+01:00',
    })

    expect(response.status).toBe(201)
    const body = (await response.json()) as { targetId: string; reachability: { state: string } }
    expect(body.reachability.state).toBe('reachable')

    const stored = await deps.repos.targets.openForCharger('U1001', LOT_A01.chargerId)
    expect(stored?.energyKwh).toBe(20)
    expect(stored?.status).toBe('open')
  })

  it('accepts an impossible target and marks it unreachable rather than trimming it (FR-036)', async () => {
    const response = await setTarget('A01', {
      energyKwh: 80,
      deadline: '2026-01-16T00:00:00+01:00',
    })

    expect(response.status).toBe(201)
    const body = (await response.json()) as {
      reachability: { state: string; expectedShortfallKwh: number }
    }
    expect(body.reachability.state).toBe('unreachable')
    expect(body.reachability.expectedShortfallKwh).toBeGreaterThan(0)

    const stored = await deps.repos.targets.openForCharger('U1001', LOT_A01.chargerId)
    expect(stored?.energyKwh).toBe(80) // not silently reduced to what fits
  })

  it('rejects a deadline too soon and says which one would work (FR-007)', async () => {
    const response = await setTarget('A01', {
      energyKwh: 5,
      deadline: '2026-01-15T22:02:00+01:00',
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string; earliestFeasibleDeadline: string }
    expect(body.error).toBe('deadline_too_soon')
    expect(Date.parse(body.earliestFeasibleDeadline)).toBeGreaterThan(NOW)
  })

  it('rejects a deadline in the past', async () => {
    const response = await setTarget('A01', {
      energyKwh: 5,
      deadline: '2026-01-15T20:00:00+01:00',
    })
    expect(response.status).toBe(400)
  })

  it('supersedes the previous open target on the same charger (FR-009)', async () => {
    const first = await setTarget('A01', { energyKwh: 10, deadline: '2026-01-16T07:00:00+01:00' })
    const firstId = ((await first.json()) as { targetId: string }).targetId

    await setTarget('A01', { energyKwh: 25, deadline: '2026-01-16T09:00:00+01:00' })

    const open = await deps.repos.targets.openForCharger('U1001', LOT_A01.chargerId)
    expect(open?.energyKwh).toBe(25)

    const superseded = await deps.repos.targets.byId('U1001', firstId)
    expect(superseded?.status).toBe('superseded')
  })

  it('refuses a charger belonging to someone else (FR-003)', async () => {
    const response = await setTarget('A02', {
      energyKwh: 10,
      deadline: '2026-01-16T07:00:00+01:00',
    })

    expect(response.status).toBe(403)
    expect(((await response.json()) as { error: string }).error).toBe('not_your_charger')
  })

  it('refuses a user with no mapped parking lot (US1 scenario 6)', async () => {
    const response = await app.request('/api/chargers', { headers: bearer('U9999') })

    expect(response.status).toBe(403)
    expect(((await response.json()) as { error: string }).error).toBe('no_charger_mapped')
  })

  it('refuses a signed-out visitor (US1 scenario 7)', async () => {
    const response = await app.request('/api/chargers')
    expect(response.status).toBe(401)
  })

  it('reports an expired token as token_expired so the client refreshes', async () => {
    const expired = mintToken('U1001', { expiresAtSeconds: Math.floor(NOW / 1000) - 7200 })
    const response = await app.request('/api/chargers', {
      headers: { authorization: `Bearer ${expired}` },
    })

    expect(response.status).toBe(401)
    expect(((await response.json()) as { error: string }).error).toBe('token_expired')
  })

  it('rejects a malformed body without applying any of it', async () => {
    const response = await setTarget('A01', { energyKwh: 0, deadline: 'not-a-date' })

    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toBe('validation_failed')
    expect(await deps.repos.targets.openForCharger('U1001', LOT_A01.chargerId)).toBeNull()
  })
})

describe.skipIf(await noEmulator())('DELETE /api/chargers/:lotNumber/target', () => {
  const { app, deps } = buildTestApi(NOW)

  beforeEach(async () => {
    await clearFirestore()
    await seedLots(deps, [LOT_A01])
  })

  it('cancels the open target', async () => {
    await app.request('/api/chargers/A01/target', {
      method: 'POST',
      headers: { ...bearer('U1001'), 'content-type': 'application/json' },
      body: JSON.stringify({ energyKwh: 10, deadline: '2026-01-16T07:00:00+01:00' }),
    })

    const response = await app.request('/api/chargers/A01/target', {
      method: 'DELETE',
      headers: bearer('U1001'),
    })

    expect(response.status).toBe(204)
    expect(await deps.repos.targets.openForCharger('U1001', LOT_A01.chargerId)).toBeNull()
  })

  it('is a 404 when there is nothing to cancel', async () => {
    const response = await app.request('/api/chargers/A01/target', {
      method: 'DELETE',
      headers: bearer('U1001'),
    })
    expect(response.status).toBe(404)
  })
})

describe.skipIf(await noEmulator())('GET /api/chargers', () => {
  const { app, deps } = buildTestApi(NOW)

  beforeEach(async () => {
    await clearFirestore()
    await seedLots(deps, [LOT_A01])
  })

  it('reports the delivered current read back from the charger, not the setpoint (FR-028)', async () => {
    await deps.repos.chargers.patch(LOT_A01.chargerId, {
      opMode: 3,
      commandedCurrentA: 16,
      outputCurrentA: 6, // the external load manager is capping us
      lastAttribution: 'grid',
      observedAt: '2026-01-15T21:59:00Z',
    })

    const response = await app.request('/api/chargers', { headers: bearer('U1001') })
    const [charger] = (await response.json()) as { deliveredCurrentA: number; state: string }[]

    expect(charger?.deliveredCurrentA).toBe(6)
    expect(charger?.state).toBe('charging_grid')
  })
})

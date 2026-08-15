import { beforeEach, describe, expect, it } from 'vitest'
import { clearFirestore, noEmulator } from '../../../tests/support/emulator.js'
import { bearer } from '../../../tests/support/tokens.js'
import { LOT_A01, LOT_B01, buildTestApi, seedLots } from './support/app.js'

/**
 * T128 — two parking lots on one account (US8, FR-011).
 *
 * The rule this pins down is that supersession is keyed by **charger**, never by user. Getting that
 * wrong is invisible with one charger each — the default case — and silently cancels a neighbouring
 * car's target the moment anyone owns two lots.
 */

const NOW = Date.parse('2026-06-16T20:00:00+02:00')
const USER = 'U1001'

describe.skipIf(await noEmulator())('a user mapped to two parking lots', () => {
  const { app, deps } = buildTestApi(NOW)

  beforeEach(async () => {
    await clearFirestore()
    await seedLots(deps, [LOT_A01, LOT_B01])
  })

  const setTarget = (lotNumber: string, energyKwh: number) =>
    app.request(`/api/chargers/${lotNumber}/target`, {
      method: 'POST',
      headers: { ...bearer(USER), 'content-type': 'application/json' },
      body: JSON.stringify({ energyKwh, deadline: '2026-06-17T07:00:00+02:00' }),
    })

  it('lists both chargers, by parking lot number (FR-004, US8 scenario 1)', async () => {
    const response = await app.request('/api/chargers', { headers: bearer(USER) })
    const chargers = (await response.json()) as { lotNumber: string }[]

    expect(chargers.map((c) => c.lotNumber).sort()).toEqual(['A01', 'B01'])
  })

  it('tracks an independent target on each, and neither supersedes the other', async () => {
    expect((await setTarget('A01', 20)).status).toBe(201)
    expect((await setTarget('B01', 35)).status).toBe(201)

    const a01 = await deps.repos.targets.openForCharger(USER, LOT_A01.chargerId)
    const b01 = await deps.repos.targets.openForCharger(USER, LOT_B01.chargerId)

    expect(a01?.energyKwh).toBe(20)
    expect(b01?.energyKwh).toBe(35)
    expect(a01?.status).toBe('open')
    expect(b01?.status).toBe('open')
  })

  it('supersedes only on the same charger', async () => {
    const first = await setTarget('A01', 20)
    const firstId = ((await first.json()) as { targetId: string }).targetId
    await setTarget('B01', 35)
    await setTarget('A01', 25)

    expect((await deps.repos.targets.byId(USER, firstId))?.status).toBe('superseded')
    expect((await deps.repos.targets.openForCharger(USER, LOT_B01.chargerId))?.energyKwh).toBe(35)
    expect((await deps.repos.targets.openForCharger(USER, LOT_A01.chargerId))?.energyKwh).toBe(25)
  })

  it('cancels only the charger asked for', async () => {
    await setTarget('A01', 20)
    await setTarget('B01', 35)

    await app.request('/api/chargers/A01/target', { method: 'DELETE', headers: bearer(USER) })

    expect(await deps.repos.targets.openForCharger(USER, LOT_A01.chargerId)).toBeNull()
    expect(await deps.repos.targets.openForCharger(USER, LOT_B01.chargerId)).not.toBeNull()
  })

  it('overrides one charger without touching the other', async () => {
    await app.request('/api/chargers/A01/override', {
      method: 'PUT',
      headers: { ...bearer(USER), 'content-type': 'application/json' },
      body: JSON.stringify({ active: true }),
    })

    expect((await deps.repos.chargers.byId(LOT_A01.chargerId))?.overrideActive).toBe(true)
    expect((await deps.repos.chargers.byId(LOT_B01.chargerId))?.overrideActive).toBe(false)
  })

  it('shows both targets on the charger list', async () => {
    await setTarget('A01', 20)
    await setTarget('B01', 35)

    const chargers = (await (
      await app.request('/api/chargers', { headers: bearer(USER) })
    ).json()) as { lotNumber: string; target: { energyKwh: number } | null }[]

    expect(chargers.find((c) => c.lotNumber === 'A01')?.target?.energyKwh).toBe(20)
    expect(chargers.find((c) => c.lotNumber === 'B01')?.target?.energyKwh).toBe(35)
  })
})

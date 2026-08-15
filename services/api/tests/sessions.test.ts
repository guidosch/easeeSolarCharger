import { SessionsRepo } from '@app/adapters'
import type { SessionDoc } from '@app/adapters'
import type { SessionSummary } from '@app/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearFirestore, noEmulator } from '../../../tests/support/emulator.js'
import { bearer } from '../../../tests/support/tokens.js'
import { LOT_A01, buildTestApi, seedLots } from './support/app.js'

/**
 * T089 — the session summary (US3, FR-037).
 *
 * A summary is what makes the optimization trustworthy: it is the only place a user can check that
 * "charged from solar" meant anything.
 */

const NOW = Date.parse('2026-06-16T08:00:00+02:00')

function session(overrides: Partial<SessionDoc> = {}): SessionDoc {
  return {
    sessionId: 's_1',
    userId: 'U1001',
    chargerId: LOT_A01.chargerId,
    lotNumber: LOT_A01.lotNumber,
    startedAt: '2026-06-15T18:02:00Z',
    endedAt: '2026-06-16T05:41:00Z',
    energyKwh: 20,
    solarKwh: 14.2,
    gridKwh: 5.8,
    targetEnergyKwh: 20,
    deadline: '2026-06-16T07:00:00+02:00',
    targetMet: true,
    endReason: 'target_reached',
    overrideUsed: false,
    sessionEnergyAtStartKwh: 0,
    ...overrides,
  }
}

describe.skipIf(await noEmulator())('GET /api/sessions', () => {
  const { app, deps } = buildTestApi(NOW)
  const sessions = new SessionsRepo(deps.db)

  beforeEach(async () => {
    await clearFirestore()
    await seedLots(deps, [LOT_A01])
  })

  it('returns the total, the solar/grid split, targetMet and endReason', async () => {
    await sessions.open(session())

    const response = await app.request('/api/sessions', { headers: bearer('U1001') })
    const [summary] = (await response.json()) as SessionSummary[]

    expect(response.status).toBe(200)
    expect(summary).toMatchObject({
      lotNumber: 'A01',
      energyKwh: 20,
      solarKwh: 14.2,
      gridKwh: 5.8,
      targetMet: true,
      endReason: 'target_reached',
      overrideUsed: false,
    })
    expect((summary?.solarKwh ?? 0) + (summary?.gridKwh ?? 0)).toBeCloseTo(
      summary?.energyKwh ?? 0,
      6,
    )
  })

  it('marks a session ended by unplugging with the energy actually delivered', async () => {
    await sessions.open(
      session({
        sessionId: 's_unplugged',
        energyKwh: 7.4,
        solarKwh: 7.4,
        gridKwh: 0,
        targetEnergyKwh: 20,
        targetMet: false,
        endReason: 'unplugged',
      }),
    )

    const response = await app.request('/api/sessions', { headers: bearer('U1001') })
    const [summary] = (await response.json()) as SessionSummary[]

    expect(summary?.endReason).toBe('unplugged')
    expect(summary?.targetMet).toBe(false)
    expect(summary?.energyKwh).toBe(7.4) // what was delivered, not what was asked for
    expect(summary?.targetEnergyKwh).toBe(20)
  })

  it('returns the newest first', async () => {
    await sessions.open(session({ sessionId: 's_old', startedAt: '2026-06-10T10:00:00Z' }))
    await sessions.open(session({ sessionId: 's_new', startedAt: '2026-06-14T10:00:00Z' }))

    const response = await app.request('/api/sessions', { headers: bearer('U1001') })
    const summaries = (await response.json()) as SessionSummary[]

    expect(summaries.map((s) => s.sessionId)).toEqual(['s_new', 's_old'])
  })

  it('shows another user nothing of this one’s history', async () => {
    await sessions.open(session())

    const response = await app.request('/api/sessions', { headers: bearer('U1002') })

    // History is keyed by the `UserId` claim, so a different token can only ever read its own —
    // an empty list, not a refusal, because reading your own history is not a charging action.
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([])
  })

  it('refuses an unauthenticated caller', async () => {
    expect((await app.request('/api/sessions')).status).toBe(401)
  })
})

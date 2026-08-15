import { SESSION_RETENTION, SessionsRepo } from '@app/adapters'
import type { SessionDoc } from '@app/adapters'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearFirestore, noEmulator, testDb } from '../../../tests/support/emulator.js'

/**
 * T090 — five-session retention (FR-038, Principle VI).
 *
 * Enforced *by construction*: closing a session deletes anything beyond the five most recent in the
 * same batch. A nightly job would be a job that might not run, and the constitution asks for
 * retention enforced by automated deletion rather than left to a provider default.
 */
describe.skipIf(await noEmulator())('session retention', () => {
  const db = testDb()
  const sessions = new SessionsRepo(db)
  const userId = 'U1001'

  const session = (index: number): SessionDoc => ({
    sessionId: `s_${index}`,
    userId,
    chargerId: 'EH100001',
    lotNumber: 'A01',
    // Ascending, so `s_6` is the newest.
    startedAt: new Date(Date.parse('2026-06-01T00:00:00Z') + index * 86_400_000).toISOString(),
    endedAt: null,
    energyKwh: index,
    solarKwh: 0,
    gridKwh: index,
    targetEnergyKwh: 20,
    deadline: '2026-06-30T00:00:00Z',
    targetMet: false,
    endReason: null,
    overrideUsed: false,
    sessionEnergyAtStartKwh: 0,
  })

  beforeEach(async () => {
    await clearFirestore()
  })

  it('keeps exactly the five most recent when a sixth closes', async () => {
    for (let i = 1; i <= 6; i += 1) await sessions.open(session(i))

    await sessions.close(userId, 's_6', { endedAt: '2026-06-07T10:00:00Z', endReason: 'unplugged' })

    const remaining = await sessions.recent(userId, 50)
    expect(remaining).toHaveLength(SESSION_RETENTION)
    expect(remaining.map((s) => s.sessionId)).toEqual(['s_6', 's_5', 's_4', 's_3', 's_2'])
  })

  it('deletes the oldest, not an arbitrary one', async () => {
    for (let i = 1; i <= 8; i += 1) await sessions.open(session(i))

    await sessions.close(userId, 's_8', { endedAt: '2026-06-09T10:00:00Z' })

    const remaining = await sessions.recent(userId, 50)
    expect(remaining.map((s) => s.sessionId)).toEqual(['s_8', 's_7', 's_6', 's_5', 's_4'])
  })

  it('does nothing when there are fewer than five', async () => {
    for (let i = 1; i <= 3; i += 1) await sessions.open(session(i))

    await sessions.close(userId, 's_3', { endedAt: '2026-06-04T10:00:00Z' })

    expect(await sessions.recent(userId, 50)).toHaveLength(3)
  })

  it('reports how many documents it wrote, so the cycle can count its own write budget', async () => {
    for (let i = 1; i <= 7; i += 1) await sessions.open(session(i))

    // One update for the closing session plus two deletions.
    const writes = await sessions.close(userId, 's_7', { endedAt: '2026-06-08T10:00:00Z' })
    expect(writes).toBe(3)
  })
})

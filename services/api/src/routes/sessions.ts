import { Hono } from 'hono'
import type { SessionDoc } from '@app/adapters'
import type { SessionSummary } from '@app/shared'
import type { ApiDeps } from '../context.js'
import type { HonoEnv } from '../middleware/requireAuth.js'

/**
 * `GET /sessions` (T093) — the five most recent, newest first (FR-038).
 *
 * There is no pagination and no "load older": older sessions are not hidden, they are deleted
 * (Principle VI). The five-session limit is enforced when a session closes, so this route needs no
 * trimming logic of its own.
 */
export function sessionRoutes(deps: ApiDeps): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>()

  app.get('/', async (c) => {
    const user = c.get('user')
    const sessions = await deps.repos.sessions.recent(user.userId)
    return c.json(sessions.map(toSummary), 200)
  })

  return app
}

export function toSummary(session: SessionDoc): SessionSummary {
  return {
    sessionId: session.sessionId,
    chargerId: session.chargerId,
    lotNumber: session.lotNumber,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    energyKwh: session.energyKwh,
    solarKwh: session.solarKwh,
    gridKwh: session.gridKwh,
    targetEnergyKwh: session.targetEnergyKwh,
    deadline: session.deadline,
    targetMet: session.targetMet,
    endReason: session.endReason,
    overrideUsed: session.overrideUsed,
  }
}

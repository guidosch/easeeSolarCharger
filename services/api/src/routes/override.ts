import { Hono } from 'hono'
import { SetOverrideRequest } from '@app/shared'
import type { ApiDeps } from '../context.js'
import { ApiFailure } from '../errors.js'
import { authorizeLot } from '../middleware/authorize.js'
import type { HonoEnv } from '../middleware/requireAuth.js'

/**
 * `PUT /chargers/{lotNumber}/override` (T098, FR-032).
 *
 * Turning the override *on* is a user action. Turning it off is not only a user action: the
 * optimizer clears it automatically when the session ends (FR-033), because the client cannot be
 * relied on to be open — or even installed — at the moment the car is unplugged.
 */
export function overrideRoutes(deps: ApiDeps): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>()

  app.put('/:lotNumber/override', async (c) => {
    const user = c.get('user')
    const lot = await authorizeLot(deps, user.userId, c.req.param('lotNumber'))

    const body: unknown = await c.req.json().catch(() => null)
    const parsed = SetOverrideRequest.safeParse(body)
    if (!parsed.success) {
      throw new ApiFailure('validation_failed', 'expected { "active": true | false }', {
        details: parsed.error.issues,
      })
    }

    const nowIso = new Date(deps.now()).toISOString()
    await deps.repos.chargers.setOverride(lot.chargerId, parsed.data.active, nowIso)
    await deps.repos.events.append([
      {
        type: parsed.data.active ? 'override_on' : 'override_off',
        chargerId: lot.chargerId,
        lotNumber: lot.lotNumber,
        at: nowIso,
        detail: `set by user ${user.userId}`,
      },
    ])

    return c.json({ active: parsed.data.active, since: parsed.data.active ? nowIso : null }, 200)
  })

  return app
}

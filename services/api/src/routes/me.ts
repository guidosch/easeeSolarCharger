import { Hono } from 'hono'
import { z } from 'zod'
import type { ApiDeps } from '../context.js'
import { ApiFailure } from '../errors.js'
import type { HonoEnv } from '../middleware/requireAuth.js'

/**
 * `DELETE /me` (T124, T125, FR-048).
 *
 * A hard delete, not a soft flag: the privacy commitment is that the record is gone, and
 * `services/api/tests/deletion.test.ts` asserts that afterwards no document in any collection
 * references the `userId`.
 *
 * `parkingLots` is deliberately **not** touched. It is operator data, not user data — deleting it
 * would orphan a charger nobody could then drive, and the user is free to sign in again
 * immediately as a fresh user.
 */
const ConfirmDeletion = z.object({ confirm: z.literal('DELETE') })

export function meRoutes(deps: ApiDeps): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>()

  app.delete('/', async (c) => {
    const user = c.get('user')

    const body: unknown = await c.req.json().catch(() => null)
    if (!ConfirmDeletion.safeParse(body).success) {
      throw new ApiFailure('validation_failed', 'deletion requires { "confirm": "DELETE" }')
    }

    const nowIso = new Date(deps.now()).toISOString()

    // T125 — the user's chargers keep running after they are gone, so anything that would still
    // command them has to be stood down first: an open target, and any active override.
    const lots = await deps.repos.parkingLots.forUser(user.userId)
    for (const lot of lots) {
      const open = await deps.repos.targets.openForCharger(user.userId, lot.chargerId)
      if (open) await deps.repos.targets.close(user.userId, open.targetId, 'cancelled', nowIso)

      const charger = await deps.repos.chargers.byId(lot.chargerId)
      if (charger?.overrideActive) {
        await deps.repos.chargers.setOverride(lot.chargerId, false, nowIso)
      }
      await deps.repos.chargers.patch(lot.chargerId, {
        activeSessionId: null,
        activeTargetPath: null,
      })
    }

    await deps.repos.users.deleteUserTree(user.userId)
    await deps.repos.fairness.remove(user.userId)

    // The user id is the only identifier this system holds, so it must not be logged on the way out
    // either — the event says a deletion happened, not whose.
    deps.logger.info('user data deleted', { chargersReleased: lots.length })

    return c.body(null, 204)
  })

  return app
}

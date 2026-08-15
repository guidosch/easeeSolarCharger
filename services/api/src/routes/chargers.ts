import { Hono } from 'hono'
import { emptyChargerDoc } from '@app/adapters'
import type { ChargerView } from '@app/shared'
import type { ApiDeps } from '../context.js'
import { chargersForUser } from '../middleware/authorize.js'
import type { HonoEnv } from '../middleware/requireAuth.js'
import { deriveChargerState, toTargetView } from '../state.js'

/**
 * `GET /chargers` (T060) — every charger mapped to the caller.
 *
 * `deliveredCurrentA` is the value read back from the charger, not the setpoint this system wrote
 * (FR-028). Showing the setpoint would make the app claim a car is charging at 16 A while the
 * external load manager is actually giving it 6.
 *
 * Returning *all* mapped chargers rather than the first is what makes the multi-lot case (US8) work
 * without a second endpoint.
 */
export function chargerRoutes(deps: ApiDeps): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>()

  app.get('/', async (c) => {
    const user = c.get('user')
    const lots = await chargersForUser(deps, user.userId)

    const views: ChargerView[] = []
    for (const lot of lots) {
      const charger =
        (await deps.repos.chargers.byId(lot.chargerId)) ??
        emptyChargerDoc({
          chargerId: lot.chargerId,
          lotNumber: lot.lotNumber,
          line: lot.line,
          phases: lot.phases,
          maxCurrentA: lot.maxCurrentA,
        })
      const target = await deps.repos.targets.openForCharger(user.userId, lot.chargerId)

      views.push({
        lotNumber: lot.lotNumber,
        chargerId: lot.chargerId,
        state: deriveChargerState(charger, target),
        phases: lot.phases,
        deliveredCurrentA: charger.outputCurrentA,
        target: target ? toTargetView(target, charger) : null,
        override: {
          active: charger.overrideActive,
          since: charger.overrideSince,
        },
        observedAt: charger.observedAt,
      })
    }

    return c.json(views, 200)
  })

  return app
}

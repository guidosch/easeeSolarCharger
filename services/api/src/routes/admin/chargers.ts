import { Hono } from 'hono'
import { emptyChargerDoc } from '@app/adapters'
import type { AdminChargerView } from '@app/shared'
import type { ApiDeps } from '../../context.js'
import { deriveChargerState, toTargetView } from '../../state.js'

/**
 * `GET /admin/chargers` (T112, FR-040).
 *
 * All thirty, whether or not they have a target — a charger with no target is exactly the one an
 * operator is looking for when a user says "nothing happened". `discrepancy` is the Principle I
 * read-back reconciliation made visible: `capped` means the external load manager overruled us,
 * `lost` means the setpoint did not stick, most often because a plug-in reset it (research R5).
 */
export function adminChargerRoutes(deps: ApiDeps): Hono {
  const app = new Hono()

  app.get('/chargers', async (c) => {
    const lots = await deps.repos.parkingLots.listAll()
    const views: AdminChargerView[] = []

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

      const orphaned = lot.easeeUserId === ''
      const target = orphaned
        ? null
        : await deps.repos.targets.openForCharger(lot.easeeUserId, lot.chargerId)
      const user = orphaned ? null : await deps.repos.users.byId(lot.easeeUserId)

      views.push({
        lotNumber: lot.lotNumber,
        chargerId: lot.chargerId,
        line: lot.line,
        phases: lot.phases,
        opMode: charger.opMode,
        state: deriveChargerState(charger, target),
        commandedCurrentA: charger.commandedCurrentA,
        deliveredCurrentA: charger.outputCurrentA,
        dynamicChargerCurrentA: charger.dynamicChargerCurrentA,
        discrepancy: charger.discrepancy,
        target: target ? toTargetView(target, charger) : null,
        // A lot whose mapping has no user is surfaced rather than hidden: it is an operator data
        // problem, and the charger it points at cannot be driven by anyone (spec edge case).
        user: orphaned
          ? null
          : { userId: lot.easeeUserId, ...(user?.email ? { email: user.email } : {}) },
        orphaned,
        observedAt: charger.observedAt,
      })
    }

    return c.json(views, 200)
  })

  return app
}

import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import type { TargetDoc } from '@app/adapters'
import { DEFAULT_SCHEDULER_CONFIG, earliestFeasibleDeadline, isReachable } from '@app/core'
import { SetTargetRequest } from '@app/shared'
import type { SetTargetResponse } from '@app/shared'
import type { ApiDeps } from '../context.js'
import { ApiFailure } from '../errors.js'
import { authorizeLot } from '../middleware/authorize.js'
import type { HonoEnv } from '../middleware/requireAuth.js'

/**
 * `POST` / `DELETE /chargers/{lotNumber}/target` (T061, T062).
 *
 * Two behaviours here are load-bearing and easy to get subtly wrong:
 *
 *  - a deadline too soon to deliver anything is **rejected with the earliest feasible one** (FR-007)
 *    rather than silently accepted and quietly missed;
 *  - a target larger than can be delivered is **accepted and marked unreachable** (FR-036), never
 *    trimmed. Trimming would be the system silently deciding how much charge someone needs.
 */
export function targetRoutes(deps: ApiDeps): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>()
  const config = DEFAULT_SCHEDULER_CONFIG

  app.post('/:lotNumber/target', async (c) => {
    const user = c.get('user')
    const lotNumber = c.req.param('lotNumber')
    const lot = await authorizeLot(deps, user.userId, lotNumber)

    const body: unknown = await c.req.json().catch(() => null)
    const parsed = SetTargetRequest.safeParse(body)
    if (!parsed.success) {
      throw new ApiFailure('validation_failed', 'energyKwh and deadline are required', {
        details: parsed.error.issues,
      })
    }

    const nowIso = new Date(deps.now()).toISOString()
    const earliest = earliestFeasibleDeadline(nowIso, config)
    if (Date.parse(parsed.data.deadline) < Date.parse(earliest)) {
      throw new ApiFailure('deadline_too_soon', 'no energy can be delivered before that deadline', {
        earliestFeasibleDeadline: earliest,
      })
    }

    const reachability = isReachable(
      { energyKwh: parsed.data.energyKwh, deadline: parsed.data.deadline, deliveredKwh: 0 },
      nowIso,
      config,
      { maxCurrentA: lot.maxCurrentA, phases: lot.phases },
    )

    const target: TargetDoc = {
      targetId: `t_${randomUUID()}`,
      userId: user.userId,
      chargerId: lot.chargerId,
      lotNumber: lot.lotNumber,
      energyKwh: parsed.data.energyKwh,
      deadline: parsed.data.deadline,
      status: 'open',
      deliveredKwh: 0,
      deliveredSolarKwh: 0,
      deliveredGridKwh: 0,
      reachability: { ...reachability, evaluatedAt: nowIso },
      createdAt: nowIso,
      closedAt: null,
    }

    // Supersedes any open target on this charger in the same transaction (FR-009), so there is no
    // instant at which the optimizer could see two open targets for one charger.
    await deps.repos.targets.createSuperseding(target)
    await deps.repos.events.append([
      {
        type: 'target_set',
        chargerId: lot.chargerId,
        lotNumber: lot.lotNumber,
        at: nowIso,
        detail: `${parsed.data.energyKwh} kWh by ${parsed.data.deadline}`,
      },
    ])

    const response: SetTargetResponse = { targetId: target.targetId, reachability }
    // 201 even when unreachable: the target *is* recorded, and the warning travels with it.
    return c.json(response, 201)
  })

  app.delete('/:lotNumber/target', async (c) => {
    const user = c.get('user')
    const lot = await authorizeLot(deps, user.userId, c.req.param('lotNumber'))

    const open = await deps.repos.targets.openForCharger(user.userId, lot.chargerId)
    if (!open) throw new ApiFailure('not_found', 'no open target on this charger')

    const nowIso = new Date(deps.now()).toISOString()
    await deps.repos.targets.close(user.userId, open.targetId, 'cancelled', nowIso)

    return c.body(null, 204)
  })

  return app
}

import { Hono } from 'hono'
import type { CycleDoc } from '@app/adapters'
import { CycleOutcome } from '@app/shared'
import type { AdminCycleSummary } from '@app/shared'
import type { ApiDeps } from '../../context.js'
import { ApiFailure } from '../../errors.js'

/**
 * `GET /admin/cycles` and `GET /admin/cycles/{cycleId}` (T110, T111, FR-039).
 *
 * The list answers "is the system healthy"; the detail answers "why did it do that". The detail
 * response is deliberately the *whole* record, because it is what `decide()` must reproduce
 * (SC-010) and the operator can paste it straight into a regression fixture.
 */
export function adminCycleRoutes(deps: ApiDeps): Hono {
  const app = new Hono()

  app.get('/cycles', async (c) => {
    const limit = Math.min(200, Number(c.req.query('limit') ?? 50) || 50)
    const outcomeParam = c.req.query('outcome')
    const outcome = outcomeParam ? CycleOutcome.safeParse(outcomeParam) : null
    if (outcome && !outcome.success) {
      throw new ApiFailure('validation_failed', `unknown outcome ${outcomeParam}`)
    }

    const cycles = await deps.repos.cycles.recent(limit, outcome?.data)
    return c.json(cycles.map(toSummary), 200)
  })

  app.get('/cycles/:cycleId', async (c) => {
    const cycle = await deps.repos.cycles.byId(c.req.param('cycleId'))
    if (!cycle) throw new ApiFailure('not_found', 'no cycle recorded for that instant')
    return c.json(cycle, 200)
  })

  return app
}

export function toSummary(cycle: CycleDoc): AdminCycleSummary {
  return {
    cycleId: cycle.cycleId,
    outcome: cycle.outcome,
    durationMs: cycle.durationMs,
    surplus: {
      smoothedKw: cycle.inputs?.surplus.smoothedKw ?? null,
      rawKw: cycle.inputs?.surplus.rawKw ?? null,
      ageMinutes: cycle.inputs?.surplus.ageMinutes ?? null,
      // `unusable` on a cycle that never gathered anything is the honest answer, not a guess.
      quality: cycle.inputs?.surplus.quality ?? 'unusable',
    },
    tariffWindow: cycle.inputs?.tariffWindow ?? 'low',
    seasonMode: cycle.inputs?.seasonMode ?? 'solar',
    chargersActedOn: cycle.decisions.filter((d) => d.targetCurrentA > 0).length,
    providerCalls: cycle.providerCalls,
  }
}

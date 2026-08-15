import { Hono } from 'hono'
import type { TraceEntry } from '@app/shared'
import type { ApiDeps } from '../../context.js'
import { ApiFailure } from '../../errors.js'

/**
 * `GET /admin/chargers/{lotNumber}/trace?from=&to=` (T113, FR-042, SC-009).
 *
 * This is the endpoint that answers "why did charger 12 not charge between 14:00 and 15:00?" from
 * the recorded decision trail alone. `ladderRule` is the field that makes it a one-glance answer:
 * every row says which rule of the Principle I ladder decided that charger's fate in that cycle.
 */
export function adminTraceRoutes(deps: ApiDeps): Hono {
  const app = new Hono()

  app.get('/chargers/:lotNumber/trace', async (c) => {
    const lotNumber = c.req.param('lotNumber')
    const lot = await deps.repos.parkingLots.byLotNumber(lotNumber)
    if (!lot) throw new ApiFailure('not_found', `no parking lot ${lotNumber}`)

    const nowMs = deps.now()
    const to = c.req.query('to') ?? new Date(nowMs).toISOString()
    const from = c.req.query('from') ?? new Date(nowMs - 60 * 60_000).toISOString()
    if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
      throw new ApiFailure('validation_failed', 'from and to must be ISO-8601 instants')
    }

    const cycles = await deps.repos.cycles.between(from, to)
    const events = await deps.repos.events.forCharger(lot.chargerId, from, to)

    const entries: TraceEntry[] = cycles.map((cycle) => {
      const decision = cycle.decisions.find((d) => d.chargerId === lot.chargerId)
      const readBack = cycle.readBack.find((r) => r.chargerId === lot.chargerId)
      return {
        cycleId: cycle.cycleId,
        startedAt: cycle.startedAt,
        targetCurrentA: decision?.targetCurrentA ?? 0,
        // A cycle that never got as far as a decision for this charger is still a row in the
        // trace — its absence is itself the explanation.
        reason: decision?.reason ?? 'charger_error',
        ladderRule: decision?.ladderRule ?? null,
        deliveredCurrentA: readBack?.deliveredCurrentA ?? 0,
        discrepancy: readBack?.discrepancy ?? null,
        events: events
          .filter((e) => e.at >= cycle.startedAt && e.at <= (cycle.finishedAt ?? cycle.startedAt))
          .map((e) => ({ type: e.type, at: e.at, ...(e.detail ? { detail: e.detail } : {}) })),
      }
    })

    return c.json(entries, 200)
  })

  return app
}

import { Hono } from 'hono'
import type { AdminHealth } from '@app/shared'
import type { ApiDeps } from '../../context.js'

/**
 * `GET /admin/health` (T115).
 *
 * `firestoreWritesToday` is the field that matters most here: it keeps the Principle VI write
 * budget *observable* rather than assumed. The design allows ~1,750 writes a day against a 20,000
 * free allowance; if this figure drifts upwards, the design has regressed and the free tier is at
 * risk long before the bill arrives.
 */
export function adminHealthRoutes(deps: ApiDeps): Hono {
  const app = new Hono()

  app.get('/health', async (c) => {
    const nowMs = deps.now()
    const nowIso = new Date(nowMs).toISOString()
    const startOfDay = `${nowIso.slice(0, 10)}T00:00:00.000Z`

    const recent = await deps.repos.cycles.recent(50)
    const today = await deps.repos.cycles.since(startOfDay, 500)
    const lease = await deps.repos.lease.current()
    const targets = await deps.repos.targets.countOpen()

    const last = recent[0]

    // Counted from the newest backwards: a run of failures that has since recovered is not a
    // current problem, and reporting it as one would train the operator to ignore this field.
    let consecutiveFailures = 0
    for (const cycle of recent) {
      if (cycle.outcome === 'failed') consecutiveFailures += 1
      else break
    }

    const health: AdminHealth = {
      lastCycle: last
        ? {
            cycleId: last.cycleId,
            outcome: last.outcome,
            ageMinutes: Math.round((nowMs - Date.parse(last.startedAt)) / 60_000),
          }
        : null,
      leaseHeld: lease !== null && Date.parse(lease.expiresAt) > nowMs,
      consecutiveFailures,
      firestoreWritesToday: today.reduce((sum, cycle) => sum + cycle.firestoreWrites, 0),
      openTargets: targets.open,
      unreachableTargets: targets.unreachable,
    }

    return c.json(health, 200)
  })

  return app
}

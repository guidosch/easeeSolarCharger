import { Hono } from 'hono'
import { PROVIDER_BUDGETS, daylightGate } from '@app/adapters'
import { DEFAULT_SCHEDULER_CONFIG } from '@app/core'
import type { AdminProviderHealth } from '@app/shared'
import type { ApiDeps } from '../../context.js'

/**
 * `GET /admin/providers` (T114, FR-041).
 *
 * Rolling 24-hour health per provider, summed from the recorded cycles rather than from an
 * in-memory counter: both services scale to zero, so anything held in a process is gone by the time
 * anyone looks at it.
 */
export function adminProviderRoutes(deps: ApiDeps): Hono {
  const app = new Hono()

  app.get('/providers', async (c) => {
    const nowMs = deps.now()
    const nowIso = new Date(nowMs).toISOString()
    const since = new Date(nowMs - 24 * 3_600_000).toISOString()
    const cycles = await deps.repos.cycles.since(since)

    const gate = daylightGate({
      nowIso,
      latitude: deps.env.SITE_LATITUDE,
      longitude: deps.env.SITE_LONGITUDE,
      config: DEFAULT_SCHEDULER_CONFIG,
    })

    const budgets = {
      easee: PROVIDER_BUDGETS.easeeObservations.capacity,
      solaredge: PROVIDER_BUDGETS.solarEdgeDaily,
      openweather: PROVIDER_BUDGETS.openWeatherDaily,
    } as const

    const health: AdminProviderHealth[] = (['easee', 'solaredge', 'openweather'] as const).map(
      (provider) => {
        const totals = cycles.reduce(
          (acc, cycle) => {
            const stats = cycle.providerCalls[provider]
            return {
              calls: acc.calls + stats.calls,
              errors: acc.errors + stats.errors,
              rateLimited: acc.rateLimited + stats.rateLimited,
            }
          },
          { calls: 0, errors: 0, rateLimited: 0 },
        )

        const lastFailure = cycles.find(
          (cycle) => cycle.providerCalls[provider].errors > 0 || cycle.outcome === 'failed',
        )

        return {
          provider,
          callsLast24h: totals.calls,
          budget: budgets[provider],
          errors: totals.errors,
          rateLimited: totals.rateLimited,
          lastError: lastFailure
            ? {
                at: lastFailure.startedAt,
                message: lastFailure.notes.join('; ') || 'see the cycle record',
                correlationId: lastFailure.correlationId,
              }
            : null,
          // Only SolarEdge has a gate; the others answer `null` rather than a misleading `false`.
          daylightGateOpen: provider === 'solaredge' ? gate.open : null,
        }
      },
    )

    return c.json(health, 200)
  })

  return app
}

import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { z } from 'zod'
import { CYCLE_MINUTES } from '@app/core'
import { loadEnv } from '@app/shared'
import { buildCycleDeps } from './context.js'
import { runCycle } from './cycle.js'

/**
 * The optimizer is HTTP-triggered exactly as Cloud Scheduler triggers it in production, which is
 * why every validation scenario in quickstart.md is a `curl` rather than a five-minute wait.
 */
const CycleRequest = z.object({
  /**
   * The scheduled instant — also the idempotency key (FR-050).
   *
   * Optional, because Cloud Scheduler cannot template the scheduled instant into a request body.
   * When it is absent (or the literal placeholder the job definition sends), the instant is derived
   * by flooring the clock to the cycle cadence — which gives every delivery of the same scheduled
   * run the same key, which is the whole point of the field.
   */
  cycleId: z.string().min(1).optional(),
})

const SCHEDULER_PLACEHOLDER = '__SCHEDULED_INSTANT__'

export function cycleIdFor(requested: string | undefined, nowMs: number): string {
  if (requested && requested !== SCHEDULER_PLACEHOLDER) return requested
  const cadenceMs = CYCLE_MINUTES * 60_000
  return new Date(Math.floor(nowMs / cadenceMs) * cadenceMs).toISOString()
}

export function createOptimizerApp(): Hono {
  const app = new Hono()

  app.get('/health', (c) => c.json({ status: 'ok' }))

  app.post('/cycle', async (c) => {
    const body: unknown = await c.req.json().catch(() => ({}))
    const parsed = CycleRequest.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: 'validation_failed', details: parsed.error.issues }, 400)
    }

    const cycleId = cycleIdFor(parsed.data.cycleId, Date.now())
    const deps = await buildCycleDeps(cycleId)
    try {
      const result = await runCycle(deps, cycleId)
      // Always 200, including for a skip: a non-2xx makes Cloud Scheduler retry and stack another
      // attempt behind the cycle that is already running (FR-026, research R7).
      return c.json(result, 200)
    } catch (error) {
      deps.logger.error('cycle failed', { error, cycleId })
      // A failure is reported as 500 so it reaches the log-based metric behind the email alert
      // (FR-043); Cloud Scheduler is configured with retries 0, so this does not stack cycles.
      return c.json({ error: 'cycle_failed', cycleId }, 500)
    }
  })

  return app
}

const isEntrypoint = process.argv[1]?.includes('optimizer')
if (isEntrypoint) {
  const env = loadEnv()
  serve({ fetch: createOptimizerApp().fetch, port: env.PORT ?? env.OPTIMIZER_PORT }, (info) => {
    console.log(
      JSON.stringify({
        severity: 'INFO',
        message: `optimizer listening on :${info.port}`,
        labels: { component: 'optimizer' },
      }),
    )
  })
}

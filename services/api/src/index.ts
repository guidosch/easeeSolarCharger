import { pathToFileURL } from 'node:url'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { loadEnv } from '@app/shared'
import { buildApiDeps } from './context.js'
import type { ApiDeps } from './context.js'
import { ApiFailure } from './errors.js'
import { requireAuth } from './middleware/requireAuth.js'
import type { HonoEnv } from './middleware/requireAuth.js'
import { adminBasicAuth } from './middleware/adminBasicAuth.js'
import { adminChargerRoutes } from './routes/admin/chargers.js'
import { adminCycleRoutes } from './routes/admin/cycles.js'
import { adminHealthRoutes } from './routes/admin/health.js'
import { adminProviderRoutes } from './routes/admin/providers.js'
import { adminSessionRoutes } from './routes/admin/sessions.js'
import { adminTraceRoutes } from './routes/admin/trace.js'
import { authRoutes } from './routes/auth.js'
import { chargerRoutes } from './routes/chargers.js'
import { meRoutes } from './routes/me.js'
import { overrideRoutes } from './routes/override.js'
import { sessionRoutes } from './routes/sessions.js'
import { targetRoutes } from './routes/targets.js'

/**
 * The user + admin HTTP API (T041).
 *
 * Every route is mounted under `/api` so a single Firebase Hosting rewrite can send `/api/**` here
 * and everything else to the static bundle.
 */
export function createApiApp(deps: ApiDeps = buildApiDeps()): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>()

  app.use('*', cors({ origin: '*', allowHeaders: ['authorization', 'content-type'] }))

  app.onError((error, c) => {
    if (error instanceof ApiFailure) {
      const body = error.body()
      if (body.retryAfterSeconds !== undefined) {
        c.header('retry-after', String(body.retryAfterSeconds))
      }
      return c.json(body, error.status)
    }
    deps.logger.error('unhandled error in the API', { error, path: c.req.path })
    return c.json({ error: 'internal_error' as const }, 500)
  })

  app.get('/api/health', (c) => c.json({ status: 'ok' }))

  // Unauthenticated: this is where a token comes from.
  app.route('/api/auth', authRoutes(deps))

  // Everything below requires a verified Easee token (FR-001).
  app.use('/api/chargers/*', requireAuth(deps))
  app.use('/api/chargers', requireAuth(deps))
  app.use('/api/sessions', requireAuth(deps))
  app.use('/api/me', requireAuth(deps))

  app.route('/api/chargers', chargerRoutes(deps))
  app.route('/api/chargers', targetRoutes(deps))
  app.route('/api/chargers', overrideRoutes(deps))
  app.route('/api/sessions', sessionRoutes(deps))
  app.route('/api/me', meRoutes(deps))

  // The operator surface, behind its own credential and its own middleware (FR-005). Mounted after
  // the user routes so a mistake in the user middleware can never leak into it.
  app.use('/api/admin/*', adminBasicAuth(deps))
  app.route('/api/admin', adminCycleRoutes(deps))
  app.route('/api/admin', adminChargerRoutes(deps))
  app.route('/api/admin', adminTraceRoutes(deps))
  app.route('/api/admin', adminProviderRoutes(deps))
  app.route('/api/admin', adminSessionRoutes(deps))
  app.route('/api/admin', adminHealthRoutes(deps))

  return app
}

// Started directly (`node index.mjs`, `tsx src/index.ts`) rather than imported by a test, which is
// the only case that should bind a port. Compared as a file URL, not by name: the Cloud Run image
// runs the bundle as `/app/index.mjs`, so any check against the path spelling silently does nothing
// there and the container exits 0 before it ever listens on $PORT.
const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isEntrypoint) {
  const env = loadEnv()
  serve({ fetch: createApiApp().fetch, port: env.PORT ?? env.API_PORT }, (info) => {
    console.log(
      JSON.stringify({
        severity: 'INFO',
        message: `api listening on :${info.port}`,
        labels: { component: 'api' },
      }),
    )
  })
}

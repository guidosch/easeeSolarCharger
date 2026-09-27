import { Hono } from 'hono'
import type { AdminSessionView } from '@app/shared'
import type { ApiDeps } from '../../context.js'
import { toSummary } from '../sessions.js'

/** How many sessions the operator table shows. */
export const ADMIN_SESSION_LIMIT = 10

/**
 * `GET /admin/sessions` — the ten most recent sessions across all users, newest first.
 *
 * Each row is exactly the summary the user sees in their own history (`toSummary`), plus whose
 * session it was, so an operator reading a support question sees what the user saw.
 */
export function adminSessionRoutes(deps: ApiDeps): Hono {
  const app = new Hono()

  app.get('/sessions', async (c) => {
    const sessions = await deps.repos.sessions.recentAcrossUsers(ADMIN_SESSION_LIMIT)

    const userIds = [...new Set(sessions.map((s) => s.userId))]
    const users = await Promise.all(userIds.map((id) => deps.repos.users.byId(id)))
    const emails = new Map(userIds.map((id, i) => [id, users[i]?.email ?? null]))

    const views: AdminSessionView[] = sessions.map((session) => {
      const email = emails.get(session.userId)
      return {
        ...toSummary(session),
        user: { userId: session.userId, ...(email ? { email } : {}) },
      }
    })

    return c.json(views, 200)
  })

  return app
}

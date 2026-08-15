import { timingSafeEqual } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import type { ApiDeps } from '../context.js'

/**
 * Admin authentication (T109, FR-005).
 *
 * A single shared basic-auth credential, enforced by *separate* middleware from the user routes.
 * The accepted consequence is that admin reads carry no per-admin identity; charger *commands* are
 * still attributed per Principle III, through `cycles` and `chargerEvents`, regardless of who was
 * looking at the screen.
 *
 * With no credential configured this refuses everything. Failing closed matters more than
 * convenience here: an admin surface that quietly opened itself because an environment variable was
 * missing would expose every user's charging pattern.
 */
export function adminBasicAuth(deps: ApiDeps): MiddlewareHandler {
  return async (c, next) => {
    const configured = deps.env.ADMIN_PASSWORD
    const unauthorized = (message: string) => {
      c.header('WWW-Authenticate', 'Basic realm="Solar charging operator", charset="UTF-8"')
      return c.json({ error: 'token_invalid' as const, message }, 401)
    }

    if (!configured) {
      deps.logger.error('admin access refused: ADMIN_PASSWORD is not configured')
      return unauthorized('the admin surface is not configured')
    }

    const header = c.req.header('authorization') ?? ''
    const [scheme, encoded] = header.split(' ')
    if (scheme?.toLowerCase() !== 'basic' || !encoded) {
      return unauthorized('basic authentication required')
    }

    const [username = '', password = ''] = Buffer.from(encoded, 'base64')
      .toString('utf8')
      .split(':')
    if (
      !constantTimeEquals(username, deps.env.ADMIN_USERNAME) ||
      !constantTimeEquals(password, configured)
    ) {
      deps.logger.warn('admin access refused: bad credential', { path: c.req.path })
      return unauthorized('invalid credentials')
    }

    await next()
    return undefined
  }
}

/** Compares without leaking the length or the position of the first difference through timing. */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) {
    // Still do a comparison so a wrong-length guess costs the same as a wrong-value one.
    timingSafeEqual(left, left)
    return false
  }
  return timingSafeEqual(left, right)
}

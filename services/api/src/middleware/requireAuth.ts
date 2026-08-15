import type { MiddlewareHandler } from 'hono'
import type { ApiDeps } from '../context.js'
import { ApiFailure } from '../errors.js'
import type { VerifiedClaims } from './easeeAuth.js'

export type HonoEnv = {
  Variables: {
    user: VerifiedClaims
  }
}

/**
 * Verifies the bearer token on every request (FR-001, FR-002).
 *
 * Verification is local and therefore cheap enough to do per call — which is what the
 * constitution asks for, and stricter than its "re-check at most once per five minutes" ceiling
 * (research R6).
 */
export function requireAuth(deps: ApiDeps): MiddlewareHandler<HonoEnv> {
  return async (c, next) => {
    const header = c.req.header('authorization') ?? ''
    const [scheme, token] = header.split(' ')
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new ApiFailure('token_invalid', 'expected an Authorization: Bearer header')
    }

    const result = await deps.verifier.verify(token)
    if (!result.ok) {
      throw new ApiFailure(result.code, result.message)
    }

    c.set('user', result.claims)
    await next()
  }
}

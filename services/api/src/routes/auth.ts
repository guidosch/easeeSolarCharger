import { Hono } from 'hono'
import { LoginRequest, RefreshRequest } from '@app/shared'
import type { LoginResponse, MappedCharger } from '@app/shared'
import type { ApiDeps } from '../context.js'
import { ApiFailure, fromProviderError } from '../errors.js'
import type { HonoEnv } from '../middleware/requireAuth.js'
import { chargersForUser } from '../middleware/authorize.js'

/**
 * `POST /auth/login` and `POST /auth/refresh` (T059).
 *
 * The credentials are forwarded to Easee and the resulting tokens are handed straight back. The
 * password is never stored and never logged — it exists in this process for the duration of one
 * outbound request and nowhere else.
 */
export function authRoutes(deps: ApiDeps): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>()

  app.post('/login', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    const parsed = LoginRequest.safeParse(body)
    if (!parsed.success) {
      throw new ApiFailure('validation_failed', 'userName and password are required', {
        details: parsed.error.issues,
      })
    }

    const result = await deps.easeeAuth.login(parsed.data.userName, parsed.data.password)
    if (!result.ok) throw fromProviderError(result.error)

    return c.json(await sessionFor(deps, result.value), 200)
  })

  app.post('/refresh', async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    const parsed = RefreshRequest.safeParse(body)
    if (!parsed.success) {
      throw new ApiFailure('validation_failed', 'refreshToken is required', {
        details: parsed.error.issues,
      })
    }

    // Easee's refresh endpoint wants the (expired) access token alongside the refresh token; the
    // client sends only the latter, and an empty access token is what an expired session looks like.
    const header = c.req.header('authorization') ?? ''
    const accessToken = header.toLowerCase().startsWith('bearer ') ? header.slice(7) : ''

    const result = await deps.easeeAuth.refresh(accessToken, parsed.data.refreshToken)
    if (!result.ok) throw fromProviderError(result.error)

    return c.json(await sessionFor(deps, result.value), 200)
  })

  return app
}

async function sessionFor(
  deps: ApiDeps,
  tokens: { accessToken: string; refreshToken: string; expiresIn: number },
): Promise<LoginResponse> {
  // The token Easee just issued is verified locally like any other: it is the only way to learn the
  // `UserId` claim, and trusting an unverified token here would make the whole verifier optional.
  const verified = await deps.verifier.verify(tokens.accessToken)
  if (!verified.ok) throw new ApiFailure(verified.code, verified.message)

  const lots = await chargersForUser(deps, verified.claims.userId)
  const nowIso = new Date(deps.now()).toISOString()
  await deps.repos.users.touch({
    userId: verified.claims.userId,
    email: verified.claims.email,
    lotNumbers: lots.map((l) => l.lotNumber),
    nowIso,
  })

  const chargers: MappedCharger[] = lots.map((lot) => ({
    lotNumber: lot.lotNumber,
    chargerId: lot.chargerId,
    phases: lot.phases,
    maxCurrentA: lot.maxCurrentA,
  }))

  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: tokens.expiresIn,
    user: {
      userId: verified.claims.userId,
      ...(verified.claims.email ? { email: verified.claims.email } : {}),
    },
    chargers,
  }
}

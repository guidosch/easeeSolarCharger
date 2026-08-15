import type { BudgetLimiter } from '../http/budget.js'
import type { HttpClient } from '../http/client.js'
import type { Result } from '../http/errors.js'
import { err, ok } from '../http/errors.js'
import { EaseeTokenResponse } from './types.js'

/**
 * The Easee auth client (T030).
 *
 * Two distinct uses live here. End users log in through `services/api`, which proxies their
 * credentials and hands the tokens straight back — the password is never stored or logged. The
 * optimizer signs in as a dedicated technical account whose token is cached in Firestore, so a
 * cold-started instance does not re-login on every cycle.
 */

export type CachedToken = {
  accessToken: string
  refreshToken: string
  /** ISO instant at which the access token expires. */
  expiresAt: string
}

/** Implemented by `firestore/providerTokens.ts`; injected so this client stays I/O-agnostic. */
export interface TokenStore {
  read(): Promise<CachedToken | null>
  write(token: CachedToken): Promise<void>
}

/** Refresh this far before expiry rather than at it, so a long cycle cannot expire mid-flight. */
const REFRESH_SKEW_MS = 5 * 60_000

export class EaseeAuthClient {
  constructor(
    private readonly http: HttpClient,
    private readonly baseUrl: string,
    private readonly budget: BudgetLimiter,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async login(userName: string, password: string): Promise<Result<EaseeTokenResponse>> {
    return this.http.request<EaseeTokenResponse>(
      {
        provider: 'easee',
        url: `${this.baseUrl}/api/accounts/login`,
        method: 'POST',
        body: { userName, password },
        timeoutMs: 10_000,
        retries: 1,
        parse: parseTokenResponse,
      },
      this.budget,
    )
  }

  async refresh(accessToken: string, refreshToken: string): Promise<Result<EaseeTokenResponse>> {
    return this.http.request<EaseeTokenResponse>(
      {
        provider: 'easee',
        url: `${this.baseUrl}/api/accounts/refresh_token`,
        method: 'POST',
        body: { accessToken, refreshToken },
        timeoutMs: 10_000,
        retries: 1,
        parse: parseTokenResponse,
      },
      this.budget,
    )
  }

  private toCached(token: EaseeTokenResponse): CachedToken {
    return {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: new Date(this.now() + token.expiresIn * 1000).toISOString(),
    }
  }

  /**
   * The optimizer's technical-account token: reused from the cache while valid, refreshed with the
   * refresh token when it is not, and only re-minted from the Secret Manager credentials when the
   * refresh itself fails.
   */
  async technicalAccessToken(
    store: TokenStore,
    credentials: { userName: string; password: string },
  ): Promise<Result<string>> {
    const cached = await store.read()
    if (cached && Date.parse(cached.expiresAt) - this.now() > REFRESH_SKEW_MS) {
      return ok(cached.accessToken)
    }

    if (cached) {
      const refreshed = await this.refresh(cached.accessToken, cached.refreshToken)
      if (refreshed.ok) {
        await store.write(this.toCached(refreshed.value))
        return ok(refreshed.value.accessToken)
      }
    }

    const fresh = await this.login(credentials.userName, credentials.password)
    if (!fresh.ok) return err(fresh.error)
    await store.write(this.toCached(fresh.value))
    return ok(fresh.value.accessToken)
  }
}

export function parseTokenResponse(payload: unknown): Result<EaseeTokenResponse> {
  const parsed = EaseeTokenResponse.safeParse(payload)
  if (!parsed.success) {
    return err({
      kind: 'malformed',
      provider: 'easee',
      message: `token response did not match the contract: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
    })
  }
  return ok(parsed.data)
}

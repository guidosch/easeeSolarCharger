/**
 * The typed failure surface every provider client shares (Principle IV).
 *
 * There is no "silent default" variant on purpose: a caller must decide what a missing reading
 * means, because the one answer that is never acceptable is treating it as zero surplus (FR-016).
 */
export type ProviderName = 'easee' | 'solaredge' | 'openweather'

export type ProviderErrorKind =
  | 'timeout'
  | 'network'
  | 'rate_limited'
  | 'http_error'
  | 'malformed'
  | 'budget_exhausted'
  | 'auth'
  | 'gated'

export type ProviderError = {
  kind: ProviderErrorKind
  provider: ProviderName
  message: string
  status?: number
  retryAfterSeconds?: number
  /** How many attempts were made before giving up — recorded so the admin view can show it. */
  attempts?: number
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: ProviderError }

export const ok = <T>(value: T): Result<T> => ({ ok: true, value })
export const err = <T = never>(error: ProviderError): Result<T> => ({ ok: false, error })

/** Per-provider counters for one cycle; surfaced by `GET /admin/cycles` and `GET /admin/providers`. */
export type CallStats = {
  calls: number
  errors: number
  rateLimited: number
  budgetRemaining: number
}

export function emptyCallStats(budgetRemaining = 0): CallStats {
  return { calls: 0, errors: 0, rateLimited: 0, budgetRemaining }
}

import type { ContentfulStatusCode } from 'hono/utils/http-status'

/**
 * The error-code mapping table from contracts/user-api.md (T041).
 *
 * One table, used by every route, so the PWA can branch on `error` rather than on a status code
 * that two routes might disagree about.
 */
export type ApiErrorCode =
  | 'validation_failed'
  | 'deadline_too_soon'
  | 'token_expired'
  | 'token_invalid'
  | 'no_charger_mapped'
  | 'not_your_charger'
  | 'not_found'
  | 'upstream_rate_limited'
  | 'upstream_unavailable'
  | 'internal_error'

export const STATUS_FOR: Record<ApiErrorCode, ContentfulStatusCode> = {
  validation_failed: 400,
  deadline_too_soon: 400,
  token_expired: 401,
  token_invalid: 401,
  no_charger_mapped: 403,
  not_your_charger: 403,
  not_found: 404,
  upstream_rate_limited: 429,
  upstream_unavailable: 503,
  internal_error: 500,
}

export type ApiErrorBody = {
  error: ApiErrorCode
  message?: string
  details?: unknown
  /** Only on `deadline_too_soon` (FR-007). */
  earliestFeasibleDeadline?: string
  /** Passed straight through on a 429 so the client waits the same time we would. */
  retryAfterSeconds?: number
}

export class ApiFailure extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message?: string,
    readonly extra: Omit<ApiErrorBody, 'error' | 'message'> = {},
  ) {
    super(message ?? code)
    this.name = 'ApiFailure'
  }

  get status(): ContentfulStatusCode {
    return STATUS_FOR[this.code]
  }

  body(): ApiErrorBody {
    return {
      error: this.code,
      ...(this.message && this.message !== this.code ? { message: this.message } : {}),
      ...this.extra,
    }
  }
}

/** Maps a provider failure onto the user-facing contract. */
export function fromProviderError(error: { kind: string; retryAfterSeconds?: number }): ApiFailure {
  if (error.kind === 'rate_limited') {
    return new ApiFailure(
      'upstream_rate_limited',
      'the charging provider rate-limited this request',
      error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds },
    )
  }
  if (error.kind === 'auth') {
    return new ApiFailure('token_invalid', 'the charging provider rejected the credentials')
  }
  // A read failure is not a charging failure: the optimizer keeps running under the fail-safe
  // (FR-044), and the UI must say so rather than implying the car stopped charging.
  return new ApiFailure('upstream_unavailable', 'a provider is unavailable; charging continues')
}

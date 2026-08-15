import type { BudgetLimiter } from './budget.js'
import type { CallStats, ProviderError, ProviderName, Result } from './errors.js'
import { err, ok } from './errors.js'

/**
 * The shared outbound HTTP client (T027, Principle IV).
 *
 * Every dependency that would otherwise make this untestable — the clock, the sleep, the jitter
 * source and `fetch` itself — is injected, because the constitution forbids tests that call live
 * third-party APIs and a retry test that really waits eight seconds is a test nobody runs.
 */

export type HttpDeps = {
  fetch: typeof globalThis.fetch
  sleep: (ms: number) => Promise<void>
  now: () => number
  /** Jitter source; injected so a contract test can pin the backoff sequence. */
  random: () => number
}

export const defaultHttpDeps: HttpDeps = {
  fetch: (...args) => globalThis.fetch(...args),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  random: () => Math.random(),
}

export type RequestSpec<T> = {
  provider: ProviderName
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: unknown
  /** Explicit timeout — never unbounded (Principle IV). */
  timeoutMs?: number
  /** Number of *retries* after the first attempt. */
  retries?: number
  baseBackoffMs?: number
  /** Ceiling on *our own* exponential backoff. */
  maxBackoffMs?: number
  /** Ceiling on a wait the *provider* asked for via `Retry-After`; beyond it we give up instead. */
  maxRetryAfterMs?: number
  /** Parses the decoded payload into the domain model, or returns a `malformed` error. */
  parse: (payload: unknown) => Result<T>
}

const DEFAULTS = {
  timeoutMs: 10_000,
  retries: 2,
  baseBackoffMs: 500,
  maxBackoffMs: 8_000,
  // A cycle has a 4-minute lease and a 90-second target, so a minute of provider-requested waiting
  // is the most that can be honoured inside one cycle. Beyond that, being a cycle late is better.
  maxRetryAfterMs: 60_000,
}

function retryAfterSeconds(headers: Headers): number | undefined {
  const raw = headers.get('retry-after')
  if (!raw) return undefined
  const asNumber = Number(raw)
  if (Number.isFinite(asNumber)) return Math.max(0, asNumber)
  const asDate = Date.parse(raw)
  return Number.isNaN(asDate) ? undefined : Math.max(0, Math.round((asDate - Date.now()) / 1000))
}

function isRetryable(error: ProviderError): boolean {
  if (error.kind === 'timeout' || error.kind === 'network') return true
  if (error.kind === 'rate_limited') return true
  if (error.kind === 'http_error') return (error.status ?? 0) >= 500
  return false
}

export class HttpClient {
  constructor(
    private readonly deps: HttpDeps = defaultHttpDeps,
    /** Optional per-provider stats, mutated in place so a cycle can record what it spent. */
    private readonly stats?: Partial<Record<ProviderName, CallStats>>,
  ) {}

  private note(provider: ProviderName, field: keyof CallStats, amount = 1): void {
    const bucket = this.stats?.[provider]
    if (bucket) bucket[field] += amount
  }

  /**
   * Backoff is exponential *with jitter*: without it, thirty chargers that fail together retry in
   * lockstep and turn one provider hiccup into a self-inflicted rate limit.
   */
  private backoffMs(spec: RequestSpec<unknown>, attempt: number): number {
    const base = spec.baseBackoffMs ?? DEFAULTS.baseBackoffMs
    const max = spec.maxBackoffMs ?? DEFAULTS.maxBackoffMs
    const exponential = Math.min(max, base * 2 ** attempt)
    return Math.round(exponential * (0.5 + this.deps.random() * 0.5))
  }

  private async attempt<T>(spec: RequestSpec<T>): Promise<Result<T>> {
    const controller = new AbortController()
    const timeoutMs = spec.timeoutMs ?? DEFAULTS.timeoutMs
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await this.deps.fetch(spec.url, {
        method: spec.method ?? 'GET',
        headers: {
          accept: 'application/json',
          ...(spec.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...spec.headers,
        },
        ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
        signal: controller.signal,
      })

      if (response.status === 429) {
        this.note(spec.provider, 'rateLimited')
        return err({
          kind: 'rate_limited',
          provider: spec.provider,
          status: 429,
          message: 'provider rate-limited the request',
          ...(retryAfterSeconds(response.headers) === undefined
            ? {}
            : { retryAfterSeconds: retryAfterSeconds(response.headers) }),
        })
      }

      if (response.status === 401 || response.status === 403) {
        return err({
          kind: 'auth',
          provider: spec.provider,
          status: response.status,
          message: `provider rejected the credentials (${response.status})`,
        })
      }

      if (!response.ok) {
        return err({
          kind: 'http_error',
          provider: spec.provider,
          status: response.status,
          message: `unexpected status ${response.status}`,
        })
      }

      let payload: unknown
      try {
        const text = await response.text()
        payload = text.length === 0 ? null : JSON.parse(text)
      } catch (cause) {
        return err({
          kind: 'malformed',
          provider: spec.provider,
          message: `response body was not JSON: ${(cause as Error).message}`,
        })
      }

      return spec.parse(payload)
    } catch (cause) {
      const error = cause as Error
      const aborted = error.name === 'AbortError' || controller.signal.aborted
      return err({
        kind: aborted ? 'timeout' : 'network',
        provider: spec.provider,
        message: aborted ? `request timed out after ${timeoutMs} ms` : error.message,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Performs the request, honouring the budget before it is made and `Retry-After` when the
   * provider pushes back.
   */
  async request<T>(spec: RequestSpec<T>, budget?: BudgetLimiter): Promise<Result<T>> {
    const retries = spec.retries ?? DEFAULTS.retries
    let lastError: ProviderError | undefined

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (budget) {
        const allowed = budget.check(this.deps.now())
        if (!allowed.ok) {
          this.note(spec.provider, 'errors')
          return err({ ...allowed.error, attempts: attempt })
        }
        budget.consume(this.deps.now())
      }

      this.note(spec.provider, 'calls')
      const result = await this.attempt(spec)
      if (result.ok) return result

      lastError = { ...result.error, attempts: attempt + 1 }
      if (!isRetryable(result.error) || attempt === retries) break

      const retryAfter = result.error.retryAfterSeconds
      if (retryAfter === undefined) {
        await this.deps.sleep(this.backoffMs(spec, attempt))
      } else {
        const waitMs = retryAfter * 1000
        // Honouring `Retry-After` means waiting that long or not retrying at all — never retrying
        // early, which is what a capped wait would amount to.
        if (waitMs > (spec.maxRetryAfterMs ?? DEFAULTS.maxRetryAfterMs)) break
        await this.deps.sleep(waitMs)
      }
    }

    this.note(spec.provider, 'errors')
    return err(
      lastError ?? {
        kind: 'network',
        provider: spec.provider,
        message: 'request failed with no recorded cause',
      },
    )
  }
}

export { ok, err }

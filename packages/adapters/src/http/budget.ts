import type { ProviderName, Result } from './errors.js'
import { err, ok } from './errors.js'

/**
 * Budget enforcement (T028, Principle IV).
 *
 * Call volume is a correctness constraint, so the cap is checked *before* the request is made. A
 * client that discovers its limit from a 429 has already spent the call, and with SolarEdge's
 * 300/day that mistake blinds the optimizer for the rest of the day.
 */

export type Clock = () => number

/** A classic token bucket, used for the per-minute and per-rolling-window limits. */
export class TokenBucket {
  private tokens: number
  private lastRefillMs: number

  constructor(
    readonly capacity: number,
    readonly refillPerMs: number,
    startedAtMs: number,
    initialTokens = capacity,
  ) {
    this.tokens = initialTokens
    this.lastRefillMs = startedAtMs
  }

  private refill(nowMs: number): void {
    if (nowMs <= this.lastRefillMs) return
    this.tokens = Math.min(
      this.capacity,
      this.tokens + (nowMs - this.lastRefillMs) * this.refillPerMs,
    )
    this.lastRefillMs = nowMs
  }

  available(nowMs: number): number {
    this.refill(nowMs)
    return this.tokens
  }

  tryTake(nowMs: number, count = 1): boolean {
    this.refill(nowMs)
    if (this.tokens < count) return false
    this.tokens -= count
    return true
  }

  /** How long until `count` tokens exist, in ms. Used to spread writes across the cycle. */
  msUntilAvailable(nowMs: number, count = 1): number {
    this.refill(nowMs)
    if (this.tokens >= count) return 0
    return Math.ceil((count - this.tokens) / this.refillPerMs)
  }
}

export type BudgetLimiterOptions = {
  provider: ProviderName
  /** Hard daily cap, e.g. SolarEdge's 300/day. `null` for providers with only a rate limit. */
  dailyLimit: number | null
  /** Sustained-rate guard: `capacity` calls per `perMs`. */
  burst?: { capacity: number; perMs: number }
  /**
   * Calls already spent today, seeded from the recorded cycle history. Both services scale to
   * zero, so an in-memory counter alone would reset the day's budget on every cold start.
   */
  spentToday?: number
  startedAtMs: number
}

export class BudgetLimiter {
  private readonly provider: ProviderName
  private readonly dailyLimit: number | null
  private readonly bucket: TokenBucket | null
  private spentToday: number
  private dayKey: string

  constructor(options: BudgetLimiterOptions) {
    this.provider = options.provider
    this.dailyLimit = options.dailyLimit
    this.spentToday = options.spentToday ?? 0
    this.dayKey = BudgetLimiter.dayKey(options.startedAtMs)
    this.bucket = options.burst
      ? new TokenBucket(
          options.burst.capacity,
          options.burst.capacity / options.burst.perMs,
          options.startedAtMs,
        )
      : null
  }

  private static dayKey(nowMs: number): string {
    return new Date(nowMs).toISOString().slice(0, 10)
  }

  private rollDay(nowMs: number): void {
    const key = BudgetLimiter.dayKey(nowMs)
    if (key !== this.dayKey) {
      this.dayKey = key
      this.spentToday = 0
    }
  }

  remainingToday(nowMs: number): number {
    this.rollDay(nowMs)
    return this.dailyLimit === null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, this.dailyLimit - this.spentToday)
  }

  /** Refuses *before* the call is made. */
  check(nowMs: number): Result<void> {
    this.rollDay(nowMs)
    if (this.dailyLimit !== null && this.spentToday >= this.dailyLimit) {
      return err({
        kind: 'budget_exhausted',
        provider: this.provider,
        message: `daily budget of ${this.dailyLimit} calls for ${this.provider} is spent`,
      })
    }
    if (this.bucket && this.bucket.available(nowMs) < 1) {
      return err({
        kind: 'budget_exhausted',
        provider: this.provider,
        message: `rate budget for ${this.provider} is exhausted; retry in ${this.bucket.msUntilAvailable(nowMs)} ms`,
      })
    }
    return ok(undefined)
  }

  /** Consumes one unit of budget. Call only after `check` succeeded. */
  consume(nowMs: number): void {
    this.rollDay(nowMs)
    this.spentToday += 1
    this.bucket?.tryTake(nowMs)
  }

  /** Milliseconds to wait before the next call is permitted, for write spreading (research R5). */
  msUntilNext(nowMs: number): number {
    return this.bucket ? this.bucket.msUntilAvailable(nowMs) : 0
  }
}

/** The documented budgets (contracts/external-providers.md, research R1/R3/R4/R5). */
export const PROVIDER_BUDGETS = {
  /** 100 requests per rolling 5 minutes, enforced from 2026-09-01. */
  easeeObservations: { capacity: 100, perMs: 5 * 60_000 },
  /** 20 requests per minute. */
  easeeSettings: { capacity: 20, perMs: 60_000 },
  /** 300/day per token and per site+IP; the daylight gate keeps the worst case at 192. */
  solarEdgeDaily: 300,
  /** Four fetches a day, so a deferral never rests on a forecast older than six hours. */
  openWeatherDaily: 4,
} as const

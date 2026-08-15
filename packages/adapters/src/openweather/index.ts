import { z } from 'zod'
import { zonedParts } from '@app/core'
import type { BudgetLimiter } from '../http/budget.js'
import type { HttpClient } from '../http/client.js'
import type { Result } from '../http/errors.js'
import { err, ok } from '../http/errors.js'

/**
 * The OpenWeatherMap client (T077, research R4).
 *
 * The 5 day / 3 hour forecast is on the genuinely free plan and needs no payment method. One Call
 * 3.0 was rejected precisely because its free tier sits inside a subscription that requires a card,
 * which puts unbounded cost risk on a system whose stated goal is to cost nothing (SC-012).
 *
 * `clouds.all` is the proxy for next-day production. It is coarse, and that is acceptable: the
 * forecast drives one binary decision (defer or not), never a setpoint.
 */

const ForecastEntry = z.object({
  dt: z.number(),
  clouds: z.object({ all: z.number().min(0).max(100) }),
})

const ForecastResponse = z.object({
  list: z.array(ForecastEntry).min(1),
})

/** Hours of the local day in which PV production is worth forecasting. */
export const DAYTIME_FROM_HOUR = 9
export const DAYTIME_TO_HOUR = 17

/** Tomorrow must be at least this many points less cloudy before a deferral is even considered. */
export const DEFER_CLOUD_COVER_MARGIN = 25

export type Forecast = {
  cloudCoverRestOfTodayPct: number
  cloudCoverTomorrowPct: number
  /**
   * The *weather* half of the R4 rule: tomorrow is materially sunnier than the rest of today.
   *
   * The other two conditions — the deadline being more than 24 h away, and the target remaining
   * reachable after the deferral — depend on a target, so they are applied in `packages/core`
   * (`decide`, ladder rule 5 / T082). A client that claimed to know them would be guessing.
   */
  deferRecommended: boolean
  fetchedAt: string
}

export function parseForecast(
  payload: unknown,
  nowIso: string,
  timeZone: string,
): Result<Forecast> {
  const parsed = ForecastResponse.safeParse(payload)
  if (!parsed.success) {
    return err({
      kind: 'malformed',
      provider: 'openweather',
      message: `forecast did not match the contract: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
    })
  }

  const nowMs = Date.parse(nowIso)
  const today = dayKey(nowMs, timeZone)
  const tomorrow = dayKey(nowMs + 24 * 3_600_000, timeZone)

  const restOfToday: number[] = []
  const tomorrowBlocks: number[] = []

  for (const entry of parsed.data.list) {
    const atMs = entry.dt * 1000
    const parts = zonedParts(atMs, timeZone)
    if (parts.hour < DAYTIME_FROM_HOUR || parts.hour >= DAYTIME_TO_HOUR) continue
    const key = dayKey(atMs, timeZone)
    if (key === today && atMs >= nowMs) restOfToday.push(entry.clouds.all)
    else if (key === tomorrow) tomorrowBlocks.push(entry.clouds.all)
  }

  if (tomorrowBlocks.length === 0) {
    return err({
      kind: 'malformed',
      provider: 'openweather',
      message: 'forecast covered no daytime blocks for tomorrow',
    })
  }

  const cloudCoverRestOfTodayPct = round(mean(restOfToday))
  const cloudCoverTomorrowPct = round(mean(tomorrowBlocks))

  return ok({
    cloudCoverRestOfTodayPct,
    cloudCoverTomorrowPct,
    // No remaining daylight today means there is nothing to compare against, and "tomorrow is
    // better than nothing" is not a reason to defer.
    deferRecommended:
      restOfToday.length > 0 &&
      cloudCoverTomorrowPct <= cloudCoverRestOfTodayPct - DEFER_CLOUD_COVER_MARGIN,
    fetchedAt: nowIso,
  })
}

export class OpenWeatherClient {
  constructor(
    private readonly http: HttpClient,
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly site: { latitude: number; longitude: number },
    private readonly budget: BudgetLimiter,
    private readonly timeZone = 'Europe/Zurich',
  ) {}

  async forecast(nowIso: string): Promise<Result<Forecast>> {
    const url =
      `${this.baseUrl}/data/2.5/forecast?lat=${this.site.latitude}&lon=${this.site.longitude}` +
      `&appid=${encodeURIComponent(this.apiKey)}&units=metric`

    return this.http.request<Forecast>(
      {
        provider: 'openweather',
        url,
        timeoutMs: 10_000,
        parse: (payload) => parseForecast(payload, nowIso, this.timeZone),
      },
      this.budget,
    )
  }

  remainingToday(nowMs: number): number {
    return this.budget.remainingToday(nowMs)
  }
}

function dayKey(ms: number, timeZone: string): string {
  const { year, month, day } = zonedParts(ms, timeZone)
  return `${year}-${month}-${day}`
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}

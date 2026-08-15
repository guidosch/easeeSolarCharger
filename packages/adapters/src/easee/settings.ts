import type { BudgetLimiter } from '../http/budget.js'
import type { HttpClient } from '../http/client.js'
import type { Result } from '../http/errors.js'
import { err, ok } from '../http/errors.js'

/**
 * The Easee settings client (T032, research R5).
 *
 * This system writes exactly one setting, `dynamicChargerCurrent` — the lowest tier of Easee's
 * limit hierarchy. That is what makes Principle I's "MUST NOT bypass the external load management"
 * structural rather than a promise: writing only at this level, the system is incapable of raising
 * a cap the load manager lowered. The guard below is the code-level enforcement the contract asks
 * for, not a convention.
 */
export const ONLY_PERMITTED_SETTING = 'dynamicChargerCurrent'

export type ChargerSettings = { dynamicChargerCurrent: number }

export function assertOnlyDynamicCurrent(
  settings: Record<string, unknown>,
): Result<ChargerSettings> {
  const keys = Object.keys(settings)
  const forbidden = keys.filter((k) => k !== ONLY_PERMITTED_SETTING)
  if (forbidden.length > 0) {
    return err({
      kind: 'malformed',
      provider: 'easee',
      message:
        `refusing to write Easee settings ${forbidden.join(', ')}: this system may only write ` +
        `${ONLY_PERMITTED_SETTING} (Principle I, research R5)`,
    })
  }
  const value = settings[ONLY_PERMITTED_SETTING]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return err({
      kind: 'malformed',
      provider: 'easee',
      message: `${ONLY_PERMITTED_SETTING} must be a non-negative number, got ${String(value)}`,
    })
  }
  return ok({ dynamicChargerCurrent: value })
}

export class EaseeSettingsClient {
  constructor(
    private readonly http: HttpClient,
    private readonly baseUrl: string,
    /** Token bucket at 20 writes/minute; a cycle touching all 30 chargers spreads over two minutes. */
    private readonly budget: BudgetLimiter,
  ) {}

  /** Milliseconds the caller should wait before the next write is permitted. */
  msUntilNextWrite(nowMs: number): number {
    return this.budget.msUntilNext(nowMs)
  }

  async setDynamicCurrent(
    chargerId: string,
    amps: number,
    accessToken: string,
  ): Promise<Result<ChargerSettings>> {
    const guarded = assertOnlyDynamicCurrent({ [ONLY_PERMITTED_SETTING]: amps })
    if (!guarded.ok) return guarded

    return this.http.request<ChargerSettings>(
      {
        provider: 'easee',
        url: `${this.baseUrl}/api/chargers/${encodeURIComponent(chargerId)}/settings`,
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}` },
        body: guarded.value,
        timeoutMs: 8_000,
        // A lost write is re-applied next cycle; hammering a rate-limited settings endpoint is
        // worse than being one cycle late.
        retries: 1,
        parse: () => ok(guarded.value),
      },
      this.budget,
    )
  }
}

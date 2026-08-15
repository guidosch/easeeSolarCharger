import { randomUUID } from 'node:crypto'
import {
  BudgetLimiter,
  EaseeAuthClient,
  EaseeObservationsClient,
  EaseeSettingsClient,
  HttpClient,
  OpenWeatherClient,
  PROVIDER_BUDGETS,
  ProviderTokensRepo,
  SolarEdgeClient,
  checkDaylightGate,
  getDb,
} from '@app/adapters'
import type { ChargerObservation, Result } from '@app/adapters'
import { DEFAULT_SCHEDULER_CONFIG } from '@app/core'
import { correlationIdForCycle, createLogger, loadEnv, requireOptimizerSecrets } from '@app/shared'
import type { AppEnv } from '@app/shared'
import type {
  ChargerReader,
  CycleDeps,
  ForecastReader,
  ProviderStats,
  SetpointWriter,
  SitePower,
  SurplusReader,
} from './ports.js'

/** Wires the production dependencies. The replay harness builds the same shape from fixtures. */

function emptyStats(): ProviderStats {
  return {
    easee: {
      calls: 0,
      errors: 0,
      rateLimited: 0,
      budgetRemaining: PROVIDER_BUDGETS.easeeObservations.capacity,
    },
    solaredge: {
      calls: 0,
      errors: 0,
      rateLimited: 0,
      budgetRemaining: PROVIDER_BUDGETS.solarEdgeDaily,
    },
    openweather: {
      calls: 0,
      errors: 0,
      rateLimited: 0,
      budgetRemaining: PROVIDER_BUDGETS.openWeatherDaily,
    },
  }
}

/**
 * Holds the technical-account token for the duration of a cycle. Acquiring it once per cycle rather
 * than once per charger keeps thirty reads at thirty requests (research R1).
 */
class EaseeSession {
  private token: string | null = null

  constructor(
    private readonly auth: EaseeAuthClient,
    private readonly store: ProviderTokensRepo,
    private readonly credentials: { userName: string; password: string },
  ) {}

  async accessToken(): Promise<Result<string>> {
    if (this.token) return { ok: true, value: this.token }
    const result = await this.auth.technicalAccessToken(this.store, this.credentials)
    if (result.ok) this.token = result.value
    return result
  }
}

class EaseeChargerReader implements ChargerReader {
  constructor(
    private readonly client: EaseeObservationsClient,
    private readonly session: EaseeSession,
  ) {}

  async read(
    serialNumber: string,
    observedAtFallback: string,
  ): Promise<Result<ChargerObservation>> {
    const token = await this.session.accessToken()
    if (!token.ok) return token
    return this.client.read(serialNumber, token.value, observedAtFallback)
  }
}

class EaseeSetpointWriter implements SetpointWriter {
  constructor(
    private readonly client: EaseeSettingsClient,
    private readonly session: EaseeSession,
  ) {}

  async write(chargerId: string, amps: number) {
    const token = await this.session.accessToken()
    if (!token.ok) return token
    return this.client.setDynamicCurrent(chargerId, amps, token.value)
  }

  msUntilNextWrite(nowMs: number): number {
    return this.client.msUntilNextWrite(nowMs)
  }
}

/**
 * A provider with no credentials configured is reported as exactly that — a typed failure the core
 * turns into deadline-only mode. It is never a zero (FR-016).
 */
const unavailable = <T>(provider: 'solaredge' | 'openweather', message: string): Result<T> => ({
  ok: false,
  error: { kind: 'gated', provider, message },
})

export const noSurplusReader: SurplusReader = {
  read: async () =>
    unavailable('solaredge', 'no SolarEdge API key or site id configured; running deadline-only'),
}

export const noForecastReader: ForecastReader = {
  read: async () => unavailable('openweather', 'no OpenWeatherMap API key configured'),
}

/**
 * The surplus reader, behind the daylight gate.
 *
 * The gate is checked *before* the call, so a night-time cycle costs no budget at all — which is
 * what keeps the worst case at 192 calls against SolarEdge's 300/day (FR-045, research R3).
 */
class GatedSurplusReader implements SurplusReader {
  constructor(
    private readonly client: SolarEdgeClient,
    private readonly site: { latitude: number; longitude: number },
  ) {}

  async read(nowIso: string): Promise<Result<SitePower>> {
    const gate = checkDaylightGate({
      nowIso,
      latitude: this.site.latitude,
      longitude: this.site.longitude,
      config: DEFAULT_SCHEDULER_CONFIG,
    })
    if (!gate.ok) return gate
    return this.client.currentPowerFlow(nowIso)
  }
}

export type BuildOptions = {
  env?: AppEnv
  surplus?: SurplusReader
  forecast?: ForecastReader
  now?: () => number
}

export async function buildCycleDeps(
  cycleId: string,
  options: BuildOptions = {},
): Promise<CycleDeps> {
  const env = options.env ?? loadEnv()
  const now = options.now ?? (() => Date.now())
  const db = getDb(env.GOOGLE_CLOUD_PROJECT)
  const stats = emptyStats()
  const http = new HttpClient(undefined, stats)

  const readBudget = new BudgetLimiter({
    provider: 'easee',
    dailyLimit: null,
    burst: PROVIDER_BUDGETS.easeeObservations,
    startedAtMs: now(),
  })
  const writeBudget = new BudgetLimiter({
    provider: 'easee',
    dailyLimit: null,
    burst: PROVIDER_BUDGETS.easeeSettings,
    startedAtMs: now(),
  })

  const auth = new EaseeAuthClient(http, env.EASEE_API_BASE, readBudget, now)
  const credentials = requireOptimizerSecrets(env)
  const session = new EaseeSession(auth, new ProviderTokensRepo(db), {
    userName: credentials.easeeUsername,
    password: credentials.easeePassword,
  })

  return {
    db,
    logger: createLogger({ component: 'optimizer', correlationId: correlationIdForCycle(cycleId) }),
    now,
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    schedulerVersion: env.SCHEDULER_VERSION,
    site: { latitude: env.SITE_LATITUDE, longitude: env.SITE_LONGITUDE },
    chargers: new EaseeChargerReader(
      new EaseeObservationsClient(http, env.EASEE_API_BASE, readBudget),
      session,
    ),
    setpoints: new EaseeSetpointWriter(
      new EaseeSettingsClient(http, env.EASEE_API_BASE, writeBudget),
      session,
    ),
    surplus: options.surplus ?? buildSurplusReader(env, http, now),
    forecast: options.forecast ?? buildForecastReader(env, http, now),
    stats,
    instanceId: `${cycleId}-${randomUUID().slice(0, 8)}`,
  }
}

function buildSurplusReader(env: AppEnv, http: HttpClient, now: () => number): SurplusReader {
  if (!env.SOLAREDGE_API_KEY || !env.SOLAREDGE_SITE_ID) return noSurplusReader
  const client = new SolarEdgeClient(
    http,
    env.SOLAREDGE_API_BASE,
    env.SOLAREDGE_API_KEY,
    env.SOLAREDGE_SITE_ID,
    new BudgetLimiter({
      provider: 'solaredge',
      dailyLimit: PROVIDER_BUDGETS.solarEdgeDaily,
      startedAtMs: now(),
    }),
  )
  return new GatedSurplusReader(client, {
    latitude: env.SITE_LATITUDE,
    longitude: env.SITE_LONGITUDE,
  })
}

function buildForecastReader(env: AppEnv, http: HttpClient, now: () => number): ForecastReader {
  if (!env.OPENWEATHER_API_KEY) return noForecastReader
  const client = new OpenWeatherClient(
    http,
    env.OPENWEATHER_API_BASE,
    env.OPENWEATHER_API_KEY,
    { latitude: env.SITE_LATITUDE, longitude: env.SITE_LONGITUDE },
    new BudgetLimiter({
      provider: 'openweather',
      dailyLimit: PROVIDER_BUDGETS.openWeatherDaily,
      startedAtMs: now(),
    }),
    DEFAULT_SCHEDULER_CONFIG.timezone,
  )
  // The port speaks `read`; the client speaks `forecast`. Keeping the port's vocabulary lets the
  // replay harness substitute a fixture without knowing what a weather API is.
  return { read: (nowIso: string) => client.forecast(nowIso) }
}

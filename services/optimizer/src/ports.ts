import type { ChargerObservation, Result } from '@app/adapters'
import type { Logger } from '@app/shared'
import type { Firestore } from 'firebase-admin/firestore'

/**
 * The optimizer's dependencies, expressed as narrow ports rather than concrete clients.
 *
 * This is what makes `pnpm replay` a real exercise of the production code path instead of a
 * parallel implementation: the replay harness supplies fixture-backed ports, the deployed service
 * supplies HTTP-backed ones, and `cycle.ts` cannot tell the difference.
 */

export type SitePower = {
  /** Negative on import (contracts/external-providers.md). */
  gridExportKw: number
  loadKw: number
  pvKw: number
  observedAt: string
}

export type Forecast = {
  cloudCoverRestOfTodayPct: number
  cloudCoverTomorrowPct: number
  deferRecommended: boolean
  fetchedAt: string
}

export interface ChargerReader {
  read(serialNumber: string, observedAtFallback: string): Promise<Result<ChargerObservation>>
}

export interface SetpointWriter {
  write(chargerId: string, amps: number): Promise<Result<{ dynamicChargerCurrent: number }>>
  /** Milliseconds to wait before the next write is permitted, for spreading across the cycle. */
  msUntilNextWrite(nowMs: number): number
}

export interface SurplusReader {
  /** The daylight/winter gate lives inside the implementation, which may refuse with `gated`. */
  read(nowIso: string): Promise<Result<SitePower>>
}

export interface ForecastReader {
  read(nowIso: string): Promise<Result<Forecast>>
}

export type ProviderStats = {
  easee: { calls: number; errors: number; rateLimited: number; budgetRemaining: number }
  solaredge: { calls: number; errors: number; rateLimited: number; budgetRemaining: number }
  openweather: { calls: number; errors: number; rateLimited: number; budgetRemaining: number }
}

export type CycleDeps = {
  db: Firestore
  logger: Logger
  /** Injected clock. The optimizer may read it; `packages/core` may not. */
  now: () => number
  /** Injected so write-spreading across the 20/min bucket is instant under test. */
  sleep: (ms: number) => Promise<void>
  schedulerVersion: string
  site: { latitude: number; longitude: number }
  chargers: ChargerReader
  setpoints: SetpointWriter
  surplus: SurplusReader
  forecast: ForecastReader
  stats: ProviderStats
  /** Identifies this execution in the lease and the logs. */
  instanceId: string
  /** Set by `pnpm cycle:dry-run` — compute and record nothing, write no setpoints. */
  dryRun?: boolean
}

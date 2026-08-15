import { CYCLE_MINUTES } from './config.js'
import type { SchedulerConfig, SurplusQuality } from './types.js'

/**
 * Surplus estimation, smoothing and staleness (T079, research R2, FR-015..FR-017).
 *
 * All of it is pure: the optimizer supplies the raw numbers and the previous state, and gets back
 * the values it records in the cycle. Nothing here reads a clock.
 */

/**
 * Available surplus, not *unused* surplus.
 *
 * `gridExportKw` already has this system's own charging subtracted from it — the cars are part of
 * the site load. Adding that power back is what stops the optimizer from chasing its own tail:
 * without it, ramping up would reduce the measured export, which would look like less surplus, which
 * would ramp it down again (FR-015).
 */
export function surplusRawKw(gridExportKw: number, ownChargingKw: number): number {
  return round(gridExportKw + ownChargingKw)
}

/**
 * Exponential moving average, α = 0.4 — roughly a three-cycle time constant, which damps heat-pump
 * and house-load spikes without hiding a real cloud edge for long (research R2).
 */
export function ewma(previousSmoothedKw: number | null, rawKw: number, alpha: number): number {
  if (previousSmoothedKw === null) return round(rawKw)
  return round(alpha * rawKw + (1 - alpha) * previousSmoothedKw)
}

/**
 * How old a reading may be before it stops being usable.
 *
 * `fresh` is one cycle — the surplus poll and the optimizer loop share a cadence, so a reading is
 * normally exactly one cycle old. Beyond the cutoff the reading is `unusable` and the core drops to
 * deadline-only mode; it is never replaced by a zero (FR-016).
 */
export function classifyQuality(
  ageMinutes: number | null,
  config: Pick<SchedulerConfig, 'stalenessCutoffMinutes'>,
): SurplusQuality {
  if (ageMinutes === null) return 'unusable'
  if (ageMinutes > config.stalenessCutoffMinutes) return 'unusable'
  if (ageMinutes > CYCLE_MINUTES) return 'stale'
  return 'fresh'
}

/** A setpoint is only rewritten when the target moves by at least the deadband (research R2). */
export function withinDeadband(
  commandedA: number,
  targetA: number,
  config: Pick<SchedulerConfig, 'deadbandA'>,
): boolean {
  return Math.abs(targetA - commandedA) < config.deadbandA
}

export type HysteresisCounters = {
  consecutiveAboveFloor: number
  consecutiveBelowFloor: number
}

/**
 * Start/stop hysteresis: two consecutive cycles above the floor before starting, two below before
 * stopping (research R2).
 *
 * This is what stops a passing cloud from dropping a charging session and a single spike from
 * starting one — the failure this whole mechanism exists to prevent is oscillation, not
 * under-delivery.
 */
export function nextHysteresis(
  previous: HysteresisCounters,
  shareClearsFloor: boolean,
): HysteresisCounters {
  return shareClearsFloor
    ? { consecutiveAboveFloor: previous.consecutiveAboveFloor + 1, consecutiveBelowFloor: 0 }
    : { consecutiveAboveFloor: 0, consecutiveBelowFloor: previous.consecutiveBelowFloor + 1 }
}

/** May a charger that is *not* currently charging start on this cycle? */
export function mayStart(
  counters: HysteresisCounters,
  config: Pick<SchedulerConfig, 'startDelayCycles'>,
): boolean {
  // The current cycle counts, so the first cycle above the floor is `consecutiveAboveFloor + 1`.
  return counters.consecutiveAboveFloor + 1 >= config.startDelayCycles
}

/** Must a charger that *is* currently charging stop on this cycle? */
export function mustStop(
  counters: HysteresisCounters,
  config: Pick<SchedulerConfig, 'stopDelayCycles'>,
): boolean {
  return counters.consecutiveBelowFloor + 1 >= config.stopDelayCycles
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

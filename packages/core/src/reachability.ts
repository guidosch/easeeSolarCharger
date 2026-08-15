import { DEADLINE_RISK_MARGIN } from './config.js'
import { lowPriceMinutesBetween, parseInstant } from './tariff.js'
import { ampsToKw } from './units.js'
import type { ChargerTarget, Phases, Reachability, SchedulerConfig } from './types.js'

export type ChargerCapability = {
  maxCurrentA: number
  phases: Phases
}

/**
 * Can this target still be met (T049, Principle II)?
 *
 * Reachability is evaluated **within** the price policy, not around it. Only remaining *low-price*
 * time counts, because a high-price window is not time this system is allowed to spend — so a
 * target may legitimately be unreachable. That is a reportable outcome (FR-036), not a licence to
 * import at peak tariff.
 *
 * The figure is deliberately optimistic about solar and pessimistic about nothing else: it assumes
 * the charger can run at its maximum for every remaining low-price minute. A target this function
 * calls unreachable cannot be met by any schedule the ladder permits.
 */
export function isReachable(
  target: ChargerTarget,
  nowIso: string,
  config: SchedulerConfig,
  capability: ChargerCapability,
): Reachability {
  return evaluateReachability(target, nowIso, config, capability).reachability
}

export type ReachabilityEvaluation = {
  reachability: Reachability
  /**
   * How much more energy the remaining low-price time could deliver than the target still needs.
   * `1.0` means it fits exactly. `decide` uses this rather than the coarse state so the deadline
   * fallback can have a hysteresis band instead of a single threshold to chatter across.
   */
  ratio: number
}

/**
 * The single walk.
 *
 * `isReachable` and the ratio come from the same pass on purpose: walking the remaining low-price
 * time is the most expensive thing the core does, and computing it twice per charger doubled the
 * cost of a cycle for no new information.
 */
export function evaluateReachability(
  target: ChargerTarget,
  nowIso: string,
  config: SchedulerConfig,
  capability: ChargerCapability,
): ReachabilityEvaluation {
  const remainingKwh = target.energyKwh - target.deliveredKwh
  if (remainingKwh <= 0) {
    return {
      reachability: { state: 'reachable', expectedShortfallKwh: 0 },
      ratio: Number.POSITIVE_INFINITY,
    }
  }

  if (parseInstant(target.deadline) <= parseInstant(nowIso)) {
    return {
      reachability: { state: 'unreachable', expectedShortfallKwh: round(remainingKwh) },
      ratio: 0,
    }
  }

  const lowPriceHours = lowPriceMinutesBetween(nowIso, target.deadline, config) / 60
  const deliverableKwh = ampsToKw(capability.maxCurrentA, capability.phases) * lowPriceHours
  const ratio = deliverableKwh / remainingKwh

  if (deliverableKwh < remainingKwh) {
    return {
      reachability: {
        state: 'unreachable',
        expectedShortfallKwh: round(remainingKwh - deliverableKwh),
      },
      ratio,
    }
  }
  if (deliverableKwh < remainingKwh * DEADLINE_RISK_MARGIN) {
    return { reachability: { state: 'at_risk', expectedShortfallKwh: 0 }, ratio }
  }
  return { reachability: { state: 'reachable', expectedShortfallKwh: 0 }, ratio }
}

export function deliverableRatio(
  target: ChargerTarget,
  nowIso: string,
  config: SchedulerConfig,
  capability: ChargerCapability,
): number {
  return evaluateReachability(target, nowIso, config, capability).ratio
}

/**
 * Rounding is part of the contract, not presentation: an unrounded float would make two replays of
 * the same cycle differ in the last bit and fail SC-010's byte-identical comparison.
 */
function round(kwh: number): number {
  return Math.round(kwh * 1000) / 1000
}

export { round as roundKwh }

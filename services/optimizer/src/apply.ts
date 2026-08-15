import { wasReset } from '@app/adapters'
import type { ChargerDecision } from '@app/core'
import type { GatheredCharger } from './gather.js'
import type { CycleDeps } from './ports.js'

/**
 * Apply (T053): turn decisions into `dynamicChargerCurrent` writes.
 *
 * Three rules govern *whether* a write happens at all, and all three exist to protect the hardware
 * and the rate limit rather than to save effort:
 *
 *  - the ±1 A deadband, so a noisy surplus estimate does not rewrite thirty setpoints every five
 *    minutes ("some cars might get upset if the current is changed too frequently", research R5);
 *  - the plug-in re-apply, because Easee resets `dynamicChargerCurrent` when a car is plugged in,
 *    so a previously written value must never be assumed to have survived;
 *  - the 20-writes-per-minute token bucket, which a worst-case cycle touching all thirty chargers
 *    spreads across at least two minutes.
 */

export type AppliedWrite = {
  chargerId: string
  amps: number
  reason: 'deadband' | 'reapply_after_reset'
  ok: boolean
  error?: string
}

export type ApplyResult = {
  writes: AppliedWrite[]
  /** Chargers whose commanded current changed, for the charger-document patch. */
  commanded: Map<string, number>
}

const PLUGGED_IN_MODES = new Set([2, 3, 6])

export function needsWrite(
  charger: GatheredCharger,
  targetCurrentA: number,
  deadbandA: number,
): AppliedWrite['reason'] | null {
  const previousCommanded = charger.previous.commandedCurrentA
  const observation = charger.observation
  if (!observation) return null // could not be read; do not command it this cycle

  // A plug-in resets the setpoint, so re-apply it whatever the deadband says.
  const pluggedInThisCycle =
    charger.previous.opMode === 1 && PLUGGED_IN_MODES.has(observation.opMode)
  if (
    targetCurrentA > 0 &&
    (pluggedInThisCycle ||
      wasReset({
        commandedCurrentA: previousCommanded,
        dynamicChargerCurrentA: observation.dynamicCurrentA,
      }))
  ) {
    return 'reapply_after_reset'
  }

  if (Math.abs(targetCurrentA - previousCommanded) >= deadbandA) return 'deadband'
  return null
}

export async function apply(
  deps: CycleDeps,
  chargers: GatheredCharger[],
  decisions: ChargerDecision[],
  deadbandA: number,
): Promise<ApplyResult> {
  const byChargerId = new Map(chargers.map((c) => [c.lot.chargerId, c]))
  const writes: AppliedWrite[] = []
  const commanded = new Map<string, number>()

  for (const decision of decisions) {
    const charger = byChargerId.get(decision.chargerId)
    if (!charger) continue

    const reason = needsWrite(charger, decision.targetCurrentA, deadbandA)
    if (reason === null) continue

    if (deps.dryRun) {
      writes.push({
        chargerId: decision.chargerId,
        amps: decision.targetCurrentA,
        reason,
        ok: true,
      })
      commanded.set(decision.chargerId, decision.targetCurrentA)
      continue
    }

    // Spread the writes rather than discovering the 20/min limit from a 429.
    const waitMs = deps.setpoints.msUntilNextWrite(deps.now())
    if (waitMs > 0) await deps.sleep(waitMs)

    const result = await deps.setpoints.write(decision.chargerId, decision.targetCurrentA)
    if (result.ok) {
      writes.push({
        chargerId: decision.chargerId,
        amps: decision.targetCurrentA,
        reason,
        ok: true,
      })
      commanded.set(decision.chargerId, decision.targetCurrentA)
    } else {
      // A failed write is not a failed cycle: the setpoint is simply unchanged, the read-back will
      // record it as `lost`, and the next cycle tries again.
      writes.push({
        chargerId: decision.chargerId,
        amps: decision.targetCurrentA,
        reason,
        ok: false,
        error: result.error.message,
      })
      deps.logger.warn('setpoint write failed; leaving the charger as it was', {
        chargerId: decision.chargerId,
        amps: decision.targetCurrentA,
        error: result.error,
      })
    }
  }

  return { writes, commanded }
}

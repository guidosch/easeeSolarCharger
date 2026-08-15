import type { Discrepancy, ReadBackDoc } from '@app/adapters'
import type { GatheredCharger } from './gather.js'

/**
 * Read-back reconciliation (T054, FR-028, Principle I).
 *
 * The command this system issued is an intention; observation 114 is what the car is actually
 * getting. Reconciling the two is not diagnostics — it is the mechanism by which the system notices
 * that the external load manager overruled it, and adapts on the next cycle instead of insisting.
 */

/** Below this, a difference between commanded and delivered current is measurement noise. */
export const CAP_TOLERANCE_A = 1

export function classifyDiscrepancy(charger: {
  commandedCurrentA: number
  dynamicChargerCurrentA: number
  deliveredCurrentA: number
  opMode: number
}): Discrepancy {
  if (charger.commandedCurrentA <= 0) return 'none'

  // `lost` — the charger does not even hold the setpoint. Most often a plug-in reset it
  // (research R5); occasionally the write never landed.
  if (charger.dynamicChargerCurrentA !== charger.commandedCurrentA) return 'lost'

  // `capped` — the setpoint stuck but less current is flowing. Only meaningful while the car is
  // actually charging: a plugged-in car that has not started drawing yet is not being capped.
  if (
    charger.opMode === 3 &&
    charger.deliveredCurrentA < charger.commandedCurrentA - CAP_TOLERANCE_A
  ) {
    return 'capped'
  }

  return 'none'
}

/** The previous cycle's commanded-versus-delivered picture, recorded with this cycle. */
export function readBack(chargers: GatheredCharger[]): ReadBackDoc[] {
  return chargers.map((charger) => {
    const commandedCurrentA = charger.previous.commandedCurrentA
    const deliveredCurrentA =
      charger.observation?.deliveredCurrentA ?? charger.previous.outputCurrentA
    const dynamicChargerCurrentA =
      charger.observation?.dynamicCurrentA ?? charger.previous.dynamicChargerCurrentA
    const opMode = charger.observation?.opMode ?? charger.previous.opMode

    return {
      chargerId: charger.lot.chargerId,
      commandedCurrentA,
      deliveredCurrentA,
      dynamicChargerCurrentA,
      // A charger that could not be read this cycle is not evidence of anything; carrying the
      // previous verdict forward avoids inventing a discrepancy out of a network failure.
      discrepancy:
        charger.observation === null
          ? charger.previous.discrepancy
          : classifyDiscrepancy({
              commandedCurrentA,
              dynamicChargerCurrentA,
              deliveredCurrentA,
              opMode,
            }),
    }
  })
}

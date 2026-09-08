import type { ChargerDoc, TargetDoc } from '@app/adapters'
import type { ChargerState, TargetView } from '@app/shared'

/**
 * Charger state is derived **server-side** so the PWA and the admin view cannot disagree about what
 * "waiting" means (contracts/user-api.md).
 *
 * The distinction FR-035 actually cares about is `waiting_for_surplus` versus `charging_grid`: a
 * user who cannot tell those apart has no way to see the optimization working.
 */
export function deriveChargerState(charger: ChargerDoc, target: TargetDoc | null): ChargerState {
  if (charger.opMode === 0) return 'offline'
  if (charger.opMode === 5) return 'error'
  if (charger.opMode === 1) return target ? 'waiting_for_car' : 'idle'
  if (charger.opMode === 4) return 'complete'
  // 7/8 are the authorisation handshake: the car is connected but the charger will refuse current
  // until it is authorised. Its own state, because neither "waiting for surplus" nor "error"
  // describes it and only one of the three tells the user to go and present their tag.
  if (charger.opMode === 7 || charger.opMode === 8) return 'awaiting_authentication'

  // Plugged in (2, 3, 6).
  if (charger.opMode === 3) {
    return charger.lastAttribution === 'solar' ? 'charging_solar' : 'charging_grid'
  }
  if (!target) return 'idle'
  return charger.commandedCurrentA > 0 ? 'charging_grid' : 'waiting_for_surplus'
}

/**
 * The target as the user sees it.
 *
 * The charger carries energy the optimizer has measured but not yet written through to the target
 * document (it flushes about every half hour to stay inside the write budget). Adding it back
 * here is what keeps the progress figure live: the saving is in Firestore writes, not in accuracy.
 */
export function toTargetView(target: TargetDoc, charger?: ChargerDoc): TargetView {
  const deliveredKwh = round(target.deliveredKwh + (charger?.pendingKwh ?? 0))
  return {
    targetId: target.targetId,
    energyKwh: target.energyKwh,
    deadline: target.deadline,
    deliveredKwh,
    remainingKwh: Math.max(0, round(target.energyKwh - deliveredKwh)),
    solarKwh: round(target.deliveredSolarKwh + (charger?.pendingSolarKwh ?? 0)),
    gridKwh: round(target.deliveredGridKwh + (charger?.pendingGridKwh ?? 0)),
    reachability: {
      state: target.reachability.state,
      expectedShortfallKwh: target.reachability.expectedShortfallKwh,
    },
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

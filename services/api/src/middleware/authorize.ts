import type { ParkingLotDoc } from '@app/adapters'
import type { ApiDeps } from '../context.js'
import { ApiFailure } from '../errors.js'

/**
 * Authorization against `parkingLots` (T063, FR-003).
 *
 * The operator-maintained mapping is the *sole* basis for who may act on which charger. There is no
 * self-service claiming and no ownership flag anywhere else, so this is the only place the question
 * is answered — and every charger-touching route goes through it.
 */

/** Every lot mapped to this user. Empty is a 403, not an empty list (US1 scenario 6). */
export async function chargersForUser(deps: ApiDeps, userId: string): Promise<ParkingLotDoc[]> {
  const lots = await deps.repos.parkingLots.forUser(userId)
  if (lots.length === 0) {
    throw new ApiFailure('no_charger_mapped', 'no parking lot is assigned to this account')
  }
  return lots
}

/** The one lot, or a refusal. A lot that exists but belongs to someone else is `not_your_charger`. */
export async function authorizeLot(
  deps: ApiDeps,
  userId: string,
  lotNumber: string,
): Promise<ParkingLotDoc> {
  const lot = await deps.repos.parkingLots.byLotNumber(lotNumber)
  if (!lot || lot.easeeUserId !== userId) {
    // Deliberately the same answer either way: whether a lot exists is not information an
    // unauthorized caller needs.
    throw new ApiFailure('not_your_charger', `parking lot ${lotNumber} is not assigned to you`)
  }
  return lot
}

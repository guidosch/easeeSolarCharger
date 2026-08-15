import type { Firestore } from 'firebase-admin/firestore'
import { COLLECTIONS } from './db.js'
import type { ParkingLotDoc } from './types.js'

/**
 * The operator-maintained authorization source (FR-003). The system only ever reads it — a lot is
 * never created or deleted by the app, which is why `DELETE /me` leaves it untouched (FR-048).
 */
export class ParkingLotsRepo {
  constructor(private readonly db: Firestore) {}

  private col() {
    return this.db.collection(COLLECTIONS.parkingLots)
  }

  async listAll(): Promise<ParkingLotDoc[]> {
    const snap = await this.col().get()
    return snap.docs.map((d) => d.data() as ParkingLotDoc)
  }

  async byLotNumber(lotNumber: string): Promise<ParkingLotDoc | null> {
    const doc = await this.col().doc(lotNumber).get()
    return doc.exists ? (doc.data() as ParkingLotDoc) : null
  }

  /** Every lot mapped to a user. Empty means "no charger is assigned to you" (US1 scenario 6). */
  async forUser(easeeUserId: string): Promise<ParkingLotDoc[]> {
    const snap = await this.col().where('easeeUserId', '==', easeeUserId).get()
    return snap.docs.map((d) => d.data() as ParkingLotDoc)
  }

  async upsert(lot: ParkingLotDoc): Promise<void> {
    await this.col().doc(lot.lotNumber).set(lot)
  }
}

import type { Firestore } from 'firebase-admin/firestore'
import { COLLECTIONS, expiresAtFrom } from './db.js'
import type { ChargerEventDoc, ChargerEventType } from './types.js'

/**
 * State-change records (~150/day). Together with the ~15-minute snapshots these give the admin view
 * a continuous picture *without* one write per charger per cycle, which is the Principle VI rule
 * FR-046 states outright.
 */
export class ChargerEventsRepo {
  constructor(private readonly db: Firestore) {}

  private col() {
    return this.db.collection(COLLECTIONS.chargerEvents)
  }

  async append(
    events: {
      type: ChargerEventType
      chargerId: string
      lotNumber: string
      at: string
      detail?: string
      cycleId?: string
    }[],
  ): Promise<number> {
    if (events.length === 0) return 0
    const batch = this.db.batch()
    for (const event of events) {
      const doc: ChargerEventDoc = {
        type: event.type,
        chargerId: event.chargerId,
        lotNumber: event.lotNumber,
        at: event.at,
        detail: event.detail ?? null,
        cycleId: event.cycleId ?? null,
        expiresAt: expiresAtFrom(event.at),
      }
      batch.set(this.col().doc(), doc)
    }
    await batch.commit()
    return events.length
  }

  async forCharger(chargerId: string, fromIso: string, toIso: string): Promise<ChargerEventDoc[]> {
    const snap = await this.col()
      .where('chargerId', '==', chargerId)
      .where('at', '>=', fromIso)
      .where('at', '<=', toIso)
      .orderBy('at', 'asc')
      .get()
    return snap.docs.map((d) => d.data() as ChargerEventDoc)
  }
}

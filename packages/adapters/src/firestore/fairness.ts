import type { Firestore } from 'firebase-admin/firestore'
import { COLLECTIONS } from './db.js'
import type { FairnessDoc } from './types.js'

const WINDOW_DAYS = 30

/**
 * Per-user accounting driving the weighted draw (FR-024, ladder rule 6).
 *
 * The window is rolling: once `windowStart` is more than 30 days old the total is decayed rather
 * than reset, so a user is not handed a fresh claim on the surplus the moment the window ticks.
 */
export class FairnessRepo {
  constructor(private readonly db: Firestore) {}

  private col() {
    return this.db.collection(COLLECTIONS.fairness)
  }

  async all(): Promise<FairnessDoc[]> {
    const snap = await this.col().get()
    return snap.docs.map((d) => d.data() as FairnessDoc)
  }

  /** The shape `CycleInputs.fairness` expects. */
  async weights(): Promise<Record<string, { solarKwhReceived: number }>> {
    const docs = await this.all()
    return Object.fromEntries(docs.map((d) => [d.userId, { solarKwhReceived: d.solarKwhReceived }]))
  }

  async addSolar(userId: string, kwh: number, cycleId: string, nowIso: string): Promise<void> {
    const ref = this.col().doc(userId)
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      const existing = snap.exists ? (snap.data() as FairnessDoc) : null
      const decayed = existing
        ? decay(existing, nowIso)
        : { solarKwhReceived: 0, windowStart: nowIso }
      const next: FairnessDoc = {
        userId,
        solarKwhReceived: decayed.solarKwhReceived + kwh,
        windowStart: decayed.windowStart,
        lastServedCycleId: cycleId,
      }
      tx.set(ref, next)
    })
  }

  async remove(userId: string): Promise<void> {
    await this.col().doc(userId).delete()
  }
}

export function decay(
  doc: Pick<FairnessDoc, 'solarKwhReceived' | 'windowStart'>,
  nowIso: string,
): { solarKwhReceived: number; windowStart: string } {
  const ageDays = (Date.parse(nowIso) - Date.parse(doc.windowStart)) / 86_400_000
  if (ageDays <= WINDOW_DAYS) return { ...doc }
  const keep = Math.max(0, 1 - (ageDays - WINDOW_DAYS) / WINDOW_DAYS)
  return { solarKwhReceived: doc.solarKwhReceived * keep, windowStart: nowIso }
}

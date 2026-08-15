import type { Firestore } from 'firebase-admin/firestore'
import { COLLECTIONS } from './db.js'
import type { LeaseDoc } from './types.js'

/** Four minutes: shorter than the 5-minute cadence, longer than the 90-second cycle target. */
export const LEASE_DURATION_MS = 4 * 60_000

export type LeaseResult =
  | { acquired: true; holder: string; expiresAt: string }
  | { acquired: false; heldBy: string; expiresAt: string }

/**
 * The single-flight lease (research R7, FR-026, Principle V).
 *
 * A *lease* rather than a boolean lock: an instance that crashes mid-cycle cannot deadlock the
 * system, because the lease simply expires. The transaction is what makes "check then take" atomic
 * across concurrent Cloud Run instances.
 */
export class LeaseRepo {
  constructor(private readonly db: Firestore) {}

  private ref() {
    return this.db.collection(COLLECTIONS.locks).doc('optimizer')
  }

  async acquire(
    holder: string,
    nowIso: string,
    durationMs = LEASE_DURATION_MS,
  ): Promise<LeaseResult> {
    const ref = this.ref()
    return this.db.runTransaction(async (tx): Promise<LeaseResult> => {
      const snap = await tx.get(ref)
      const now = Date.parse(nowIso)
      if (snap.exists) {
        const existing = snap.data() as LeaseDoc
        if (Date.parse(existing.expiresAt) > now) {
          return { acquired: false, heldBy: existing.holder, expiresAt: existing.expiresAt }
        }
      }
      const lease: LeaseDoc = {
        holder,
        acquiredAt: nowIso,
        expiresAt: new Date(now + durationMs).toISOString(),
      }
      tx.set(ref, lease)
      return { acquired: true, holder, expiresAt: lease.expiresAt }
    })
  }

  /** Released in a `finally`, so a failed cycle does not hold the lease for its full four minutes. */
  async release(holder: string): Promise<void> {
    const ref = this.ref()
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      if (!snap.exists) return
      const existing = snap.data() as LeaseDoc
      // Only the holder may release: a cycle whose lease already expired must not clear the lease
      // a *later* cycle is legitimately holding.
      if (existing.holder !== holder) return
      tx.delete(ref)
    })
  }

  async current(): Promise<LeaseDoc | null> {
    const doc = await this.ref().get()
    return doc.exists ? (doc.data() as LeaseDoc) : null
  }

  async isHeld(nowIso: string): Promise<boolean> {
    const lease = await this.current()
    return lease !== null && Date.parse(lease.expiresAt) > Date.parse(nowIso)
  }
}

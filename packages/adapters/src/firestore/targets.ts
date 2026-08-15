import type { Firestore } from 'firebase-admin/firestore'
import { COLLECTIONS } from './db.js'
import type { TargetDoc } from './types.js'

/**
 * At most **one open target per charger** (FR-009). Setting a new one supersedes the previous one
 * *in the same transaction*, so there is no instant at which a charger has two open targets and the
 * optimizer could act on either.
 */
export class TargetsRepo {
  constructor(private readonly db: Firestore) {}

  private col(userId: string) {
    return this.db.collection(COLLECTIONS.users).doc(userId).collection(COLLECTIONS.targets)
  }

  pathOf(userId: string, targetId: string): string {
    return `${COLLECTIONS.users}/${userId}/${COLLECTIONS.targets}/${targetId}`
  }

  async byId(userId: string, targetId: string): Promise<TargetDoc | null> {
    const doc = await this.col(userId).doc(targetId).get()
    return doc.exists ? (doc.data() as TargetDoc) : null
  }

  async openForCharger(userId: string, chargerId: string): Promise<TargetDoc | null> {
    const snap = await this.col(userId)
      .where('chargerId', '==', chargerId)
      .where('status', '==', 'open')
      .limit(1)
      .get()
    const first = snap.docs[0]
    return first ? (first.data() as TargetDoc) : null
  }

  async allOpen(): Promise<TargetDoc[]> {
    const snap = await this.db
      .collectionGroup(COLLECTIONS.targets)
      .where('status', '==', 'open')
      .get()
    return snap.docs.map((d) => d.data() as TargetDoc)
  }

  /** Creates the target and supersedes any open one on the same charger, atomically (FR-009). */
  async createSuperseding(target: TargetDoc): Promise<void> {
    const col = this.col(target.userId)
    const previous = await col
      .where('chargerId', '==', target.chargerId)
      .where('status', '==', 'open')
      .get()

    await this.db.runTransaction(async (tx) => {
      for (const doc of previous.docs) {
        if (doc.id === target.targetId) continue
        tx.set(doc.ref, { status: 'superseded', closedAt: target.createdAt }, { merge: true })
      }
      tx.set(col.doc(target.targetId), target)
    })
  }

  async patch(userId: string, targetId: string, fields: Partial<TargetDoc>): Promise<void> {
    await this.col(userId).doc(targetId).set(fields, { merge: true })
  }

  async close(
    userId: string,
    targetId: string,
    status: Exclude<TargetDoc['status'], 'open'>,
    atIso: string,
  ): Promise<void> {
    await this.patch(userId, targetId, { status, closedAt: atIso })
  }

  async countOpen(): Promise<{ open: number; unreachable: number }> {
    const open = await this.allOpen()
    return {
      open: open.length,
      unreachable: open.filter((t) => t.reachability.state === 'unreachable').length,
    }
  }
}

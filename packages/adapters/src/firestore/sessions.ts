import type { Firestore } from 'firebase-admin/firestore'
import { COLLECTIONS } from './db.js'
import type { SessionDoc } from './types.js'

/** Users see their last five sessions; older ones are deleted (FR-038). */
export const SESSION_RETENTION = 5

/**
 * Session storage.
 *
 * Retention is enforced **by construction**: closing a session deletes anything beyond the five
 * most recent in the same batch. A nightly job would be a job that might not run, and the
 * constitution asks for retention enforced by automated deletion rather than left to a default.
 */
export class SessionsRepo {
  constructor(private readonly db: Firestore) {}

  private col(userId: string) {
    return this.db.collection(COLLECTIONS.users).doc(userId).collection(COLLECTIONS.sessions)
  }

  async byId(userId: string, sessionId: string): Promise<SessionDoc | null> {
    const doc = await this.col(userId).doc(sessionId).get()
    return doc.exists ? (doc.data() as SessionDoc) : null
  }

  async open(session: SessionDoc): Promise<void> {
    await this.col(session.userId).doc(session.sessionId).set(session)
  }

  async patch(userId: string, sessionId: string, fields: Partial<SessionDoc>): Promise<void> {
    await this.col(userId).doc(sessionId).set(fields, { merge: true })
  }

  /** Closes the session and trims the history to five in one batch (FR-038). */
  async close(userId: string, sessionId: string, fields: Partial<SessionDoc>): Promise<number> {
    const batch = this.db.batch()
    batch.set(this.col(userId).doc(sessionId), fields, { merge: true })

    const all = await this.col(userId).orderBy('startedAt', 'desc').get()
    const surplus = all.docs.slice(SESSION_RETENTION)
    surplus.forEach((doc) => batch.delete(doc.ref))

    await batch.commit()
    return 1 + surplus.length
  }

  /** The five most recent, newest first. */
  async recent(userId: string, limit = SESSION_RETENTION): Promise<SessionDoc[]> {
    const snap = await this.col(userId).orderBy('startedAt', 'desc').limit(limit).get()
    return snap.docs.map((d) => d.data() as SessionDoc)
  }

  /**
   * The most recent sessions across every user, newest first — the operator's view (admin).
   *
   * A collection-group query over each user's `sessions` subcollection; it needs the
   * collection-group `startedAt` index declared in `firestore.indexes.json`.
   */
  async recentAcrossUsers(limit: number): Promise<SessionDoc[]> {
    const snap = await this.db
      .collectionGroup(COLLECTIONS.sessions)
      .orderBy('startedAt', 'desc')
      .limit(limit)
      .get()
    return snap.docs.map((d) => d.data() as SessionDoc)
  }
}

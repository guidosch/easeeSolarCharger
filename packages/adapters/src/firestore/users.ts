import type { Firestore } from 'firebase-admin/firestore'
import { COLLECTIONS } from './db.js'
import type { UserDoc } from './types.js'

/**
 * `UserId` from the Easee token is the only identity key (FR-049). Nothing else about a person is
 * stored beyond the email the token already carries.
 */
export class UsersRepo {
  constructor(private readonly db: Firestore) {}

  private col() {
    return this.db.collection(COLLECTIONS.users)
  }

  async byId(userId: string): Promise<UserDoc | null> {
    const doc = await this.col().doc(userId).get()
    return doc.exists ? (doc.data() as UserDoc) : null
  }

  async touch(user: {
    userId: string
    email: string | null
    lotNumbers: string[]
    nowIso: string
  }): Promise<void> {
    const ref = this.col().doc(user.userId)
    const existing = await ref.get()
    if (existing.exists) {
      await ref.set(
        { email: user.email, lotNumbers: user.lotNumbers, lastSeenAt: user.nowIso },
        { merge: true },
      )
      return
    }
    const doc: UserDoc = {
      userId: user.userId,
      email: user.email,
      lotNumbers: user.lotNumbers,
      createdAt: user.nowIso,
      lastSeenAt: user.nowIso,
    }
    await ref.set(doc)
  }

  /**
   * Hard delete of the user document and every subcollection under it (FR-048). No soft flag: the
   * privacy commitment is that the record is gone, and a test asserts no document references the
   * `userId` afterwards.
   */
  async deleteUserTree(userId: string): Promise<number> {
    const ref = this.col().doc(userId)
    let deleted = 0
    for (const sub of [COLLECTIONS.targets, COLLECTIONS.sessions]) {
      const snap = await ref.collection(sub).get()
      if (snap.empty) continue
      const batch = this.db.batch()
      snap.docs.forEach((d) => batch.delete(d.ref))
      await batch.commit()
      deleted += snap.size
    }
    await ref.delete()
    return deleted + 1
  }
}

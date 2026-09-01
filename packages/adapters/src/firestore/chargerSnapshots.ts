import type { Firestore } from 'firebase-admin/firestore'
import { COLLECTIONS, expiresAtFrom } from './db.js'
import type { ChargerSnapshotDoc } from './types.js'

/** Roughly every fifteen minutes, for *active* chargers only (FR-046). */
export const SNAPSHOT_INTERVAL_MINUTES = 15

export class ChargerSnapshotsRepo {
  constructor(private readonly db: Firestore) {}

  private col() {
    return this.db.collection(COLLECTIONS.chargerSnapshots)
  }

  /** `{chargerId}_{isoMinute}` — a repeated cycle overwrites its own snapshot rather than adding one. */
  static docId(chargerId: string, observedAtIso: string): string {
    return `${chargerId}_${observedAtIso.slice(0, 16)}`
  }

  async writeMany(snapshots: Omit<ChargerSnapshotDoc, 'expiresAt'>[]): Promise<number> {
    if (snapshots.length === 0) return 0
    const batch = this.db.batch()
    for (const snapshot of snapshots) {
      const doc: ChargerSnapshotDoc = { ...snapshot, expiresAt: expiresAtFrom(snapshot.observedAt) }
      batch.set(
        this.col().doc(ChargerSnapshotsRepo.docId(snapshot.chargerId, snapshot.observedAt)),
        doc,
      )
    }
    await batch.commit()
    return snapshots.length
  }

  async forCharger(chargerId: string, limit = 100): Promise<ChargerSnapshotDoc[]> {
    const snap = await this.col()
      .where('chargerId', '==', chargerId)
      .orderBy('observedAt', 'desc')
      .limit(limit)
      .get()
    return snap.docs.map((d) => d.data() as ChargerSnapshotDoc)
  }
}

/** Is this charger due a snapshot? Active chargers only, at most one per ~15 minutes. */
export function snapshotDue(
  charger: { opMode: number; lastSnapshotAt: string | null },
  nowIso: string,
): boolean {
  // A car is connected in 2, 3, 6 and 7 — including 7 (awaiting authentication), because a charger
  // stuck there is exactly the case an operator needs the snapshot history to explain.
  const active = [2, 3, 6, 7].includes(charger.opMode)
  if (!active) return false
  if (!charger.lastSnapshotAt) return true
  const minutes = (Date.parse(nowIso) - Date.parse(charger.lastSnapshotAt)) / 60_000
  return minutes >= SNAPSHOT_INTERVAL_MINUTES
}

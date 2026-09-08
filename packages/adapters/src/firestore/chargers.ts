import type { Firestore } from 'firebase-admin/firestore'
import { COLLECTIONS, stripUndefined } from './db.js'
import type { ChargerDoc } from './types.js'

/**
 * The live mirror of one charger, **updated in place** each cycle.
 *
 * Updating in place rather than appending is what keeps the write budget at ~1,750/day (research
 * R8): thirty chargers × 288 cycles as appends would be ~260k writes/month on its own.
 */
export class ChargersRepo {
  constructor(private readonly db: Firestore) {}

  private col() {
    return this.db.collection(COLLECTIONS.chargers)
  }

  async listAll(): Promise<ChargerDoc[]> {
    const snap = await this.col().get()
    return snap.docs.map((d) => hydrateChargerDoc(d.data() as Partial<ChargerDoc>))
  }

  async byId(chargerId: string): Promise<ChargerDoc | null> {
    const doc = await this.col().doc(chargerId).get()
    return doc.exists ? hydrateChargerDoc(doc.data() as Partial<ChargerDoc>) : null
  }

  async byLotNumber(lotNumber: string): Promise<ChargerDoc | null> {
    const snap = await this.col().where('lotNumber', '==', lotNumber).limit(1).get()
    const first = snap.docs[0]
    return first ? hydrateChargerDoc(first.data() as Partial<ChargerDoc>) : null
  }

  async upsert(charger: ChargerDoc): Promise<void> {
    await this.col().doc(charger.chargerId).set(stripUndefined(charger), { merge: true })
  }

  async patch(chargerId: string, fields: Partial<ChargerDoc>): Promise<void> {
    await this.col().doc(chargerId).set(stripUndefined(fields), { merge: true })
  }

  /** One batched write for the whole sweep rather than thirty round-trips. */
  async patchMany(updates: { chargerId: string; fields: Partial<ChargerDoc> }[]): Promise<number> {
    if (updates.length === 0) return 0
    const batch = this.db.batch()
    for (const { chargerId, fields } of updates) {
      batch.set(this.col().doc(chargerId), stripUndefined(fields), { merge: true })
    }
    await batch.commit()
    return updates.length
  }

  async setOverride(chargerId: string, active: boolean, atIso: string): Promise<void> {
    await this.patch(chargerId, {
      overrideActive: active,
      overrideSince: active ? atIso : null,
    })
  }
}

/**
 * A mirror document as the model requires it, whatever the stored document happens to carry.
 *
 * `patchMany` writes a *partial* document every cycle — it never sends a field nothing has touched
 * yet — and `set(..., { merge: true })` on a missing document creates it from just those fields. A
 * mirror created that way (a lot added to `parkingLots` without re-running `pnpm seed:lots`) is
 * therefore missing everything that has never been written, and reading it raw handed `undefined`
 * to arithmetic: `commandedCurrentA` made the cycle record unwritable (Firestore rejects
 * `undefined`), and `pendingKwh` turned every energy sum into `NaN`, which silently froze a
 * target's delivered energy for good. Defaults are applied once, here at the boundary, so no
 * caller has to know which fields a document happens to have.
 */
export function hydrateChargerDoc(stored: Partial<ChargerDoc>): ChargerDoc {
  return {
    ...emptyChargerDoc({
      chargerId: stored.chargerId ?? '',
      lotNumber: stored.lotNumber ?? '',
      line: stored.line ?? 'L1',
      phases: stored.phases ?? 3,
      maxCurrentA: stored.maxCurrentA ?? 0,
    }),
    ...stripUndefined(stored),
  }
}

export function emptyChargerDoc(seed: {
  chargerId: string
  lotNumber: string
  line: ChargerDoc['line']
  phases: ChargerDoc['phases']
  maxCurrentA: number
}): ChargerDoc {
  return {
    ...seed,
    opMode: 0,
    outputCurrentA: 0,
    dynamicChargerCurrentA: 0,
    totalPowerKw: 0,
    sessionEnergyKwh: 0,
    lifetimeEnergyKwh: 0,
    reasonForNoCurrent: 0,
    commandedCurrentA: 0,
    commandedAt: null,
    discrepancy: 'none',
    activeSessionId: null,
    activeTargetPath: null,
    overrideActive: false,
    overrideSince: null,
    observedAt: null,
    consecutiveAboveFloor: 0,
    consecutiveBelowFloor: 0,
    lastSnapshotAt: null,
    lastAttribution: 'none',
    pendingKwh: 0,
    pendingSolarKwh: 0,
    pendingGridKwh: 0,
    lastFlushAt: null,
  }
}

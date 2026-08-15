import type { Firestore } from 'firebase-admin/firestore'
import type { ChargerDecision } from '@app/core'
import type { ChargerDecisionWire } from '@app/shared'
import { COLLECTIONS, stripUndefined } from './db.js'
import type { CycleDoc } from './types.js'

/**
 * Drift guard: `packages/core` owns the decision *types* and `packages/shared` owns the wire
 * *schema*, and the two are written independently because core has no dependencies. These two
 * assignments fail to compile the moment a reason or a ladder rule is added to one and not the
 * other, which is the only thing standing between the admin trace and a silently truncated union.
 */
type _CoreDecisionSatisfiesWire = ChargerDecision extends ChargerDecisionWire ? true : never
type _WireDecisionSatisfiesCore = ChargerDecisionWire extends ChargerDecision ? true : never
const _decisionTypesAgree: [_CoreDecisionSatisfiesWire, _WireDecisionSatisfiesCore] = [true, true]
void _decisionTypesAgree

/**
 * The audit and reproducibility record (Principle III, SC-010). `cycleId` is the scheduled instant,
 * which also makes the write idempotent under Cloud Scheduler's at-least-once delivery (FR-050).
 */
/**
 * How a cycle is stored.
 *
 * `inputs` is persisted as a **JSON string**, not as a nested document. Two reasons, and the first
 * one is not negotiable: Firestore cannot store an array inside an array, and
 * `config.highPriceWindows` is exactly that (`[["11:00","13:00"], …]`). The second is the better
 * reason to keep it this way even if that limitation vanished — a JSON string round-trips byte for
 * byte, whereas a document round-trip is subject to Firestore's own type coercions, and SC-010 asks
 * for a *byte-identical* replay.
 */
type StoredCycleDoc = Omit<CycleDoc, 'inputs'> & { inputsJson: string | null }

export class CyclesRepo {
  constructor(private readonly db: Firestore) {}

  private col() {
    return this.db.collection(COLLECTIONS.cycles)
  }

  private static toStored(cycle: CycleDoc): StoredCycleDoc {
    const { inputs, ...rest } = cycle
    return { ...rest, inputsJson: inputs === null ? null : JSON.stringify(inputs) }
  }

  private static fromStored(data: StoredCycleDoc): CycleDoc {
    const { inputsJson, ...rest } = data
    return {
      ...rest,
      inputs: inputsJson ? (JSON.parse(inputsJson) as CycleDoc['inputs']) : null,
    }
  }

  async byId(cycleId: string): Promise<CycleDoc | null> {
    const doc = await this.col().doc(cycleId).get()
    return doc.exists ? CyclesRepo.fromStored(doc.data() as StoredCycleDoc) : null
  }

  async exists(cycleId: string): Promise<boolean> {
    return (await this.col().doc(cycleId).get()).exists
  }

  /** Keyed by `cycleId`, so a repeated delivery of the same trigger overwrites rather than appends. */
  async write(cycle: CycleDoc): Promise<void> {
    const stored = stripUndefined(CyclesRepo.toStored(cycle) as unknown as Record<string, unknown>)
    await this.col().doc(cycle.cycleId).set(stored)
  }

  async recent(limit = 50, outcome?: CycleDoc['outcome']): Promise<CycleDoc[]> {
    const query = outcome
      ? this.col().where('outcome', '==', outcome).orderBy('startedAt', 'desc').limit(limit)
      : this.col().orderBy('startedAt', 'desc').limit(limit)
    const snap = await query.get()
    return snap.docs.map((d) => CyclesRepo.fromStored(d.data() as StoredCycleDoc))
  }

  /** Every cycle in a window, for the per-charger decision trace (FR-042, SC-009). */
  async between(fromIso: string, toIso: string, limit = 500): Promise<CycleDoc[]> {
    const snap = await this.col()
      .where('startedAt', '>=', fromIso)
      .where('startedAt', '<=', toIso)
      .orderBy('startedAt', 'asc')
      .limit(limit)
      .get()
    return snap.docs.map((d) => CyclesRepo.fromStored(d.data() as StoredCycleDoc))
  }

  /** Rolling 24-hour provider health (FR-041) and today's write count (`GET /admin/health`). */
  async since(fromIso: string, limit = 500): Promise<CycleDoc[]> {
    const snap = await this.col()
      .where('startedAt', '>=', fromIso)
      .orderBy('startedAt', 'desc')
      .limit(limit)
      .get()
    return snap.docs.map((d) => CyclesRepo.fromStored(d.data() as StoredCycleDoc))
  }
}

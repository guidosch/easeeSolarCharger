import { CyclesRepo, expiresAtFrom } from '@app/adapters'
import type { CycleDoc, ReadBackDoc } from '@app/adapters'
import type { CycleDecision, CycleInputs } from '@app/core'
import { correlationIdForCycle } from '@app/shared'
import type { CycleDeps } from './ports.js'

/**
 * Record (T056) — the audit and reproducibility entry (Principle III, SC-010).
 *
 * The whole of `inputs` is written, not a summary: `decide(cycle.inputs)` must return
 * `cycle.decisions` exactly, and a record that omits one field of the input is a record that cannot
 * be replayed. `cycleId` is the scheduled instant, so a repeated delivery overwrites its own
 * record rather than appending a second one (FR-050).
 */
export async function recordCycle(
  deps: CycleDeps,
  args: {
    cycleId: string
    startedAtMs: number
    inputs: CycleInputs
    decision: CycleDecision
    readBack: ReadBackDoc[]
    notes: string[]
    outcome: CycleDoc['outcome']
    firestoreWrites: number
  },
): Promise<CycleDoc> {
  const startedAt = new Date(args.startedAtMs).toISOString()
  const finishedAt = new Date(deps.now()).toISOString()

  const doc: CycleDoc = {
    cycleId: args.cycleId,
    startedAt,
    finishedAt,
    outcome: args.outcome,
    durationMs: deps.now() - args.startedAtMs,
    inputs: args.inputs,
    decisions: args.decision.decisions,
    readBack: args.readBack,
    providerCalls: {
      easee: { ...deps.stats.easee },
      solaredge: { ...deps.stats.solaredge },
      openweather: { ...deps.stats.openweather },
    },
    notes: [...args.notes, ...args.decision.notes],
    surplusAllocatedKw: args.decision.surplusAllocatedKw,
    schedulerVersion: args.decision.schedulerVersion,
    correlationId: correlationIdForCycle(args.cycleId),
    // Counting its own writes is what keeps the Principle VI budget observable rather than assumed;
    // `GET /admin/health` sums this across the day.
    firestoreWrites: args.firestoreWrites + 1,
    expiresAt: expiresAtFrom(startedAt),
  }

  await new CyclesRepo(deps.db).write(doc)
  return doc
}

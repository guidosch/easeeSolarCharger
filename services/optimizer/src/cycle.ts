import { CyclesRepo, FairnessRepo, expiresAtFrom } from '@app/adapters'
import type { CycleDoc } from '@app/adapters'
import { decide } from '@app/core'
import { correlationIdForCycle } from '@app/shared'
import { apply } from './apply.js'
import { gather } from './gather.js'
import { emptyProviderCalls, recordSkippedCycle, withLease } from './lease.js'
import { persistChargerState } from './persistence.js'
import type { CycleDeps } from './ports.js'
import { readBack } from './readback.js'
import { recordCycle } from './record.js'
import { reconcileSessions } from './sessions.js'

/**
 * One optimizer cycle (T058): lease → gather → decide → apply → read-back → sessions → record →
 * persistence, releasing the lease in a `finally`.
 *
 * The ordering is not arbitrary. Read-back is computed from the observations gathered *before* this
 * cycle's writes, so it reports on the previous cycle's commands (FR-028). Sessions are reconciled
 * after `apply` so a plug-in detected this cycle has already had its setpoint re-applied. The
 * record is written last, with everything the replay contract needs.
 */

export type CycleResult = {
  cycleId: string
  outcome: CycleDoc['outcome']
  chargersActedOn: number
  notes: string[]
}

/** A repeated delivery of the same scheduled trigger must change nothing (FR-050). */
export async function alreadyRecorded(deps: CycleDeps, cycleId: string): Promise<CycleDoc | null> {
  const existing = await new CyclesRepo(deps.db).byId(cycleId)
  if (!existing) return null
  // A recorded *skip* is not a completed cycle: the next delivery is free to try again.
  return existing.outcome === 'skipped_locked' ? null : existing
}

export async function runCycle(deps: CycleDeps, cycleId: string): Promise<CycleResult> {
  const startedAtMs = deps.now()
  const logger = deps.logger.child({ cycleId })

  const previous = await alreadyRecorded(deps, cycleId)
  if (previous) {
    logger.info('cycle already recorded; at-least-once delivery is a no-op', { cycleId })
    return {
      cycleId,
      outcome: previous.outcome,
      chargersActedOn: previous.decisions.filter((d) => d.targetCurrentA > 0).length,
      notes: ['idempotent replay of an already-recorded cycle'],
    }
  }

  const lease = await withLease(deps)
  if (!lease.acquired) {
    await recordSkippedCycle(deps, cycleId, lease.heldBy)
    return { cycleId, outcome: 'skipped_locked', chargersActedOn: 0, notes: ['lease held'] }
  }

  try {
    const gathered = await gather(deps, cycleId)
    const decision = decide(gathered.inputs)
    const previousCycleReadBack = readBack(gathered.chargers)

    const applied = await apply(
      deps,
      gathered.chargers,
      decision.decisions,
      gathered.inputs.config.deadbandA,
    )

    const sessions = await reconcileSessions(deps, gathered.chargers, decision.decisions, cycleId)

    // T106 — the fairness ledger. Only *solar* energy is recorded: the draw exists to share the
    // building's own production, and grid kWh are not a benefit anyone competes for (FR-024).
    const fairness = new FairnessRepo(deps.db)
    const nowIso = new Date(deps.now()).toISOString()
    let fairnessWrites = 0
    for (const [userId, kwh] of sessions.solarKwhByUser) {
      if (kwh <= 0) continue
      await fairness.addSolar(userId, kwh, cycleId, nowIso)
      fairnessWrites += 1
    }
    const persistedWrites = await persistChargerState(
      deps,
      gathered.chargers,
      decision.decisions,
      applied.commanded,
      sessions.chargerPatches,
      gathered.inputs,
    )

    const failedWrites = applied.writes.filter((w) => !w.ok)
    const notes = [
      ...gathered.notes,
      ...(failedWrites.length > 0 ? [`${failedWrites.length} setpoint write(s) failed`] : []),
      ...(deps.dryRun ? ['dry run: no setpoint or Firestore write was made'] : []),
    ]

    const outcome: CycleDoc['outcome'] =
      gathered.degraded || failedWrites.length > 0 ? 'degraded' : 'completed'

    if (!deps.dryRun) {
      await recordCycle(deps, {
        cycleId,
        startedAtMs,
        inputs: gathered.inputs,
        decision,
        readBack: previousCycleReadBack,
        notes,
        outcome,
        firestoreWrites: sessions.writes + persistedWrites + fairnessWrites,
      })
    }

    const chargersActedOn = applied.writes.filter((w) => w.ok).length
    logger.info('cycle complete', {
      outcome,
      chargersActedOn,
      surplusAllocatedKw: decision.surplusAllocatedKw,
      durationMs: deps.now() - startedAtMs,
    })

    return { cycleId, outcome, chargersActedOn, notes }
  } catch (error) {
    // A failed cycle still leaves a record, so it reaches the admin view and the alerting policy
    // rather than simply being absent (FR-043, SC-008).
    await recordFailure(deps, cycleId, startedAtMs, error)
    throw error
  } finally {
    await lease.release()
  }
}

async function recordFailure(
  deps: CycleDeps,
  cycleId: string,
  startedAtMs: number,
  error: unknown,
): Promise<void> {
  const startedAt = new Date(startedAtMs).toISOString()
  const doc: CycleDoc = {
    cycleId,
    startedAt,
    finishedAt: new Date(deps.now()).toISOString(),
    outcome: 'failed',
    durationMs: deps.now() - startedAtMs,
    inputs: null,
    decisions: [],
    readBack: [],
    providerCalls: emptyProviderCalls(),
    notes: [`cycle failed: ${error instanceof Error ? error.message : String(error)}`],
    surplusAllocatedKw: 0,
    schedulerVersion: deps.schedulerVersion,
    correlationId: correlationIdForCycle(cycleId),
    firestoreWrites: 1,
    expiresAt: expiresAtFrom(startedAt),
  }
  deps.logger.error('cycle failed', { cycleId, error })
  try {
    await new CyclesRepo(deps.db).write(doc)
  } catch (writeError) {
    // If Firestore itself is the failure, the structured error log above is the only signal left —
    // which is why the alerting policy counts `severity >= ERROR` as well as failed cycles.
    deps.logger.error('could not record the failed cycle', { cycleId, error: writeError })
  }
}

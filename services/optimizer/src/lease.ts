import { CyclesRepo, LeaseRepo, expiresAtFrom } from '@app/adapters'
import type { CycleDoc } from '@app/adapters'
import { correlationIdForCycle } from '@app/shared'
import type { CycleDeps } from './ports.js'

/**
 * Single-flight execution (T038, FR-026, research R7).
 *
 * A cycle that finds a live lease records `skipped_locked` and the caller returns **200**. The
 * status code is the point: a non-2xx would make Cloud Scheduler retry, and a retry stacks another
 * attempt behind the cycle that is already running — which is exactly the overlap the lease exists
 * to prevent.
 */

export type LeaseOutcome =
  | { acquired: true; release: () => Promise<void> }
  | { acquired: false; heldBy: string; expiresAt: string }

export function emptyProviderCalls(): CycleDoc['providerCalls'] {
  const zero = { calls: 0, errors: 0, rateLimited: 0, budgetRemaining: 0 }
  return { easee: { ...zero }, solaredge: { ...zero }, openweather: { ...zero } }
}

export async function withLease(deps: CycleDeps): Promise<LeaseOutcome> {
  const leases = new LeaseRepo(deps.db)
  const nowIso = new Date(deps.now()).toISOString()
  const result = await leases.acquire(deps.instanceId, nowIso)

  if (!result.acquired) {
    return { acquired: false, heldBy: result.heldBy, expiresAt: result.expiresAt }
  }
  return {
    acquired: true,
    release: () => leases.release(deps.instanceId),
  }
}

/** Records the skip so it is visible in the admin view rather than merely absent (Principle V). */
export async function recordSkippedCycle(
  deps: CycleDeps,
  cycleId: string,
  heldBy: string,
): Promise<void> {
  const nowIso = new Date(deps.now()).toISOString()
  const cycles = new CyclesRepo(deps.db)
  const doc: CycleDoc = {
    cycleId,
    startedAt: nowIso,
    finishedAt: nowIso,
    outcome: 'skipped_locked',
    durationMs: 0,
    inputs: null,
    decisions: [],
    readBack: [],
    providerCalls: emptyProviderCalls(),
    notes: [`skipped: lease held by ${heldBy}`],
    surplusAllocatedKw: 0,
    schedulerVersion: deps.schedulerVersion,
    correlationId: correlationIdForCycle(cycleId),
    firestoreWrites: 1,
    expiresAt: expiresAtFrom(nowIso),
  }
  await cycles.write(doc)
  deps.logger.warn('cycle skipped: another cycle holds the lease', { cycleId, heldBy })
}

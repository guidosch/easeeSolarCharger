import { isDaylight, seasonModeAt } from '@app/core'
import type { SchedulerConfig } from '@app/core'
import type { Result } from '../http/errors.js'
import { err, ok } from '../http/errors.js'

/**
 * The SolarEdge daylight gate (T075, FR-045, research R3).
 *
 * SolarEdge allows 300 requests a day per site. A round-the-clock five-minute poll costs 288 and
 * leaves almost no headroom for retries; gating on daylight caps the worst case at 192 — which is
 * why this is a *correctness* requirement rather than an optimization, and why it is enforced here
 * rather than left to a comment.
 */
export type GateContext = {
  nowIso: string
  latitude: number
  longitude: number
  config: SchedulerConfig
}

export type GateVerdict = {
  open: boolean
  reason: 'daylight' | 'night' | 'winter'
}

export function daylightGate(context: GateContext): GateVerdict {
  if (seasonModeAt(context.nowIso, context.config) === 'winter') {
    // Solar optimization is disabled in the winter window (FR-023), so the reading has no consumer.
    return { open: false, reason: 'winter' }
  }
  if (!isDaylight(context.nowIso, context.latitude, context.longitude)) {
    return { open: false, reason: 'night' }
  }
  return { open: true, reason: 'daylight' }
}

/** Refuses the call outside the gate, before any budget is spent. */
export function checkDaylightGate(context: GateContext): Result<void> {
  const verdict = daylightGate(context)
  if (verdict.open) return ok(undefined)
  return err({
    kind: 'gated',
    provider: 'solaredge',
    message:
      verdict.reason === 'winter'
        ? 'SolarEdge not called: inside the winter window (FR-023)'
        : 'SolarEdge not called: outside the daylight gate (FR-045)',
  })
}

/** Worst-case daily call count under the gate, for the budget assertion in the contract test. */
export function callsPerDay(
  context: Omit<GateContext, 'nowIso'> & { dayStartIso: string; stepMinutes: number },
): number {
  const start = Date.parse(context.dayStartIso)
  let calls = 0
  for (let t = start; t < start + 24 * 3_600_000; t += context.stepMinutes * 60_000) {
    const nowIso = new Date(t).toISOString()
    if (daylightGate({ ...context, nowIso }).open) calls += 1
  }
  return calls
}

import { ChargerEventsRepo, SessionsRepo, TargetsRepo } from '@app/adapters'
import type { ChargerDoc, ChargerEventType, SessionDoc, TargetDoc } from '@app/adapters'
import type { Attribution, ChargerDecision } from '@app/core'
import type { GatheredCharger } from './gather.js'
import type { CycleDeps } from './ports.js'

/**
 * Sessions (T055) — the `opMode` transitions this system acts on (data-model.md).
 *
 * | Transition   | Meaning       | Action                                                        |
 * | ------------ | ------------- | ------------------------------------------------------------- |
 * | `1 → {2,3,6}`| car plugged in| open a session, activate any stored target (FR-010)            |
 * | `{2,3,4,6} → 1` | car unplugged | close the session, close the target, clear the override    |
 *
 * Delivered energy comes from observation 121, as a *difference* from the value seen last cycle —
 * never as an absolute, because the charger resets that counter when a new session starts.
 *
 * The solar/grid split follows the *previous* cycle's attribution, held in `charger.lastAttribution`.
 * The energy observed now was produced by the setpoint written last cycle, so crediting it to this
 * cycle's decision would mis-attribute every transition between solar and grid charging.
 */

/**
 * How often the accumulated energy is written through to the target and session documents.
 *
 * This is a *durability* interval, not a freshness one: the API adds the charger's pending energy
 * to whatever the target document says, so the user always sees live progress whatever this is set
 * to. What it buys is how much measured energy a lost charger document could cost — half an hour of
 * one car's charging, at ~1,700 writes a day against a 20,000 free allowance (research R8).
 */
export const FLUSH_INTERVAL_MINUTES = 30

const PLUGGED_IN = new Set([2, 3, 6])
const CONNECTED = new Set([2, 3, 4, 6])

export type SessionOutcome = {
  writes: number
  chargerPatches: Map<string, Partial<ChargerDoc>>
  events: { type: ChargerEventType; chargerId: string; lotNumber: string; detail?: string }[]
  /** Solar energy credited per user this cycle; the fairness ledger consumes it in US5. */
  solarKwhByUser: Map<string, number>
}

export function energyDeltaKwh(previousSessionKwh: number, currentSessionKwh: number): number {
  // A drop means the charger started a new session and reset its counter to (nearly) zero.
  if (currentSessionKwh < previousSessionKwh) return Math.max(0, currentSessionKwh)
  return currentSessionKwh - previousSessionKwh
}

export async function reconcileSessions(
  deps: CycleDeps,
  chargers: GatheredCharger[],
  decisions: ChargerDecision[],
  cycleId: string,
): Promise<SessionOutcome> {
  const nowIso = new Date(deps.now()).toISOString()
  const targets = new TargetsRepo(deps.db)
  const sessions = new SessionsRepo(deps.db)
  const events = new ChargerEventsRepo(deps.db)

  const decisionFor = new Map(decisions.map((d) => [d.chargerId, d]))
  const outcome: SessionOutcome = {
    writes: 0,
    chargerPatches: new Map(),
    events: [],
    solarKwhByUser: new Map(),
  }

  for (const charger of chargers) {
    const observation = charger.observation
    if (!observation) continue // unread this cycle: infer nothing from silence

    const previous = charger.previous
    const patch: Partial<ChargerDoc> = {}
    const previousMode = previous.opMode
    const currentMode = observation.opMode
    const lot = charger.lot

    const pluggedIn = previousMode === 1 && PLUGGED_IN.has(currentMode)
    const unplugged = CONNECTED.has(previousMode) && currentMode === 1

    if (pluggedIn)
      outcome.events.push({
        type: 'plugged_in',
        chargerId: lot.chargerId,
        lotNumber: lot.lotNumber,
      })
    if (unplugged)
      outcome.events.push({ type: 'unplugged', chargerId: lot.chargerId, lotNumber: lot.lotNumber })
    if (previousMode !== 3 && currentMode === 3) {
      outcome.events.push({
        type: 'charging_started',
        chargerId: lot.chargerId,
        lotNumber: lot.lotNumber,
      })
    }
    if (previousMode === 3 && currentMode !== 3) {
      outcome.events.push({
        type: 'charging_stopped',
        chargerId: lot.chargerId,
        lotNumber: lot.lotNumber,
      })
    }
    if (previousMode !== 5 && currentMode === 5) {
      outcome.events.push({
        type: 'error',
        chargerId: lot.chargerId,
        lotNumber: lot.lotNumber,
        detail: `reasonForNoCurrent=${observation.reasonForNoCurrent}`,
      })
    }

    const target = charger.target
    const userId = target?.userId ?? (lot.easeeUserId === '' ? null : lot.easeeUserId)

    // --- Open a session on plug-in -------------------------------------------------------------
    let activeSessionId = previous.activeSessionId
    if (pluggedIn && userId && activeSessionId === null) {
      const sessionId = `s_${lot.chargerId}_${nowIso.replace(/[^0-9]/g, '')}`
      const session: SessionDoc = {
        sessionId,
        userId,
        chargerId: lot.chargerId,
        lotNumber: lot.lotNumber,
        startedAt: nowIso,
        endedAt: null,
        energyKwh: 0,
        solarKwh: 0,
        gridKwh: 0,
        targetEnergyKwh: target?.energyKwh ?? null,
        deadline: target?.deadline ?? null,
        targetMet: false,
        endReason: null,
        overrideUsed: previous.overrideActive,
        sessionEnergyAtStartKwh: observation.sessionEnergyKwh,
      }
      await sessions.open(session)
      outcome.writes += 1
      activeSessionId = sessionId
      patch.activeSessionId = sessionId
      if (target) patch.activeTargetPath = targets.pathOf(target.userId, target.targetId)
    }

    // A target set after the car was plugged in (FR-010) belongs on the already-open session, so
    // the summary survives the target being deleted later (data-model.md).
    if (target && activeSessionId && userId && !pluggedIn) {
      const existing = await sessions.byId(userId, activeSessionId)
      if (existing && existing.targetEnergyKwh === null) {
        await sessions.patch(userId, activeSessionId, {
          targetEnergyKwh: target.energyKwh,
          deadline: target.deadline,
        })
        outcome.writes += 1
      }
    }

    // --- Credit the energy delivered since the last cycle ---------------------------------------
    //
    // Accumulated on the charger mirror, which is written once per cycle in a single batch for all
    // thirty, and flushed to the target and session documents only every ~15 minutes or when
    // something closes. Writing them every cycle instead is one write per active charger per cycle
    // — the thing FR-046 names outright — and on a busy day it is the difference between ~1,700
    // and ~3,000 documents.
    const deltaKwh = energyDeltaKwh(previous.sessionEnergyKwh, observation.sessionEnergyKwh)
    const attribution: Attribution = previous.lastAttribution
    const pendingKwh = round(previous.pendingKwh + deltaKwh)
    const pendingSolarKwh = round(
      previous.pendingSolarKwh + (attribution === 'solar' ? deltaKwh : 0),
    )
    const pendingGridKwh = round(previous.pendingGridKwh + (attribution === 'solar' ? 0 : deltaKwh))

    if (deltaKwh > 0 && userId && attribution === 'solar') {
      outcome.solarKwhByUser.set(userId, (outcome.solarKwhByUser.get(userId) ?? 0) + deltaKwh)
    }

    const sinceFlushMinutes =
      previous.lastFlushAt === null
        ? Number.POSITIVE_INFINITY
        : (Date.parse(nowIso) - Date.parse(previous.lastFlushAt)) / 60_000
    const dueToFlush = pendingKwh > 0 && sinceFlushMinutes >= FLUSH_INTERVAL_MINUTES

    // --- Keep the target's progress and reachability current -------------------------------------
    let closedTarget = false
    let closedTargetStatus: 'met' | 'shortfall' | null = null
    let flushed = false
    if (target) {
      const decision = decisionFor.get(lot.chargerId)
      const deliveredKwh = round(target.deliveredKwh + pendingKwh)

      const closing =
        deliveredKwh >= target.energyKwh || Date.parse(target.deadline) <= Date.parse(nowIso)

      if (closing || dueToFlush) {
        const patchFields: Partial<TargetDoc> = {
          deliveredKwh,
          deliveredSolarKwh: round(target.deliveredSolarKwh + pendingSolarKwh),
          deliveredGridKwh: round(target.deliveredGridKwh + pendingGridKwh),
          ...(decision
            ? {
                reachability: {
                  state: decision.reachability.state,
                  expectedShortfallKwh: decision.reachability.expectedShortfallKwh,
                  evaluatedAt: nowIso,
                },
              }
            : {}),
        }

        if (deliveredKwh >= target.energyKwh) {
          // FR-030: stop requesting charge once the target energy has been delivered.
          patchFields.status = 'met'
          patchFields.closedAt = nowIso
          closedTarget = true
          closedTargetStatus = 'met'
        } else if (Date.parse(target.deadline) <= Date.parse(nowIso)) {
          // The deadline is never extended on the system's own initiative (spec edge case).
          patchFields.status = 'shortfall'
          patchFields.closedAt = nowIso
          closedTarget = true
          closedTargetStatus = 'shortfall'
        }

        await targets.patch(target.userId, target.targetId, patchFields)
        outcome.writes += 1
        flushed = true
      }

      if (closedTarget && activeSessionId) {
        const session = await sessions.byId(target.userId, activeSessionId)
        outcome.writes += await sessions.close(target.userId, activeSessionId, {
          endedAt: nowIso,
          endReason: closedTargetStatus === 'met' ? 'target_reached' : 'deadline_passed',
          targetMet: closedTargetStatus === 'met',
          ...(session
            ? {
                energyKwh: round(session.energyKwh + pendingKwh),
                solarKwh: round(session.solarKwh + pendingSolarKwh),
                gridKwh: round(session.gridKwh + pendingGridKwh),
              }
            : {}),
        })
        patch.activeSessionId = null
        patch.activeTargetPath = null
        clearOverride(previous, patch, outcome, lot)
      }
    }

    // A session with no target still accrues energy, and a long one should not lag by hours.
    if (!closedTarget && dueToFlush && userId && activeSessionId) {
      const session = await sessions.byId(userId, activeSessionId)
      if (session) {
        await sessions.patch(userId, activeSessionId, {
          energyKwh: round(session.energyKwh + pendingKwh),
          solarKwh: round(session.solarKwh + pendingSolarKwh),
          gridKwh: round(session.gridKwh + pendingGridKwh),
          overrideUsed: session.overrideUsed || previous.overrideActive,
        })
        outcome.writes += 1
        flushed = true
      }
    }

    // --- Close the session on unplug -------------------------------------------------------------
    if (unplugged && userId && activeSessionId) {
      const session = await sessions.byId(userId, activeSessionId)
      const energyKwh = round((session?.energyKwh ?? 0) + (flushed ? 0 : pendingKwh))
      const met = session ? energyKwh >= (session.targetEnergyKwh ?? Infinity) : false
      outcome.writes += await sessions.close(userId, activeSessionId, {
        endedAt: nowIso,
        endReason: met ? 'target_reached' : 'unplugged',
        targetMet: met,
        energyKwh,
        solarKwh: round((session?.solarKwh ?? 0) + (flushed ? 0 : pendingSolarKwh)),
        gridKwh: round((session?.gridKwh ?? 0) + (flushed ? 0 : pendingGridKwh)),
      })
      flushed = true
      patch.activeSessionId = null
      patch.activeTargetPath = null

      // No automatic resume on the next plug-in (spec assumption): the target is closed, and the
      // user sets a new one.
      if (target && !closedTarget) {
        await targets.close(target.userId, target.targetId, 'cancelled', nowIso)
        outcome.writes += 1
      }
    }

    // The pending counters ride along on the charger mirror, which is written anyway.
    if (flushed) {
      patch.pendingKwh = 0
      patch.pendingSolarKwh = 0
      patch.pendingGridKwh = 0
      patch.lastFlushAt = nowIso
    } else if (deltaKwh > 0) {
      patch.pendingKwh = pendingKwh
      patch.pendingSolarKwh = pendingSolarKwh
      patch.pendingGridKwh = pendingGridKwh
      if (previous.lastFlushAt === null) patch.lastFlushAt = nowIso
    }

    // An unplug ends the session whether or not this system had a session *document* open for it
    // — a charger that was plugged in before the first cycle ever ran has no document, and its
    // override must still clear (FR-033).
    if (unplugged) clearOverride(previous, patch, outcome, lot)

    if (Object.keys(patch).length > 0) outcome.chargerPatches.set(lot.chargerId, patch)
  }

  if (outcome.events.length > 0) {
    outcome.writes += await events.append(
      outcome.events.map((event) => ({ ...event, at: nowIso, cycleId })),
    )
  }

  return outcome
}

/**
 * Clears the "charge now" override at session end (T099, FR-033).
 *
 * The client must not be relied on to do this: the phone may be in a pocket, the app closed, or the
 * user's token expired. An override that survived a session would silently keep the next one at
 * full power through a high-price window.
 */
function clearOverride(
  previous: ChargerDoc,
  patch: Partial<ChargerDoc>,
  outcome: SessionOutcome,
  lot: { chargerId: string; lotNumber: string },
): void {
  if (!previous.overrideActive) return
  patch.overrideActive = false
  patch.overrideSince = null
  outcome.events.push({
    type: 'override_off',
    chargerId: lot.chargerId,
    lotNumber: lot.lotNumber,
    detail: 'cleared automatically at session end (FR-033)',
  })
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

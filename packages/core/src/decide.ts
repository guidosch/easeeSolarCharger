import { CYCLE_MINUTES, DEADLINE_RESUME_MARGIN, DEADLINE_RISK_MARGIN } from './config.js'
import { drawOrder } from './fairness.js'
import { evaluateReachability } from './reachability.js'
import { mayStart, mustStop } from './surplus.js'
import { ampsToKw, energyKwh, floorToWholeAmps, kwToAmps } from './units.js'
import { parseInstant } from './tariff.js'
import type {
  ChargerDecision,
  ChargerInput,
  CycleDecision,
  CycleInputs,
  DecisionReason,
  LadderRule,
  OpMode,
  Reachability,
} from './types.js'

/**
 * `decide(inputs) → CycleDecision` — the Principle I precedence ladder (T050, T080, T097, T105).
 *
 * The ladder, highest first:
 *
 *   1. External load management (advisory line headroom is all this system may assert)
 *   2. "Charge now" override
 *   3. No grid import during a high-price window
 *   4. The user's deadline, from low-price grid energy
 *   5. Maximize solar self-consumption
 *   6. Fairness between users competing for the same surplus
 *
 * Rule 1 is applied *last in code and first in precedence*: it is a ceiling on whatever the rules
 * below asked for, never a floor, so it can only ever reduce a current. That is what makes
 * "MUST NOT bypass the external load management" structural rather than a promise.
 *
 * ## Two orderings that look wrong and are not
 *
 * **Rule 3 does not block rule 5.** The high-price rule bans grid *import*, not charging, so solar
 * is spent during a high-price window (FR-019). What rule 3 blocks is rule 4.
 *
 * **Rule 4 is evaluated before rule 5.** When a target is genuinely at risk, charging at the full
 * current from low-price grid beats charging at whatever the sun happens to be giving — the deadline
 * outranks self-consumption, and taking the smaller solar share would be choosing the lower rule.
 *
 * ## When rule 4 imports, and why that differs by season
 *
 * In **solar mode** the deadline fallback waits for the target to become `at_risk`, because waiting
 * has an upside: the surplus may yet arrive, and FR-020 forbids topping up from the grid to reach
 * the modulation floor.
 *
 * In the **winter window** solar optimization is disabled outright (FR-023), so waiting has no
 * upside at all — only the risk of running out of low-price time. Scheduling there is "purely
 * deadline-driven", which means charging on every low-price cycle while the target is unmet. This
 * is why quickstart V1 expects `deadline_fallback` at 22:00 on a January night rather than a
 * charger sitting idle until 04:00.
 */
export function decide(inputs: CycleInputs): CycleDecision {
  const notes: string[] = []

  const solarUsable =
    inputs.seasonMode === 'solar' &&
    inputs.surplus.quality !== 'unusable' &&
    inputs.surplus.smoothedKw !== null

  if (inputs.seasonMode === 'winter') {
    notes.push('winter window: solar optimization disabled, scheduling is deadline-driven (FR-023)')
  } else if (inputs.surplus.smoothedKw === null) {
    notes.push(
      'no surplus reading — deadline-only mode; a missing reading is not zero surplus (FR-016)',
    )
  } else if (inputs.surplus.quality === 'unusable') {
    notes.push(
      `surplus reading unusable at ${inputs.surplus.ageMinutes ?? '?'} minutes old — deadline-only mode (FR-016)`,
    )
  } else if (inputs.surplus.quality === 'stale') {
    notes.push(`surplus reading is ${inputs.surplus.ageMinutes ?? '?'} minutes old`)
  }

  if (inputs.forecast === null) {
    // A missing forecast may never *cause* a deferral, because a wrong deferral risks a deadline.
    notes.push('no forecast available — deferral not considered (FR-044)')
  }

  const allocation = allocateSurplus(inputs, solarUsable, notes)
  const proposals = inputs.chargers.map((charger) =>
    propose(
      charger,
      inputs,
      solarUsable,
      allocation.shareByChargerId.get(charger.chargerId) ?? 0,
      allocation.notSelected.has(charger.chargerId),
    ),
  )
  // `applyLineHeadroom` preserves input order one-for-one, so a decision and its charger share an
  // index — which is also what makes the recorded `decisions` array replay-comparable.
  const decisions = applyLineHeadroom(proposals, inputs)

  const surplusAllocatedKw = decisions.reduce((sum, decision, index) => {
    const charger = inputs.chargers[index]
    if (!charger || decision.attribution !== 'solar') return sum
    return sum + ampsToKw(decision.targetCurrentA, charger.phases)
  }, 0)

  return {
    cycleId: inputs.cycleId,
    schedulerVersion: inputs.schedulerVersion,
    decisions,
    surplusAllocatedKw: round(surplusAllocatedKw),
    notes,
  }
}

type Proposal = ChargerDecision & { charger: ChargerInput }

/**
 * The surplus share each charger would receive this cycle, before the start/stop hysteresis is
 * applied.
 *
 * Exported because the optimizer has to advance the hysteresis counters from the *share*, not from
 * the decision: a charger held back by the two-cycle start delay is recorded as `awaiting_surplus`
 * while its share was above the floor, and counting that as a cycle "below the floor" would reset
 * the counter every cycle and mean the charger could never start at all.
 */
export function solarShares(inputs: CycleInputs): Map<string, number> {
  const solarUsable =
    inputs.seasonMode === 'solar' &&
    inputs.surplus.quality !== 'unusable' &&
    inputs.surplus.smoothedKw !== null
  return allocateSurplus(inputs, solarUsable, []).shareByChargerId
}

/**
 * Can a setpoint be written to a charger in this mode at all?
 *
 * Exported because the optimizer advances its hysteresis counters over the same set: a charger this
 * returns `false` for is not "below the floor", it is simply not in the game this cycle.
 * 0 (offline), 1 (disconnected) and 5 (error) never take current; 7 (awaiting authentication) and
 * 8 (de-authenticating) are plugged in but not authorised, so current asked for now would be
 * refused and surplus allocated to them would be surplus thrown away.
 */
export function canAcceptSetpoint(opMode: OpMode): boolean {
  return COMMANDABLE_OP_MODES.has(opMode)
}

const COMMANDABLE_OP_MODES = new Set<OpMode>([2, 3, 4, 6])

/** Chargers that could physically absorb surplus this cycle. */
function isSolarCandidate(charger: ChargerInput): boolean {
  if (!canAcceptSetpoint(charger.opMode)) return false
  if (charger.overrideActive) return false
  if (!charger.target) return false
  return charger.target.deliveredKwh < charger.target.energyKwh
}

/**
 * Ladder rule 5 — allocate the available surplus (T080).
 *
 * Chargers are served in input order, which the optimizer keeps stable, and each is given only what
 * still clears the modulation floor. A share that would fall below the floor is not rounded up from
 * the grid — the charger waits (FR-020). US5 replaces the ordering with the fairness draw when the
 * surplus cannot serve everyone.
 */
function allocateSurplus(
  inputs: CycleInputs,
  solarUsable: boolean,
  notes: string[],
): { shareByChargerId: Map<string, number>; notSelected: Set<string> } {
  const shareByChargerId = new Map<string, number>()
  const notSelected = new Set<string>()
  if (!solarUsable) return { shareByChargerId, notSelected }

  let remainingKw = inputs.surplus.smoothedKw ?? 0
  if (remainingKw <= 0) return { shareByChargerId, notSelected }

  const candidates = inputs.chargers.filter(isSolarCandidate)
  if (candidates.length === 0) return { shareByChargerId, notSelected }

  // --- Rule 6: the order of service is the fairness draw (T105, FR-024) -------------------------
  //
  // Chargers already drawing solar keep their place in the queue, and only the rest is drawn for.
  // Re-rolling every charger every cycle would be *more* random but not more fair: a contested
  // charger would be switched on and off every five minutes all afternoon, which is precisely the
  // treatment research R5 warns some cars object to. Stickiness costs nothing in fairness terms
  // because the ledger is a rolling 30-day total — an incumbent's advantage today is repaid in the
  // weights tomorrow.
  //
  // With one candidate there is nothing to be fair about, and the draw is skipped entirely.
  const incumbents = candidates.filter((c) => c.commandedCurrentA >= inputs.config.minCurrentA)
  const challengers = candidates.filter((c) => c.commandedCurrentA < inputs.config.minCurrentA)
  const ordered = [
    ...incumbents,
    ...drawOrder(
      challengers.map((charger) => ({ item: charger, userId: charger.userId })),
      inputs.fairness,
      inputs.randomSeed,
    ),
  ]

  for (const charger of ordered) {
    const wantedA = Math.min(
      charger.maxCurrentA,
      floorToWholeAmps(kwToAmps(remainingKw, charger.phases)),
    )
    if (wantedA < inputs.config.minCurrentA) {
      // Splitting further would put every share below the modulation floor, so the remainder of
      // the draw goes unserved this cycle (FR-020, FR-024).
      notSelected.add(charger.chargerId)
      continue
    }
    shareByChargerId.set(charger.chargerId, wantedA)
    remainingKw = round(remainingKw - ampsToKw(wantedA, charger.phases))
  }

  const served = shareByChargerId.size
  if (served < candidates.length && served > 0) {
    notes.push(
      `surplus of ${inputs.surplus.smoothedKw} kW served ${served} of ${candidates.length} competing chargers`,
    )
  }
  // With nobody served there is no winner, so nobody "lost" the draw either — they are all simply
  // waiting for surplus.
  return { shareByChargerId, notSelected: served > 0 ? notSelected : new Set<string>() }
}

/**
 * The deferral decision (T082, FR-022, research R4).
 *
 * All three R4 conditions must hold: the deadline is more than 24 hours away, tomorrow is
 * materially sunnier (`forecast.deferRecommended`, computed by the weather client), and the target
 * is still comfortably reachable.
 *
 * Note what a deferral *is* here: a reason recorded against a cycle in which the charger was not
 * going to charge anyway. It never suppresses a charge that rule 4 would otherwise have made,
 * because rule 4 only fires once a target stops being `reachable` — which is the same condition
 * this function requires. That is why a deferral can never create a shortfall, by construction
 * rather than by a re-check.
 */
function deferralApplies(
  charger: ChargerInput,
  inputs: CycleInputs,
  reachability: Reachability,
): boolean {
  if (inputs.seasonMode === 'winter') return false
  if (!inputs.forecast?.deferRecommended) return false
  if (!charger.target) return false
  if (reachability.state !== 'reachable') return false
  const hoursAway = (parseInstant(charger.target.deadline) - parseInstant(inputs.now)) / 3_600_000
  return hoursAway > 24
}

/** Rules 2–6 for one charger, before the line-headroom ceiling is applied. */
function propose(
  charger: ChargerInput,
  inputs: CycleInputs,
  solarUsable: boolean,
  solarShareA: number,
  lostTheDraw: boolean,
): Proposal {
  const { config } = inputs
  const evaluation = charger.target
    ? evaluateReachability(charger.target, inputs.now, config, {
        maxCurrentA: charger.maxCurrentA,
        phases: charger.phases,
      })
    : {
        reachability: { state: 'reachable' as const, expectedShortfallKwh: 0 },
        ratio: Number.POSITIVE_INFINITY,
      }
  const reachability: Reachability = evaluation.reachability

  const decided = (
    targetCurrentA: number,
    reason: DecisionReason,
    ladderRule: LadderRule,
    attribution: ChargerDecision['attribution'],
  ): Proposal => ({
    charger,
    chargerId: charger.chargerId,
    targetCurrentA,
    reason,
    ladderRule,
    expectedKwhThisCycle: round(energyKwh(targetCurrentA, charger.phases, CYCLE_MINUTES)),
    attribution,
    reachability,
  })

  // --- States in which no command may be issued at all ---------------------------------------
  // opMode 0 (offline) and 5 (error) are recorded for the admin view and left alone: retrying a
  // charger that is reporting an error is how a retry storm starts (contracts/scheduler-core.md).
  if (charger.opMode === 0 || charger.opMode === 5) {
    return decided(0, 'charger_error', null, 'none')
  }
  if (charger.opMode === 1) {
    return decided(0, 'not_plugged_in', null, 'none')
  }
  // opMode 7/8: a car is connected but the charger is still in the authorisation handshake. It
  // would refuse the current, so none is commanded — and this is deliberately *not* `charger_error`:
  // the fix is at the charger (present the RFID tag), not in this system.
  if (charger.opMode === 7 || charger.opMode === 8) {
    return decided(0, 'awaiting_authentication', null, 'none')
  }
  // FR-030 is unconditional: once the declared energy has been delivered, this system stops asking
  // for current — the override lifts the price policy and the deadline, not the user's own target.
  if (charger.target && charger.target.deliveredKwh >= charger.target.energyKwh) {
    return decided(0, 'target_met', null, 'none')
  }

  // --- Rule 2: the override ---------------------------------------------------------------------
  // Evaluated *before* the no-target case on purpose. "A user in a hurry presses charge now" (US4);
  // making them declare a kWh figure and a deadline first would defeat the escape hatch.
  if (charger.overrideActive) {
    return decided(charger.maxCurrentA, 'override', 2, 'grid')
  }

  if (!charger.target) {
    return decided(0, 'no_target', null, 'none')
  }

  const highPrice = inputs.tariffWindow === 'high'
  const charging = charger.commandedCurrentA >= config.minCurrentA

  // --- Rule 4: the deadline, from low-price grid energy (FR-021) -------------------------------
  // Rule 3 forbids this inside a high-price window, which is exactly the conflict the constitution
  // resolves in rule 3's favour. Only the winter window imports unconditionally: a *missing*
  // surplus reading in solar mode is not evidence that there is no sun today, and treating it as
  // such would be the zero-surplus assumption FR-016 forbids wearing different clothes.
  if (!highPrice) {
    const ratio = evaluation.ratio

    // A hysteresis band, not a threshold — and the band is asymmetric for a reason.
    //
    // Starting is easy: the headroom fell below the risk margin. *Stopping* is only ever a good
    // idea when something better is available to take over, and the only better thing is the sun.
    // With no usable surplus, stopping is actively harmful: the headroom ratio shrinks on its own
    // as the deadline approaches, so a charger that stops because it is momentarily comfortable is
    // at risk again minutes later — and it has spent low-price time doing nothing in between. That
    // is what quickstart V3 caught, ten minutes of idling near a deadline it then only just met.
    // "Something better" means a *usable surplus reading*. While one exists the ordinary band
    // applies and the fallback can hand back to rule 5; with no usable reading at all there is
    // nothing to hand over to, so an engaged fallback runs until the target is met.
    const marginNeeded = !charging
      ? DEADLINE_RISK_MARGIN
      : solarUsable
        ? DEADLINE_RESUME_MARGIN
        : Number.POSITIVE_INFINITY

    const mustImport = inputs.seasonMode === 'winter' || ratio < marginNeeded
    if (mustImport) {
      return decided(charger.maxCurrentA, 'deadline_fallback', 4, 'grid')
    }
  }

  // --- Rule 5: solar self-consumption (FR-019, FR-020) ------------------------------------------
  if (solarUsable) {
    if (solarShareA >= config.minCurrentA) {
      // Two consecutive cycles above the floor before starting, so a single spike cannot start a
      // session (research R2).
      if (charging || mayStart(charger, config)) {
        return decided(solarShareA, 'solar_surplus', 5, 'solar')
      }
      return decided(0, 'awaiting_surplus', null, 'none')
    }

    if (charging) {
      // Below the floor while already charging: hold for one more cycle, so a passing cloud does
      // not drop the session (research R2).
      if (!mustStop(charger, config)) {
        return decided(charger.commandedCurrentA, 'solar_surplus', 5, 'solar')
      }
      return decided(0, 'below_modulation_floor', 5, 'none')
    }

    // Ladder rule 6: there was surplus, and it went to someone else this cycle.
    if (lostTheDraw) {
      return decided(0, 'fairness_not_selected', 6, 'none')
    }
  }

  // --- Rule 3: nothing left that is permitted inside a high-price window ------------------------
  if (highPrice) {
    return decided(0, 'high_price_blocked', 3, 'none')
  }

  if (deferralApplies(charger, inputs, reachability)) {
    return decided(0, 'deferred_to_tomorrow', 5, 'none')
  }

  return decided(0, 'awaiting_surplus', null, 'none')
}

/**
 * Rule 1 — the advisory per-line headroom (T051).
 *
 * This caps *this system's own* commanded sum per supply line. It is never used to raise a cap the
 * external load manager set, and it is not a substitute for that load manager: if it is capping us
 * anyway, the read-back records it and the next cycle adapts.
 *
 * Chargers are considered in input order, which the optimizer keeps stable, so the allocation is
 * reproducible (SC-010) rather than dependent on iteration order.
 */
function applyLineHeadroom(proposals: Proposal[], inputs: CycleInputs): ChargerDecision[] {
  const { config, lineLimits } = inputs
  const used: Record<'L1' | 'L2', number> = { L1: 0, L2: 0 }
  let usedTotal = 0

  return proposals.map((proposal) => {
    const { charger, ...decision } = proposal
    if (decision.targetCurrentA <= 0) return decision

    const headroom = Math.min(
      lineLimits[charger.line] - used[charger.line],
      lineLimits.total - usedTotal,
    )
    const capped = Math.min(decision.targetCurrentA, floorToWholeAmps(Math.max(0, headroom)))

    if (capped >= decision.targetCurrentA) {
      used[charger.line] += decision.targetCurrentA
      usedTotal += decision.targetCurrentA
      return decision
    }

    if (capped < config.minCurrentA) {
      // Below the modulation floor a charger cannot be modulated at all: it runs at the floor or
      // it is off (FR-020). Off is the only honest option here.
      return {
        ...decision,
        targetCurrentA: 0,
        reason: 'below_modulation_floor' as const,
        ladderRule: 1 as const,
        expectedKwhThisCycle: 0,
        attribution: 'none' as const,
      }
    }

    used[charger.line] += capped
    usedTotal += capped
    return {
      ...decision,
      targetCurrentA: capped,
      ladderRule: 1 as const,
      expectedKwhThisCycle: round(energyKwh(capped, charger.phases, CYCLE_MINUTES)),
    }
  })
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

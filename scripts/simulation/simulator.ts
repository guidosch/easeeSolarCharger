import {
  CYCLE_MINUTES,
  DEFAULT_LINE_LIMITS,
  DEFAULT_SCHEDULER_CONFIG,
  classifyQuality,
  decide,
  energyKwh,
  ewma,
  isDaylight,
  nextHysteresis,
  seasonModeAt,
  solarShares,
  surplusRawKw,
  tariffWindowAt,
} from '@app/core'
import type {
  Attribution,
  ChargerDecision,
  ChargerInput,
  CycleDecision,
  CycleInputs,
  OpMode,
  SurplusInput,
} from '@app/core'
import type { FixtureDay, FixtureLot } from './types.js'

/**
 * The replay simulator (T045).
 *
 * What it simulates is the **hardware and the providers** — a charger that accepts a setpoint,
 * loses it on plug-in, and delivers no more than the external load manager allows. What it does
 * *not* simulate is the decision: that comes from the real `decide()` in `packages/core`, so a
 * replay is evidence about the shipped scheduler rather than about a second implementation of it.
 *
 * Firestore is deliberately out of the loop. The decision path is pure and the recorded corpus is
 * about decisions; the Firestore edges (leases, retention, deletion) have their own emulator-backed
 * integration tests. Keeping the two separate is also what lets `pnpm replay` run without Java.
 */

export type RecordedCycle = {
  cycleId: string
  inputs: CycleInputs
  decision: CycleDecision
}

export type SimulationResult = {
  fixture: string
  schedulerVersion: string
  cycles: RecordedCycle[]
  /** Per lot: how the day ended, for scenario assertions. */
  outcomes: Record<
    string,
    {
      deliveredKwh: number
      solarKwh: number
      gridKwh: number
      targetEnergyKwh: number | null
      deadline: string | null
      targetMet: boolean
      setpointChanges: number
      /** Instants at which the commanded current went from 0 to non-zero or back. */
      startStopInstants: string[]
    }
  >
  /** Documents a real cycle would have written, for the write-budget report (V10). */
  firestoreWrites: number
}

type SimCharger = {
  lot: FixtureLot
  opMode: OpMode
  deliveredCurrentA: number
  dynamicChargerCurrentA: number
  commandedCurrentA: number
  totalPowerKw: number
  sessionEnergyKwh: number
  overrideActive: boolean
  consecutiveAboveFloor: number
  consecutiveBelowFloor: number
  lastAttribution: Attribution
  lastSnapshotAtMs: number | null
  target: { energyKwh: number; deadline: string; deliveredKwh: number } | null
  lastFlushAtMs: number | null
  solarKwh: number
  gridKwh: number
  setpointChanges: number
  startStopInstants: string[]
}

const PLUGGED_MODES: OpMode[] = [2, 3, 6]

/** Mirrors `FLUSH_INTERVAL_MINUTES` in services/optimizer/src/sessions.ts. */
const FLUSH_INTERVAL_MINUTES = 30

export function runFixtureDay(fixture: FixtureDay): SimulationResult {
  const config = DEFAULT_SCHEDULER_CONFIG
  const chargers = new Map<string, SimCharger>(
    fixture.lots.map((lot) => [
      lot.lotNumber,
      {
        lot,
        opMode: 1,
        deliveredCurrentA: 0,
        dynamicChargerCurrentA: 0,
        commandedCurrentA: 0,
        totalPowerKw: 0,
        sessionEnergyKwh: 0,
        overrideActive: false,
        consecutiveAboveFloor: 0,
        consecutiveBelowFloor: 0,
        lastAttribution: 'none' as Attribution,
        lastSnapshotAtMs: null,
        lastFlushAtMs: null,
        target: null,
        solarKwh: 0,
        gridKwh: 0,
        setpointChanges: 0,
        startStopInstants: [],
      },
    ]),
  )

  for (const target of fixture.targets) {
    const charger = chargers.get(target.lotNumber)
    if (charger) {
      charger.target = {
        energyKwh: target.energyKwh,
        deadline: target.deadline,
        deliveredKwh: target.deliveredKwh,
      }
    }
  }

  const cycles: RecordedCycle[] = []
  let firestoreWrites = 0
  let previousSurplus: { smoothedKw: number | null; observedAt: string | null } = {
    smoothedKw: null,
    observedAt: null,
  }

  const from = Date.parse(fixture.cycles.from)
  const to = Date.parse(fixture.cycles.to)
  const stepMs = fixture.cycles.stepMinutes * 60_000

  for (let t = from; t <= to; t += stepMs) {
    const nowIso = new Date(t).toISOString()

    // --- the world as the optimizer would observe it -------------------------------------------
    for (const charger of chargers.values()) {
      applyPlugState(charger, fixture, t)
      charger.overrideActive = fixture.overrides.some(
        (o) =>
          o.lotNumber === charger.lot.lotNumber && t >= Date.parse(o.from) && t < Date.parse(o.to),
      )
    }

    const ownChargingKw = [...chargers.values()]
      .filter((c) => c.commandedCurrentA > 0)
      .reduce((sum, c) => sum + c.totalPowerKw, 0)

    const surplus = surplusAt(fixture, t, previousSurplus, ownChargingKw, config)
    previousSurplus = { smoothedKw: surplus.smoothedKw, observedAt: surplus.observedAt }

    const inputs: CycleInputs = {
      cycleId: nowIso,
      now: nowIso,
      schedulerVersion: fixture.schedulerVersion,
      randomSeed: nowIso,
      surplus,
      gridExportKw: surplus.rawKw,
      ownChargingKw: round(ownChargingKw),
      daylight: isDaylight(nowIso, fixture.site.latitude, fixture.site.longitude),
      seasonMode: seasonModeAt(nowIso, config),
      tariffWindow: tariffWindowAt(nowIso, config),
      forecast: fixture.forecast ? { ...fixture.forecast, deferRecommended: false } : null,
      chargers: [...chargers.values()].map(toChargerInput),
      fairness: fairnessFrom(chargers),
      lineLimits: { ...DEFAULT_LINE_LIMITS },
      config,
    }

    const decision = decide(inputs)
    cycles.push({ cycleId: nowIso, inputs, decision })

    // Advance the start/stop hysteresis exactly as `persistence.ts` does, from the share rather
    // than from the decision.
    const shares = solarShares(inputs)
    for (const charger of chargers.values()) {
      const eligible = charger.target !== null && ![0, 1, 5].includes(charger.opMode)
      if (!eligible) {
        charger.consecutiveAboveFloor = 0
        charger.consecutiveBelowFloor = 0
        continue
      }
      const counters = nextHysteresis(
        {
          consecutiveAboveFloor: charger.consecutiveAboveFloor,
          consecutiveBelowFloor: charger.consecutiveBelowFloor,
        },
        (shares.get(charger.lot.chargerId) ?? 0) >= config.minCurrentA,
      )
      charger.consecutiveAboveFloor = counters.consecutiveAboveFloor
      charger.consecutiveBelowFloor = counters.consecutiveBelowFloor
    }

    // --- what the hardware does with that decision ---------------------------------------------
    firestoreWrites += 1 // the cycle record
    firestoreWrites += 1 // the lease
    for (const chargerDecision of decision.decisions) {
      const charger = [...chargers.values()].find(
        (c) => c.lot.chargerId === chargerDecision.chargerId,
      )
      if (charger) firestoreWrites += applyDecision(charger, chargerDecision, fixture, t, nowIso)
    }
    firestoreWrites += 1 // the batched charger-mirror update
  }

  return {
    fixture: fixture.name,
    schedulerVersion: fixture.schedulerVersion,
    cycles,
    outcomes: Object.fromEntries(
      [...chargers.entries()].map(([lotNumber, charger]) => [
        lotNumber,
        {
          deliveredKwh: round(charger.target?.deliveredKwh ?? 0),
          solarKwh: round(charger.solarKwh),
          gridKwh: round(charger.gridKwh),
          targetEnergyKwh: charger.target?.energyKwh ?? null,
          deadline: charger.target?.deadline ?? null,
          targetMet: charger.target
            ? charger.target.deliveredKwh >= charger.target.energyKwh
            : false,
          setpointChanges: charger.setpointChanges,
          startStopInstants: charger.startStopInstants,
        },
      ]),
    ),
    firestoreWrites,
  }
}

function toChargerInput(charger: SimCharger): ChargerInput {
  return {
    chargerId: charger.lot.chargerId,
    lotNumber: charger.lot.lotNumber,
    userId: charger.lot.easeeUserId === '' ? null : charger.lot.easeeUserId,
    line: charger.lot.line,
    phases: charger.lot.phases,
    maxCurrentA: charger.lot.maxCurrentA,
    opMode: charger.opMode,
    deliveredCurrentA: charger.deliveredCurrentA,
    dynamicChargerCurrentA: charger.dynamicChargerCurrentA,
    commandedCurrentA: charger.commandedCurrentA,
    totalPowerKw: charger.totalPowerKw,
    sessionEnergyKwh: charger.sessionEnergyKwh,
    observedAt: new Date(0).toISOString(),
    overrideActive: charger.overrideActive,
    consecutiveAboveFloor: charger.consecutiveAboveFloor,
    consecutiveBelowFloor: charger.consecutiveBelowFloor,
    target: charger.target ? { ...charger.target } : null,
  }
}

function fairnessFrom(chargers: Map<string, SimCharger>): CycleInputs['fairness'] {
  const fairness: CycleInputs['fairness'] = {}
  for (const charger of chargers.values()) {
    const userId = charger.lot.easeeUserId
    if (!userId) continue
    fairness[userId] = {
      solarKwhReceived: round((fairness[userId]?.solarKwhReceived ?? 0) + charger.solarKwh),
    }
  }
  return fairness
}

function applyPlugState(charger: SimCharger, fixture: FixtureDay, t: number): void {
  const window = fixture.plugged.find(
    (p) => p.lotNumber === charger.lot.lotNumber && t >= Date.parse(p.from) && t < Date.parse(p.to),
  )
  const wasPlugged = PLUGGED_MODES.includes(charger.opMode)

  if (!window) {
    if (wasPlugged) {
      charger.opMode = 1
      charger.deliveredCurrentA = 0
      charger.totalPowerKw = 0
      charger.sessionEnergyKwh = 0
      charger.commandedCurrentA = 0
      charger.dynamicChargerCurrentA = 0
    }
    return
  }

  if (!wasPlugged) {
    charger.opMode = 2 // AwaitingStart
    charger.sessionEnergyKwh = 0
    // Easee resets the dynamic current on plug-in; the optimizer must notice and re-apply it.
    if (window.resetsSetpointOnPlugIn) charger.dynamicChargerCurrentA = 0
  }
}

/**
 * Applies one charger decision and advances that charger by a cycle.
 *
 * Returns the number of Firestore documents a real cycle would have written for it, so the
 * write-budget report (V10) counts the same things the optimizer does.
 */
function applyDecision(
  charger: SimCharger,
  decision: ChargerDecision,
  fixture: FixtureDay,
  t: number,
  nowIso: string,
): number {
  let writes = 0
  const window = fixture.plugged.find(
    (p) => p.lotNumber === charger.lot.lotNumber && t >= Date.parse(p.from) && t < Date.parse(p.to),
  )

  const previousCommanded = charger.commandedCurrentA
  const setpointLost = charger.dynamicChargerCurrentA !== previousCommanded
  const beyondDeadband =
    Math.abs(decision.targetCurrentA - previousCommanded) >= DEFAULT_SCHEDULER_CONFIG.deadbandA

  if (beyondDeadband || (setpointLost && decision.targetCurrentA > 0)) {
    charger.commandedCurrentA = decision.targetCurrentA
    charger.dynamicChargerCurrentA = decision.targetCurrentA
    charger.setpointChanges += 1
    const wasOn = previousCommanded > 0
    const isOn = decision.targetCurrentA > 0
    if (wasOn !== isOn) charger.startStopInstants.push(nowIso)
  }

  if (!window) {
    charger.deliveredCurrentA = 0
    charger.totalPowerKw = 0
    return writes
  }

  const externalCap = window.externalCapA ?? Number.POSITIVE_INFINITY
  const delivered = Math.min(charger.dynamicChargerCurrentA, externalCap)
  charger.deliveredCurrentA = delivered >= DEFAULT_SCHEDULER_CONFIG.minCurrentA ? delivered : 0
  charger.opMode = charger.deliveredCurrentA > 0 ? 3 : 6
  charger.totalPowerKw = round(
    (energyKwh(charger.deliveredCurrentA, charger.lot.phases, 60) * 60) / 60,
  )

  const deliveredKwh = energyKwh(charger.deliveredCurrentA, charger.lot.phases, CYCLE_MINUTES)
  if (deliveredKwh > 0) {
    charger.sessionEnergyKwh = round(charger.sessionEnergyKwh + deliveredKwh)
    if (charger.target)
      charger.target.deliveredKwh = round(charger.target.deliveredKwh + deliveredKwh)
    if (decision.attribution === 'solar') charger.solarKwh = round(charger.solarKwh + deliveredKwh)
    else charger.gridKwh = round(charger.gridKwh + deliveredKwh)

    // The target and session documents are flushed about every fifteen minutes, not every cycle —
    // the accumulated energy rides on the charger mirror, which is written anyway (FR-046).
    const due =
      charger.lastFlushAtMs === null || t - charger.lastFlushAtMs >= FLUSH_INTERVAL_MINUTES * 60_000
    const met = charger.target !== null && charger.target.deliveredKwh >= charger.target.energyKwh
    if (due || met) {
      charger.lastFlushAtMs = t
      writes += charger.target ? 2 : 1 // the target update and the session update
    }
  }
  charger.lastAttribution = decision.attribution

  // A snapshot roughly every fifteen minutes for an active charger (FR-046).
  const active = PLUGGED_MODES.includes(charger.opMode)
  if (
    active &&
    (charger.lastSnapshotAtMs === null || t - charger.lastSnapshotAtMs >= 15 * 60_000)
  ) {
    charger.lastSnapshotAtMs = t
    writes += 1
  }

  return writes
}

/**
 * Reproduces exactly what `gather.ts` does to a SolarEdge reading: add our own charging back,
 * smooth it, and age it. A simulator that skipped the EWMA would make the hysteresis tests pass
 * for the wrong reason.
 */
function surplusAt(
  fixture: FixtureDay,
  t: number,
  previous: { smoothedKw: number | null; observedAt: string | null },
  ownChargingKw: number,
  config: typeof DEFAULT_SCHEDULER_CONFIG,
): SurplusInput {
  const failing =
    fixture.surplus.failsFrom !== undefined && t >= Date.parse(fixture.surplus.failsFrom)
  const daylight = isDaylight(
    new Date(t).toISOString(),
    fixture.site.latitude,
    fixture.site.longitude,
  )
  const winter = seasonModeAt(new Date(t).toISOString(), config) === 'winter'

  if (fixture.surplus.mode === 'series' && !failing && daylight && !winter) {
    const sample = [...fixture.surplus.samples]
      .filter((s) => Date.parse(s.at) <= t)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]
    if (sample) {
      const ageMinutes = Math.round((t - Date.parse(sample.at)) / 60_000)
      if (ageMinutes <= config.stalenessCutoffMinutes) {
        const rawKw = surplusRawKw(sample.gridExportKw, ownChargingKw)
        return {
          rawKw,
          smoothedKw: ewma(previous.smoothedKw, rawKw, config.ewmaAlpha),
          observedAt: sample.at,
          ageMinutes,
          quality: classifyQuality(ageMinutes, config),
        }
      }
    }
  }

  const observedAt = previous.observedAt
  const ageMinutes = observedAt === null ? null : Math.round((t - Date.parse(observedAt)) / 60_000)
  const quality = classifyQuality(ageMinutes, config)
  return {
    rawKw: null,
    smoothedKw: quality === 'unusable' ? null : previous.smoothedKw,
    observedAt,
    ageMinutes,
    quality,
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

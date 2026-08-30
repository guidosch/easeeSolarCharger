import {
  ChargersRepo,
  CyclesRepo,
  FairnessRepo,
  ParkingLotsRepo,
  TargetsRepo,
  emptyChargerDoc,
} from '@app/adapters'
import type { ChargerDoc, ChargerObservation, ParkingLotDoc, TargetDoc } from '@app/adapters'
import {
  DEFAULT_LINE_LIMITS,
  DEFAULT_SCHEDULER_CONFIG,
  classifyQuality,
  ewma,
  isDaylight,
  seasonModeAt,
  surplusRawKw,
  tariffWindowAt,
} from '@app/core'
import type { ChargerInput, CycleInputs, SurplusInput } from '@app/core'
import type { CycleDeps } from './ports.js'

/**
 * Gather (T052): read the world, join it, and produce the `CycleInputs` the pure core consumes.
 *
 * Everything impure about a cycle happens here and in `apply.ts`. What comes out is a plain value
 * that is recorded verbatim — which is what makes a recorded cycle replayable (Principle III).
 */

export type GatheredCharger = {
  lot: ParkingLotDoc
  previous: ChargerDoc
  observation: ChargerObservation | null
  /** Set when the charger could not be read this cycle; its last known state is carried forward. */
  readError: string | null
  target: TargetDoc | null
}

export type Gathered = {
  inputs: CycleInputs
  chargers: GatheredCharger[]
  notes: string[]
  degraded: boolean
}

export async function gather(deps: CycleDeps, cycleId: string): Promise<Gathered> {
  const nowIso = new Date(deps.now()).toISOString()
  const notes: string[] = []

  const lots = await new ParkingLotsRepo(deps.db).listAll()
  const chargerDocs = await new ChargersRepo(deps.db).listAll()
  const openTargets = await new TargetsRepo(deps.db).allOpen()
  const fairness = await new FairnessRepo(deps.db).weights()

  const byChargerId = new Map(chargerDocs.map((c) => [c.chargerId, c]))
  const targetByCharger = new Map(openTargets.map((t) => [t.chargerId, t]))

  // One request per charger, all observation IDs in a single call: 30 of the 100 requests the
  // rolling five-minute window allows (research R1).
  const gatheredChargers: GatheredCharger[] = []
  for (const lot of lots) {
    const previous =
      byChargerId.get(lot.chargerId) ??
      emptyChargerDoc({
        chargerId: lot.chargerId,
        lotNumber: lot.lotNumber,
        line: lot.line,
        phases: lot.phases,
        maxCurrentA: lot.maxCurrentA,
      })

    const result = await deps.chargers.read(lot.serialNumber, nowIso)
    if (result.ok) {
      gatheredChargers.push({
        lot,
        previous,
        observation: result.value,
        readError: null,
        target: targetByCharger.get(lot.chargerId) ?? null,
      })
    } else {
      // Fail-safe: the reading is stale for this charger, the last known state is kept, and no new
      // command is issued to it (contracts/external-providers.md).
      gatheredChargers.push({
        lot,
        previous,
        observation: null,
        readError: result.error.message,
        target: targetByCharger.get(lot.chargerId) ?? null,
      })
    }
  }

  const unreadable = gatheredChargers.filter((c) => c.readError !== null)
  if (unreadable.length > 0) {
    // The count alone hid a total provider outage for as long as it lasted: every charger read
    // failed, the cycle recorded `charger_error` for all of them, and nothing anywhere said why.
    // The cause travels with the count now — into the log *and* into the recorded cycle.
    const causes = [...new Set(unreadable.map((c) => c.readError as string))]
    notes.push(
      `${unreadable.length} charger(s) could not be read; their last known state is used ` +
        `(${causes.slice(0, 3).join('; ')})`,
    )
    deps.logger.error('charger reads failed; last known state is carried forward', {
      cycleId,
      failed: unreadable.length,
      total: gatheredChargers.length,
      causes,
      chargerIds: unreadable.slice(0, 10).map((c) => c.lot.chargerId),
    })
  }

  const ownChargingKw = gatheredChargers.reduce((sum, charger) => {
    if (charger.previous.commandedCurrentA <= 0) return sum
    return sum + (charger.observation?.totalPowerKw ?? charger.previous.totalPowerKw)
  }, 0)

  const config = DEFAULT_SCHEDULER_CONFIG
  const seasonMode = seasonModeAt(nowIso, config)
  const daylight = isDaylight(nowIso, deps.site.latitude, deps.site.longitude)

  const previousCycle = await mostRecentCycleInputs(deps)
  const surplus = await readSurplus(deps, nowIso, {
    seasonMode,
    daylight,
    ownChargingKw,
    previousSmoothedKw: previousCycle?.surplus.smoothedKw ?? null,
    previousObservedAt: previousCycle?.surplus.observedAt ?? null,
    notes,
  })
  const forecast = await readForecast(
    deps,
    nowIso,
    previousCycle?.forecast ?? null,
    seasonMode,
    notes,
  )

  const chargerInputs: ChargerInput[] = gatheredChargers.map((charger) =>
    toChargerInput(charger, nowIso),
  )

  const inputs: CycleInputs = {
    cycleId,
    now: nowIso,
    schedulerVersion: deps.schedulerVersion,
    // Seeded from the cycle ID: random across cycles, identical on replay (Principle III).
    randomSeed: cycleId,
    surplus: surplus.value,
    gridExportKw: surplus.gridExportKw,
    ownChargingKw: round(ownChargingKw),
    daylight,
    seasonMode,
    tariffWindow: tariffWindowAt(nowIso, config),
    forecast,
    chargers: chargerInputs,
    fairness,
    lineLimits: { ...DEFAULT_LINE_LIMITS },
    config,
  }

  return {
    inputs,
    chargers: gatheredChargers,
    notes,
    degraded: unreadable.length > 0 || surplus.degraded,
  }
}

export function toChargerInput(charger: GatheredCharger, nowIso: string): ChargerInput {
  const { lot, previous, observation, target } = charger
  return {
    chargerId: lot.chargerId,
    lotNumber: lot.lotNumber,
    userId: lot.easeeUserId === '' ? null : lot.easeeUserId,
    line: lot.line,
    phases: lot.phases,
    maxCurrentA: lot.maxCurrentA,
    opMode: observation?.opMode ?? previous.opMode,
    deliveredCurrentA: observation?.deliveredCurrentA ?? previous.outputCurrentA,
    dynamicChargerCurrentA: observation?.dynamicCurrentA ?? previous.dynamicChargerCurrentA,
    commandedCurrentA: previous.commandedCurrentA,
    totalPowerKw: observation?.totalPowerKw ?? previous.totalPowerKw,
    sessionEnergyKwh: observation?.sessionEnergyKwh ?? previous.sessionEnergyKwh,
    observedAt: observation?.observedAt ?? previous.observedAt ?? nowIso,
    overrideActive: previous.overrideActive,
    consecutiveAboveFloor: previous.consecutiveAboveFloor,
    consecutiveBelowFloor: previous.consecutiveBelowFloor,
    target: target
      ? {
          energyKwh: target.energyKwh,
          deadline: target.deadline,
          // Flushed plus not-yet-flushed: the core must never see less energy than has actually
          // been delivered, or it would keep charging past a met target for up to fifteen minutes.
          deliveredKwh: round(target.deliveredKwh + previous.pendingKwh),
        }
      : null,
  }
}

async function mostRecentCycleInputs(deps: CycleDeps): Promise<CycleInputs | null> {
  const recent = await new CyclesRepo(deps.db).recent(1)
  return recent[0]?.inputs ?? null
}

type SurplusContext = {
  seasonMode: 'solar' | 'winter'
  daylight: boolean
  ownChargingKw: number
  previousSmoothedKw: number | null
  previousObservedAt: string | null
  notes: string[]
}

/**
 * Reads the site surplus behind the daylight and winter gates.
 *
 * A failure is never a zero (FR-016). The previous reading is carried forward with its real age,
 * and past the staleness cutoff it becomes `unusable`, which puts the core into deadline-only mode.
 * US2 (T083) replaces the reader; the degradation rules here are the ones FR-044 requires and do
 * not change with it.
 */
async function readSurplus(
  deps: CycleDeps,
  nowIso: string,
  context: SurplusContext,
): Promise<{ value: SurplusInput; gridExportKw: number | null; degraded: boolean }> {
  const stale = (reason: string, byDesign = false) => {
    const observedAt = context.previousObservedAt
    const ageMinutes =
      observedAt === null
        ? null
        : Math.round((Date.parse(nowIso) - Date.parse(observedAt)) / 60_000)
    const quality = classifyQuality(ageMinutes, DEFAULT_SCHEDULER_CONFIG)
    if (reason) context.notes.push(reason)
    return {
      value: {
        rawKw: null,
        smoothedKw: quality === 'unusable' ? null : context.previousSmoothedKw,
        observedAt,
        ageMinutes,
        quality,
      },
      gridExportKw: null,
      // A cycle that skips SolarEdge *by design* — at night, or in the winter window — is running
      // exactly as specified, so it is not degraded. Reserving `degraded` for things that actually
      // went wrong is what keeps it worth looking at in the admin view.
      degraded: byDesign ? false : quality !== 'fresh',
    }
  }

  if (context.seasonMode === 'winter') {
    return stale('SolarEdge not called: winter window (FR-023, research R3)', true)
  }
  if (!context.daylight) {
    return stale('SolarEdge not called: outside the daylight gate (FR-045, research R3)', true)
  }

  const reading = await deps.surplus.read(nowIso)
  if (!reading.ok) {
    return stale(`surplus read failed (${reading.error.kind}): ${reading.error.message}`)
  }

  // Available surplus, not unused surplus: the cars this system commands are part of the site
  // load, so their power is added back (FR-015, research R2).
  const rawKw = surplusRawKw(reading.value.gridExportKw, context.ownChargingKw)
  return {
    value: {
      rawKw,
      smoothedKw: ewma(context.previousSmoothedKw, rawKw, DEFAULT_SCHEDULER_CONFIG.ewmaAlpha),
      observedAt: reading.value.observedAt,
      ageMinutes: Math.max(
        0,
        Math.round((Date.parse(nowIso) - Date.parse(reading.value.observedAt)) / 60_000),
      ),
      quality: 'fresh',
    },
    gridExportKw: round(reading.value.gridExportKw),
    degraded: false,
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

/**
 * The forecast (T084, FR-045, research R4).
 *
 * Fetched at most four times a day, so a deferral never rests on a forecast more than six hours
 * old. On any failure the previous forecast is reused; when there is none, the forecast is `null`
 * and `deferRecommended` is treated as false by the core — a missing forecast may never *cause* a
 * deferral, because a wrong deferral risks a deadline.
 */
const FORECAST_MAX_AGE_MINUTES = 6 * 60

async function readForecast(
  deps: CycleDeps,
  nowIso: string,
  previous: CycleInputs['forecast'],
  seasonMode: 'solar' | 'winter',
  notes: string[],
): Promise<CycleInputs['forecast']> {
  if (seasonMode === 'winter') {
    // Nothing to defer to: solar optimization is off for the whole window (FR-023).
    return null
  }

  const ageMinutes =
    previous === null ? null : (Date.parse(nowIso) - Date.parse(previous.fetchedAt)) / 60_000
  if (previous !== null && ageMinutes !== null && ageMinutes < FORECAST_MAX_AGE_MINUTES) {
    return previous
  }

  const reading = await deps.forecast.read(nowIso)
  if (reading.ok) return reading.value

  if (previous !== null) {
    notes.push(`forecast refresh failed (${reading.error.kind}); reusing the previous one`)
    return previous
  }
  notes.push(`no forecast available (${reading.error.kind})`)
  return null
}

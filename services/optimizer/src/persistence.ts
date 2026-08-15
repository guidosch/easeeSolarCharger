import { ChargerSnapshotsRepo, ChargersRepo, snapshotDue } from '@app/adapters'
import type { ChargerDoc } from '@app/adapters'
import { nextHysteresis, solarShares } from '@app/core'
import type { ChargerDecision, CycleInputs } from '@app/core'
import type { GatheredCharger } from './gather.js'
import type { CycleDeps } from './ports.js'
import { classifyDiscrepancy } from './readback.js'

/**
 * Persistence (T057) — the Principle VI compromise, stated as code.
 *
 * The live `chargers` mirror is updated **in place** (thirty documents, one batched write), and a
 * `chargerSnapshots` row is appended only for *active* chargers and only about every fifteen
 * minutes. Writing one snapshot per charger per cycle instead would be ~260k writes/month and would
 * blow the free tier on its own — which is exactly what FR-046 forbids.
 */
export async function persistChargerState(
  deps: CycleDeps,
  chargers: GatheredCharger[],
  decisions: ChargerDecision[],
  commanded: Map<string, number>,
  extraPatches: Map<string, Partial<ChargerDoc>>,
  inputs: CycleInputs,
): Promise<number> {
  const nowIso = new Date(deps.now()).toISOString()
  const decisionFor = new Map(decisions.map((d) => [d.chargerId, d]))
  // Advanced from the *share*, not from the decision: a charger held back by the two-cycle start
  // delay still had a share above the floor, and counting that as "below" would stop it ever
  // starting (see `solarShares`).
  const shares = solarShares(inputs)
  const eligible = new Set(
    inputs.chargers
      .filter((c) => c.target !== null && c.opMode !== 0 && c.opMode !== 1 && c.opMode !== 5)
      .map((c) => c.chargerId),
  )

  const updates: { chargerId: string; fields: Partial<ChargerDoc> }[] = []
  const snapshots: Parameters<ChargerSnapshotsRepo['writeMany']>[0] = []

  for (const charger of chargers) {
    const { lot, previous, observation } = charger
    const decision = decisionFor.get(lot.chargerId)
    const newlyCommanded = commanded.get(lot.chargerId)

    const fields: Partial<ChargerDoc> = {
      chargerId: lot.chargerId,
      lotNumber: lot.lotNumber,
      line: lot.line,
      phases: lot.phases,
      maxCurrentA: lot.maxCurrentA,
      ...extraPatches.get(lot.chargerId),
    }

    if (observation) {
      fields.opMode = observation.opMode
      fields.outputCurrentA = observation.deliveredCurrentA
      fields.dynamicChargerCurrentA = observation.dynamicCurrentA
      fields.totalPowerKw = observation.totalPowerKw
      fields.sessionEnergyKwh = observation.sessionEnergyKwh
      fields.lifetimeEnergyKwh = observation.lifetimeEnergyKwh
      fields.reasonForNoCurrent = observation.reasonForNoCurrent
      fields.observedAt = observation.observedAt
    }

    if (newlyCommanded !== undefined) {
      fields.commandedCurrentA = newlyCommanded
      fields.commandedAt = nowIso
    }

    if (decision) {
      // Remembered for the *next* cycle's energy attribution (see sessions.ts).
      fields.lastAttribution = decision.attribution
    }

    if (eligible.has(lot.chargerId)) {
      const counters = nextHysteresis(
        {
          consecutiveAboveFloor: previous.consecutiveAboveFloor,
          consecutiveBelowFloor: previous.consecutiveBelowFloor,
        },
        (shares.get(lot.chargerId) ?? 0) >= inputs.config.minCurrentA,
      )
      fields.consecutiveAboveFloor = counters.consecutiveAboveFloor
      fields.consecutiveBelowFloor = counters.consecutiveBelowFloor
    } else {
      // No target or not connected: there is no run of cycles to remember.
      fields.consecutiveAboveFloor = 0
      fields.consecutiveBelowFloor = 0
    }

    if (observation) {
      fields.discrepancy = classifyDiscrepancy({
        commandedCurrentA: newlyCommanded ?? previous.commandedCurrentA,
        dynamicChargerCurrentA: observation.dynamicCurrentA,
        deliveredCurrentA: observation.deliveredCurrentA,
        opMode: observation.opMode,
      })

      if (
        snapshotDue({ opMode: observation.opMode, lastSnapshotAt: previous.lastSnapshotAt }, nowIso)
      ) {
        snapshots.push({
          chargerId: lot.chargerId,
          lotNumber: lot.lotNumber,
          opMode: observation.opMode,
          outputCurrentA: observation.deliveredCurrentA,
          commandedCurrentA: newlyCommanded ?? previous.commandedCurrentA,
          totalPowerKw: observation.totalPowerKw,
          sessionEnergyKwh: observation.sessionEnergyKwh,
          observedAt: observation.observedAt,
        })
        fields.lastSnapshotAt = nowIso
      }
    }

    updates.push({ chargerId: lot.chargerId, fields })
  }

  if (deps.dryRun) return 0

  const chargerWrites = await new ChargersRepo(deps.db).patchMany(updates)
  const snapshotWrites = await new ChargerSnapshotsRepo(deps.db).writeMany(snapshots)
  return chargerWrites + snapshotWrites
}

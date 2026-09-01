import { ChargersRepo, CyclesRepo, TargetsRepo } from '@app/adapters'
import type { TargetDoc } from '@app/adapters'
import { beforeEach, describe, expect, it } from 'vitest'
import { runCycle } from '../src/cycle.js'
import { clearFirestore, noEmulator } from '../../../tests/support/emulator.js'
import { LOT, buildTestCycleDeps, observation, seedCharger } from './support/optimizer.js'
import type { FakeWorld } from './support/optimizer.js'

/**
 * T133 / quickstart **V7** — a plug-in resets the setpoint (research R5, FR-028).
 *
 * This is documented Easee behaviour, not a hypothesis: `dynamicChargerCurrent` is reset when a car
 * is plugged in. A system that assumed its last write survived would leave a freshly plugged-in car
 * at zero amps and never notice — the car simply would not charge, and the decision trail would
 * show a perfectly healthy commanded current the whole time.
 */

// A January night: winter mode, low tariff, so the deadline rule commands full current.
const NOW = Date.parse('2026-01-15T22:00:00+01:00')
const CYCLE_ID = '2026-01-15T21:00:00Z'

const target: TargetDoc = {
  targetId: 't_1',
  userId: LOT.easeeUserId,
  chargerId: LOT.chargerId,
  lotNumber: LOT.lotNumber,
  energyKwh: 40,
  deadline: '2026-01-16T07:00:00+01:00',
  status: 'open',
  deliveredKwh: 0,
  deliveredSolarKwh: 0,
  deliveredGridKwh: 0,
  reachability: {
    state: 'reachable',
    expectedShortfallKwh: 0,
    evaluatedAt: '2026-01-15T21:00:00Z',
  },
  createdAt: '2026-01-15T20:00:00Z',
  closedAt: null,
}

describe.skipIf(await noEmulator())('plug-in resets the setpoint', () => {
  let world: FakeWorld

  beforeEach(async () => {
    await clearFirestore()
    world = { observations: new Map(), written: [] }
  })

  it('records `lost` and re-applies the setpoint on the cycle that sees the plug-in', async () => {
    const deps = buildTestCycleDeps(world, NOW)
    // Last cycle the car was unplugged, and this system had commanded 16 A before that.
    await seedCharger(deps, LOT, {
      opMode: 1,
      commandedCurrentA: 16,
      dynamicChargerCurrentA: 16,
      lastAttribution: 'grid',
    })
    await new TargetsRepo(deps.db).createSuperseding(target)

    // The charger now reports AwaitingStart with its dynamic current reset to zero.
    world.observations.set(
      LOT.serialNumber,
      observation({
        opMode: 2,
        deliveredCurrentA: 0,
        dynamicCurrentA: 0,
        totalPowerKw: 0,
        sessionEnergyKwh: 0,
      }),
    )

    await runCycle(deps, CYCLE_ID)

    // The setpoint was re-applied rather than skipped by the deadband.
    expect(world.written).toEqual([{ chargerId: LOT.chargerId, amps: 16 }])

    const charger = await new ChargersRepo(deps.db).byId(LOT.chargerId)
    expect(charger?.commandedCurrentA).toBe(16)
    // The read-back for the *previous* command is recorded as lost, which is what makes the reset
    // visible in the admin view rather than a silent non-event.
    const cycle = await new CyclesRepo(deps.db).byId(CYCLE_ID)
    expect(cycle?.readBack[0]?.discrepancy).toBe('lost')
  })

  it('re-applies even when the decision is unchanged and the deadband would skip it', async () => {
    const deps = buildTestCycleDeps(world, NOW)
    await seedCharger(deps, LOT, {
      opMode: 3,
      commandedCurrentA: 16,
      dynamicChargerCurrentA: 16,
      sessionEnergyKwh: 5,
    })
    await new TargetsRepo(deps.db).createSuperseding(target)

    // Still charging, still wants 16 A — but the charger has lost the value (a reboot, say).
    world.observations.set(
      LOT.serialNumber,
      observation({ opMode: 3, deliveredCurrentA: 0, dynamicCurrentA: 0, sessionEnergyKwh: 5 }),
    )

    await runCycle(deps, CYCLE_ID)

    expect(world.written).toEqual([{ chargerId: LOT.chargerId, amps: 16 }])
  })

  it('opens the session when the plug-in lands on opMode 7 and commands once it is authorised', async () => {
    // A charger that requires an RFID tag goes `1 → 7 → 6`, never `1 → 2`. If 7 were not a plug-in,
    // the `6` would arrive with a previous mode of 7, no plug-in would ever be detected, and the
    // stored target would never be activated — the car would sit at 0 A with nothing to show why.
    const deps = buildTestCycleDeps(world, NOW)
    await seedCharger(deps, LOT, { opMode: 1, commandedCurrentA: 0, dynamicChargerCurrentA: 0 })
    await new TargetsRepo(deps.db).createSuperseding(target)

    world.observations.set(
      LOT.serialNumber,
      observation({ opMode: 7, deliveredCurrentA: 0, dynamicCurrentA: 0, sessionEnergyKwh: 0 }),
    )
    await runCycle(deps, CYCLE_ID)

    // Awaiting authentication: a session is open, but no current is asked for.
    expect(world.written).toEqual([])
    const afterPlugIn = await new ChargersRepo(deps.db).byId(LOT.chargerId)
    expect(afterPlugIn?.activeSessionId).not.toBeNull()

    // The tag is presented and the charger moves on to ReadyToCharge.
    world.observations.set(
      LOT.serialNumber,
      observation({ opMode: 6, deliveredCurrentA: 0, dynamicCurrentA: 0, sessionEnergyKwh: 0 }),
    )
    await runCycle(deps, '2026-01-15T21:05:00Z')

    expect(world.written).toEqual([{ chargerId: LOT.chargerId, amps: 16 }])
  })

  it('does not rewrite a setpoint that stuck', async () => {
    const deps = buildTestCycleDeps(world, NOW)
    await seedCharger(deps, LOT, {
      opMode: 3,
      commandedCurrentA: 16,
      dynamicChargerCurrentA: 16,
      sessionEnergyKwh: 5,
    })
    await new TargetsRepo(deps.db).createSuperseding(target)
    world.observations.set(
      LOT.serialNumber,
      observation({ opMode: 3, deliveredCurrentA: 16, dynamicCurrentA: 16, sessionEnergyKwh: 6 }),
    )

    await runCycle(deps, CYCLE_ID)

    // The ±1 A deadband holds: no write, no Easee call, nothing for the car to object to.
    expect(world.written).toHaveLength(0)
    const cycle = await new CyclesRepo(deps.db).byId(CYCLE_ID)
    expect(cycle?.readBack[0]?.discrepancy).toBe('none')
  })

  it('classifies a capped charger separately from a lost setpoint', async () => {
    const deps = buildTestCycleDeps(world, NOW)
    await seedCharger(deps, LOT, {
      opMode: 3,
      commandedCurrentA: 16,
      dynamicChargerCurrentA: 16,
      sessionEnergyKwh: 5,
    })
    await new TargetsRepo(deps.db).createSuperseding(target)
    // The setpoint stuck, but the external load manager is only allowing 6 A.
    world.observations.set(
      LOT.serialNumber,
      observation({ opMode: 3, deliveredCurrentA: 6, dynamicCurrentA: 16, sessionEnergyKwh: 6 }),
    )

    await runCycle(deps, CYCLE_ID)

    const cycle = await new CyclesRepo(deps.db).byId(CYCLE_ID)
    expect(cycle?.readBack[0]?.discrepancy).toBe('capped')
    // Principle I: the cap is accepted and recorded, never worked around.
    expect(world.written).toHaveLength(0)
  })
})

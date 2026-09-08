import { ChargersRepo, ParkingLotsRepo, SessionsRepo, TargetsRepo } from '@app/adapters'
import type { TargetDoc } from '@app/adapters'
import { energyKwh } from '@app/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { runCycle } from '../src/cycle.js'
import { energyDeltaKwh } from '../src/sessions.js'
import { clearFirestore, noEmulator } from '../../../tests/support/emulator.js'
import { LOT, buildTestCycleDeps, observation, seedCharger } from './support/optimizer.js'
import type { CycleDeps } from '../src/ports.js'
import type { FakeWorld } from './support/optimizer.js'

/**
 * Delivered energy, end to end (FR-029, FR-037, FR-046).
 *
 * The replay scenarios cannot cover this: the simulator adds each cycle's energy straight onto the
 * target, whereas production derives it from *differences* in Easee observation 121 and accumulates
 * them on the charger mirror, flushing to the target only every half hour. That is a completely
 * separate mechanism, it is the one a user reads on the progress bar, and every one of its failures
 * is silent — a target that stops advancing looks exactly like a car that stopped charging.
 *
 * These tests therefore drive the real cycle against a simulated charger and compare what the
 * target *records* with what the car *drew*.
 */

const START = Date.parse('2026-06-17T07:00:00+02:00')
const CYCLE_MS = 5 * 60_000

function openTarget(energy = 60): TargetDoc {
  return {
    targetId: 't_1',
    userId: LOT.easeeUserId,
    chargerId: LOT.chargerId,
    lotNumber: LOT.lotNumber,
    energyKwh: energy,
    deadline: '2026-06-17T22:00:00+02:00',
    status: 'open',
    deliveredKwh: 0,
    deliveredSolarKwh: 0,
    deliveredGridKwh: 0,
    reachability: {
      state: 'reachable',
      expectedShortfallKwh: 0,
      evaluatedAt: '2026-06-17T05:00:00Z',
    },
    createdAt: '2026-06-17T04:00:00Z',
    closedAt: null,
  }
}

/**
 * The charger as the hardware behaves (research R5).
 *
 * It holds the last setpoint written to it, the car draws that current whenever it is at or above
 * the modulation floor, and **observation 121 restarts at zero on every new charging session** —
 * which is why delivered energy is read as a difference and never as an absolute.
 */
class SimulatedCharger {
  dynamicA = 0
  deliveredA = 0
  sessionKwh = 0
  plugged: boolean
  drewKwh = 0
  /** What the optimizer has been *shown* so far: an observation always lags the draw by a cycle. */
  reportedKwh = 0

  constructor(plugged = true) {
    this.plugged = plugged
  }

  get opMode(): 1 | 3 | 6 {
    if (!this.plugged) return 1
    return this.deliveredA > 0 ? 3 : 6
  }

  advance(minutes: number): void {
    const wasCharging = this.deliveredA > 0
    this.deliveredA = this.plugged && this.dynamicA >= 6 ? this.dynamicA : 0
    if (this.deliveredA > 0 && !wasCharging) this.sessionKwh = 0
    const kwh = energyKwh(this.deliveredA, LOT.phases, minutes)
    this.sessionKwh = round(this.sessionKwh + kwh)
    this.drewKwh = round(this.drewKwh + kwh)
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** One cycle: show the charger to the optimizer, then apply whatever it commanded. */
async function tick(
  deps: CycleDeps,
  world: FakeWorld,
  hardware: SimulatedCharger,
  atMs: number,
): Promise<void> {
  world.observations.set(
    LOT.serialNumber,
    observation({
      opMode: hardware.opMode,
      deliveredCurrentA: hardware.deliveredA,
      dynamicCurrentA: hardware.dynamicA,
      totalPowerKw: energyKwh(hardware.deliveredA, LOT.phases, 60),
      sessionEnergyKwh: hardware.sessionKwh,
      observedAt: new Date(atMs).toISOString(),
    }),
  )
  world.surplus = {
    gridExportKw: 11,
    loadKw: 1,
    pvKw: 12,
    observedAt: new Date(atMs).toISOString(),
  }

  hardware.reportedKwh = hardware.drewKwh

  world.written.length = 0
  await runCycle(deps, new Date(atMs).toISOString())
  const written = world.written.at(-1)
  if (written) hardware.dynamicA = written.amps
  hardware.advance(5)
}

describe('energyDeltaKwh', () => {
  it('is the increment while a session runs', () => {
    expect(energyDeltaKwh(4.2, 5.1)).toBeCloseTo(0.9, 6)
  })

  it('credits only the new counter when the charger restarted its session', () => {
    // Observation 121 restarts at zero on a new charging session, so a drop is a reset rather than
    // negative energy — crediting the difference would subtract a whole session's worth.
    expect(energyDeltaKwh(12, 0.4)).toBeCloseTo(0.4, 6)
    expect(energyDeltaKwh(12, 0)).toBe(0)
  })
})

describe.skipIf(await noEmulator())('delivered energy reaches the target', () => {
  let world: FakeWorld

  beforeEach(async () => {
    await clearFirestore()
    world = { observations: new Map(), written: [] }
  })

  it('books every kWh the car drew across a long charge, and closes the target at the end', async () => {
    let clock = START
    const deps: CycleDeps = { ...buildTestCycleDeps(world, START), now: () => clock }
    const hardware = new SimulatedCharger()

    await seedCharger(deps, LOT, { opMode: 6, sessionEnergyKwh: 0 })
    await new TargetsRepo(deps.db).createSuperseding(openTarget(30))

    for (let cycle = 0; cycle < 60; cycle += 1) {
      await tick(deps, world, hardware, clock)
      clock += CYCLE_MS
    }

    const target = await new TargetsRepo(deps.db).byId(LOT.easeeUserId, 't_1')
    const charger = await new ChargersRepo(deps.db).byId(LOT.chargerId)
    expect(hardware.drewKwh).toBeGreaterThan(30)
    // Flushed plus not-yet-flushed is what every reader of a target sees (`toTargetView`), so it is
    // what has to add up to the energy the car actually took.
    expect((target?.deliveredKwh ?? 0) + (charger?.pendingKwh ?? 0)).toBeCloseTo(
      hardware.drewKwh,
      1,
    )
    expect(target?.status).toBe('met')
  })

  it('writes the unflushed remainder into the target when the car is unplugged', async () => {
    let clock = START
    const deps: CycleDeps = { ...buildTestCycleDeps(world, START), now: () => clock }
    const hardware = new SimulatedCharger(false)

    await seedCharger(deps, LOT, { opMode: 1, sessionEnergyKwh: 0 })
    await new TargetsRepo(deps.db).createSuperseding(openTarget())

    // Plugged in, charged for half an hour — less than one flush interval — and taken away again.
    // The energy accumulated since the last flush lives only on the charger mirror at that point,
    // and the mirror is cleared by the same cycle that closes the target: if the close does not
    // carry the remainder, the charge is gone from the record for good.
    for (let cycle = 0; cycle < 10; cycle += 1) {
      if (cycle === 1) hardware.plugged = true
      if (cycle === 8) hardware.plugged = false
      await tick(deps, world, hardware, clock)
      clock += CYCLE_MS
    }

    const target = await new TargetsRepo(deps.db).byId(LOT.easeeUserId, 't_1')
    const sessions = await new SessionsRepo(deps.db).recent(LOT.easeeUserId)
    expect(hardware.drewKwh).toBeGreaterThan(4)
    expect(target?.status).toBe('cancelled')
    expect(target?.deliveredKwh).toBeCloseTo(hardware.drewKwh, 1)
    // The session summary and the target must agree; the session used to be the only one right.
    expect(sessions[0]?.energyKwh).toBeCloseTo(hardware.drewKwh, 1)
  })

  it('works on a charger mirror the optimizer created itself, field by field', async () => {
    // `patchMany` writes a partial document, and `set(…, { merge: true })` on a missing one creates
    // it from just those fields — so a lot added to `parkingLots` without re-running `pnpm
    // seed:lots` gets a mirror with no `commandedCurrentA`, no `pendingKwh` and no `lastFlushAt`.
    // Read raw, those `undefined`s made the cycle record unwritable and turned every energy sum
    // into `NaN`: the charger was never commanded and its target never advanced again.
    let clock = START
    const deps: CycleDeps = { ...buildTestCycleDeps(world, START), now: () => clock }
    const hardware = new SimulatedCharger()

    await new ParkingLotsRepo(deps.db).upsert(LOT)
    await new TargetsRepo(deps.db).createSuperseding(openTarget())

    for (let cycle = 0; cycle < 12; cycle += 1) {
      await tick(deps, world, hardware, clock)
      clock += CYCLE_MS
    }

    const target = await new TargetsRepo(deps.db).byId(LOT.easeeUserId, 't_1')
    const charger = await new ChargersRepo(deps.db).byId(LOT.chargerId)
    // The run ends mid-charge, so the comparison is against what the last reading reported rather
    // than against the draw itself — an observation is always one cycle behind the car.
    expect(hardware.reportedKwh).toBeGreaterThan(5)
    expect((target?.deliveredKwh ?? 0) + (charger?.pendingKwh ?? 0)).toBeCloseTo(
      hardware.reportedKwh,
      1,
    )
  })
})

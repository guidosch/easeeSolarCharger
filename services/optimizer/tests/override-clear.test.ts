import { ChargersRepo, SessionsRepo } from '@app/adapters'
import { beforeEach, describe, expect, it } from 'vitest'
import { runCycle } from '../src/cycle.js'
import { clearFirestore, noEmulator } from '../../../tests/support/emulator.js'
import { LOT, buildTestCycleDeps, observation, seedCharger } from './support/optimizer.js'
import type { FakeWorld } from './support/optimizer.js'

/**
 * T099 / quickstart V4 — the override clears itself at session end (FR-033).
 *
 * The client must not be the thing that clears it: the phone may be in a pocket, the app closed or
 * the token expired at the moment the car is unplugged. An override that survived a session would
 * silently run the next one at full power straight through a high-price window.
 */
const NOW = Date.parse('2026-06-10T13:35:00+02:00')

describe.skipIf(await noEmulator())('override auto-clear', () => {
  let world: FakeWorld

  beforeEach(async () => {
    await clearFirestore()
    world = { observations: new Map(), written: [] }
  })

  it('clears the override when the car is unplugged, with no client call', async () => {
    const deps = buildTestCycleDeps(world, NOW)

    // The previous cycle saw a charging car with the override on and a session open.
    await seedCharger(deps, LOT, {
      opMode: 3,
      overrideActive: true,
      overrideSince: '2026-06-10T12:00:00+02:00',
      commandedCurrentA: 16,
      dynamicChargerCurrentA: 16,
      activeSessionId: 's_open',
      sessionEnergyKwh: 10,
      lastAttribution: 'grid',
    })
    await new SessionsRepo(deps.db).open({
      sessionId: 's_open',
      userId: LOT.easeeUserId,
      chargerId: LOT.chargerId,
      lotNumber: LOT.lotNumber,
      startedAt: '2026-06-10T09:00:00+02:00',
      endedAt: null,
      energyKwh: 10,
      solarKwh: 0,
      gridKwh: 10,
      targetEnergyKwh: 40,
      deadline: '2026-06-10T23:00:00+02:00',
      targetMet: false,
      endReason: null,
      overrideUsed: true,
      sessionEnergyAtStartKwh: 0,
    })

    // This cycle the charger reports opMode 1 — the car has been unplugged.
    world.observations.set(
      LOT.serialNumber,
      observation({
        opMode: 1,
        deliveredCurrentA: 0,
        dynamicCurrentA: 0,
        sessionEnergyKwh: 0,
        totalPowerKw: 0,
      }),
    )

    await runCycle(deps, '2026-06-10T11:35:00Z')

    const charger = await new ChargersRepo(deps.db).byId(LOT.chargerId)
    expect(charger?.overrideActive).toBe(false)
    expect(charger?.overrideSince).toBeNull()
    expect(charger?.activeSessionId).toBeNull()

    const session = await new SessionsRepo(deps.db).byId(LOT.easeeUserId, 's_open')
    expect(session?.endedAt).not.toBeNull()
    expect(session?.endReason).toBe('unplugged')
    expect(session?.overrideUsed).toBe(true)
  })

  it('leaves the override alone while the car is still plugged in', async () => {
    const deps = buildTestCycleDeps(world, NOW)
    await seedCharger(deps, LOT, {
      opMode: 3,
      overrideActive: true,
      overrideSince: '2026-06-10T12:00:00+02:00',
      commandedCurrentA: 16,
      dynamicChargerCurrentA: 16,
      sessionEnergyKwh: 10,
    })
    world.observations.set(LOT.serialNumber, observation({ sessionEnergyKwh: 11 }))

    await runCycle(deps, '2026-06-10T11:35:00Z')

    expect((await new ChargersRepo(deps.db).byId(LOT.chargerId))?.overrideActive).toBe(true)
  })

  it('records an override_off event, so the trail shows who ended it', async () => {
    const deps = buildTestCycleDeps(world, NOW)
    await seedCharger(deps, LOT, {
      opMode: 3,
      overrideActive: true,
      commandedCurrentA: 16,
      dynamicChargerCurrentA: 16,
      activeSessionId: null,
    })
    world.observations.set(
      LOT.serialNumber,
      observation({ opMode: 1, deliveredCurrentA: 0, dynamicCurrentA: 0, totalPowerKw: 0 }),
    )

    await runCycle(deps, '2026-06-10T11:35:00Z')

    const events = await deps.db.collection('chargerEvents').get()
    const types = events.docs.map((d) => (d.data() as { type: string }).type)
    expect(types).toContain('override_off')
    expect(types).toContain('unplugged')
  })
})

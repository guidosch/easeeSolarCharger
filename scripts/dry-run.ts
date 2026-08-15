import { buildCycleDeps } from '../services/optimizer/src/context.js'
import { gather } from '../services/optimizer/src/gather.js'
import { decide } from '@app/core'

/**
 * `pnpm cycle:dry-run --lot=<lot>` (T135).
 *
 * Computes a real cycle against the real world — the same gather, the same `decide()` — and writes
 * **nothing**: no setpoint, no Firestore document, no lease. It is the first step of every hardware
 * validation (quickstart, "Hardware validation"), because the only real hardware available is the
 * owner's own parking lot and the cheapest way to be wrong is on screen rather than on a car.
 */
function argValue(name: string): string | undefined {
  const prefix = `--${name}=`
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length)
}

async function main(): Promise<void> {
  const lotFilter = argValue('lot')
  const cycleId = argValue('at') ?? new Date().toISOString()

  const deps = await buildCycleDeps(cycleId)
  const dryDeps = { ...deps, dryRun: true }

  const gathered = await gather(dryDeps, cycleId)
  const decision = decide(gathered.inputs)

  const { inputs } = gathered
  console.log(`\ndry run at ${inputs.now}   (nothing was written)`)
  console.log(
    `  tariff ${inputs.tariffWindow}   season ${inputs.seasonMode}   ` +
      `daylight ${inputs.daylight ? 'yes' : 'no'}`,
  )
  console.log(
    `  surplus ${inputs.surplus.smoothedKw ?? '—'} kW ` +
      `(raw ${inputs.surplus.rawKw ?? '—'}, ${inputs.surplus.quality}, ` +
      `age ${inputs.surplus.ageMinutes ?? '—'} min, own charging ${inputs.ownChargingKw} kW)`,
  )
  for (const note of [...gathered.notes, ...decision.notes]) console.log(`  note: ${note}`)

  console.log('\n  decisions:')
  for (const chargerDecision of decision.decisions) {
    const charger = inputs.chargers.find((c) => c.chargerId === chargerDecision.chargerId)
    if (lotFilter && charger?.lotNumber !== lotFilter) continue
    console.log(
      `    ${(charger?.lotNumber ?? chargerDecision.chargerId).padEnd(5)} ` +
        `${String(chargerDecision.targetCurrentA).padStart(2)} A  ` +
        `${chargerDecision.reason.padEnd(22)} rule ${chargerDecision.ladderRule ?? '-'}  ` +
        `${chargerDecision.attribution}  ${chargerDecision.reachability.state}` +
        (charger ? `   (opMode ${charger.opMode}, commanded ${charger.commandedCurrentA} A)` : ''),
    )
  }

  if (lotFilter && !inputs.chargers.some((c) => c.lotNumber === lotFilter)) {
    console.error(`\n  no charger for parking lot ${lotFilter} — check the parkingLots mapping`)
    process.exitCode = 1
  }
  console.log()
}

main().catch((error: unknown) => {
  console.error('dry run failed:', error)
  process.exitCode = 1
})

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SimulationResult } from './simulation/simulator.js'
import { runFixtureDay } from './simulation/simulator.js'
import { parseFixtureDay } from './simulation/types.js'

/**
 * `pnpm cycle <instant>` (T045) — the decision at one simulated instant of the fixture that
 * `pnpm replay` last loaded.
 *
 * This is the command every quickstart scenario uses to make an assertion about a specific moment,
 * which is why it prints the ladder rule alongside the reason: those two fields are the whole
 * explanation of why a charger did or did not charge.
 */

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const CURRENT_POINTER = resolve(ROOT, 'fixtures/replays/current.json')

function loadCurrent(): { fixture: string; name: string } {
  try {
    return JSON.parse(readFileSync(CURRENT_POINTER, 'utf8')) as { fixture: string; name: string }
  } catch {
    throw new Error('no fixture loaded — run `pnpm replay <fixture>` first')
  }
}

function main(): void {
  const args = process.argv.slice(2)
  const instant = args.find((a) => !a.startsWith('--'))
  if (!instant) {
    console.error('usage: pnpm cycle <instant> [--fixture <path>]')
    process.exitCode = 1
    return
  }

  const explicit = args.indexOf('--fixture')
  const fixturePath =
    explicit >= 0 ? resolve(process.cwd(), args[explicit + 1] ?? '') : loadCurrent().fixture

  const fixture = parseFixtureDay(JSON.parse(readFileSync(fixturePath, 'utf8')))
  const result: SimulationResult = runFixtureDay(fixture)

  const wanted = Date.parse(instant)
  if (Number.isNaN(wanted)) {
    console.error(`not an instant: ${instant}`)
    process.exitCode = 1
    return
  }

  const cycle = result.cycles.find((c) => Date.parse(c.cycleId) === wanted)
  if (!cycle) {
    console.error(
      `no cycle at ${instant}. The fixture runs ${fixture.cycles.from} → ${fixture.cycles.to} ` +
        `every ${fixture.cycles.stepMinutes} minutes.`,
    )
    process.exitCode = 1
    return
  }

  const { inputs, decision } = cycle
  console.log(`\ncycle ${cycle.cycleId}  (${fixture.name})`)
  console.log(
    `  tariff ${inputs.tariffWindow}   season ${inputs.seasonMode}   ` +
      `daylight ${inputs.daylight ? 'yes' : 'no'}`,
  )
  console.log(
    `  surplus ${inputs.surplus.smoothedKw ?? '—'} kW ` +
      `(${inputs.surplus.quality}, age ${inputs.surplus.ageMinutes ?? '—'} min)`,
  )
  for (const note of decision.notes) console.log(`  note: ${note}`)

  console.log('\n  decisions:')
  for (const chargerDecision of decision.decisions) {
    const charger = inputs.chargers.find((c) => c.chargerId === chargerDecision.chargerId)
    console.log(
      `    ${charger?.lotNumber ?? chargerDecision.chargerId}  ` +
        `${String(chargerDecision.targetCurrentA).padStart(2)} A  ` +
        `${chargerDecision.reason} (rule ${chargerDecision.ladderRule ?? '-'}, ` +
        `${chargerDecision.attribution}, ${chargerDecision.reachability.state})`,
    )
  }
  console.log()
}

main()

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runFixtureDay } from './simulation/simulator.js'
import { parseFixtureDay } from './simulation/types.js'

/**
 * `pnpm replay <fixture>` (T045).
 *
 * Runs a recorded day through the real `decide()` and writes the resulting cycles to
 * `fixtures/replays/<name>.json`. That file is the regression corpus the constitution requires:
 * `pnpm test:determinism` re-runs every cycle in it and diffs against the recorded decisions.
 */

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
export const REPLAY_DIR = resolve(ROOT, 'fixtures/replays')
export const CURRENT_POINTER = resolve(REPLAY_DIR, 'current.json')

function main(): void {
  const args = process.argv.slice(2)
  const path = args.find((a) => !a.startsWith('--'))
  if (!path) {
    console.error('usage: pnpm replay <fixture> [--all-cycles] [--quiet]')
    process.exitCode = 1
    return
  }

  const fixturePath = resolve(process.cwd(), path)
  const fixture = parseFixtureDay(JSON.parse(readFileSync(fixturePath, 'utf8')))
  const result = runFixtureDay(fixture)

  mkdirSync(REPLAY_DIR, { recursive: true })
  const outputPath = resolve(REPLAY_DIR, `${fixture.name}.json`)
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`)
  writeFileSync(
    CURRENT_POINTER,
    `${JSON.stringify({ fixture: fixturePath, replay: outputPath, name: fixture.name }, null, 2)}\n`,
  )

  if (args.includes('--quiet')) return

  console.log(`\n${fixture.name} — ${result.cycles.length} cycles`)
  if (fixture.description) console.log(fixture.description)
  console.log(`recorded to ${outputPath.replace(`${ROOT}/`, '')}\n`)

  const reasons = new Map<string, number>()
  for (const cycle of result.cycles) {
    for (const decision of cycle.decision.decisions) {
      reasons.set(decision.reason, (reasons.get(decision.reason) ?? 0) + 1)
    }
  }

  console.log('decisions by reason:')
  for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason.padEnd(24)} ${count}`)
  }

  console.log('\nper parking lot:')
  for (const [lotNumber, outcome] of Object.entries(result.outcomes)) {
    const target = outcome.targetEnergyKwh === null ? 'no target' : `${outcome.targetEnergyKwh} kWh`
    console.log(
      `  ${lotNumber}: ${outcome.deliveredKwh.toFixed(1)} kWh delivered of ${target} ` +
        `(solar ${outcome.solarKwh.toFixed(1)}, grid ${outcome.gridKwh.toFixed(1)}), ` +
        `${outcome.targetMet ? 'target met' : 'target not met'}, ` +
        `${outcome.setpointChanges} setpoint changes, ${outcome.startStopInstants.length} start/stops`,
    )
  }

  console.log(`\nFirestore documents a real run would have written: ${result.firestoreWrites}`)

  if (args.includes('--all-cycles')) {
    console.log('\nevery cycle:')
    for (const cycle of result.cycles) {
      for (const decision of cycle.decision.decisions) {
        console.log(
          `  ${cycle.cycleId}  ${decision.chargerId}  ${String(decision.targetCurrentA).padStart(2)} A  ` +
            `${decision.reason} (rule ${decision.ladderRule ?? '-'})`,
        )
      }
    }
  }
}

if (dirname(fileURLToPath(import.meta.url)) === dirname(resolve(process.argv[1] ?? ''))) {
  main()
}

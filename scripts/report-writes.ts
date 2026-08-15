import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CYCLE_MINUTES } from '@app/core'
import type { CycleInputs } from '@app/core'

/**
 * `pnpm report:writes` — quickstart **V10** (T134, Principle VI, SC-012).
 *
 * Extrapolates a replayed day to a full 24 hours and checks it against the Firestore free
 * allowance. The budget is a *design* constraint, not a cost line: at 20,000 writes/day, a
 * regression to one write per charger per cycle (FR-046) is ~9,000/day at thirty chargers and the
 * system leaves the free tier without anything visibly breaking.
 */

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const FREE_TIER_WRITES_PER_DAY = 20_000
/** The figure quickstart V10 asserts, and roughly research R8's ~1,750. */
const BUDGET_WRITES_PER_DAY = 2_000

type Replay = {
  fixture: string
  cycles: { cycleId: string; inputs: CycleInputs }[]
  firestoreWrites: number
}

function main(): void {
  const name = process.argv[2] ?? 'summer-busy'
  const path = resolve(ROOT, `fixtures/replays/${name}.json`)

  let replay: Replay
  try {
    replay = JSON.parse(readFileSync(path, 'utf8')) as Replay
  } catch {
    console.error(
      `No recorded replay at ${path}. Run \`pnpm replay fixtures/days/${name}.json\` first.`,
    )
    process.exitCode = 1
    return
  }

  const cycles = replay.cycles.length
  const firstCycle = replay.cycles[0]
  const lastCycle = replay.cycles[cycles - 1]
  if (!firstCycle || !lastCycle) {
    console.error('the replay contains no cycles')
    process.exitCode = 1
    return
  }

  const spanMinutes = (Date.parse(lastCycle.cycleId) - Date.parse(firstCycle.cycleId)) / 60_000
  const cyclesPerDay = (24 * 60) / CYCLE_MINUTES

  // The replayed window is the *busy* part of the day. The rest is charged at the fixed per-cycle
  // cost only — a cycle record, the lease and the batched charger mirror — because nothing is
  // plugged in to snapshot or credit.
  const uncoveredCycles = Math.max(0, cyclesPerDay - cycles)
  const FIXED_WRITES_PER_CYCLE = 3
  const extrapolated = replay.firestoreWrites + uncoveredCycles * FIXED_WRITES_PER_CYCLE

  const activeChargers = new Set(
    replay.cycles.flatMap((c) =>
      c.inputs.chargers.filter((ch) => ch.target).map((ch) => ch.chargerId),
    ),
  ).size

  console.log(`\nwrite budget — ${replay.fixture}`)
  console.log(`  replayed          ${cycles} cycles over ${(spanMinutes / 60).toFixed(1)} h`)
  console.log(`  chargers with a target  ${activeChargers}`)
  console.log(`  writes in that window   ${replay.firestoreWrites}`)
  console.log(`  extrapolated to 24 h    ${extrapolated}`)
  console.log(`  design budget           ${BUDGET_WRITES_PER_DAY}`)
  console.log(
    `  free allowance          ${FREE_TIER_WRITES_PER_DAY} ` +
      `(${((extrapolated / FREE_TIER_WRITES_PER_DAY) * 100).toFixed(1)}% used)\n`,
  )

  if (extrapolated > BUDGET_WRITES_PER_DAY) {
    console.error(
      `FAIL: ${extrapolated} writes/day exceeds the ${BUDGET_WRITES_PER_DAY}/day design budget.\n` +
        'Check that snapshots are still ~15-minutely for active chargers only, and that the target\n' +
        'and session documents are still flushed periodically rather than every cycle (FR-046).',
    )
    process.exitCode = 1
    return
  }

  console.log(
    `OK: inside the design budget, and at ${((extrapolated / FREE_TIER_WRITES_PER_DAY) * 100).toFixed(1)}% of the free allowance.`,
  )
}

main()

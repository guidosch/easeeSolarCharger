import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decide } from '@app/core'
import type { CycleDecision, CycleInputs } from '@app/core'

/**
 * `pnpm test:determinism` — the SC-010 gate (T107).
 *
 * Re-runs `decide()` over every cycle in every recorded replay and compares the result with what
 * was recorded, byte for byte. This must be green before any optimizer change merges: a difference
 * here is either a behavioural change that has to be explained in the pull request, or a source of
 * non-determinism that makes the whole audit trail worthless.
 */

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const REPLAY_DIR = resolve(ROOT, 'fixtures/replays')

type Replay = {
  fixture: string
  schedulerVersion: string
  cycles: { cycleId: string; inputs: CycleInputs; decision: CycleDecision }[]
}

type Difference = {
  fixture: string
  cycleId: string
  recorded: string
  replayed: string
}

function main(): void {
  let files: string[]
  try {
    files = readdirSync(REPLAY_DIR).filter((f) => f.endsWith('.json') && f !== 'current.json')
  } catch {
    console.error(
      `No recorded replays in ${REPLAY_DIR}. Run \`pnpm replay fixtures/days/<day>.json\` first.`,
    )
    process.exitCode = 1
    return
  }

  if (files.length === 0) {
    console.error(
      'The regression corpus is empty — nothing to verify. This is a failure, not a pass.',
    )
    process.exitCode = 1
    return
  }

  const differences: Difference[] = []
  let cycleCount = 0

  for (const file of files) {
    const replay = JSON.parse(readFileSync(resolve(REPLAY_DIR, file), 'utf8')) as Replay
    for (const cycle of replay.cycles) {
      cycleCount += 1
      const replayed = decide(cycle.inputs)
      const recordedJson = JSON.stringify(cycle.decision)
      const replayedJson = JSON.stringify(replayed)
      if (recordedJson !== replayedJson) {
        differences.push({
          fixture: replay.fixture,
          cycleId: cycle.cycleId,
          recorded: recordedJson,
          replayed: replayedJson,
        })
      }
    }
  }

  if (differences.length === 0) {
    console.log(
      `determinism: ${cycleCount} recorded cycles across ${files.length} day(s) replayed byte-identically`,
    )
    return
  }

  console.error(
    `determinism: ${differences.length} of ${cycleCount} cycles differ from their recording\n`,
  )
  for (const difference of differences.slice(0, 10)) {
    // Print a window around the first differing character: these payloads are thousands of
    // characters long and the interesting part is rarely at the front.
    let at = 0
    while (at < difference.recorded.length && difference.recorded[at] === difference.replayed[at]) {
      at += 1
    }
    const from = Math.max(0, at - 80)
    console.error(
      `  ${difference.fixture} ${difference.cycleId} — first differs at character ${at}`,
    )
    console.error(`    recorded: …${difference.recorded.slice(from, at + 120)}`)
    console.error(`    replayed: …${difference.replayed.slice(from, at + 120)}\n`)
  }
  if (differences.length > 10) console.error(`  …and ${differences.length - 10} more`)
  console.error(
    'If this change was intended, re-record with `pnpm replay` and explain the behavioural ' +
      'difference in the pull request (constitution, Regression corpus).',
  )
  process.exitCode = 1
}

main()

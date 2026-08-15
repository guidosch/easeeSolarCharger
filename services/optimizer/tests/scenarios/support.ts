import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ChargerDecision } from '@app/core'
import { runFixtureDay } from '../../../../scripts/simulation/simulator.js'
import type { RecordedCycle, SimulationResult } from '../../../../scripts/simulation/simulator.js'
import { parseFixtureDay } from '../../../../scripts/simulation/types.js'

/**
 * The quickstart validation scenarios, as tests.
 *
 * `pnpm replay` is the interactive form of the same thing; running them here as well is what stops
 * a scenario from quietly stopping being true between manual runs.
 */
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

export function replay(fixtureName: string): SimulationResult {
  const path = `${ROOT}fixtures/days/${fixtureName}.json`
  return runFixtureDay(parseFixtureDay(JSON.parse(readFileSync(path, 'utf8'))))
}

export function cycleAt(result: SimulationResult, instant: string): RecordedCycle {
  const wanted = Date.parse(instant)
  const cycle = result.cycles.find((c) => Date.parse(c.cycleId) === wanted)
  if (!cycle) throw new Error(`no cycle at ${instant} in ${result.fixture}`)
  return cycle
}

export function decisionFor(cycle: RecordedCycle, lotNumber: string): ChargerDecision {
  const charger = cycle.inputs.chargers.find((c) => c.lotNumber === lotNumber)
  const decision = cycle.decision.decisions.find((d) => d.chargerId === charger?.chargerId)
  if (!decision) throw new Error(`no decision for ${lotNumber} at ${cycle.cycleId}`)
  return decision
}

/** Every decision for one lot across the whole day, in cycle order. */
export function decisionsFor(result: SimulationResult, lotNumber: string): ChargerDecision[] {
  return result.cycles.map((cycle) => decisionFor(cycle, lotNumber))
}

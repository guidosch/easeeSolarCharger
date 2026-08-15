import type { SchedulerConfig } from './types.js'

/**
 * The parameters in force by default (research R2, FR-018, FR-023).
 *
 * `config` travels *inside* `CycleInputs` rather than being read as a module constant, so every
 * recorded cycle replays under the parameters that were in force when it ran — otherwise tuning
 * the deadband would silently invalidate the whole regression corpus.
 */
export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  minCurrentA: 6,
  ewmaAlpha: 0.4,
  deadbandA: 1,
  startDelayCycles: 2,
  stopDelayCycles: 2,
  stalenessCutoffMinutes: 15,
  highPriceWindows: [
    ['11:00', '13:00'],
    ['18:00', '20:00'],
  ],
  winterWindow: { from: '10-01', toExclusive: '03-01' },
  timezone: 'Europe/Zurich',
}

/**
 * Headroom required before a target counts as `reachable` rather than `at_risk`: the deadline
 * fallback engages once the remaining low-price time offers less than 25% more energy than the
 * target still needs.
 *
 * Deliberately *not* a `SchedulerConfig` field — that type is fixed by
 * contracts/scheduler-core.md. Replay stays exact because `schedulerVersion` is recorded with
 * every cycle, so a change to this constant is a version change, which is what the regression
 * corpus keys on.
 */
export const DEADLINE_RISK_MARGIN = 1.25

/**
 * The *upper* edge of the deadline-fallback hysteresis band.
 *
 * Grid charging starts when the headroom falls below `DEADLINE_RISK_MARGIN` and continues until it
 * recovers past this figure. Without the band the two states sit on the same threshold: one cycle
 * of charging pushes the target back over the line, the fallback disengages, the next cycle finds
 * it at risk again, and the charger starts and stops every five minutes. That oscillation is what
 * FR-017 forbids, and quickstart V3 is the scenario that catches it.
 */
export const DEADLINE_RESUME_MARGIN = 1.6

/** How far ahead reachability will look. A deadline beyond this is treated as "plenty of time". */
export const REACHABILITY_HORIZON_DAYS = 14

/**
 * The optimizer cadence, in minutes. Derived from the SolarEdge budget (research R3) and, per the
 * constitution, MUST NOT be shortened without re-deriving that budget.
 */
export const CYCLE_MINUTES = 5

/** Granularity of the low-price-time walk in `tariff.ts` — one optimizer cycle. */
export const TARIFF_WALK_STEP_MINUTES = CYCLE_MINUTES

/** The line limits the installer documented (open item O3). Advisory in this system. */
export const DEFAULT_LINE_LIMITS = { L1: 63, L2: 63, total: 126 }

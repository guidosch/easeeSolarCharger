/**
 * The scheduler-core contract (contracts/scheduler-core.md).
 *
 * This package is the reproducibility boundary: everything here is a pure function of its
 * arguments. `now` and `randomSeed` are *fields of the input*, not things the code reads for
 * itself, which is what makes SC-010's byte-identical replay possible.
 */

export type SurplusQuality = 'fresh' | 'stale' | 'unusable'
export type TariffWindow = 'low' | 'high'
export type SeasonMode = 'solar' | 'winter'
export type Attribution = 'solar' | 'grid' | 'none'
export type ReachabilityState = 'reachable' | 'at_risk' | 'unreachable'
export type SupplyLine = 'L1' | 'L2'
export type Phases = 1 | 3

/** Easee observation 109. `0` Offline, `1` Disconnected, `2` AwaitingStart, `3` Charging, `4` Completed, `5` Error, `6` ReadyToCharge. */
export type OpMode = 0 | 1 | 2 | 3 | 4 | 5 | 6

export type LadderRule = 1 | 2 | 3 | 4 | 5 | 6 | null

export type DecisionReason =
  | 'override' // ladder 2
  | 'solar_surplus' // ladder 5
  | 'deadline_fallback' // ladder 4
  | 'high_price_blocked' // ladder 3
  | 'below_modulation_floor'
  | 'awaiting_surplus'
  | 'no_target'
  | 'target_met'
  | 'not_plugged_in'
  | 'charger_error'
  | 'deferred_to_tomorrow'
  | 'fairness_not_selected' // ladder 6

export type Reachability = {
  state: ReachabilityState
  expectedShortfallKwh: number
}

export type SchedulerConfig = {
  minCurrentA: number // 6
  ewmaAlpha: number // 0.4
  deadbandA: number // 1
  startDelayCycles: number // 2
  stopDelayCycles: number // 2
  stalenessCutoffMinutes: number // 15
  highPriceWindows: [string, string][] // [["11:00","13:00"], ["18:00","20:00"]]
  winterWindow: { from: '10-01'; toExclusive: '03-01' }
  timezone: 'Europe/Zurich'
}

export type ChargerTarget = {
  energyKwh: number
  deadline: string
  deliveredKwh: number
}

export type ChargerInput = {
  chargerId: string
  lotNumber: string
  /** `null` = the parking-lot mapping has no user; the charger is orphaned. */
  userId: string | null
  line: SupplyLine
  phases: Phases
  maxCurrentA: number
  opMode: OpMode
  /** Observation 114 — the truth (FR-028). */
  deliveredCurrentA: number
  /** Observation 48 — what the charger thinks it was told. */
  dynamicChargerCurrentA: number
  /** What this system last wrote. */
  commandedCurrentA: number
  totalPowerKw: number
  sessionEnergyKwh: number
  observedAt: string
  overrideActive: boolean
  consecutiveAboveFloor: number
  consecutiveBelowFloor: number
  target: ChargerTarget | null
}

export type SurplusInput = {
  /** `null` = no reading at all. Never a substituted zero (FR-016). */
  rawKw: number | null
  smoothedKw: number | null
  observedAt: string | null
  ageMinutes: number | null
  quality: SurplusQuality
}

export type ForecastInput = {
  cloudCoverRestOfTodayPct: number
  cloudCoverTomorrowPct: number
  deferRecommended: boolean
  fetchedAt: string
}

export type CycleInputs = {
  /** The scheduled instant, ISO — also the idempotency key (FR-050). */
  cycleId: string
  /** The injected clock. */
  now: string
  /** Bumped on any behavioural change; recorded so a replay knows which code produced a record. */
  schedulerVersion: string
  /** Derived from `cycleId`; seeds the fairness draw. */
  randomSeed: string

  surplus: SurplusInput
  gridExportKw: number | null
  /** Σ totalPower of chargers this system commands — added back so the signal measures *available* surplus. */
  ownChargingKw: number

  daylight: boolean
  seasonMode: SeasonMode
  tariffWindow: TariffWindow

  forecast: ForecastInput | null

  chargers: ChargerInput[]
  fairness: Record<string, { solarKwhReceived: number }>
  /** 63 / 63 / 126 A — advisory only; the external load manager is the real enforcement. */
  lineLimits: { L1: number; L2: number; total: number }
  config: SchedulerConfig
}

export type ChargerDecision = {
  chargerId: string
  /** `0` = do not charge; otherwise ≥ `config.minCurrentA`. */
  targetCurrentA: number
  reason: DecisionReason
  /** Which precedence rule decided this — the one-glance answer for SC-009. */
  ladderRule: LadderRule
  expectedKwhThisCycle: number
  /** Drives the session solar/grid split (FR-037). Follows the decision, not a measurement. */
  attribution: Attribution
  reachability: Reachability
}

export type CycleDecision = {
  cycleId: string
  schedulerVersion: string
  decisions: ChargerDecision[]
  surplusAllocatedKw: number
  notes: string[]
}

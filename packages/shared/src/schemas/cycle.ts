import { z } from 'zod'
import { IsoInstant, OpMode, Phases, SupplyLine } from './common.js'
import { Reachability } from './common.js'

export const SurplusQuality = z.enum(['fresh', 'stale', 'unusable'])
export type SurplusQuality = z.infer<typeof SurplusQuality>

export const TariffWindow = z.enum(['low', 'high'])
export type TariffWindow = z.infer<typeof TariffWindow>

export const SeasonMode = z.enum(['solar', 'winter'])
export type SeasonMode = z.infer<typeof SeasonMode>

export const DecisionReason = z.enum([
  'override',
  'solar_surplus',
  'deadline_fallback',
  'high_price_blocked',
  'below_modulation_floor',
  'awaiting_surplus',
  'no_target',
  'target_met',
  'not_plugged_in',
  'charger_error',
  'deferred_to_tomorrow',
  'fairness_not_selected',
])
export type DecisionReason = z.infer<typeof DecisionReason>

/** Which rule of the Principle I ladder decided this — the one-glance answer for SC-009. */
export const LadderRule = z
  .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)])
  .nullable()
export type LadderRule = z.infer<typeof LadderRule>

export const Attribution = z.enum(['solar', 'grid', 'none'])
export type Attribution = z.infer<typeof Attribution>

export const ChargerDecisionSchema = z.object({
  chargerId: z.string(),
  targetCurrentA: z.number(),
  reason: DecisionReason,
  ladderRule: LadderRule,
  expectedKwhThisCycle: z.number(),
  attribution: Attribution,
  reachability: Reachability,
})
export type ChargerDecisionWire = z.infer<typeof ChargerDecisionSchema>

export const SchedulerConfigSchema = z.object({
  minCurrentA: z.number(),
  ewmaAlpha: z.number(),
  deadbandA: z.number(),
  startDelayCycles: z.number(),
  stopDelayCycles: z.number(),
  stalenessCutoffMinutes: z.number(),
  highPriceWindows: z.array(z.tuple([z.string(), z.string()])),
  winterWindow: z.object({ from: z.literal('10-01'), toExclusive: z.literal('03-01') }),
  timezone: z.literal('Europe/Zurich'),
})

export const ChargerInputSchema = z.object({
  chargerId: z.string(),
  lotNumber: z.string(),
  userId: z.string().nullable(),
  line: SupplyLine,
  phases: Phases,
  maxCurrentA: z.number(),
  opMode: OpMode,
  deliveredCurrentA: z.number(),
  dynamicChargerCurrentA: z.number(),
  commandedCurrentA: z.number(),
  totalPowerKw: z.number(),
  sessionEnergyKwh: z.number(),
  observedAt: IsoInstant,
  overrideActive: z.boolean(),
  consecutiveAboveFloor: z.number(),
  consecutiveBelowFloor: z.number(),
  target: z
    .object({
      energyKwh: z.number(),
      deadline: IsoInstant,
      deliveredKwh: z.number(),
    })
    .nullable(),
})

/**
 * The full replay input (Principle III). `decide(cycle.inputs)` must return `cycle.decisions`
 * exactly — which is only possible because `now` and `randomSeed` are fields here rather than
 * things the core reads for itself.
 */
export const CycleInputsSchema = z.object({
  cycleId: z.string(),
  now: IsoInstant,
  schedulerVersion: z.string(),
  randomSeed: z.string(),
  surplus: z.object({
    rawKw: z.number().nullable(),
    smoothedKw: z.number().nullable(),
    observedAt: IsoInstant.nullable(),
    ageMinutes: z.number().nullable(),
    quality: SurplusQuality,
  }),
  gridExportKw: z.number().nullable(),
  ownChargingKw: z.number(),
  daylight: z.boolean(),
  seasonMode: SeasonMode,
  tariffWindow: TariffWindow,
  forecast: z
    .object({
      cloudCoverRestOfTodayPct: z.number(),
      cloudCoverTomorrowPct: z.number(),
      deferRecommended: z.boolean(),
      fetchedAt: IsoInstant,
    })
    .nullable(),
  chargers: z.array(ChargerInputSchema),
  fairness: z.record(z.string(), z.object({ solarKwhReceived: z.number() })),
  lineLimits: z.object({ L1: z.number(), L2: z.number(), total: z.number() }),
  config: SchedulerConfigSchema,
})

export const CycleOutcome = z.enum(['completed', 'skipped_locked', 'failed', 'degraded'])
export type CycleOutcome = z.infer<typeof CycleOutcome>

export const ProviderCallStats = z.object({
  calls: z.number(),
  errors: z.number(),
  rateLimited: z.number(),
  budgetRemaining: z.number(),
})
export type ProviderCallStats = z.infer<typeof ProviderCallStats>

export const ProviderCalls = z.object({
  easee: ProviderCallStats,
  solaredge: ProviderCallStats,
  openweather: ProviderCallStats,
})
export type ProviderCalls = z.infer<typeof ProviderCalls>

export const ReadBackEntry = z.object({
  chargerId: z.string(),
  commandedCurrentA: z.number(),
  deliveredCurrentA: z.number(),
  dynamicChargerCurrentA: z.number(),
  discrepancy: z.enum(['none', 'capped', 'lost']),
})
export type ReadBackEntry = z.infer<typeof ReadBackEntry>

/** `GET /admin/cycles` — the recent-cycles table (FR-039). */
export const AdminCycleSummary = z.object({
  cycleId: z.string(),
  outcome: CycleOutcome,
  durationMs: z.number(),
  surplus: z.object({
    smoothedKw: z.number().nullable(),
    rawKw: z.number().nullable(),
    ageMinutes: z.number().nullable(),
    quality: SurplusQuality,
  }),
  tariffWindow: TariffWindow,
  seasonMode: SeasonMode,
  chargersActedOn: z.number(),
  providerCalls: ProviderCalls,
})
export type AdminCycleSummary = z.infer<typeof AdminCycleSummary>

/** `GET /admin/cycles/{cycleId}` — the complete record; copyable straight into a fixture. */
export const CycleRecord = z.object({
  cycleId: z.string(),
  startedAt: IsoInstant,
  finishedAt: IsoInstant.nullable(),
  outcome: CycleOutcome,
  durationMs: z.number(),
  inputs: CycleInputsSchema.nullable(),
  decisions: z.array(ChargerDecisionSchema),
  readBack: z.array(ReadBackEntry),
  providerCalls: ProviderCalls,
  notes: z.array(z.string()),
  surplusAllocatedKw: z.number(),
  schedulerVersion: z.string(),
  correlationId: z.string(),
})
export type CycleRecord = z.infer<typeof CycleRecord>

/** One row of `GET /admin/chargers/{lotNumber}/trace` (FR-042, SC-009). */
export const TraceEntry = z.object({
  cycleId: z.string(),
  startedAt: IsoInstant,
  targetCurrentA: z.number(),
  reason: DecisionReason,
  ladderRule: LadderRule,
  deliveredCurrentA: z.number(),
  discrepancy: z.enum(['none', 'capped', 'lost']).nullable(),
  events: z.array(z.object({ type: z.string(), at: IsoInstant, detail: z.string().optional() })),
})
export type TraceEntry = z.infer<typeof TraceEntry>

export const AdminHealth = z.object({
  lastCycle: z
    .object({ cycleId: z.string(), outcome: CycleOutcome, ageMinutes: z.number() })
    .nullable(),
  leaseHeld: z.boolean(),
  consecutiveFailures: z.number(),
  firestoreWritesToday: z.number(),
  openTargets: z.number(),
  unreachableTargets: z.number(),
})
export type AdminHealth = z.infer<typeof AdminHealth>

export const AdminProviderHealth = z.object({
  provider: z.enum(['easee', 'solaredge', 'openweather']),
  callsLast24h: z.number(),
  budget: z.number(),
  errors: z.number(),
  rateLimited: z.number(),
  lastError: z
    .object({ at: IsoInstant, message: z.string(), correlationId: z.string() })
    .nullable(),
  daylightGateOpen: z.boolean().nullable(),
})
export type AdminProviderHealth = z.infer<typeof AdminProviderHealth>

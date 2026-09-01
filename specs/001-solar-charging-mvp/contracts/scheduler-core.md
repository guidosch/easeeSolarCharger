# Contract: Scheduler Core (`packages/core`)

This is the **reproducibility boundary**. Everything inside is a pure function of its arguments;
everything impure lives in `packages/adapters` and `services/optimizer`. Principle III and SC-010
are enforced here or nowhere.

```ts
export function decide(inputs: CycleInputs): CycleDecision
```

**Invariants**, each covered by a test:

1. `decide` performs no I/O.
2. `decide` never reads a clock or a random source — `now` and `randomSeed` are fields of
   `CycleInputs`. A lint rule bans `Date.now`, `new Date()` with no argument, and `Math.random`
   inside `packages/core`.
3. `decide(x)` is referentially transparent: equal inputs, deeply equal outputs, always.
4. `decide` never throws on well-typed input. Degraded inputs (missing surplus, stale reading,
   offline charger) are *modelled states*, not exceptions — because an exception here would mean no
   schedule at all, and the fail-safe (FR-044) has to be a decision, not a crash.

---

## `CycleInputs`

```ts
type CycleInputs = {
  cycleId: string                    // scheduled instant, ISO — also the idempotency key
  now: string                        // injected clock, ISO instant
  schedulerVersion: string           // bumped on any behavioural change
  randomSeed: string                 // derived from cycleId; seeds the fairness draw

  surplus: {
    rawKw: number | null             // null = no reading at all
    smoothedKw: number | null        // EWMA, α = 0.4
    observedAt: string | null
    ageMinutes: number | null
    quality: 'fresh' | 'stale' | 'unusable'   // unusable at > 15 min (3 cycles)
  }
  gridExportKw: number | null
  ownChargingKw: number              // Σ totalPower of chargers we command — added back into surplus

  daylight: boolean                  // computed locally from lat/lon; gates the SolarEdge call
  seasonMode: 'solar' | 'winter'     // winter: 1 Oct – end of Feb (FR-023)
  tariffWindow: 'low' | 'high'       // high: 11:00–13:00, 18:00–20:00 Europe/Zurich

  forecast: {
    cloudCoverRestOfTodayPct: number
    cloudCoverTomorrowPct: number
    deferRecommended: boolean
    fetchedAt: string
  } | null

  chargers: ChargerInput[]
  fairness: Record<string /* userId */, { solarKwhReceived: number }>
  lineLimits: { L1: number; L2: number; total: number }   // 63 / 63 / 126, advisory only
  config: SchedulerConfig
}

type ChargerInput = {
  chargerId: string
  lotNumber: string
  userId: string | null              // null = orphaned mapping
  line: 'L1' | 'L2'
  phases: 1 | 3
  maxCurrentA: number
  opMode: 0|1|2|3|4|5|6|7|8           // Easee observation 109
  deliveredCurrentA: number           // observation 114 — the truth
  dynamicChargerCurrentA: number      // observation 48 — what the charger thinks it was told
  commandedCurrentA: number           // what we last wrote
  totalPowerKw: number
  sessionEnergyKwh: number
  observedAt: string
  overrideActive: boolean
  consecutiveAboveFloor: number
  consecutiveBelowFloor: number
  target: { energyKwh: number; deadline: string; deliveredKwh: number } | null
}

type SchedulerConfig = {
  minCurrentA: number                // 6
  ewmaAlpha: number                  // 0.4
  deadbandA: number                  // 1
  startDelayCycles: number           // 2
  stopDelayCycles: number            // 2
  stalenessCutoffMinutes: number     // 15
  highPriceWindows: [string, string][]   // [["11:00","13:00"], ["18:00","20:00"]]
  winterWindow: { from: '10-01'; toExclusive: '03-01' }
  timezone: 'Europe/Zurich'
}
```

`config` is an input rather than a constant so that every recorded cycle replays under the
parameters that were in force at the time — otherwise tuning the deadband would silently
invalidate the whole regression corpus.

---

## `CycleDecision`

```ts
type CycleDecision = {
  cycleId: string
  schedulerVersion: string
  decisions: ChargerDecision[]
  surplusAllocatedKw: number
  notes: string[]                    // e.g. "surplus unusable — deadline-only mode"
}

type ChargerDecision = {
  chargerId: string
  targetCurrentA: number             // 0 = do not charge; otherwise ≥ minCurrentA
  reason:
    | 'override'                     // ladder 2
    | 'solar_surplus'                // ladder 5
    | 'deadline_fallback'            // ladder 4
    | 'high_price_blocked'           // ladder 3
    | 'below_modulation_floor'
    | 'awaiting_surplus'
    | 'no_target'
    | 'target_met'
    | 'not_plugged_in'
    | 'charger_error'
    | 'deferred_to_tomorrow'
    | 'fairness_not_selected'        // ladder 6
  ladderRule: 1|2|3|4|5|6 | null     // which precedence rule decided this
  expectedKwhThisCycle: number
  attribution: 'solar' | 'grid' | 'none'   // drives the session split (FR-037)
  reachability: { state: 'reachable'|'at_risk'|'unreachable'; expectedShortfallKwh: number }
}
```

`ladderRule` is not decoration — it is the field that makes an admin trace answerable in one glance
(SC-009) and the field a test asserts on when checking that the ladder was applied in order.

---

## The decision procedure

Applied per cycle, in exactly this order (FR-013, Principle I):

1. **External load management** — never contradicted. The system only ever writes
   `dynamicChargerCurrent`, the lowest tier of Easee's limit hierarchy, so it is structurally
   incapable of raising a cap the load manager set. `lineLimits` are used only to keep our *own*
   sum per line below the line rating; if the load manager is capping us anyway, `readBack` records
   it and the schedule adapts next cycle.
2. **Override** → `targetCurrentA = maxCurrentA`, `reason: 'override'`, regardless of everything
   below (FR-032).
3. **High-price window** → grid charging is forbidden. Solar charging is still allowed (FR-019) —
   the rule bans *import*, not *charging*.
4. **Deadline** → if the target is at risk and the window is low-price, charge from the grid
   (FR-021). "At risk" means: remaining energy cannot be delivered in the remaining *low-price,
   solar-plausible* time at the achievable current.
5. **Solar** → allocate available surplus to chargers with open targets, respecting the modulation
   floor: below it, wait rather than top up (FR-020), subject to the start/stop hysteresis counters.
6. **Fairness** → when surplus is insufficient for all competitors, allocate by a draw weighted
   inversely to `fairness[userId].solarKwhReceived`, seeded from `randomSeed`. Surplus **may be
   split** across chargers when each share still clears the modulation floor (FR-024).

**Degraded paths**:

- `surplus.quality === 'unusable'` or `surplus.smoothedKw === null` → skip rules 5 and 6 entirely,
  run deadline-only, add a note. Never treat a missing reading as zero surplus (FR-016).
- `seasonMode === 'winter'` → same, by policy rather than by failure (FR-023).
- `forecast === null` → `deferRecommended` is treated as `false`. A missing forecast may never
  *cause* a deferral, because a wrong deferral risks a deadline.
- `opMode === 0 or 5` (offline/error) → `targetCurrentA: 0`, no command issued, recorded for admin.
- `opMode === 7 or 8` (awaiting authentication / de-authenticating) → `targetCurrentA: 0`, reason
  `awaiting_authentication`, and excluded from the surplus allocation: the charger is plugged in but
  will refuse current until it is authorised.

---

## Test obligations

Constitution, Development Workflow — the following are required, not optional:

| Area | Test |
| --- | --- |
| Ladder order | high-price vs deadline conflict resolves to *no grid import*, `ladderRule: 3` |
| Override | beats the high-price rule; auto-clears at session end |
| Modulation floor | surplus at 5.5 A → wait, not a 6 A grid top-up |
| Winter window | 1 Oct and 28/29 Feb boundaries in Europe/Zurich |
| DST | 2027-03-28 and 2026-10-25 — deadlines, tariff windows and the winter boundary stay correct across the missing and the doubled local hour |
| Determinism | `decide(inputs)` twice → deeply equal; and replay of every fixture cycle reproduces its recorded `decisions` |
| Fairness | over 100 seeded cycles the under-served user is selected more often; same seed → same selection |
| Staleness | `quality: 'unusable'` never yields `reason: 'solar_surplus'` |
| Regression corpus | recorded PV/charging days in `fixtures/` replay with explained diffs only |

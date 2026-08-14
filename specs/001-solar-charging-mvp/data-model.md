# Data Model: Solar-Optimized EV Charging (MVP)

**Feature**: `specs/001-solar-charging-mvp` | **Date**: 2026-08-14

Firestore in Native mode. All timestamps are stored as UTC instants; every *interpretation*
(deadlines, tariff windows, winter boundary, daylight) happens in `Europe/Zurich` in
`packages/core`. Storing a naive local time is a defect (FR-025).

Every collection that grows carries an `expiresAt` field driving a Firestore TTL policy, so
retention is enforced by the database rather than by a cleanup job that might not run (Principle
VI, FR-047).

---

## Collection overview

| Collection | Key | Written by | Growth | Retention |
| --- | --- | --- | --- | --- |
| `parkingLots` | `{lotNumber}` | operator (manual/import) | 30 docs, static | forever |
| `chargers` | `{chargerId}` | optimizer | 30 docs, updated in place | forever |
| `users/{userId}` | Easee `UserId` | api | ~30 docs | until user deletes |
| `users/{userId}/targets` | `{targetId}` | api, optimizer | ~1 open per charger | closed targets deleted with their session |
| `users/{userId}/sessions` | `{sessionId}` | optimizer | ~1/day/user | **five most recent** (FR-038) |
| `chargerSnapshots` | `{chargerId}_{ts}` | optimizer | ~960/day | 1 month (TTL) |
| `chargerEvents` | auto | optimizer | ~150/day | 1 month (TTL) |
| `cycles` | `{cycleId}` | optimizer | 288/day | 1 month (TTL) |
| `fairness` | `{userId}` | optimizer | ~30 docs | until user deletes |
| `locks/optimizer` | fixed | optimizer | 1 doc | forever |
| `providerTokens/easeeTechnical` | fixed | optimizer | 1 doc | forever |

---

## `parkingLots/{lotNumber}`

The operator-maintained authorization source (FR-003). Written outside the app; the system only
reads it.

| Field | Type | Notes |
| --- | --- | --- |
| `lotNumber` | string | user-facing charger name, e.g. `"A12"` |
| `chargerId` | string | Easee charger id |
| `serialNumber` | string | used for the observations endpoint |
| `easeeUserId` | string | the `UserId` claim that may act on this charger |
| `line` | `"L1" \| "L2"` | supply line, for the advisory headroom check |
| `phases` | `1 \| 3` | determines the kW ↔ A conversion (research R2) |
| `maxCurrentA` | number | charger ceiling, ≤16 A three-phase (11 kW) |

**Validation**: `easeeUserId` must be non-empty; a lot with no user is orphaned and surfaces in the
admin view (spec edge case). `lotNumber` is unique; `chargerId` is unique.

---

## `chargers/{chargerId}`

Live mirror of one charger, updated in place each cycle. Updating in place rather than appending is
what keeps the write budget at ~1,750/day (Principle VI).

| Field | Type | Notes |
| --- | --- | --- |
| `lotNumber`, `line`, `phases` | — | denormalised from `parkingLots` to save a read per cycle |
| `opMode` | `0..6` | Easee observation 109; see state machine below |
| `outputCurrentA` | number | observation 114 — **the delivered current, the truth** (FR-028) |
| `dynamicChargerCurrentA` | number | observation 48 — what the charger believes it was told |
| `totalPowerKw` | number | observation 120 — feeds the own-charging correction in the surplus formula |
| `sessionEnergyKwh` | number | observation 121 |
| `lifetimeEnergyKwh` | number | observation 124 |
| `reasonForNoCurrent` | number | observation 96 |
| `commandedCurrentA` | number | what *this system* last wrote |
| `commandedAt` | timestamp | |
| `discrepancy` | `"none" \| "capped" \| "lost"` | `capped`: read-back current < commanded (external load manager). `lost`: `dynamicChargerCurrentA` ≠ commanded (write lost or reset on plug-in) |
| `activeSessionId` | string \| null | |
| `activeTargetRef` | path \| null | |
| `overrideActive` | boolean | "charge now" (FR-032) |
| `observedAt` | timestamp | when the observations were read |
| `consecutiveAboveFloor` / `consecutiveBelowFloor` | number | hysteresis counters (research R2) |

### Charger state machine (Easee `opMode`, observation 109)

```
0 Offline ─────────────┐
                       ▼
1 Disconnected ──plug in──▶ 2 AwaitingStart / 6 ReadyToCharge ──current ≥ 6 A──▶ 3 Charging
        ▲                              │                                              │
        └──────── unplug ──────────────┴──────────── setpoint → 0 ─────────────────────┤
        │                                                                              │
        └──────────────────── unplug ────────────── 4 Completed ◀── target reached ────┘
                                                    5 Error (surfaced to admin, no retry storm)
```

**Transitions the system acts on**:

| Transition | Meaning | Action |
| --- | --- | --- |
| `1 → {2,3,6}` | car plugged in | open a session; **re-apply the setpoint** — Easee resets `dynamicChargerCurrent` on plug-in (research R5); activate any stored target (FR-010) |
| `{2,3,4,6} → 1` | car unplugged | close the session as `ended_early` or `completed`; clear any override (FR-033); close the target (spec assumption: no automatic resume) |
| `→ 5` | error | record, surface to admin, stop commanding that charger this cycle |
| `→ 0` | offline | treat the reading as stale for that charger; do not infer zero power |

---

## `users/{userId}`

| Field | Type | Notes |
| --- | --- | --- |
| `userId` | string | Easee `UserId` — the only identity key (FR-049) |
| `email` | string | from the token; shown in the admin view only |
| `lotNumbers` | string[] | resolved from `parkingLots`, cached for the multi-charger case (US8) |
| `createdAt`, `lastSeenAt` | timestamp | |

Nothing else about a person is stored. Deleting this document and its subcollections plus the
`fairness/{userId}` document is the complete FR-048 deletion.

---

## `users/{userId}/targets/{targetId}`

At most **one open target per charger** (FR-009). Setting a new one closes the previous.

| Field | Type | Notes |
| --- | --- | --- |
| `chargerId`, `lotNumber` | string | |
| `energyKwh` | number | 1–100, slider input (FR-006) |
| `deadline` | timestamp | must be in the future (FR-007) |
| `status` | `"open" \| "met" \| "shortfall" \| "cancelled" \| "superseded"` | |
| `deliveredKwh` | number | running total |
| `deliveredSolarKwh` / `deliveredGridKwh` | number | the split shown in the summary (FR-037) |
| `reachability` | `{ state: "reachable" \| "at_risk" \| "unreachable", expectedShortfallKwh: number, evaluatedAt: timestamp }` | drives FR-036 and the admin view |
| `createdAt` | timestamp | |

**Validation rules**:

- `deadline` > now, and > now + the time needed to deliver *any* energy at the modulation floor,
  otherwise rejected with the earliest feasible deadline (FR-007).
- `energyKwh` > 0. A target larger than can be delivered before the deadline is **accepted** and
  immediately marked `unreachable` with a shortfall (spec edge case), never silently trimmed.
- Writing a new open target for a charger sets the previous one to `superseded` in the same
  transaction.

### Target state machine

```
                  ┌──── deadline passes with deliveredKwh < energyKwh ────▶ shortfall
open ─────────────┤
  │               └──── deliveredKwh ≥ energyKwh ───────────────────────────▶ met
  │
  ├── user cancels ──▶ cancelled
  ├── new target set on same charger ──▶ superseded
  └── car unplugged early ──▶ cancelled (session recorded as ended_early)
```

`reachability` is recomputed every cycle by `packages/core/reachability.ts`; the transition
`reachable → unreachable` is what triggers the user-visible warning required by FR-036 and
SC-003.

---

## `users/{userId}/sessions/{sessionId}`

One charging process (FR-037). **Only the five most recent are retained** (FR-038): closing a
session deletes the sixth-oldest in the same batch, which keeps the rule enforced by construction
rather than by a nightly job.

| Field | Type | Notes |
| --- | --- | --- |
| `chargerId`, `lotNumber` | string | |
| `startedAt`, `endedAt` | timestamp | |
| `energyKwh` | number | total delivered |
| `solarKwh`, `gridKwh` | number | attribution, see below |
| `targetEnergyKwh`, `deadline` | — | copied from the target so the summary survives target deletion |
| `targetMet` | boolean | |
| `endReason` | `"target_reached" \| "unplugged" \| "cancelled" \| "deadline_passed"` | |
| `overrideUsed` | boolean | |

**Solar/grid attribution**: each cycle adds `deliveredKwh_thisCycle` to either `solarKwh` or
`gridKwh` according to the *reason the core chose to charge* — `solar_surplus` counts as solar,
`deadline_fallback` and `override` count as grid. Attribution follows the decision, not a
measurement, because site-level metering cannot tell which electrons went where; this is stated in
the spec's assumptions and must be stated in the UI wording too.

---

## `chargerSnapshots/{chargerId}_{isoMinute}` and `chargerEvents/{auto}`

The Principle VI compromise: **snapshots** are written roughly every 15 minutes for *active*
chargers only (~960/day), **events** are written on every state change (~150/day). Together they
give the admin view a continuous picture without one write per charger per cycle.

Snapshot fields: `opMode`, `outputCurrentA`, `commandedCurrentA`, `totalPowerKw`,
`sessionEnergyKwh`, `observedAt`, `expiresAt`.

Event fields: `type` (`plugged_in`, `unplugged`, `charging_started`, `charging_stopped`,
`target_set`, `override_on`, `override_off`, `command_lost`, `command_capped`, `error`),
`chargerId`, `at`, `detail`, `cycleId`, `expiresAt`.

---

## `cycles/{cycleId}`

The audit and reproducibility record (Principle III, SC-010). `cycleId` is the scheduled instant in
ISO form, which also makes the write idempotent under Cloud Scheduler's at-least-once delivery
(FR-050).

| Field | Type | Notes |
| --- | --- | --- |
| `cycleId` | string | e.g. `2026-08-14T14:35:00Z` |
| `startedAt`, `finishedAt` | timestamp | |
| `outcome` | `"completed" \| "skipped_locked" \| "failed" \| "degraded"` | `degraded` = ran with a stale or missing provider input |
| `inputs` | object | **the full replay input**: `surplus {rawKw, smoothedKw, observedAt, ageMinutes, quality}`, `gridExportKw`, `ownChargingKw`, `tariffWindow`, `seasonMode`, `daylight`, `forecast {cloudCoverToday, cloudCoverTomorrow, deferRecommended}`, `chargers[]` (opMode, delivered current, commanded current, session energy), `targets[]`, `fairnessWeights`, `randomSeed`, `schedulerVersion`, `now` |
| `decisions` | array | per charger: `chargerId`, `targetCurrentA`, `reason`, `ladderRule` (1–6, which rule decided it), `expectedKwhThisCycle` |
| `readBack` | array | previous cycle's commanded vs delivered, per charger |
| `providerCalls` | object | per provider: `calls`, `errors`, `rateLimited`, `budgetRemaining` |
| `correlationId` | string | links to Cloud Logging entries and to the API calls this cycle made |
| `expiresAt` | timestamp | +1 month |

**The reproducibility contract**: `decide(cycle.inputs)` must return `cycle.decisions` exactly.
`inputs` therefore contains everything the core reads — including `now` and `randomSeed`, because a
core that read the wall clock or a random source could not be replayed. This is asserted directly by
the regression suite over `fixtures/`.

---

## `fairness/{userId}`

Per-user accounting driving the weighted draw (FR-024).

| Field | Type | Notes |
| --- | --- | --- |
| `solarKwhReceived` | number | rolling 30-day total |
| `windowStart` | timestamp | |
| `lastServedCycleId` | string | tie-breaker |

The draw is **seeded from the cycle ID**, so it is random across cycles but deterministic on replay
(Principle III). Weight is inversely proportional to `solarKwhReceived` within the competing set.

---

## `locks/optimizer`

| Field | Type | Notes |
| --- | --- | --- |
| `holder` | string | instance/execution id |
| `acquiredAt`, `expiresAt` | timestamp | 4-minute lease (research R7) |

Acquired in a Firestore transaction. A cycle finding a live lease writes a `skipped_locked` cycle
record and returns 200 so Cloud Scheduler does not retry (FR-026).

---

## `providerTokens/easeeTechnical`

The optimizer's dedicated technical account token, cached so cold starts do not each re-login.
Fields: `accessToken`, `refreshToken`, `expiresAt`. The *values* live here rather than in Secret
Manager because they rotate hourly; the **credentials** that mint them stay in Secret Manager
(Principle V).

---

## Indexes and rules

**Composite indexes**: `users/{userId}/targets` on `(status, deadline)`; `cycles` on
`(outcome, startedAt desc)`; `chargerSnapshots` on `(chargerId, observedAt desc)`.

**Security rules**: clients never talk to Firestore directly — both frontends go through
`services/api`, which holds the only credentials. Firestore rules therefore **deny all client
access**, and authorization is enforced in the API against `parkingLots` (FR-003). This is simpler
and stricter than mirroring the lot mapping into rules.

**TTL policies**: on `expiresAt` for `cycles`, `chargerSnapshots` and `chargerEvents`.

---

## Entity → spec mapping

| Spec entity | Realised as |
| --- | --- |
| User | `users/{userId}` |
| Charger | `chargers/{chargerId}` |
| Parking Lot Mapping | `parkingLots/{lotNumber}` |
| Target | `users/{userId}/targets/{targetId}` |
| Session | `users/{userId}/sessions/{sessionId}` |
| Override | `chargers.overrideActive` + `chargerEvents` |
| Cycle Decision | `cycles/{cycleId}` |
| Surplus Estimate | `cycles.inputs.surplus` |
| Forecast | `cycles.inputs.forecast` |
| Fairness Ledger | `fairness/{userId}` |

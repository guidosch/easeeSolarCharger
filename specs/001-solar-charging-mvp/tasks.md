---
description: "Task list for Solar-Optimized EV Charging (MVP)"
---

# Tasks: Solar-Optimized EV Charging (MVP)

**Input**: Design documents from `/specs/001-solar-charging-mvp/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: Test tasks **are** included. They are not optional here — the constitution's *Development
Workflow & Quality Gates* section makes unit tests over the Principle I ladder, provider contract
tests, an idempotency test per trigger handler, a single-flight test, and the recorded-day
regression corpus mandatory, and [contracts/scheduler-core.md](./contracts/scheduler-core.md) and
[contracts/external-providers.md](./contracts/external-providers.md) both close with an explicit
"test obligations" table.

**Organization**: Tasks are grouped by user story so each story can be implemented, tested and
demonstrated independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1..US8)
- Exact file paths are included in every description

## Path Conventions

pnpm workspace per [plan.md](./plan.md) "Project Structure": `apps/web/`, `apps/admin/`,
`services/api/`, `services/optimizer/`, `packages/core/`, `packages/adapters/`, `packages/shared/`,
`fixtures/`, `infra/`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create the pnpm workspace, the type/lint/test gates, and the scripts every later phase
invokes.

- [X] T001 Create the pnpm workspace root — `package.json`, `pnpm-workspace.yaml` listing `apps/*`, `services/*`, `packages/*`, `.gitignore` (including `.env.local`), and `.nvmrc` pinned to Node 22 LTS
- [X] T002 [P] Create `tsconfig.base.json` at the repository root with `strict: true` and `noUncheckedIndexedAccess: true`, plus an extending `tsconfig.json` in each of `packages/core/`, `packages/adapters/`, `packages/shared/`, `services/api/`, `services/optimizer/`
- [X] T003 [P] Configure ESLint and Prettier in `eslint.config.js` and `.prettierrc` at the root, with `@typescript-eslint/no-explicit-any` and `no-non-null-assertion` as errors per Principle VII
- [X] T004 [P] Add the purity lint override for `packages/core/**` in `eslint.config.js` banning `Date.now`, argument-less `new Date()`, `Math.random`, and any `node:*`/`firebase-admin`/`fetch` import — this is the mechanical enforcement of Principle III and SC-010
- [X] T005 [P] Configure Vitest in `vitest.workspace.ts` with three projects — `unit` (`packages/core`), `contract` (`packages/adapters/tests/contract`), `integration` (`services/*/tests`)
- [X] T006 [P] Scaffold `packages/shared/` — `package.json` (`@app/shared`), `src/index.ts`
- [X] T007 [P] Scaffold `packages/core/` — `package.json` (`@app/core`), `src/index.ts`; declare no runtime dependencies other than `zod` types
- [X] T008 [P] Scaffold `packages/adapters/` — `package.json` (`@app/adapters`), `src/index.ts`, dependencies on `zod` and `firebase-admin`
- [X] T009 [P] Scaffold `services/api/` with Hono — `package.json` (`@app/api`), `src/index.ts` listening on `:8081`
- [X] T010 [P] Scaffold `services/optimizer/` with Hono — `package.json` (`@app/optimizer`), `src/index.ts` listening on `:8082`
- [X] T011 [P] Scaffold `apps/web/` — Vue 3 + Vite + Pinia + `vite-plugin-pwa`, mobile-first, dev server on `:5173`
- [X] T012 [P] Scaffold `apps/admin/` — Vue 3 + Vite, desktop-only, dev server on `:5174`
- [X] T013 [P] Add `firebase.json`, `.firebaserc` and the Firestore emulator config (Firestore on `:8080`, UI on `:4000`) per [quickstart.md](./quickstart.md)
- [X] T014 [P] Create `.env.example` and a Zod-validated config loader in `packages/shared/src/env.ts` covering Easee technical credentials, SolarEdge key + site id, OpenWeatherMap key, admin basic-auth credential, lat/lon
- [X] T015 [P] Add `.github/workflows/ci.yml` running `pnpm typecheck && pnpm lint && pnpm test` on every pull request — a red pipeline blocks merge (constitution, Automated Gates)
- [X] T016 Add the root `package.json` scripts referenced throughout [quickstart.md](./quickstart.md): `dev`, `build`, `typecheck`, `lint`, `test`, `test:unit`, `test:contract`, `test:integration`, `seed:lots`, `replay`, `cycle`, `report:writes`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The three de-risking spikes, the shared types, the time/tariff calendar, every provider
client, the Firestore layer, the lease, and the replay harness. Nothing story-specific may start
until this phase is complete.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

### Spikes (do these first — each invalidates real work if deferred)

- [x] T017 [P] Spike **O1** — **DONE 2026-08-15**. Live daylight reading in `fixtures/providers/solaredge/currentPowerFlow-live.json`: `LOAD` **and** `GRID` are both present, so the site does expose consumption metering and **R2's surplus formula holds as written**. Direction is stated as `{from: "LOAD", to: "Grid"}` → exporting, `gridExportKw = +23.21` (PV 46.33 = LOAD 23.12 + GRID 23.21). No re-derivation of R3 needed; the 192/day budget and the daylight gate stand
- [x] T018 [P] Spike **O2** — **DONE 2026-08-14**. Easee tokens are Keycloak-issued **RS256** JWTs (`iss: https://auth.easee.com/realms/easee`); a real token's signature verified against the published JWKS, whose `kid` matches the realm's `use: sig` key. **Deviation D1 withdrawn** from `plan.md`, R6 rewritten, T042 changed to local verification. Evidence in `fixtures/providers/easee/`
- [ ] T019 [P] Spike **O4**: run `python3 scripts/spikes/o4_dynamic_current_watchdog.py --hours 6` against the **owner's own lot** with a car left plugged in; it writes a CSV trace and prints the verdict. Record in `research.md` and, if a watchdog exists, revise the write budget in R8 and the write-spreading in T053 — *script ready; blocked on credentials and ~6 h of observation*

### Shared types and the pure calendar

- [X] T020 [P] Define the cross-boundary Zod schemas and inferred types in `packages/shared/src/schemas/` — `charger.ts`, `target.ts`, `session.ts`, `cycle.ts`, `auth.ts` — matching [contracts/user-api.md](./contracts/user-api.md) and [contracts/admin-api.md](./contracts/admin-api.md)
- [X] T021 [P] Define `CycleInputs`, `ChargerInput`, `CycleDecision`, `ChargerDecision` and `SchedulerConfig` in `packages/core/src/types.ts` exactly as specified in [contracts/scheduler-core.md](./contracts/scheduler-core.md)
- [X] T022 [P] Define the default `SchedulerConfig` values in `packages/core/src/config.ts` — `minCurrentA: 6`, `ewmaAlpha: 0.4`, `deadbandA: 1`, `startDelayCycles: 2`, `stopDelayCycles: 2`, `stalenessCutoffMinutes: 15`, the two high-price windows, the winter window, `timezone: 'Europe/Zurich'`
- [X] T023 [P] Implement kW ↔ A conversion for 1-phase (×4.348) and 3-phase (×1.443) in `packages/core/src/units.ts` per research R2
- [X] T024 Implement `packages/core/src/tariff.ts` — `tariffWindowAt(now, config)`, `seasonModeAt(now, config)`, and `isDaylight(now, lat, lon)`, all evaluated in Europe/Zurich with no naive local timestamps (FR-025)
- [X] T025 [P] Unit tests for the calendar in `packages/core/tests/tariff.test.ts` — high-price boundaries at 11:00/13:00/18:00/20:00, the winter window boundaries at 1 October and 28/29 February, and the DST days `2026-10-25` (doubled 02:00) and `2027-03-28` (missing 02:00)
- [X] T026 [P] Unit tests for `units.ts` in `packages/core/tests/units.test.ts` asserting the canvas figures — 6 A → 4.16 kW three-phase and 1.38 kW single-phase, 16 A three-phase → 11 kW

### Provider adapter foundation

- [X] T027 Implement the shared outbound HTTP client in `packages/adapters/src/http/client.ts` — explicit timeout, bounded retry with exponential backoff **and jitter**, `Retry-After` honoured, typed error union, never a silent default (Principle IV)
- [X] T028 Implement budget enforcement in `packages/adapters/src/http/budget.ts` — a token-bucket limiter plus daily counters that **refuse the call before it is made** rather than discovering the cap from a 429
- [X] T029 [P] Contract tests for the base client and budget limiter in `packages/adapters/tests/contract/http.test.ts` — 429 with `Retry-After` honoured and counted, timeout → bounded retry then typed failure, budget exhausted → refuses to call
- [X] T030 [P] Implement the Easee auth client in `packages/adapters/src/easee/auth.ts` — `POST /api/accounts/login`, `POST /api/accounts/refresh_token`, plus the technical-account token cache backed by `providerTokens/easeeTechnical`
- [X] T031 [P] Implement the Easee observations client in `packages/adapters/src/easee/observations.ts` — `GET /state/{serialNumber}/observations?ids=109,114,120,121,124,48,96,103`, mapped to the `ChargerObservation` domain model. **The deprecated `/state` endpoint must not be used** (removed 2026-09-01, research R1)
- [X] T032 [P] Implement the Easee settings client in `packages/adapters/src/easee/settings.ts` — `POST /api/chargers/{chargerId}/settings` writing **only** `dynamicChargerCurrent`, with a code-level guard rejecting any other key (Principle I, research R5) and a 20-writes/minute token bucket
- [X] T033 [P] Commit real Easee response recordings to `fixtures/providers/easee/` — observations for each `opMode` value, a settings 200, a 429 with `Retry-After`, and a malformed payload
- [X] T034 Easee contract tests in `packages/adapters/tests/contract/easee.test.ts` — happy-path parse of the committed recording, malformed payload → typed error, 429 honoured, budget exhausted → refuses, and the **setpoint reset after a simulated plug-in** (`wasReset(charger)`)

### Firestore layer

- [X] T035 Implement the Firestore repositories in `packages/adapters/src/firestore/` — `parkingLots.ts`, `chargers.ts`, `users.ts`, `targets.ts`, `sessions.ts`, `cycles.ts`, `chargerEvents.ts`, `chargerSnapshots.ts`, `fairness.ts`, `lease.ts`, `providerTokens.ts`, each matching the collection layouts in [data-model.md](./data-model.md)
- [X] T036 [P] Write the Firestore security rules (**deny all client access** — both frontends go through `services/api`), the three composite indexes, and the `expiresAt` TTL policies for `cycles`, `chargerSnapshots` and `chargerEvents` in `infra/firestore/`
- [X] T037 [P] Implement structured JSON logging with a correlation ID in `packages/shared/src/logging.ts` — Cloud Logging structured format, `severity` and `labels.component` fields (Principle III, and the alerting policy in [contracts/admin-api.md](./contracts/admin-api.md) depends on these fields)

### Service skeletons and the replay harness

- [X] T038 Implement the optimizer lease in `services/optimizer/src/lease.ts` — a Firestore transaction on `locks/optimizer` with a 4-minute expiry; a cycle finding a live lease writes a `skipped_locked` cycle record and returns **200** so Cloud Scheduler does not retry (FR-026, research R7)
- [X] T039 Implement the `POST /cycle` handler skeleton in `services/optimizer/src/index.ts` — accepts `{ cycleId }`, acquires the lease, and is idempotent per `cycleId` (FR-050)
- [X] T040 [P] Single-flight and idempotency integration tests in `services/optimizer/tests/single-flight.test.ts` — two overlapping requests, exactly one acquires the lease, the second returns 200 with `skipped_locked`; and a repeated `cycleId` changes nothing
- [X] T041 Implement the API application shell in `services/api/src/index.ts` — Hono app, Zod boundary validation, and the error-code mapping table from [contracts/user-api.md](./contracts/user-api.md) (`validation_failed`, `deadline_too_soon`, `token_expired`, `token_invalid`, `no_charger_mapped`, `not_your_charger`, `upstream_rate_limited`, `upstream_unavailable`)
- [X] T042 Implement JWKS-backed **local** token verification in `services/api/src/middleware/easeeAuth.ts` (spike O2, research R6) — fetch `https://auth.easee.com/realms/easee/protocol/openid-connect/certs`, cache keys by `kid` honouring the response cache headers, re-fetch on an unknown `kid` **behind a rate limit** so a forged `kid` cannot amplify fetches, and verify: signature with `alg` taken **from the JWKS entry, never from the token header** (algorithm-confusion guard), `iss === "https://auth.easee.com/realms/easee"`, `exp`, and `aud` containing `easee`. Extract the `UserId` claim for FR-003. No remote validation call is needed
- [X] T043 [P] Auth middleware tests in `services/api/tests/auth.test.ts` — valid token passes; expired token → 401 `token_expired`; **token re-signed with an attacker key whose `kid` matches a real one → rejected**; **`alg: none` and an HS256 token forged with the RSA public key as the HMAC secret → both rejected**; wrong `iss` → rejected; `aud` without `easee` → rejected; unknown `kid` triggers at most one rate-limited JWKS re-fetch
- [X] T044 [P] Implement `pnpm seed:lots` in `scripts/seed-lots.ts` loading `fixtures/parking-lots.json` into the `parkingLots` collection — the only data the system does not produce itself
- [X] T045 Implement the replay harness in `scripts/replay.ts` and `scripts/cycle.ts` — `pnpm replay <fixture>` loads a fixture day into the provider mocks, `pnpm cycle <instant>` runs one cycle at a simulated time. Every validation scenario in [quickstart.md](./quickstart.md) depends on this

**Checkpoint**: Workspace, types, calendar, Easee client, Firestore layer, lease and replay harness
are in place — user story implementation can begin.

---

## Phase 3: User Story 1 - Get my car charged by a deadline (Priority: P1) 🎯 MVP

**Goal**: A signed-in user sets kWh + deadline with two sliders; the system delivers that energy
before the deadline and never imports from the grid during the high-price windows. No solar data is
involved.

**Independent Test**: Sign in as a user with a mapped parking lot, set 20 kWh by 07:00 tomorrow, and
verify charging is scheduled and executed outside 11:00–13:00 and 18:00–20:00 and the energy is
delivered before the deadline — quickstart scenario **V1**, `fixtures/days/winter-overcast.json`.

### Tests for User Story 1 ⚠️

> Write these first and confirm they fail before implementing T049–T051.

- [X] T046 [P] [US1] Ladder unit tests in `packages/core/tests/ladder.test.ts` — the high-price-versus-deadline conflict resolves to **no grid import** with `reason: 'high_price_blocked'`, `ladderRule: 3`, `targetCurrentA: 0`; a low-price at-risk target resolves to `reason: 'deadline_fallback'`, `ladderRule: 4`
- [X] T047 [P] [US1] Reachability unit tests in `packages/core/tests/reachability.test.ts` — reachable / at_risk / unreachable transitions and the `expectedShortfallKwh` figure, computed only over remaining **low-price** time
- [X] T048 [P] [US1] Degraded-state unit tests in `packages/core/tests/degraded.test.ts` — `opMode` 0 (offline) and 5 (error) yield `targetCurrentA: 0` and never throw; `decide` never throws on well-typed input (contract invariant 4)

### Implementation for User Story 1

- [X] T049 [US1] Implement `packages/core/src/reachability.ts` — `isReachable(target, now, config, chargerCapability)` returning `{ state, expectedShortfallKwh }`, evaluated within the price policy (Principle II)
- [X] T050 [US1] Implement `packages/core/src/decide.ts` — the pure `decide(inputs): CycleDecision`, initially covering ladder rules **1, 3 and 4** plus the non-charging reasons `no_target`, `target_met`, `not_plugged_in`, `charger_error`; every decision carries `ladderRule`, `attribution` and `reachability`
- [X] T051 [US1] Enforce the advisory per-line headroom (`lineLimits.L1/L2/total`) over this system's own commanded sum inside `packages/core/src/decide.ts` — ladder rule 1; never used to raise a cap the external load manager set
- [X] T052 [US1] Implement `services/optimizer/src/gather.ts` — sweep all 30 chargers' observations, join with `parkingLots` and open targets, and build `CycleInputs` with `surplus: null` and `quality: 'unusable'` for this story
- [X] T053 [US1] Implement `services/optimizer/src/apply.ts` — write setpoints via the Easee settings client, honouring the ±1 A deadband, spreading writes across the 20/min token bucket, and **re-applying the setpoint on every detected plug-in** (research R5)
- [X] T054 [US1] Implement `services/optimizer/src/readback.ts` — compare observation 48 and 114 against `commandedCurrentA` and classify `discrepancy` as `none` / `capped` / `lost` (FR-028, Principle I)
- [X] T055 [US1] Implement `services/optimizer/src/sessions.ts` — the `opMode` transition handling from [data-model.md](./data-model.md): `1 → {2,3,6}` opens a session and activates a stored target (FR-010), `{2,3,4,6} → 1` closes it as `ended_early` or `completed` and closes the target; accumulate `deliveredKwh` from observation 121
- [X] T056 [US1] Implement `services/optimizer/src/record.ts` — persist `cycles/{cycleId}` with the complete `inputs`, `decisions`, `readBack`, `providerCalls` and `correlationId` (Principle III); `cycleId` is the scheduled instant, which is also the idempotency key
- [X] T057 [US1] Implement `services/optimizer/src/persistence.ts` — ~15-minute `chargerSnapshots` for **active chargers only** plus `chargerEvents` on state changes; explicitly **not** one write per charger per cycle (FR-046, Principle VI)
- [X] T058 [US1] Wire the full cycle in `services/optimizer/src/cycle.ts` — lease → gather → decide → apply → readback → sessions → record → persistence, releasing the lease in a `finally`
- [X] T059 [P] [US1] Implement `POST /auth/login` and `POST /auth/refresh` in `services/api/src/routes/auth.ts` — proxy to Easee, return tokens plus the caller's mapped chargers, never store or log the password; `403 no_charger_mapped` when no lot is mapped (US1 scenario 6)
- [X] T060 [P] [US1] Implement `GET /chargers` in `services/api/src/routes/chargers.ts` — server-derived `state`, `deliveredCurrentA` from read-back rather than the setpoint, and the target block per [contracts/user-api.md](./contracts/user-api.md)
- [X] T061 [US1] Implement `POST /chargers/{lotNumber}/target` in `services/api/src/routes/targets.ts` — Zod validation, rejection of a deadline in the past or too soon with `earliestFeasibleDeadline` (FR-007), acceptance-with-`unreachable` rather than silent trimming, and marking any previous open target `superseded` **in the same transaction** (FR-009)
- [X] T062 [US1] Implement `DELETE /chargers/{lotNumber}/target` in `services/api/src/routes/targets.ts` — cancels the open target, returns 204
- [X] T063 [US1] Implement authorization against `parkingLots` in `services/api/src/middleware/authorize.ts` — refuse any action on a charger not mapped to the token's `userId` with `403 not_your_charger` (FR-003)
- [X] T064 [P] [US1] API integration tests against the Firestore emulator in `services/api/tests/targets.test.ts` — target creation, supersession, deadline rejection, unauthorized charger, unmapped user
- [X] T065 [P] [US1] Implement the login view and the `session` Pinia store in `apps/web/src/views/LoginView.vue` and `apps/web/src/stores/session.ts` — token refresh on `401 token_expired`
- [X] T066 [P] [US1] Implement `apps/web/src/views/ChargerView.vue` and `apps/web/src/stores/chargers.ts` — parking lot number as the charger identity (FR-004), state, delivered and remaining energy
- [X] T067 [US1] Implement `apps/web/src/views/TargetView.vue` — the two sliders (kWh, deadline) and one confirmation, targeting under 60 seconds end to end (SC-001), showing `earliestFeasibleDeadline` on a 400
- [X] T068 [US1] Surface unreachability in `apps/web/src/views/ChargerView.vue` — the expected shortfall shown explicitly rather than silent under-delivery (FR-036, SC-003)
- [X] T069 [US1] Create `fixtures/days/winter-overcast.json` and run quickstart scenario **V1** — assert `reason: 'deadline_fallback'` / `ladderRule: 4` at 22:00 and `reason: 'high_price_blocked'` / `ladderRule: 3` / `targetCurrentA: 0` at 12:00 and 19:00

**Checkpoint**: User Story 1 is fully functional — deadline-driven charging under the price policy,
which is also exactly the required winter-window behaviour.

---

## Phase 4: User Story 2 - Charge from the building's own solar surplus (Priority: P2)

**Goal**: Spend the building's PV surplus on open targets first, defer grid charging as long as the
deadline allows, and defer to tomorrow when the forecast says tomorrow is sunnier — without changing
the US1 deadline guarantee or price policy.

**Independent Test**: Replay a recorded day of site production against a set of open targets and
verify charging follows the surplus curve, that grid charging occurs only when the deadline is at
risk, and that delivered energy is attributed to solar vs grid — quickstart scenarios **V2** and
**V3**.

### Tests for User Story 2 ⚠️

- [X] T070 [P] [US2] SolarEdge contract tests in `packages/adapters/tests/contract/solaredge.test.ts` — parse of the committed recording, **both import and export directions** derived from `connections` rather than the sign of `currentPower` (the highest-cost bug available in this integration), missing `GRID` element → typed error, 429 honoured, budget exhausted → refuses
- [X] T071 [P] [US2] OpenWeatherMap contract tests in `packages/adapters/tests/contract/openweather.test.ts` — parse of the committed recording, `deferRecommended` true only under all three R4 conditions, missing forecast → `null` and never a deferral
- [X] T072 [P] [US2] Surplus unit tests in `packages/core/tests/surplus.test.ts` — EWMA at α = 0.4, the ±1 A deadband, 2-cycle start and stop hysteresis, and `quality` transitions `fresh → stale → unusable` at the 15-minute cutoff
- [X] T073 [P] [US2] Solar ladder unit tests in `packages/core/tests/solar.test.ts` — surplus at 5.5 A **waits** rather than taking a 6 A grid top-up (FR-020); surplus during a high-price window **is** used (FR-019); `quality: 'unusable'` never yields `reason: 'solar_surplus'`; `seasonMode: 'winter'` skips rules 5 and 6 entirely

### Implementation for User Story 2

- [X] T074 [P] [US2] Implement the SolarEdge client in `packages/adapters/src/solaredge/index.ts` — `GET /site/{siteId}/currentPowerFlow`, exposing `SitePower { gridExportKw, loadKw, pvKw, observedAt }` with `gridExportKw` negative on import, direction taken from `connections`
- [X] T075 [P] [US2] Enforce the SolarEdge budget in `packages/adapters/src/solaredge/budget.ts` — one call per cycle, **daylight only**, skipped during the winter window, refusing the call outside the daylight gate; worst case 192/day against 300 (FR-045, research R3)
- [X] T076 [P] [US2] Commit SolarEdge recordings to `fixtures/providers/solaredge/` — an export case, an import case, a 429, and a payload with no `GRID` element
- [X] T077 [P] [US2] Implement the OpenWeatherMap client in `packages/adapters/src/openweather/index.ts` — `GET /data/2.5/forecast`, exposing `Forecast { cloudCoverRestOfTodayPct, cloudCoverTomorrowPct, deferRecommended, fetchedAt }`, capped at 4 fetches/day
- [X] T078 [P] [US2] Commit OpenWeatherMap recordings to `fixtures/providers/openweather/`
- [X] T079 [US2] Implement `packages/core/src/surplus.ts` — `surplusRaw = gridExportKw + ownChargingKw`, the α = 0.4 EWMA, the ±1 A deadband, the 2-cycle start/stop hysteresis counters, and the `fresh|stale|unusable` classification (FR-015, FR-016, FR-017)
- [X] T080 [US2] Extend `packages/core/src/decide.ts` with **ladder rule 5** — allocate available surplus to chargers with open targets, respecting the modulation floor by waiting rather than topping up, subject to the hysteresis counters
- [X] T081 [US2] Implement the degraded paths in `packages/core/src/decide.ts` — `quality: 'unusable'` or `smoothedKw === null` skips rules 5 and 6 and adds a note; `seasonMode: 'winter'` does the same by policy; `forecast === null` forces `deferRecommended: false`. A missing reading is **never** zero surplus (FR-016, FR-023, FR-044)
- [X] T082 [US2] Implement the deferral decision in `packages/core/src/decide.ts` — `reason: 'deferred_to_tomorrow'` only when the deadline is >24 h away, tomorrow's mean daytime cloud cover is ≥25 points lower, **and** `isReachable` still holds after the deferral (FR-022, research R4)
- [X] T083 [US2] Extend `services/optimizer/src/gather.ts` — read SolarEdge behind the daylight gate, compute `ownChargingKw` from observation 120 over commanded chargers, carry `observedAt`/`ageMinutes`/`quality`, and reuse the previous reading with its age on failure rather than substituting zero
- [X] T084 [US2] Implement forecast scheduling in `services/optimizer/src/forecast.ts` — fetch at most 4×/day so a deferral never rests on a forecast older than 6 hours, reusing the previous forecast on error
- [X] T085 [US2] Implement solar/grid attribution in `services/optimizer/src/sessions.ts` — add each cycle's delivered kWh to `deliveredSolarKwh` or `deliveredGridKwh` according to the decision's `attribution` field, not a measurement, per [data-model.md](./data-model.md)
- [X] T086 [US2] Surface the solar states in `apps/web/src/views/ChargerView.vue` — `waiting_for_surplus` distinguished from `charging_grid`, and `charging_solar` (FR-035), with wording that states attribution follows the decision rather than metering
- [X] T087 [US2] Create `fixtures/days/summer-broken-cloud.json` and run quickstart scenario **V2** — assert the **setpoint change count**, not just delivered energy: no charger starts or stops more than once per 15 minutes despite the cloud edges
- [X] T088 [US2] Create `fixtures/days/summer-solaredge-outage.json` and run quickstart scenario **V3** — cycles marked `degraded`, `quality` degrading to `unusable`, no `solar_surplus` decisions thereafter, charging continues under the deadline rule, and **no cycle fails**

**Checkpoint**: User Stories 1 and 2 both work — the deadline guarantee is unchanged and surplus is
now consumed first.

---

## Phase 5: User Story 3 - See what my car is doing and what it did (Priority: P3)

**Goal**: Live state and progress during a session, a solar/grid summary after it, and the last five
sessions in history.

**Independent Test**: Run a session to completion and verify the live view during, and the summary
and history entries after, including the solar/grid split.

- [X] T089 [P] [US3] Session summary integration test in `services/api/tests/sessions.test.ts` — summary contains total, solar/grid split, `targetMet` and `endReason`; a session ended by unplug is marked `unplugged` with the energy actually delivered
- [X] T090 [P] [US3] Retention test in `services/optimizer/tests/retention.test.ts` — a user with six completed sessions retains exactly the five most recent
- [X] T091 [US3] Complete the session close-out in `services/optimizer/src/sessions.ts` — write `energyKwh`, `solarKwh`, `gridKwh`, `targetEnergyKwh`, `deadline`, `targetMet`, `endReason`, `overrideUsed` (FR-037)
- [X] T092 [US3] Enforce five-session retention in `packages/adapters/src/firestore/sessions.ts` — closing a session deletes the sixth-oldest **in the same batch**, so FR-038 holds by construction rather than via a nightly job
- [X] T093 [P] [US3] Implement `GET /sessions` in `services/api/src/routes/sessions.ts` — the five most recent, newest first
- [X] T094 [P] [US3] Implement `apps/web/src/views/HistoryView.vue` — the five sessions with their solar/grid split and target-met status
- [X] T095 [US3] Implement the live progress display in `apps/web/src/views/ChargerView.vue` — current state, energy delivered so far, energy remaining (FR-035)

**Checkpoint**: Users can see what the optimization did, which is what makes it trustworthy.

---

## Phase 6: User Story 4 - Charge now, ignore the optimization (Priority: P4)

**Goal**: An immediate full-power override that beats every rule below the external load manager and
clears itself at session end.

**Independent Test**: Activate the override during a high-price window with no surplus, verify
charging starts immediately, then simulate an unplug and verify the override cleared without a
client call — quickstart scenario **V4**.

- [X] T096 [P] [US4] Override unit tests in `packages/core/tests/override.test.ts` — `overrideActive` yields `targetCurrentA: maxCurrentA`, `reason: 'override'`, `ladderRule: 2` inside a high-price window with no surplus; and it never raises a limit above `maxCurrentA` (ladder rule 1 still wins)
- [X] T097 [US4] Extend `packages/core/src/decide.ts` with **ladder rule 2** — the override, evaluated immediately after the external load-management constraint and before the high-price rule (FR-032)
- [X] T098 [US4] Implement `PUT /chargers/{lotNumber}/override` in `services/api/src/routes/override.ts` — `{ active: true|false }` → `{ active, since }`, authorized against `parkingLots`
- [X] T099 [US4] Clear the override automatically at session end in `services/optimizer/src/sessions.ts` — on `{2,3,4,6} → 1` or target reached, write `overrideActive: false` and an `override_off` event (FR-033); the client must not be relied on to clear it
- [X] T100 [P] [US4] Implement the override control and banner in `apps/web/src/views/ChargerView.vue` — the active state and the reason optimization is suspended are both visible (FR-034)
- [X] T101 [US4] Run quickstart scenario **V4** — override inside a high-price window with no surplus charges at `maxCurrentA`; a simulated unplug (`opMode → 1`) clears it automatically

**Checkpoint**: The escape hatch exists and is auditable.

---

## Phase 7: User Story 5 - Fair sharing of surplus between competing users (Priority: P5)

**Goal**: When surplus is insufficient for all competitors, split it where each share clears the
modulation floor, otherwise draw a winner weighted inversely to solar energy already received — and
make that draw reproducible.

**Independent Test**: Replay three open targets against surplus sufficient for one and a half cars
over several days and verify distribution across users and byte-identical replay — quickstart
scenario **V5**.

- [X] T102 [P] [US5] Fairness unit tests in `packages/core/tests/fairness.test.ts` — over 100 seeded cycles the under-served user is selected more often; the same seed yields the same selection; surplus is split across chargers when each share clears the floor
- [X] T103 [P] [US5] Determinism test in `packages/core/tests/determinism.test.ts` — `decide(inputs)` twice is deeply equal, for inputs including a contested fairness draw (contract invariant 3)
- [X] T104 [US5] Implement `packages/core/src/fairness.ts` — a draw seeded from `randomSeed` (derived from `cycleId`), weighted inversely to `fairness[userId].solarKwhReceived`, plus the power-splitting rule
- [X] T105 [US5] Extend `packages/core/src/decide.ts` with **ladder rule 6** — apply the draw when rule 5 cannot serve every competitor, emitting `reason: 'fairness_not_selected'` for the losers
- [X] T106 [US5] Maintain the fairness ledger in `services/optimizer/src/sessions.ts` and `packages/adapters/src/firestore/fairness.ts` — rolling 30-day `solarKwhReceived`, `windowStart`, `lastServedCycleId`
- [X] T107 [US5] Implement `pnpm test:determinism` in `scripts/determinism.ts` — re-run `decide()` over every recorded fixture cycle and diff against the recorded `decisions`. This is the SC-010 gate and must be green before any optimizer change merges
- [X] T108 [US5] Create `fixtures/days/summer-three-competitors.json` and run quickstart scenario **V5** — surplus distributed across users over the day, every cycle replaying byte-identically

**Checkpoint**: Allocation is fair, and every allocation is explainable and replayable.

---

## Phase 8: User Story 6 - Operator monitoring and troubleshooting (Priority: P6)

**Goal**: A desktop admin view that answers "why did charger 12 not charge between 14:00 and 15:00?"
from the recorded decision trail alone, plus an email alert when cycles fail.

**Independent Test**: With cycles running against recorded data, answer that question using only
what the view shows, in under 5 minutes (SC-009).

- [X] T109 [P] [US6] Implement the `adminBasicAuth` middleware in `services/api/src/middleware/adminBasicAuth.ts` — a single shared credential from Secret Manager, enforced separately from the user routes; unauthenticated access refused (FR-005, US6 scenario 5)
- [X] T110 [P] [US6] Implement `GET /admin/cycles` in `services/api/src/routes/admin/cycles.ts` — newest first, with `outcome`, `durationMs`, the surplus block including `ageMinutes` and `quality`, `tariffWindow`, `seasonMode`, `chargersActedOn` and `providerCalls` (FR-039)
- [X] T111 [P] [US6] Implement `GET /admin/cycles/{cycleId}` in `services/api/src/routes/admin/cycles.ts` — the complete record (`inputs`, `decisions`, `readBack`, `correlationId`), copyable straight into a regression fixture
- [X] T112 [P] [US6] Implement `GET /admin/chargers` in `services/api/src/routes/admin/chargers.ts` — all 30 whether or not they have a target, with `commandedCurrentA`, `deliveredCurrentA`, `dynamicChargerCurrentA` and `discrepancy`; lots with no `easeeUserId` returned as `user: null` and flagged `orphaned` (FR-040, US6 scenario 3)
- [X] T113 [P] [US6] Implement `GET /admin/chargers/{lotNumber}/trace?from=&to=` in `services/api/src/routes/admin/trace.ts` — every cycle in range with that charger's `targetCurrentA`, `reason`, `ladderRule`, delivered current and events (FR-042, SC-009)
- [X] T114 [P] [US6] Implement `GET /admin/providers` in `services/api/src/routes/admin/providers.ts` — rolling 24-hour call count against budget, error and rate-limit counts, last error with correlation ID, and the SolarEdge daylight-gate state (FR-041)
- [X] T115 [P] [US6] Implement `GET /admin/health` in `services/api/src/routes/admin/health.ts` — `lastCycle`, `leaseHeld`, `consecutiveFailures`, `firestoreWritesToday`, `openTargets`, `unreachableTargets`; `firestoreWritesToday` keeps the Principle VI budget observable rather than assumed
- [X] T116 [P] [US6] Implement `apps/admin/src/views/CyclesView.vue` — the recent-cycles table with outcome, surplus estimate and age
- [X] T117 [P] [US6] Implement `apps/admin/src/views/ChargersView.vue` — per-charger target, state, commanded vs delivered current, and the `discrepancy` flag made visible rather than hidden
- [X] T118 [P] [US6] Implement `apps/admin/src/views/DecisionTraceView.vue` — the per-charger trail with `ladderRule` as the one-glance answer
- [X] T119 [P] [US6] Implement `apps/admin/src/views/ProvidersView.vue` — per-provider budget, errors and rate limits
- [X] T120 [US6] Configure alerting in `infra/monitoring/` — a log-based metric over `outcome IN (failed, skipped_locked)` or `severity >= ERROR`, and an alerting policy firing on **≥2 occurrences in 15 minutes** that emails the operator (FR-043, SC-008)
- [X] T121 [P] [US6] Retention test in `services/api/tests/retention.test.ts` — monitoring data older than one month is removed by the `expiresAt` TTL policy (FR-047, US6 scenario 6)
- [X] T122 [P] [US6] Admin API integration tests in `services/api/tests/admin.test.ts` — unauthenticated access refused, trace answers the "why did charger 12 not charge" question from recorded data alone

**Checkpoint**: Every user complaint is answerable, and silent failure is no longer possible.

---

## Phase 9: User Story 7 - Delete all my data (Priority: P7)

**Goal**: One confirmed action removes every record referencing the user, hard-deleted, within one
minute.

**Independent Test**: Create a user with targets, sessions and history, delete, and verify no record
references their identifier and they can sign in again as a fresh user — quickstart scenario **V9**.

- [X] T123 [P] [US7] Deletion test in `services/api/tests/deletion.test.ts` — after `DELETE /me` no document in any collection references the `userId`, the `fairness` entry is gone, and `parkingLots` is **untouched** because it is operator data
- [X] T124 [US7] Implement `DELETE /me` in `services/api/src/routes/me.ts` — requires `{ "confirm": "DELETE" }`, hard-deletes `users/{userId}` with its `targets` and `sessions` subcollections plus `fairness/{userId}`, returns 204 (FR-048)
- [X] T125 [US7] Cancel any open target and clear any override on the user's chargers as part of the same deletion in `services/api/src/routes/me.ts` (US7 scenario 3)
- [X] T126 [P] [US7] Implement the delete control in `apps/web/src/views/SettingsView.vue` — explicit confirmation, and a clear statement that the deletion is permanent
- [X] T127 [US7] Run quickstart scenario **V9** (`pnpm test:deletion`) and confirm the one-minute bound in SC-013

**Checkpoint**: The privacy commitment is real and verified.

---

## Phase 10: User Story 8 - Multiple chargers on one account (Priority: P8)

**Goal**: A user mapped to several parking lots sees them all and sets an independent target on each;
a user mapped to exactly one goes straight to it.

**Independent Test**: Sign in as a user mapped to two lots, set different targets on each, and verify
both are scheduled independently.

- [X] T128 [P] [US8] Multi-charger integration test in `services/api/tests/multi-charger.test.ts` — two lots on one `userId`, independent targets, neither supersedes the other
- [X] T129 [US8] Return every mapped charger from `GET /chargers` in `services/api/src/routes/chargers.ts`, resolved from `users/{userId}.lotNumbers` (FR-011)
- [X] T130 [US8] Confirm target independence in `services/api/src/routes/targets.ts` — supersession is keyed by `chargerId`, never by `userId`
- [X] T131 [US8] Implement charger selection in `apps/web/src/views/ChargerListView.vue` and route directly to the single charger when only one is mapped (US8 scenario 3)

**Checkpoint**: All eight user stories are independently functional.

---

## Phase 11: Polish & Cross-Cutting Concerns

- [X] T132 [P] Implement `pnpm test:dst` in `packages/core/tests/dst.test.ts` — full cycles across `2026-10-25` (doubled 02:00) and `2027-03-28` (missing 02:00): tariff windows apply for the correct wall-clock hours, no deadline missed or double-counted, winter boundary evaluated locally (quickstart **V6**, FR-025, SC-014)
- [X] T133 [P] Create `fixtures/days/plug-in-reset.json` and run quickstart scenario **V7** — after a simulated plug-in, `discrepancy: 'lost'` is recorded and the next cycle re-applies the setpoint
- [X] T134 [P] Create `fixtures/days/summer-busy.json` and implement `pnpm report:writes` in `scripts/report-writes.ts` — quickstart **V10**, asserting extrapolated writes ≤2,000/day against the 20,000/day free allowance (Principle VI, SC-012)
- [X] T135 [P] Implement `pnpm cycle:dry-run --lot=<owner-lot>` in `scripts/dry-run.ts` — compute and print the decision, write nothing; this is the first step of every hardware validation
- [X] T136 [P] Write `infra/README.md` documenting the one-time setup: the Cloud Scheduler job (5 min, OIDC, `min-backoff` 60 s, **retries 0** — a missed cycle is preferable to a stacked one), Secret Manager entries, the Firestore TTL policies, and the alerting policy
- [X] T137 [P] Add the Cloud Run service definitions (both at `min-instances=0`) and the Cloud Scheduler job to `infra/`, so deployment is reproducible from repository contents alone (Principle V)
- [X] T138 [P] Add `.github/workflows/deploy.yml` — deploy from `main` via Workload Identity Federation, with no service-account key in the repository
- [X] T139 Verify the performance goal against `fixtures/days/summer-busy.json` — a full cycle (30 charger reads, one surplus read, decide, writes) completes within **90 seconds**, inside the 4-minute lease
- [X] T140 [P] Raise the MINOR constitution amendment for deviation **D2** (Firebase Hosting instead of Cloud Storage) against `.specify/memory/constitution.md`, alongside the first implementation pull request as `plan.md` requires. **D1 no longer applies** — spike O2 showed local JWT verification is possible, so the Authentication constraint is met as written and needs no amendment
- [X] T141 Run the complete [quickstart.md](./quickstart.md) validation set V1–V10 end to end against the emulator, then the hardware sequence: dry-run → owner's lot only → widen to the other 29

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies — start immediately
- **Foundational (Phase 2)**: depends on Setup — **blocks every user story**. The three spikes
  (T017–T019) should complete before T074 (SolarEdge), T042 (auth) and T053 (setpoint writes)
  respectively, because each spike can invalidate that work
- **US1 (Phase 3)**: depends on Foundational only
- **US2 (Phase 4)**: depends on Foundational; extends `decide.ts` and `gather.ts` from US1
- **US3 (Phase 5)**: depends on Foundational; the session records it reports on are written in US1,
  the solar/grid split in US2
- **US4 (Phase 6)**: depends on Foundational; extends `decide.ts` and `sessions.ts`
- **US5 (Phase 7)**: depends on US2 — fairness only arises when there is surplus to contend for
- **US6 (Phase 8)**: depends on Foundational; richer once US1–US5 are producing decisions
- **US7 (Phase 9)**: depends on Foundational; independent of US2–US6
- **US8 (Phase 10)**: depends on US1's target and charger routes
- **Polish (Phase 11)**: depends on all desired stories

### The one real cross-story constraint

`packages/core/src/decide.ts` is extended by four stories — US1 adds ladder rules 1/3/4, US2 adds
rule 5, US4 adds rule 2, US5 adds rule 6. Those four tasks (T050, T080, T097, T105) touch the same
file and are therefore **never parallel with each other**, even though the stories are otherwise
independent. Everything else in each story phase is parallelisable across stories.

`services/optimizer/src/sessions.ts` is touched by T055 (US1), T085 (US2), T091 (US3), T099 (US4)
and T106 (US5) for the same reason.

### Within Each User Story

- Tests are written first and must fail before the implementation tasks that satisfy them
- Core (pure) before adapters before services before UI
- Story complete and independently validated before moving to the next priority

### Parallel Opportunities

- Phase 1: T002–T015 are all `[P]` — the whole scaffold can be built at once
- Phase 2: the three spikes T017–T019 run in parallel with each other and with T020–T026
- Phase 2: the Easee client modules T030–T033 are separate files and run in parallel
- Phase 4: the two provider clients (T074–T078) are independent of the core surplus work (T079)
- Phase 8: T110–T119 are ten separate route and view files — the admin surface is the most
  parallelisable phase in the plan
- Across stories: once Foundational is done, US1, US4, US6 and US7 can proceed concurrently subject
  to the `decide.ts` and `sessions.ts` serialisation noted above

---

## Parallel Example: User Story 2

```bash
# Tests first — four independent files:
Task: "SolarEdge contract tests in packages/adapters/tests/contract/solaredge.test.ts"
Task: "OpenWeatherMap contract tests in packages/adapters/tests/contract/openweather.test.ts"
Task: "Surplus unit tests in packages/core/tests/surplus.test.ts"
Task: "Solar ladder unit tests in packages/core/tests/solar.test.ts"

# Then the two provider clients and their fixtures, all independent files:
Task: "SolarEdge client in packages/adapters/src/solaredge/index.ts"
Task: "SolarEdge budget gate in packages/adapters/src/solaredge/budget.ts"
Task: "OpenWeatherMap client in packages/adapters/src/openweather/index.ts"
Task: "Commit SolarEdge recordings to fixtures/providers/solaredge/"
Task: "Commit OpenWeatherMap recordings to fixtures/providers/openweather/"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1: Setup
2. Phase 2: Foundational — including the three spikes, which are cheap now and expensive later
3. Phase 3: User Story 1
4. **STOP and VALIDATE**: quickstart V1 against `fixtures/days/winter-overcast.json`, then the
   dry-run and the owner's own parking lot
5. This is a complete, useful system: deadline-driven charging under the price policy — which is
   also exactly the behaviour required during the winter window

### Incremental Delivery

1. Setup + Foundational → foundation ready
2. + US1 → deadline charging works → **MVP**, demonstrable on the owner's lot
3. + US2 → the business case (solar self-consumption) is live → V2, V3
4. + US3 → users can see what happened → the optimization becomes trustworthy
5. + US4 → the escape hatch → the optimization becomes socially acceptable
6. + US5 → fairness once several users are active
7. + US6 → the operator can answer complaints without reading logs
8. + US7, US8 → the privacy commitment and the multi-lot edge case
9. + Polish → DST, write budget, deployment, hardware rollout

### Solo-Developer Note

There is one developer. The phase ordering above is the delivery order; the `[P]` markers indicate
where work is genuinely independent, which matters most for deciding what can be batched into a
single pull request without creating merge conflicts in `decide.ts`.

---

## Notes

- `[P]` = different files, no dependencies on incomplete tasks
- Every task touching current limits, start/stop behaviour or cycle execution must state in its pull
  request how it was validated — fixtures or the owner's lot (constitution, Development Workflow)
- No test may call a live third-party API; refreshing a recording in `fixtures/` is an explicit,
  reviewed act
- `pnpm test:determinism` (T107) is the SC-010 gate — it must be green before any optimizer change
  merges, including changes made in later phases
- Commit after each task or logical group; every change reaches `main` via pull request

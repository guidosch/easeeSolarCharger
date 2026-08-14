# Implementation Plan: Solar-Optimized EV Charging (MVP)

**Branch**: `001-solar-charging-mvp` | **Date**: 2026-08-14 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-solar-charging-mvp/spec.md`

## Summary

EV owners in a 30-charger building declare an energy amount and a deadline; a scheduled cycle
running every 5 minutes spends the building's PV surplus on the cars that need it, tops up from the
grid only at low tariff, and never imports during the operator's high-price windows.

The technical approach is a small monorepo with **one pure decision core and everything else at the
edges**. `packages/core` contains the scheduler as a total function — recorded inputs in, per-charger
setpoints out, no clock, no randomness, no I/O — which is what makes Principle III's reproducibility
requirement and SC-010's byte-identical replay achievable rather than aspirational. Two Cloud Run
services surround it: a request-driven API for the Vue PWA and the admin view, and a
Cloud-Scheduler-driven optimizer that gathers inputs, calls the core, writes setpoints, and records
the decision. Firestore holds all state; there is no queue, no cache and no second datastore.

Research settled the two questions the inception canvas deferred. Plug-in and session-end detection
is done by sweeping all 30 chargers' observations every cycle — affordable because Easee's limit is
100 requests per rolling 5 minutes, not a daily quota — which removes the need for a paid streaming
channel or a second polling tier. Surplus comes from SolarEdge's `currentPowerFlow`, whose net grid
position plus the system's own charging power is exactly the "available surplus" quantity the
optimizer needs, smoothed by an EWMA and a ±1 A deadband so a stale reading cannot cause
oscillation.

Three findings change what would otherwise have been built: Easee's `/state` endpoint is **removed
on 2026-09-01**, two weeks from now, so the observations endpoint must be used from the first
commit; `dynamicChargerCurrent` is **reset when a car is plugged in**, so setpoints must be
re-applied on every detected plug-in; and Easee's tokens are **Keycloak-issued RS256 JWTs with a
published JWKS**, so the constitution's "verify the JWT signature locally" rule is satisfied
directly (spike O2, 2026-08-14 — this replaced an earlier assumption that no JWKS existed).

## Technical Context

**Language/Version**: TypeScript 5.x on Node.js 22 LTS (`strict: true`, `noUncheckedIndexedAccess`);
Vue 3 + Vite for both frontends

**Primary Dependencies**: Hono (HTTP), Zod (boundary validation), `firebase-admin` (Firestore),
Pinia (frontend state), `date-fns-tz` or the `Temporal` polyfill (Europe/Zurich + DST), Vitest
(tests). No queue, cache, ORM or scheduling library.

**Storage**: Firestore in Native mode — targets, sessions, charger state, cycle decisions, fairness
ledger, the optimizer lease, and cached provider tokens. Firebase Hosting serves the two static
bundles. No other persistence primitive.

**Testing**: Vitest across all packages. Three tiers: unit tests over `packages/core` (the
precedence ladder, modulation floor, winter window, DST boundaries, fairness determinism); contract
tests for each provider client against committed recordings of real responses; integration tests for
the two services against the Firestore emulator. No test may call a live third-party API.

**Target Platform**: Google Cloud Run (two services, `min-instances=0`), Cloud Scheduler, Secret
Manager, Firestore, Firebase Hosting, Cloud Logging. Clients are mobile browsers (user PWA) and
desktop browsers (admin).

**Project Type**: Web application — two frontends, two backend services, shared TypeScript packages
in a pnpm workspace.

**Performance Goals**: A full optimizer cycle — 30 charger reads, one surplus read, the decision,
and the resulting writes — completes within **90 seconds**, giving a 3.3× margin inside the
5-minute cadence and inside the 4-minute lease. User-facing API reads answer in under 500 ms at p95
from a warm instance; a cold start is acceptable for a 15-user private installation.

**Constraints**:

- **Provider budgets are correctness constraints, enforced in code**: SolarEdge 1 call/cycle,
  daylight only, ≤192/day against a 300/day limit; Easee observations 30 calls/cycle against
  100 per rolling 5 min; Easee `POST /settings` ≤20/min via a token bucket; OpenWeatherMap 4/day.
- **Firestore free tier**: the design writes ~1,750 documents/day (~9% of the 20,000/day
  allowance). Derivation in [research.md](./research.md) R8.
- **Europe/Zurich throughout**, including both DST transitions; no naive local timestamps.
- **The external dynamic load management always wins** — this system only ever writes
  `dynamicChargerCurrent`, the lowest level in Easee's limit hierarchy, so it is structurally
  incapable of raising a cap the load manager has lowered.
- **Cost ceiling of zero**: no component may leave the free tier.

**Scale/Scope**: 30 chargers on 2 supply lines (63 A per line, 126 A total, enforced externally);
~15 active users growing to 30; 288 cycles/day; 8 user stories, 50 functional requirements; roughly
6 workspace packages and ~15 HTTP routes.

## Constitution Check

*GATE: evaluated before Phase 0 and re-evaluated after Phase 1 design.*

| # | Principle | Gate | Initial | Post-design |
| --- | --- | --- | --- | --- |
| I | Load-Management Safety & Rule Precedence | Ladder implemented as the single ordered decision path in `packages/core`; only `dynamicChargerCurrent` is ever written; delivered current is read back and reconciled every cycle | PASS | PASS |
| II | Deadline Commitment Within the Price Policy | `isReachable(target, now, forecast)` is a first-class core function feeding both FR-036 (user) and the admin view; grid top-up gated on the low-price window; modulation floor honoured by waiting, not topping up | PASS | PASS |
| III | Auditable, Reproducible Charge Decisions | `decide(inputs) → decisions` is pure; clock and fairness seed are injected parameters; every cycle persists its full input set, output, previous read-back, scheduler version and correlation ID as structured JSON | PASS | PASS |
| IV | Resilient, Budgeted Integrations | One client module per provider exposing a domain model; timeout + bounded backoff + `Retry-After` handling; budgets enforced by in-code limiters, not comments; fail-safe to grid-within-price-policy; contract tests over recorded responses | PASS | PASS |
| V | Stateless, Single-Flight Serverless Units | Both services stateless at `min-instances=0`; Firestore lease with a 4-minute expiry guards the cycle; skips are logged; every handler idempotent per trigger key; secrets from Secret Manager | PASS | PASS |
| VI | Free-Tier Frugality & Data Minimalism | State changes plus ~15-minute snapshots for active chargers only; write budget derived and stated (~53k/month); TTL-driven deletion at one month; five-session user history; hard delete of all user data | PASS | PASS |
| VII | Type-Safe Simplicity | `strict` everywhere; Zod at every boundary; no queue, cache, ORM or extra datastore; 6 workspace packages justified below | PASS | PASS |

**Technology & Deployment Constraints**: satisfied except for static hosting — see deviation D2.

**Authentication constraint**: **satisfied as written**. Spike O2 (2026-08-14) established that
Easee tokens are Keycloak-issued RS256 JWTs (`iss: https://auth.easee.com/realms/easee`) whose
signing key is published at the realm JWKS; a real token's signature was verified against it. The
backend therefore verifies the signature and expiry locally on every call, exactly as the
constitution requires. See [research.md](./research.md) R6.

**Deviations requiring justification**: **two**, recorded in Complexity Tracking. D1 was withdrawn
once O2 disproved its premise. Neither remaining deviation reorders the Principle I ladder, so
neither is a MAJOR amendment; D2 amends the Technology & Deployment Constraints section and should
be raised as a MINOR constitution amendment alongside the first implementation PR.

## Project Structure

### Documentation (this feature)

```text
specs/001-solar-charging-mvp/
├── plan.md              # This file (/speckit-plan command output)
├── spec.md              # Feature specification
├── research.md          # Phase 0 output — R1..R9 decisions, open items O1..O4
├── data-model.md        # Phase 1 output — Firestore collections, state machines
├── quickstart.md        # Phase 1 output — how to run and validate end to end
├── contracts/           # Phase 1 output
│   ├── user-api.md          # PWA ↔ backend
│   ├── admin-api.md         # admin view ↔ backend
│   ├── scheduler-core.md    # the pure decide() contract — the reproducibility boundary
│   └── external-providers.md # Easee, SolarEdge, OpenWeatherMap as consumed
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
apps/
├── web/                     # Vue 3 PWA, mobile-first — user surface (US1, US3, US4, US7, US8)
│   ├── src/views/           # ChargerView, TargetView, HistoryView, SettingsView
│   ├── src/stores/          # Pinia: session, chargers, targets
│   └── tests/
└── admin/                   # Vue 3 SPA, desktop-only — operator surface (US6)
    ├── src/views/           # CyclesView, ChargersView, ProvidersView, DecisionTraceView
    └── tests/

services/
├── api/                     # Cloud Run: user + admin HTTP API
│   ├── src/routes/          # auth, chargers, targets, sessions, admin
│   ├── src/middleware/      # easeeAuth (local JWKS verification), adminBasicAuth
│   └── tests/
└── optimizer/               # Cloud Run: the 5-minute cycle (Cloud Scheduler → OIDC HTTP)
    ├── src/cycle.ts         # lease → gather → decide → apply → record
    ├── src/gather.ts        # provider reads, staleness handling
    ├── src/apply.ts         # setpoint writes, rate limiting, read-back reconciliation
    └── tests/

packages/
├── core/                    # PURE. No I/O, no clock, no randomness.
│   ├── src/decide.ts        # decide(CycleInputs) → CycleDecision — the Principle I ladder
│   ├── src/surplus.ts       # EWMA, deadband, staleness classification
│   ├── src/reachability.ts  # can this target still be met under the price policy?
│   ├── src/tariff.ts        # high-price windows, winter window, DST-correct calendar
│   ├── src/fairness.ts      # seeded weighted draw + power splitting
│   └── tests/               # includes the recorded-day regression corpus
├── adapters/                # All I/O. One module per external system.
│   ├── src/easee/           # observations, settings, auth, token-bucket limiter
│   ├── src/solaredge/       # currentPowerFlow, daylight gate, budget counter
│   ├── src/openweather/     # 3-hour forecast, 4×/day
│   ├── src/firestore/       # repositories: targets, sessions, chargers, cycles, lease, fairness
│   └── tests/contract/      # tests against committed real-response recordings
└── shared/                  # Zod schemas and types crossing the frontend/backend boundary

fixtures/                    # Recorded provider responses + historical PV/charging days (Principle III)
infra/                       # Cloud Scheduler, Cloud Run, Firestore rules/indexes/TTL, alerting policy
.github/workflows/           # typecheck, lint, test, contract tests, deploy via Workload Identity
```

**Structure Decision**: a pnpm workspace with six packages. The split that matters is
`core` versus `adapters`: the constitution's reproducibility requirement (Principle III) and SC-010
are only enforceable if the decision logic physically cannot reach a clock, a random source or a
network — so purity is a package boundary with a lint rule behind it, not a coding convention. The
two services are separate deployables because they have different triggers, different auth and
different failure semantics; merging them would give the public API the optimizer's Firestore
permissions. `apps/web` and `apps/admin` are separate because the constitution defines the admin
view as a distinct desktop-only surface behind different credentials, and shipping the admin bundle
to end users' phones would be both wasteful and an information leak. `shared` exists only to stop
the frontends from redefining types the backend already validates.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| ~~**D1**~~ — **WITHDRAWN 2026-08-14** | Spike O2 disproved its premise: Easee tokens *are* Keycloak-issued RS256 JWTs with a published JWKS, and a real token's signature was verified against it. Local verification is implemented as the constitution requires, so there is no deviation to justify | — |
| **D2** — Static assets are served by Firebase Hosting, not Cloud Storage as the constitution's Technology section specifies | Cloud Storage cannot serve HTTPS on a custom domain without an external HTTP(S) Load Balancer, which has no free tier (~USD 18/month) and would break SC-012 on its own | A bare `storage.googleapis.com` URL over the bucket's default domain has no custom domain and a poor PWA install story. Firebase Hosting is free, already in the same project, and adds no new vendor |
| **D3** — All 30 chargers are polled every cycle, where the constitution says any full sweep "MUST be low-frequency and explicitly budgeted" | The sweep *is* explicitly budgeted: 30 requests against a limit of 100 per rolling 5 minutes (30%). It is the only way to satisfy FR-029 (detect plug-in with no active target) without a paid streaming channel, and `dynamicChargerCurrent` resets on plug-in, so plug-ins must be noticed promptly | A 15-minute sweep would delay plug-in detection by up to three cycles and leave a freshly plugged-in car at a reset current in the meantime. Easee's AMQP stream removes polling entirely but is a paid service; SignalR needs a persistent connection incompatible with `min-instances=0` |

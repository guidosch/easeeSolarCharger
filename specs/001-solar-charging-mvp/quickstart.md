# Quickstart & Validation Guide

**Feature**: `specs/001-solar-charging-mvp` | **Date**: 2026-08-14

How to run the system locally and prove it works end to end without touching a real car. Read
[contracts/](./contracts/) for payload shapes and [data-model.md](./data-model.md) for collection
layouts; this file does not repeat them.

---

## Prerequisites

| Need | Notes |
| --- | --- |
| Node.js 22 LTS, pnpm | one lockfile, committed |
| Java 11+ | required by the Firestore emulator |
| Firebase CLI | `pnpm dlx firebase-tools` — emulator + hosting |
| gcloud CLI | only for deploying; not needed for local validation |
| Easee account | one real account for the hardware test; the emulator path needs none |
| SolarEdge API key + site ID | for the one-off O1 spike only |
| OpenWeatherMap free API key | free plan, no card |

**No test credentials belong in the repo.** Local secrets go in `.env.local`, which is gitignored.
Committing a secret requires rotation, not just removal (Principle V).

---

## Setup

```bash
pnpm install
cp .env.example .env.local          # fill in keys; all optional for the fixture-driven tests
pnpm firebase emulators:start       # Firestore on :8080, UI on :4000
pnpm seed:lots                      # loads fixtures/parking-lots.json into parkingLots
```

`pnpm seed:lots` writes the operator's parking-lot ↔ user mapping. Everything else is created by
the running system — there is no other seed step, because the mapping is the only data the system
does not produce itself.

---

## Running

```bash
pnpm --filter @app/api dev              # user + admin API        → :8081
pnpm --filter @app/optimizer dev        # cycle handler           → :8082
pnpm --filter @app/web dev              # user PWA                → :5173
pnpm --filter @app/admin dev            # admin view              → :5174
```

The optimizer is HTTP-triggered, exactly as Cloud Scheduler triggers it in production — so a cycle
is just a POST:

```bash
curl -X POST localhost:8082/cycle -H 'Content-Type: application/json' \
  -d '{"cycleId":"2026-08-14T14:35:00Z"}'
```

Driving it by hand is deliberate: it means every scenario below is reproducible without waiting five
minutes, and it is the same entry point production uses.

---

## Validation scenarios

Each maps to a user story and is runnable against the emulator with recorded provider responses.
`pnpm replay <fixture>` loads a fixture day into the provider mocks; `pnpm cycle <instant>` runs one
cycle at a simulated time.

### V1 — Deadline met without solar (US1, P1)

```bash
pnpm replay fixtures/days/winter-overcast.json
pnpm cycle 2026-01-15T22:00:00+01:00
```

**Expect**: the target is scheduled; `decisions[].reason` is `deadline_fallback`, `ladderRule: 4`;
the requested kWh is delivered before the deadline. Run the same fixture at `12:00` and `19:00` and
expect `reason: 'high_price_blocked'`, `ladderRule: 3`, `targetCurrentA: 0` — **no grid import in
the high-price windows**.

### V2 — Solar tracking and hysteresis (US2, P2)

```bash
pnpm replay fixtures/days/summer-broken-cloud.json
pnpm replay:all-cycles
```

**Expect**: charging follows the surplus curve; `attribution: 'solar'` while surplus is available;
no charger starts or stops more than once per 15 minutes despite the cloud edges — that is the
deadband and the 2-cycle hysteresis doing their job. Assert the setpoint change count, not just the
final energy: the failure this scenario exists to catch is oscillation, not under-delivery.

### V3 — Stale and missing surplus (US2, FR-016, FR-044)

```bash
pnpm replay fixtures/days/summer-solaredge-outage.json
```

**Expect**: cycles are marked `degraded`; `surplus.quality` goes `fresh → stale → unusable`; once
`unusable`, no decision carries `reason: 'solar_surplus'`, charging continues under the deadline
rule at low price, and **no cycle fails**. A missing reading must never appear as zero surplus.

### V4 — Charge-now override (US4)

```bash
pnpm cycle 2026-06-10T12:15:00+02:00      # inside a high-price window, no surplus
```

Set the override via `PUT /api/chargers/A12/override` first. **Expect**: `reason: 'override'`,
`ladderRule: 2`, charging at `maxCurrentA` despite the high-price window. Then simulate an unplug
(`opMode → 1`) and expect the override cleared automatically without a client call.

### V5 — Fairness and determinism (US5, SC-010)

```bash
pnpm replay fixtures/days/summer-three-competitors.json
pnpm test:determinism
```

**Expect**: surplus is distributed across users over the day rather than concentrated; and every
recorded cycle replays to a byte-identical `decisions` array. `test:determinism` re-runs `decide()`
over every fixture cycle and diffs against the recorded output — this is the SC-010 gate and it must
be green before any optimizer change is merged.

### V6 — DST correctness (FR-025)

```bash
pnpm test:dst
```

Runs cycles across `2026-10-25` (doubled 02:00) and `2027-03-28` (missing 02:00) in Europe/Zurich.
**Expect**: tariff windows apply for the correct wall-clock hours on both days, no deadline is
missed or double-counted, and the winter-window boundary is evaluated in local time. These dates
are the reason `Temporal`/`date-fns-tz` is a dependency instead of manual offset arithmetic.

### V7 — Plug-in resets the setpoint (research R5, FR-028)

```bash
pnpm replay fixtures/days/plug-in-reset.json
```

**Expect**: after a simulated plug-in, `dynamicChargerCurrentA` reads back as `0` while
`commandedCurrentA` is non-zero → `discrepancy: 'lost'`, and the next cycle **re-applies** the
setpoint. This is documented Easee behaviour, not a hypothetical.

### V8 — Single flight (FR-026, Principle V)

```bash
pnpm test:single-flight     # fires two overlapping cycle requests
```

**Expect**: exactly one acquires the lease; the second returns 200 with a `skipped_locked` cycle
record. Returning 200 matters — a non-2xx would make Cloud Scheduler retry and stack further
attempts.

### V9 — Delete my data (US7, FR-048)

```bash
pnpm test:deletion
```

**Expect**: after `DELETE /api/me`, no document in any collection references the `userId`, the
fairness entry is gone, open targets and overrides are cancelled — and `parkingLots` is untouched,
because that is operator data.

### V10 — Write budget (Principle VI, SC-012)

```bash
pnpm replay fixtures/days/summer-busy.json && pnpm report:writes
```

**Expect**: extrapolated writes ≤ 2,000/day against Firestore's 20,000/day free allowance. A busy
day is the right test — the budget in [research.md](./research.md) R8 assumes 15 active chargers,
and this is the scenario that would break it if snapshotting regressed to per-cycle.

---

## Test suites

```bash
pnpm typecheck && pnpm lint      # includes the purity lint over packages/core
pnpm test:unit                   # packages/core — ladder, floor, winter, DST, fairness
pnpm test:contract               # provider clients against committed recordings
pnpm test:integration            # services against the Firestore emulator
pnpm test                        # all of the above — this is what CI runs
```

No test may call a live third-party API. The provider clients are exercised against recordings in
`fixtures/`; refreshing a recording is an explicit, reviewed act.

---

## Hardware validation

The only real hardware is the owner's own parking lot. Any change touching current limits, start or
stop behaviour, or cycle execution must state in its PR how it was validated (constitution,
Development Workflow).

```bash
pnpm cycle:dry-run --lot=<owner-lot>    # computes and prints the decision, writes nothing
```

Sequence: dry-run first and read the decision; then enable the single owner lot; watch
`GET /api/admin/chargers/<lot>/trace` for a full session; only then widen to the other 29 lots.

---

## Deployment

```bash
pnpm build
gcloud run deploy easee-api        --source services/api
gcloud run deploy easee-optimizer  --source services/optimizer
pnpm firebase deploy --only hosting,firestore:rules,firestore:indexes
```

CI does this from `main` via Workload Identity Federation — no service-account key in the repo. What
is in the repository is what runs; there are no manual console steps.

**One-time setup, documented in `infra/README.md`** because there is no ops team to rediscover it:
Cloud Scheduler job (5 min, OIDC, `min-backoff` 60s, retries 0 — a missed cycle is preferable to a
stacked one), Secret Manager entries, the Firestore TTL policies on `expiresAt`, and the log-based
metric plus email alerting policy from [contracts/admin-api.md](./contracts/admin-api.md).

---

## Before writing the first line of production code

Three open items from [research.md](./research.md) are cheap spikes that would each invalidate real
work if left until later:

- **O1** — confirm `currentPowerFlow` returns `LOAD` and `GRID` for this site. If not, the surplus
  formula changes and costs twice the API budget.
- ~~**O2**~~ — **closed 2026-08-14**. Easee tokens are Keycloak-issued RS256 JWTs with a published
  JWKS at `auth.easee.com/realms/easee`; a real token's signature was verified against it. Deviation
  D1 is withdrawn and tokens are verified locally, as the constitution intends.
- **O4** — observe whether `dynamicChargerCurrent` expires on a watchdog timer. If it does, every
  active charger must be rewritten every cycle, which changes the write budget and the Easee call
  budget.

**O3** — confirming the 63 A / 126 A line limits against the installer's documentation — is an
owner action, not a spike.

# Phase 0 Research: Solar-Optimized EV Charging (MVP)

**Feature**: `specs/001-solar-charging-mvp` | **Date**: 2026-08-14

This document resolves every NEEDS CLARIFICATION raised in the plan's Technical Context, plus the
two items the Architecture Inception Canvas explicitly deferred to planning. Findings were taken
from the live provider documentation on 2026-08-14; the URLs are listed under Sources.

---

## R1 — Plug-in and session-end detection

**Decision**: Poll the Easee **observations** endpoint for **all 30 chargers on every 5-minute
cycle**. One request per charger, requesting all needed observation IDs in a single call:

```
GET https://api.easee.com/api/state/{serialNumber}/observations?ids=109,114,120,121,124,48,96,103
```

Plug-in, session start and session end are all derived from transitions of observation **109
(chargerOpMode)**: `0 Offline, 1 Disconnected, 2 AwaitingStart, 3 Charging, 4 Completed, 5 Error,
6 ReadyToCharge`. A transition `1 → {2,3,6}` is a plug-in; a transition `{2,3,4,6} → 1` is an
unplug and therefore a session end.

**Rationale**: the observations endpoint is rate-limited at **100 requests per 5 minutes**
(enforced from 2026-09-01). A full sweep of 30 chargers costs 30 requests per cycle — **30% of the
budget** — leaving room for retries and for the settings writes, which are counted against a
different endpoint limit. Because the limit is a *rolling window* rather than a daily quota, the
canvas's original worry (30 × 1440 calls/day) does not apply: a per-cycle sweep is affordable, and
it removes the need for a separate low-frequency sweep and a separate "is a car plugged in"
mechanism. One uniform polling path is simpler and is the only way FR-029 can be met without a
streaming connection.

**Alternatives considered**:

- **AMQP real-time stream** — Easee's push channel. Rejected: it is a **paid commercial service**
  requiring a quote from `integration@easee.com`, which conflicts directly with the zero-cost
  quality goal (SC-012).
- **SignalR real-time observations** — free, but requires a *persistent* connection. Incompatible
  with a scale-to-zero Cloud Run service driven by Cloud Scheduler; keeping it alive would mean a
  permanently-running instance (min-instances ≥ 1), which leaves the free tier and violates
  Principle V's stateless requirement.
- **Two-tier polling** (active chargers every cycle, all chargers every 15 min) — the canvas's
  suggestion. Rejected as unnecessary complexity (Principle VII) now that the rate limit is known
  to be a rolling window with ample headroom, and it would delay plug-in detection by up to 15
  minutes for no saving that matters.

**Consequence for the plan**: the `GET /api/chargers/{id}/state` endpoint is **deprecated and is
removed on 2026-09-01** — two weeks after this plan is written. The implementation must use the
observations endpoint from the first commit; using `/state` would build on an endpoint that dies
during development.

---

## R2 — Surplus estimation and anti-oscillation

**Decision**: Derive surplus from SolarEdge `currentPowerFlow`, which reports live PV, LOAD and
GRID power together with the flow direction, rather than subtracting two separately-fetched series.

```
GET https://monitoringapi.solaredge.com/site/{siteId}/currentPowerFlow?api_key=...
```

The `connections` array carries the direction. Export is present when a connection has
`to: "GRID"`; import when a connection has `from: "GRID"`.

```
gridExport_kW = connections contains {to: GRID} ?  GRID.currentPower : -GRID.currentPower
ownCharging_kW = Σ observation 120 (totalPower) over chargers this system currently commands
surplusRaw_kW  = gridExport_kW + ownCharging_kW
```

Adding back the system's own charging power is what makes the signal a measure of *available*
surplus rather than *unused* surplus — without it the optimizer would ramp down as soon as it
ramped up. This satisfies FR-015's requirement to exclude self-induced load.

**Smoothing and hysteresis** (FR-017), all parameters in configuration, all recorded in the cycle
decision:

| Rule | Value | Purpose |
| --- | --- | --- |
| Exponential moving average over `surplusRaw` | α = 0.4 (≈3-cycle time constant) | damps heat-pump and house-load spikes |
| Setpoint deadband | ±1 A | a charger's current is only rewritten when the target moves by ≥1 A |
| Start delay | 2 consecutive cycles above the modulation floor | prevents starting on a single spike |
| Stop delay | 2 consecutive cycles below the floor | prevents dropping a session on a passing cloud |
| Staleness cutoff | reading older than 15 min (3 cycles) | beyond this the reading is unusable; the cycle falls back to deadline-only mode (FR-016, FR-044) |

**Power ↔ current conversion** (needed because Easee is commanded in amps and SolarEdge reports
kilowatts), at 400 V three-phase and 230 V single-phase:

```
I(A) = kW × 1000 / (√3 × 400) = kW × 1.443    (three-phase)
I(A) = kW × 1000 / 230        = kW × 4.348    (single-phase)
```

This reproduces the canvas's floor figures exactly: 6 A → 4.16 kW three-phase, 1.38 kW
single-phase. An 11 kW charger corresponds to 16 A three-phase.

**Rationale**: `currentPowerFlow` is a single call that already contains the net grid position,
which is precisely the quantity the optimizer needs, and it costs one request against the SolarEdge
budget instead of two. Deriving surplus from separate production and consumption series would
double the call cost and introduce a timestamp-skew error between the two readings.

**Alternatives considered**:

- **`/site/{id}/overview` or `/powerDetails`** — aggregate energy, not live power; too coarse for a
  5-minute control loop.
- **Modbus/TCP direct to the inverter** — no rate limit and sub-second data, but requires a local
  gateway on-site and a VPN path into GCP. Rejected: it adds hardware and a network dependency to a
  system explicitly designed to be cloud-only.

**Verification note**: `currentPowerFlow` only reports LOAD and GRID when the site has consumption
metering installed. The canvas states site-level metering exists. A one-off spike must confirm the
endpoint returns `LOAD` and `GRID` for this specific site before the surplus formula is built on it
— if it does not, the fallback is `PV.currentPower` minus a consumption series, at twice the call
cost.

---

## R3 — SolarEdge call budget

**Decision**: One `currentPowerFlow` call per cycle, **daylight only** (civil sunrise → sunset,
Europe/Zurich, computed locally from latitude/longitude — no API call), and **skipped entirely
during the winter window**.

**Rationale**: SolarEdge enforces **300 requests/day per account token** and **300/day per site ID
per source IP**, with HTTP 429 beyond that, plus a maximum of 3 concurrent calls per source IP.
Daylight in Zürich never exceeds ~16 hours, so a 5-minute cadence costs at most **192 calls/day**,
leaving ~35% headroom for retries. A round-the-clock 5-minute poll would cost 288 and leave almost
none — this is why the daylight gate is a correctness requirement (FR-045) rather than an
optimization.

---

## R4 — Weather forecast provider and endpoint

**Decision**: OpenWeatherMap **5 day / 3 hour forecast** (`/data/2.5/forecast`), fetched **4× per
day**, using the `clouds.all` percentage per 3-hour block as the proxy for next-day production.

**Rationale**: this endpoint is on the genuinely free plan (60 calls/minute, 1,000,000 calls/month)
and needs no payment method. Four calls per day is 120/month — a rounding error against the quota.
**One Call API 3.0 was rejected**: although its first 1,000 calls/day are free, it is sold as a
"One Call by Call" subscription that requires a card on file, which puts an unbounded cost risk on a
system whose stated goal is to cost nothing (SC-012).

The forecast only drives the binary defer/no-defer decision (FR-022), so a cloud-cover percentage is
sufficient fidelity; a modelled irradiance figure would be more accurate but is a paid product.

**Deferral rule**: defer only when *all three* hold — (a) the deadline is more than 24 h away,
(b) mean daytime cloud cover tomorrow is at least 25 percentage points lower than the remainder of
today, and (c) the target remains reachable under the Principle I ladder if the deferral is taken.
Condition (c) is evaluated by the same reachability function used for FR-036, so a deferral can
never create a shortfall.

---

## R5 — Commanding the chargers

**Decision**: Control charging exclusively through the **`dynamicChargerCurrent`** setting.

```
POST https://api.easee.com/api/chargers/{chargerId}/settings
{ "dynamicChargerCurrent": <amps> }
```

`0` means "do not charge"; any value ≥ 6 A means "charge at this current". Start, stop, throttle and
resume are therefore a single operation with a single failure mode, and the read-back is the same
quantity that was written.

**Rationale**: Easee applies **the lowest applicable current** across circuit-level
(`maxCircuitCurrentP1-P3`), charger-dynamic (`dynamicChargerCurrent`) and charger-static
(`maxChargerCurrent`) limits. `dynamicChargerCurrent` is the level Easee documents as intended for
frequent external load-balancing updates, and writing only at that level means this system
**cannot** raise a limit the existing dynamic load management has lowered — Principle I's
"MUST NOT bypass" requirement is satisfied structurally rather than by convention.

**Three findings that constrain the design**:

1. **`dynamicChargerCurrent` is reset when a car is plugged in or the charger reboots.** The
   optimizer must therefore re-apply the setpoint on every detected plug-in transition and must not
   assume a previously written value survives. This is an additional reason to sweep all chargers
   every cycle (R1).
2. **`POST /settings` is rate-limited to 20 requests per minute.** With the ±1 A deadband, a normal
   cycle writes to only a handful of chargers; a worst-case cycle touching all 30 must spread its
   writes across at least two minutes. The client enforces this with a token-bucket limiter.
3. **"Some cars might get upset if the current is changed too frequently."** A further reason for
   the deadband and the 5-minute cadence — the plan must not shorten either.

**Read-back** (FR-028, Principle I): the next cycle reads observation **114 (outputCurrent)** and
**48 (dynamicChargerCurrent)**. If `48` differs from what was written, the write was lost or reset;
if `48` matches but `114` is materially lower, the external load management is capping the charger.
Both are recorded and shown in the admin view; neither is retried aggressively.

**Alternatives considered**:

- **Basic/weekly charge plans** — Easee recommends schedules because they survive a loss of cloud
  connectivity. Rejected as the primary mechanism: a plan is a fixed time window, but this system's
  decisions change every 5 minutes with the surplus. Worth revisiting later as a *safety net* that
  guarantees a deadline is met if the optimizer is down for hours.
- **Pause/Resume commands** — a second control surface with its own state to reconcile, and it does
  not modulate. Rejected on Principle VII.

---

## R6 — User authentication against Easee

**Decision**: The browser posts Easee credentials to this system's own `POST /api/auth/login`, which
forwards them to `POST https://api.easee.com/api/accounts/login` and returns the resulting
`accessToken` (`expiresIn` 3600 s) and `refreshToken` to the client. On every subsequent request the
backend checks token expiry, and **validates the token against the Easee API**, caching the result
for **5 minutes** keyed by a hash of the token.

**Superseded by the O2 spike — see the findings below.** The paragraph that stood here argued that
Easee published no JWKS and that remote validation therefore had to replace local signature
verification. That premise was wrong. **Tokens are verified locally against the published JWKS**,
and the remote check is not needed at all.

This is recorded as a deviation in the plan's Complexity Tracking, and a spike task must confirm the
absence of a JWKS before the deviation is accepted permanently. Within a cache window of up to 5
minutes a revoked token still works — an accepted consequence for a 15-user private installation.

### R6 spike findings (2026-08-14, task T018 / open item O2) — **RESOLVED: D1 withdrawn**

The claim "Easee publishes no JWKS or OpenID discovery document" is **disproved**. Evidence, all
reproducible with `scripts/spikes/o2_easee_token_issuer.py` and committed under
`fixtures/providers/easee/`:

| Probe | Result |
| --- | --- |
| `api.easee.com/.well-known/*`, `/jwks`, and variants | HTTP 403 `{"message":"Forbidden"}` — but a **control request to a path that certainly does not exist returns the identical body**, so this is AWS API Gateway's catch-all, not evidence of a route. A real route (`/api/chargers`) returns 401. No discovery endpoint exists on this host |
| DNS `auth.easee.com` | `auth.prod.easee.com` → **`keycloak-lb-production-*.elb.amazonaws.com`** — Easee runs Keycloak in production |
| `auth.easee.com/realms/easee/.well-known/openid-configuration` | **HTTP 200**, 7.2 KB. `issuer: https://auth.easee.com/realms/easee` |
| `auth.easee.com/realms/easee/protocol/openid-connect/certs` | **HTTP 200**, 3 keys — an **RS256** signing key, a PS256 signing key, an RSA-OAEP encryption key |
| `auth.easee.com/realms/master/...` | HTTP 200 (the stock Keycloak admin realm; not ours) |

**The link is confirmed.** `POST /api/accounts/login` is a custom .NET service (`x-amzn-remapped-
server: Kestrel`, error shape `{"errorCode":100,"errorCodeName":"InvalidUserPassword"}`) and not a
Keycloak proxy — so its token still had to be checked directly. A real token was decoded and its
signature **verified against the published JWKS**:

| Property | Value |
| --- | --- |
| `header.alg` | `RS256` (asymmetric — a public key suffices) |
| `header.kid` | `eqRJ08F11AB-xAhg6sRmwqHNOw9eKOInbZIZHJjh9W8` — **the `use: sig` RS256 key in the realm JWKS** |
| Signature | **VALID** — RSASSA-PKCS1-v1_5 over a 2048-bit modulus, `e=65537` |
| `iss` | `https://auth.easee.com/realms/easee` |
| `aud` / `azp` | `["account", "easee"]` / `easee` |
| `scope` | `full_access email` |
| Lifetime | `exp - iat` = **60 minutes**, confirming R6's `expiresIn: 3600` |
| Authorization claim | **`UserId`** present — this is the FR-003 key, alongside `AccountId`, `role`, `email`, `email_verified` |

**Decision (replaces the deviation).** The backend verifies the signature and expiry **locally** on
every call against the realm JWKS, exactly as the constitution's Authentication constraint requires:

1. Fetch `https://auth.easee.com/realms/easee/protocol/openid-connect/certs`, cache the keys by
   `kid`, honour the response cache headers, and re-fetch on an unknown `kid` (rate-limited, so a
   forged `kid` cannot become a fetch amplifier).
2. Verify `alg: RS256` **from the JWKS entry, never from the token header** — accepting the token's
   own `alg` is the classic `alg: none` / algorithm-confusion bug.
3. Check `iss === "https://auth.easee.com/realms/easee"`, `exp`, and that `aud` contains `easee`.
4. Authorize `UserId` against `parkingLots` (FR-003).

**Consequences.** Deviation **D1 is withdrawn** from `plan.md`; the constitution's Authentication
constraint needs no amendment. The 5-minute cached remote re-check is **no longer required** —
FR-002's "re-confirm at most once per five minutes" is now a ceiling that local verification
trivially satisfies rather than a network round-trip on the critical path. This removes an Easee
call from every cold request, removes a failure mode from the request path, and closes the
accepted-risk window in which a revoked token still worked.

**Residual risk, unchanged and accepted**: local verification cannot detect a token revoked before
its 60-minute expiry. For a 15-user private installation this is the same trade the constitution
already sanctions.

**Optimizer identity**: a dedicated technical Easee account (Principle V), credentials in Secret
Manager, its `accessToken` refreshed via the refresh-token endpoint and cached in Firestore so that
cold-started instances do not each re-login.

---

## R7 — Single-flight execution and scheduling

**Decision**: Cloud Scheduler invokes the optimizer over HTTP with an OIDC token every 5 minutes.
The handler's first action is a Firestore transaction that acquires a **lease** on `locks/optimizer`
— a document holding `holder`, `acquiredAt` and `expiresAt`. The lease runs for 4 minutes; a cycle
that finds a live lease logs a `cycle_skipped` record and returns 200 immediately.

**Rationale**: a lease rather than a boolean lock means a crashed instance cannot deadlock the
system — the lease simply expires. Returning 200 on a skip prevents Cloud Scheduler from retrying
and stacking further attempts. Firestore transactions give the required atomicity without adding a
second infrastructure primitive (Principle VII, and the constitution's ban on new storage
primitives).

---

## R8 — Free-tier budget verification

**Decision**: Firestore in Native mode with a TTL policy on `expiresAt`; static hosting on
**Firebase Hosting**; both Cloud Run services at `min-instances=0`.

**Write budget** (Principle VI requires this figure in the plan):

| Source | Writes/day | Basis |
| --- | --- | --- |
| Cycle decision records | 288 | one per cycle |
| Charger snapshots (~15 min, active only) | ~960 | 15 active chargers × 4/h × 16 h |
| Charger state-change records | ~150 | plug-in, start, stop, complete transitions |
| Session and target documents | ~60 | create + updates |
| Lease document | 288 | one per cycle |
| **Total** | **~1,750/day** | **~53k/month** |

Firestore's free tier allows **20,000 writes/day**, so the design uses roughly **9%** of it. Reads
are dominated by the optimizer loading 30 charger documents per cycle (~8,600/day) against a 50,000
/day allowance. The one-month TTL keeps stored volume around 60 MB, well inside the 1 GiB
allowance. The figures assume the FR-046 rule holds — writing per charger per cycle instead would
be ~260k writes/month and would blow the tier, exactly as the constitution warns.

**Static hosting deviation**: the constitution specifies Cloud Storage for static assets. Cloud
Storage alone cannot serve HTTPS on a custom domain without an external HTTP(S) Load Balancer, which
has no free tier and costs roughly USD 18/month — it would break SC-012 on its own. Firebase Hosting
provides free managed HTTPS, a CDN, 10 GB storage and 360 MB/day transfer, and is already part of
the Firebase project. Recorded as a deviation in Complexity Tracking.

---

## R9 — Stack versions and libraries

| Choice | Decision | Rationale |
| --- | --- | --- |
| Runtime | Node.js 22 LTS | current active LTS as required by the constitution; supported by Cloud Run |
| Language | TypeScript 5.x, `strict: true`, `noUncheckedIndexedAccess` | Principle VII |
| Boundary validation | Zod | one schema per external payload, satisfying Principle VII's runtime-validation rule; schemas double as the contract-test fixtures' shape |
| Tests | Vitest | one runner for backend and frontend; native TS and fake timers for DST and cadence tests |
| Frontend | Vue 3 + Vite + Pinia, PWA plugin | constitution mandates Vue; Vite gives the static bundle Firebase Hosting serves |
| HTTP server | Hono on Cloud Run | minimal, typed, no framework ceremony for ~15 routes |
| Firestore access | `firebase-admin` | official, works with Application Default Credentials on Cloud Run |
| Package manager | pnpm workspaces, single committed lockfile | constitution requires one manager and one lockfile |
| CI/CD | GitHub Actions + Workload Identity Federation | no long-lived service-account key in the repo; deploy from git only |
| Time zone | `Temporal` via polyfill, or `date-fns-tz` | DST correctness (FR-025) must not rest on manual UTC offsets |

**Randomness and clock** (Principle III): the fairness draw is seeded from the cycle ID, and the
clock is injected into the scheduler as an explicit parameter. Neither `Date.now()` nor
`Math.random()` may appear inside `packages/core`; a lint rule enforces this so that any recorded
cycle replays byte-identically (SC-010).

---

## Open items carried into implementation

| # | Item | Status | Resolution path |
| --- | --- | --- | --- |
| O1 | Confirm `currentPowerFlow` returns `LOAD` and `GRID` for this specific site | **OPEN** — blocked on a SolarEdge API key + site ID | scripted: `python3 scripts/spikes/o1_solaredge_powerflow.py`, one call, **must be run in daylight** |
| O2 | Confirm Easee publishes no JWKS | **CLOSED (2026-08-14)** — a JWKS **does** exist and **does** sign our tokens; signature verified. D1 withdrawn, local verification adopted (see R6 spike findings) | done |
| O3 | Confirm the 63 A / 126 A line limits against the installer's documentation | **OPEN** | owner action, before the per-line headroom check is implemented |
| O4 | Confirm whether `dynamicChargerCurrent` expires on a watchdog timer | **OPEN** — needs Easee credentials and several hours of observation on the owner's lot | scripted: `python3 scripts/spikes/o4_dynamic_current_watchdog.py --hours 6`. If it does expire, every cycle must rewrite every active charger, which changes the write budget in R5/R8 and undermines the deadband |

---

## Sources

- [Easee — Current limits and control](https://developer.easee.com/docs/current-limits-and-control)
- [Easee — Get Observations](https://easee.readme.io/reference/getobservations.md)
- [Easee — Charger Observation IDs](https://easee.readme.io/docs/charger-observation-ids.md)
- [Easee — Charger State (deprecated 2026-09-01)](https://easee.readme.io/reference/getchargerstate.md)
- [Easee — Authenticate](https://easee.readme.io/reference/account_authenticate.md)
- [Easee — Change Charger Settings](https://developer.easee.com/reference/charger_setchargersetting)
- [Easee — Smart Charging](https://developer.easee.com/docs/api-smart-charging)
- [Easee — AMQP service (paid)](https://easee.readme.io/docs/amqp-service.md)
- [Easee — Integrations overview](https://developer.easee.com/docs/integrations)
- [SolarEdge — Monitoring API](https://knowledge-center.solaredge.com/sites/kc/files/se_monitoring_api.pdf)
- [OpenWeatherMap — Pricing and free plan](https://openweathermap.org/price)
- [OpenWeatherMap — One Call API 3.0](https://openweathermap.org/api/one-call-3)

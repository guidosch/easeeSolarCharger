# Contract: External Providers (as consumed)

Each provider is isolated behind one client module in `packages/adapters` exposing an internal
domain model, so `packages/core` never sees a vendor payload (Principle IV). Each client has
contract tests against **committed recordings of real responses** in `fixtures/`; those recordings
are refreshed when a provider contract changes.

Every call: explicit timeout, bounded retry with exponential backoff **and jitter**, `Retry-After`
honoured, budget checked *before* the call is made.

---

## Easee — `packages/adapters/src/easee`

**Base**: `https://api.easee.com`

| Purpose | Call | Limit |
| --- | --- | --- |
| Login | `POST /api/accounts/login` → `{accessToken, refreshToken, expiresIn: 3600}` | — |
| Refresh | `POST /api/accounts/refresh_token` | — |
| **Observations** | `GET /state/{serialNumber}/observations?ids=109,114,120,121,124,48,96,103` (**no `/api` segment** — with one the gateway answers 403) | **100 requests / rolling 5 min** (enforced from 2026-09-01) |
| **Set current** | `POST /api/chargers/{chargerId}/settings` `{ "dynamicChargerCurrent": <A> }` | **20 requests / min** |

**Observation IDs consumed**: `109` chargerOpMode, `114` outputCurrent, `120` totalPower,
`121` sessionEnergy, `124` lifetimeEnergy, `48` dynamicChargerCurrent, `96` reasonForNoCurrent,
`103` cableLocked.

`chargerOpMode`: `0` Offline, `1` Disconnected, `2` AwaitingStart, `3` Charging, `4` Completed,
`5` Error, `6` ReadyToCharge.

**Three behaviours the client must encode, not assume**:

1. **`GET /api/chargers/{id}/state` is removed on 2026-09-01.** Do not use it. All reads go through
   the observations endpoint.
2. **`dynamicChargerCurrent` is reset when a car is plugged in or the charger reboots.** The client
   exposes `wasReset(charger)` and the optimizer re-applies the setpoint on every plug-in
   transition. Never assume a previous write survives.
3. **Easee applies the lowest of circuit-static, charger-dynamic and charger-static limits.** The
   client may write **only** `dynamicChargerCurrent`; writing circuit settings is out of scope and
   would violate Principle I. A code-level guard, not a convention.

**Budget enforcement**: a token-bucket limiter (30 reads/cycle = 30% of the read budget; writes
capped at 20/min and spread across the cycle). Exceeding a budget is an error the client raises
*before* calling, so the cap can never be discovered from a 429.

**Domain model exposed**: `ChargerObservation { opMode, deliveredCurrentA, dynamicCurrentA,
totalPowerKw, sessionEnergyKwh, lifetimeEnergyKwh, reasonForNoCurrent, cableLocked, observedAt }`.

**Fail-safe**: on error or rate-limit, the charger's reading is `stale` for this cycle; the
optimizer keeps the last known state and does not issue a new command to that charger.

---

## SolarEdge — `packages/adapters/src/solaredge`

**Base**: `https://monitoringapi.solaredge.com`

| Purpose | Call | Limit |
| --- | --- | --- |
| Live power flow | `GET /site/{siteId}/currentPowerFlow?api_key=…` | **300/day per token and per site+IP**; max 3 concurrent per IP |

```jsonc
// response shape consumed
{ "siteCurrentPowerFlow": {
    "unit": "kW",
    "connections": [ { "from": "PV", "to": "Load" }, { "from": "LOAD", "to": "Grid" } ],
    "GRID": { "status": "Active", "currentPower": 4.2 },
    "LOAD": { "status": "Active", "currentPower": 3.1 },
    "PV":   { "status": "Active", "currentPower": 7.3 }
} }
```

**Direction is in `connections`, not in the sign of `currentPower`** — a connection with
`to: "GRID"` is export, one with `from: "GRID"` is import. Reading the magnitude without the
direction inverts the surplus signal, which is the single most damaging bug available in this
integration; the contract test asserts both directions.

**Domain model**: `SitePower { gridExportKw, loadKw, pvKw, observedAt }` where `gridExportKw` is
negative on import.

**Budget enforcement**: one call per cycle, **daylight only** (sunrise–sunset Europe/Zurich,
computed locally — no API call), **skipped in the winter window**. Worst case 192 calls/day against
300. The client refuses the call outside the daylight gate.

**Open item O1**: `LOAD` and `GRID` are only present when the site has consumption metering. Confirm
against the live site before the surplus formula is built on it.

**Fail-safe**: on error, 429 or a missing `GRID` element, the previous reading is reused with its
age; past 15 minutes it becomes `unusable` and the optimizer runs deadline-only. Never substitute
zero.

---

## OpenWeatherMap — `packages/adapters/src/openweather`

**Base**: `https://api.openweathermap.org`

| Purpose | Call | Limit |
| --- | --- | --- |
| 5-day / 3-hour forecast | `GET /data/2.5/forecast?lat=…&lon=…&appid=…&units=metric` | free plan: 60/min, 1,000,000/month |

Fetched **4× per day** (FR-045). Consumes `list[].dt` and `list[].clouds.all` for daytime blocks.

**Domain model**: `Forecast { cloudCoverRestOfTodayPct, cloudCoverTomorrowPct, deferRecommended,
fetchedAt }`.

`deferRecommended` is true only when the deadline is >24 h away **and** tomorrow's mean daytime
cloud cover is ≥25 percentage points lower than the rest of today. Reachability is re-checked
afterwards, so a deferral can never create a shortfall.

**Why not One Call 3.0**: its free 1,000 calls/day sit inside a "One Call by Call" subscription that
requires a payment method, putting unbounded cost risk on a system whose goal is to cost nothing
(SC-012).

**Fail-safe**: on error the previous forecast is reused; if none exists, `forecast: null` and
`deferRecommended` is treated as `false` — a missing forecast may never *cause* a deferral.

---

## Contract test obligations

For every client (constitution, Development Workflow — tests must not call live APIs):

| Test | Why |
| --- | --- |
| Happy-path parse of a committed real recording | the payload shape is real, not imagined |
| Malformed / partial payload → typed error, never a silent default | Principle VII |
| 429 with `Retry-After` → honoured, counted, surfaced | Principle IV |
| Timeout → bounded retry with jitter, then typed failure | Principle IV |
| Budget exhausted → refuses to call | budgets are enforced in code, not documented |
| SolarEdge import **and** export directions | inverting the surplus sign is the highest-cost bug here |
| Easee setpoint reset after a simulated plug-in | the documented reset behaviour is handled |

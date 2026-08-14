# Contract: User API (PWA ↔ backend)

**Service**: `services/api` | **Base**: `https://api.<domain>/api`
**Auth**: `Authorization: Bearer <easee access token>` on every route except `POST /auth/login`.

Validation: every request body and every provider response is parsed with a Zod schema at the
boundary (Principle VII). A body failing validation returns `400` with `{ error, details }` and is
never partially applied.

---

## Authentication

### `POST /auth/login`

Proxies the credentials to Easee (`POST https://api.easee.com/api/accounts/login`) and returns the
tokens. The password is never stored or logged.

```jsonc
// request
{ "userName": "user@example.com", "password": "..." }

// 200
{
  "accessToken": "eyJ...",      // opaque to the client; expires in 3600 s
  "refreshToken": "...",
  "expiresIn": 3600,
  "user": { "userId": "12345", "email": "user@example.com" },
  "chargers": [ { "lotNumber": "A12", "chargerId": "EH...", "phases": 3, "maxCurrentA": 16 } ]
}
```

`401` — Easee rejected the credentials.
`403` — authenticated, but no parking lot is mapped to this `userId` (FR-003, US1 scenario 6).
The client shows "no charger is assigned to you" and offers no charging action.

### `POST /auth/refresh`

`{ "refreshToken": "..." }` → the same shape as login. Called by the client when a request returns
`401` with `code: "token_expired"`.

**Validation model**: the API verifies the token **locally** on every call — RS256 signature against
the cached Easee JWKS (`https://auth.easee.com/realms/easee/protocol/openid-connect/certs`), plus
`iss`, `exp` and `aud`. No network call to Easee is on the request path. Authorization uses the
`UserId` claim. See [research.md](../research.md) R6; this replaced the withdrawn deviation D1.

---

## Chargers

### `GET /chargers`

Every charger mapped to the caller. One entry for the common case, several for US8.

```jsonc
[
  {
    "lotNumber": "A12",
    "chargerId": "EH123456",
    "state": "charging_solar",     // idle | waiting_for_car | waiting_for_surplus
                                   // charging_solar | charging_grid | complete | error | offline
    "phases": 3,
    "deliveredCurrentA": 12.0,     // read back from the charger, not the setpoint (FR-028)
    "target": {
      "targetId": "t_01J...",
      "energyKwh": 20,
      "deadline": "2026-08-15T07:00:00+02:00",
      "deliveredKwh": 6.4,
      "remainingKwh": 13.6,
      "solarKwh": 5.1,
      "gridKwh": 1.3,
      "reachability": { "state": "reachable", "expectedShortfallKwh": 0 }
    },
    "override": { "active": false },
    "observedAt": "2026-08-14T14:35:12Z"
  }
]
```

`state` is derived server-side so the two frontends cannot disagree about what "waiting" means.
`waiting_for_surplus` versus `charging_grid` is exactly the distinction FR-035 requires the user to
see.

---

## Targets

### `POST /chargers/{lotNumber}/target`

```jsonc
// request — both values come from sliders (FR-006)
{ "energyKwh": 20, "deadline": "2026-08-15T07:00:00+02:00" }

// 201
{ "targetId": "t_01J...", "reachability": { "state": "reachable", "expectedShortfallKwh": 0 } }

// 201 with a warning — accepted but not achievable (spec edge case, FR-036)
{ "targetId": "t_01J...", "reachability": { "state": "unreachable", "expectedShortfallKwh": 7.2 } }

// 400 — deadline in the past or too soon to deliver any energy (FR-007)
{ "error": "deadline_too_soon", "earliestFeasibleDeadline": "2026-08-14T16:05:00+02:00" }
```

Setting a target where one is already open marks the old one `superseded` in the same transaction
(FR-009). A target set while the car is unplugged is stored and activates on plug-in (FR-010).

**Effective within one cycle**: the response does not mean charging has started — it means the
target is recorded. The next optimizer cycle (≤5 minutes) acts on it (FR-008).

### `DELETE /chargers/{lotNumber}/target`

Cancels the open target. `204`.

---

## Override

### `PUT /chargers/{lotNumber}/override`

```jsonc
{ "active": true }   // → 200 { "active": true, "since": "2026-08-14T14:36:00Z" }
```

Charges at the maximum current the external load management permits, ignoring surplus, tariff and
deadline (FR-032). Cleared automatically at session end (FR-033) — the client must not rely on
being the one to clear it.

---

## Sessions

### `GET /sessions`

The five most recent, newest first (FR-038).

```jsonc
[
  {
    "sessionId": "s_01J...",
    "lotNumber": "A12",
    "startedAt": "2026-08-13T18:02:00Z",
    "endedAt": "2026-08-14T05:41:00Z",
    "energyKwh": 20.0,
    "solarKwh": 14.2,
    "gridKwh": 5.8,
    "targetMet": true,
    "endReason": "target_reached",
    "overrideUsed": false
  }
]
```

---

## Account deletion

### `DELETE /me`

Requires `{ "confirm": "DELETE" }` in the body. Removes the user document, all targets, all
sessions, the fairness ledger entry, and cancels any open target or override on their chargers
(FR-048, US7 scenario 3). Hard delete, no soft flag. `204`.

The `parkingLots` mapping is **not** deleted — it is operator data, not user data, and deleting it
would orphan the charger. The user can sign in again immediately as a fresh user.

---

## Errors

| Status | `code` | Meaning |
| --- | --- | --- |
| 400 | `validation_failed`, `deadline_too_soon` | request rejected, nothing applied |
| 401 | `token_expired`, `token_invalid` | client should refresh or re-login |
| 403 | `no_charger_mapped`, `not_your_charger` | authorization against `parkingLots` failed |
| 429 | `upstream_rate_limited` | Easee rate-limited us; `Retry-After` is passed through |
| 503 | `upstream_unavailable` | a provider is down; charging continues under the fail-safe (FR-044) — this is a *read* failure, not a charging failure, and the UI must say so |

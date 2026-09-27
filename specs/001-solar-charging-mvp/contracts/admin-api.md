# Contract: Admin API (operator view ↔ backend)

**Service**: `services/api`, routes under `/api/admin` | **Auth**: HTTP Basic, single shared
credential from Secret Manager, enforced by separate middleware from the user routes.

The accepted consequence (constitution, Technology & Deployment Constraints) is that admin *reads*
carry no per-admin identity. Charger *commands* remain individually attributed via `cycles` and
`chargerEvents` regardless of who was looking at the screen.

---

## `GET /admin/cycles?limit=50&outcome=`

Recent optimizer cycles, newest first (FR-039).

```jsonc
[
  {
    "cycleId": "2026-08-14T14:35:00Z",
    "outcome": "completed",          // completed | skipped_locked | failed | degraded
    "durationMs": 4210,
    "surplus": { "smoothedKw": 8.4, "rawKw": 9.1, "ageMinutes": 4, "quality": "fresh" },
    "tariffWindow": "low",           // low | high
    "seasonMode": "solar",           // solar | winter
    "chargersActedOn": 3,
    "providerCalls": {
      "easee":      { "calls": 30, "errors": 0, "rateLimited": 0, "budgetRemaining": 70 },
      "solaredge":  { "calls": 1,  "errors": 0, "rateLimited": 0, "budgetRemaining": 163 },
      "openweather":{ "calls": 0,  "errors": 0, "rateLimited": 0, "budgetRemaining": 3 }
    }
  }
]
```

`quality` is `fresh | stale | unusable`. `unusable` (older than 15 minutes) is what forces
deadline-only mode, and seeing it here is how the operator diagnoses "why did nothing charge from
solar this afternoon".

## `GET /admin/cycles/{cycleId}`

The complete record — `inputs`, `decisions`, `readBack`, `correlationId`. This is the payload that
`decide()` must reproduce exactly (SC-010), and the operator can copy it into a regression fixture
directly.

Each decision carries `ladderRule` (1–6), naming **which rule of the Principle I ladder decided the
outcome**. That single field is what turns "why did charger A12 not charge?" into a one-glance
answer (FR-042, SC-009).

## `GET /admin/chargers`

All 30, whether or not they have a target (FR-040).

```jsonc
[
  {
    "lotNumber": "A12", "chargerId": "EH123456", "line": "L1", "phases": 3,
    "opMode": 3, "state": "charging_solar",
    "commandedCurrentA": 12, "deliveredCurrentA": 12, "dynamicChargerCurrentA": 12,
    "discrepancy": "none",           // none | capped | lost
    "target": { "energyKwh": 20, "deadline": "...", "deliveredKwh": 6.4,
                "reachability": { "state": "reachable", "expectedShortfallKwh": 0 } },
    "user": { "userId": "12345", "email": "user@example.com" },
    "observedAt": "2026-08-14T14:35:12Z"
  }
]
```

`discrepancy` is the Principle I read-back reconciliation made visible (FR-028, US6 scenario 3):
`capped` means the external load manager overruled us, `lost` means the setpoint did not stick —
most often because a plug-in reset it (research R5).

Chargers whose `parkingLots` entry has no `easeeUserId` are returned with `user: null` and flagged
`orphaned` (spec edge case).

## `GET /admin/chargers/{lotNumber}/trace?from=&to=`

The decision trail for one charger over a window: every cycle in range with that charger's
`targetCurrentA`, `reason`, `ladderRule`, delivered current and events. This is the FR-042 / SC-009
endpoint.

## `GET /admin/sessions`

The ten most recent charging sessions across all users, newest first. Each entry is the same
`SessionSummary` a user gets from `GET /sessions`, plus `user: { userId, email? }` naming whose
session it was. Served by a collection-group query on `sessions` ordered by `startedAt`.

## `GET /admin/providers`

Rolling 24-hour health per provider (FR-041): call count against budget, error and rate-limit
counts, last error with timestamp and correlation ID, and — for SolarEdge — remaining daily budget
and whether the daylight gate is currently open.

## `GET /admin/health`

```jsonc
{
  "lastCycle": { "cycleId": "...", "outcome": "completed", "ageMinutes": 2 },
  "leaseHeld": false,
  "consecutiveFailures": 0,
  "firestoreWritesToday": 1642,
  "openTargets": 4,
  "unreachableTargets": 1
}
```

`firestoreWritesToday` keeps the Principle VI budget observable rather than assumed — if it drifts
towards 20,000 the design has regressed.

---

## Alerting (FR-043, US6 scenario 4)

Not an API surface, but part of this contract because the operator depends on it. Defined in
`infra/` and documented in the repository, since there is no ops team to rediscover it:

1. Structured error logs carry `severity: ERROR` and `labels.component: optimizer`.
2. A log-based metric counts entries where `outcome IN (failed, skipped_locked)` or
   `severity >= ERROR`.
3. An alerting policy fires on **≥2 occurrences in 15 minutes** and emails the operator.

Two occurrences rather than one, because a single transient provider failure is expected and
already handled by the fail-safe; two consecutive means the fail-safe itself is the steady state.

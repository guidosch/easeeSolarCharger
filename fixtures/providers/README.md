# Provider recordings

Contract tests run against these files and never against a live API (constitution, Development
Workflow & Quality Gates). Refreshing a recording is an explicit, reviewed act.

## Recording format

Files added for the contract tests use an HTTP envelope so a test can replay status, headers and
body exactly as the provider sent them:

```jsonc
{ "status": 429, "headers": { "retry-after": "30" }, "body": { /* … */ } }
```

Files produced by the Phase 0 spikes (`easee/auth-jwks.json`,
`easee/auth-openid-configuration.json`) predate that convention and are stored as bare bodies.

## Provenance — read this before trusting a fixture

| File(s) | Provenance |
| --- | --- |
| `easee/auth-jwks.json`, `easee/auth-openid-configuration.json` | **Live capture**, spike O2, 2026-08-14. Real responses from `auth.easee.com`. |
| `easee/observations-opmode-*.json`, `easee/login-200.json`, `easee/settings-accepted-202.json`, `easee/rate-limited-429.json`, `easee/observations-malformed.json` | **Synthesised from the documented contract**, not captured — see below. |
| `solaredge/*`, `openweather/*` | **Synthesised from the documented contract**, not captured — see below. |

### Why some of these are synthesised

Capturing them needs credentials that are not available in the development environment: an Easee
technical account, a SolarEdge API key and site ID, and an OpenWeatherMap key. The same missing
credentials block spikes **O1** and **O4** (research.md, Open items).

The synthesised files follow the payload shapes in
[`specs/001-solar-charging-mvp/contracts/external-providers.md`](../../specs/001-solar-charging-mvp/contracts/external-providers.md)
and the provider documentation cited in `research.md`. They are enough to pin the *parsing and
failure* behaviour the clients must have, but they are **not** evidence that the shape is right —
which is exactly the assurance the constitution asks recordings to provide.

**Before the hardware rollout** (quickstart.md, "Hardware validation"), each synthesised file must
be replaced with a real capture and the contract tests re-run. `scripts/spikes/` already contains
the capture scripts for SolarEdge (O1) and the Easee watchdog observation (O4).

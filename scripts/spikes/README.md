# Research spikes (T017–T019 / open items O1, O2, O4)

Throwaway diagnostics that answer questions which would otherwise be discovered *after* the code
depending on them is written. They are **zero-dependency Python 3 stdlib** rather than TypeScript so
they run before the pnpm workspace exists. They are not part of the build and not production code.

Node is available via nvm (`nvm use 22` → v22.17.1, matching the Node 22 LTS the plan pins), but
`nvm` is a shell function, so a non-interactive shell sees no `node` on `PATH` unless a version is
activated first.

Secrets come from the environment only — never commit them, and never paste a key into a fixture.

| Spike | Question | Status | Cost |
| --- | --- | --- | --- |
| `o1_solaredge_powerflow.py` | Does `currentPowerFlow` return `LOAD` and `GRID` for this site? | **CLOSED 2026-08-15** — both present, exporting; R2 formula holds, R3 budget unchanged | 1 call of 300/day |
| `o2_easee_token_issuer.py` | Is there a JWKS, and does it sign the tokens we receive? | **CLOSED 2026-08-14** — yes and yes; RS256 signature verified, D1 withdrawn | 1 login |
| `o4_dynamic_current_watchdog.py` | Does `dynamicChargerCurrent` decay on its own? | **OPEN** — needs Easee credentials + several hours on the owner's lot | ~1 call / 5 min |

```bash
# O1 — must be run in DAYLIGHT; at night PV is 0 and the direction check proves nothing
SOLAREDGE_API_KEY=... SOLAREDGE_SITE_ID=... python3 scripts/spikes/o1_solaredge_powerflow.py

# O2 — the unauthenticated half already ran; this closes the remaining half
EASEE_USERNAME=... EASEE_PASSWORD=... python3 scripts/spikes/o2_easee_token_issuer.py

# O4 — owner's own parking lot only; leave a car plugged in and do not touch the cable
EASEE_USERNAME=... EASEE_PASSWORD=... EASEE_CHARGER_ID=EH... EASEE_SERIAL=... \
  python3 scripts/spikes/o4_dynamic_current_watchdog.py --amps 6 --hours 6 --interval 5
```

Each script prints a `VERDICT` block naming which plan artefact changes under each outcome. Record
the result in [`research.md`](../../specs/001-solar-charging-mvp/research.md) — the Open items table
at the bottom is the register.

## Why these three block real work

- **O1** — `packages/core/src/surplus.ts` is built directly on the R2 formula. If `LOAD`/`GRID` are
  absent the fallback costs two calls per cycle, i.e. 384/day against SolarEdge's 300/day limit, so
  the R3 budget and the daylight gate both have to be re-derived.
- **O2** — **answered**: T042 verifies signatures locally against the JWKS, which is
  constitution-compliant, and deviation D1 is withdrawn. The script remains useful as a regression
  check if Easee ever rotates keys or changes issuer.
- **O4** — decides whether the ±1 A deadband is a legitimate optimization or a bug. A watchdog means
  every active charger is rewritten every cycle, changing the R8 Firestore budget and forcing writes
  to spread across ≥2 minutes under Easee's 20/min cap.

# easeeSolarCharger

Optimize self-consumption of solar generated electricity by auto-scheduling 30 Easee charging
stations for EV cars. A user enters a deadline and an amount of kWh to charge by then, and the
system spends the building's own PV surplus on the cars that need it — topping up from the grid only
at low tariff, and never importing during the operator's high-price windows.

- **Specification**: [`specs/001-solar-charging-mvp/`](specs/001-solar-charging-mvp/)
- **Governance**: [`.specify/memory/constitution.md`](.specify/memory/constitution.md)
- **Domain background**: [`Arch-inception-canvas.md`](Arch-inception-canvas.md)

## The shape of it

```
packages/core        PURE. decide(inputs) → setpoints. No clock, no randomness, no I/O.
packages/adapters    All I/O. One client per external system, each with a call budget.
packages/shared      Zod schemas and types crossing the frontend/backend boundary.
services/api         Cloud Run: the user + admin HTTP API.
services/optimizer   Cloud Run: the five-minute cycle, driven by Cloud Scheduler.
apps/web             Vue 3 PWA — the user surface.
apps/admin           Vue 3 SPA — the operator surface, desktop only.
fixtures/            Recorded provider responses and replayable days.
infra/               Cloud Run, Cloud Scheduler, Firestore rules/indexes/TTL, alerting.
```

The split that carries its weight is `core` versus everything else. Every scheduling decision is a
pure function of a recorded input set, which is what makes any past decision replayable — and a lint
rule, not a convention, keeps a clock or a random source out of it.

## Getting started

```bash
rm -rf node_modules apps/*/node_modules packages/*/node_modules services/*/node_modules # clean when coming from lima VM (different arch)
pnpm install                        # corepack enable pnpm if not installed
cp .env.example .env.local          # all values optional for the fixture-driven tests
pnpm emulators                      # Firestore on :8080 (needs Java 11+): pnpm add -Dw firebase-tools if not installed
pnpm seed:lots                      # the operator's parking-lot ↔ user mapping
```

```bash
pnpm --filter @app/api dev          # :8081
pnpm --filter @app/optimizer dev    # :8082
pnpm --filter @app/web dev          # :5173
pnpm --filter @app/admin dev        # :5174
```

The optimizer is HTTP-triggered exactly as Cloud Scheduler triggers it, so a cycle is just a POST:

```bash
curl -X POST localhost:8082/cycle -H 'Content-Type: application/json' \
  -d '{"cycleId":"2026-08-14T14:35:00Z"}'
```

## Checks

```bash
pnpm typecheck && pnpm lint && pnpm format   # includes the purity fence over packages/core
pnpm test                                    # unit, contract and integration
pnpm test:determinism                        # the SC-010 gate — replay every recorded cycle
pnpm report:writes                           # the Principle VI write budget
```

`pnpm test` needs the Firestore emulator for the integration tier; without it those suites skip with
a visible message and the rest still runs. CI always has one.

## Replaying a day

Every validation scenario in
[`quickstart.md`](specs/001-solar-charging-mvp/quickstart.md) is a recorded day run through the real
`decide()`:

```bash
pnpm replay fixtures/days/winter-overcast.json
pnpm cycle 2026-01-15T22:00:00+01:00     # why did each charger do that, at that moment?
```

`pnpm replay` writes its cycles to `fixtures/replays/`, which is the regression corpus.
`pnpm test:determinism` re-runs every one of them and fails on any difference — so a behavioural
change has to be re-recorded deliberately and explained, rather than discovered later.

## Before touching real hardware

The only real hardware is the owner's own parking lot.

```bash
pnpm cycle:dry-run --lot=<owner-lot>    # computes the decision, writes nothing
```

Then enable that single lot, watch `GET /api/admin/chargers/<lot>/trace` for a full session, and
only afterwards widen the mapping to the other 29. See [`infra/README.md`](infra/README.md).

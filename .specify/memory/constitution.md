<!--
Sync Impact Report
==================
Version change: 2.1.0 → 2.2.0 (MINOR)

PROPOSED — not yet adopted. Per the Amendment procedure below, this is adopted when the pull
request carrying it is approved and merged by the owner. It accompanies the first implementation
pull request, as plan.md requires.

Rationale for MINOR: a permitted technology is widened, and no principle is removed, redefined or
reordered. The Principle I precedence ladder is untouched, so this is not MAJOR; but a deployment
serving static assets from Firebase Hosting would not have been compliant with v2.1.0, so it is not
PATCH either.

Modified sections:
- Technology & Deployment Constraints → Frontend: static assets may be served from Firebase Hosting
  as well as Cloud Storage.

Motivation (deviation D2 in specs/001-solar-charging-mvp/plan.md): Cloud Storage cannot serve HTTPS
on a custom domain without an external HTTP(S) Load Balancer. That load balancer has no free tier
and costs roughly USD 18/month — on its own it would break SC-012 ("running the system costs the
operator nothing per month"), which is a stated quality goal of the feature this constitution
governs. Firebase Hosting provides free managed HTTPS, a CDN, 10 GB of storage and 360 MB/day of
transfer, is already part of the same Firebase project that holds Firestore, and adds no new vendor.

Impact on existing specifications, plans and tasks: none beyond removing the recorded deviation.
`specs/001-solar-charging-mvp/plan.md` lists D2 in Complexity Tracking and `research.md` R8 states
the same reasoning; both may drop the "deviation" framing once this is adopted. No work in flight is
invalidated, so no migration steps are required.

Alternative rejected: serving the bundles from the bucket's default `storage.googleapis.com` URL.
It is free, but it has no custom domain and a poor PWA install story for a phone-first application.

--- Previous amendment ---

Version change: 2.0.0 → 2.1.0 (MINOR)

Rationale for MINOR: the optimizer control-loop cadence changes from one minute to five minutes, to
match the SolarEdge ~300 requests/day/site budget. No principle is removed or redefined and the
Principle I precedence ladder is untouched, so this is not MAJOR; but it is a semantic change to a
stated requirement (a one-minute deployment would no longer be compliant), so it is not PATCH.

Modified principles:
- IV. Resilient, Budgeted Integrations — optimizer loop cadence 1 min → 5 min; cadence is now
  explicitly derived from the SolarEdge budget and MUST NOT be shortened without re-deriving it.
  Stale-tolerance reworded: loop and poll now share a cadence, so the surplus reading is normally
  one cycle old, but staleness still arises from failed/rate-limited/skipped/night-time polls.
- V. Stateless, Single-Flight Serverless Units — single-flight window is the cycle interval rather
  than one minute.
- VI. Free-Tier Frugality & Data Minimalism — write-volume rationale restated for the 5-minute
  cadence (~260k writes/month if written per charger per cycle).

Modified sections:
- Technology & Deployment Constraints → Scheduling: five-minute optimizer cycle.

Added / removed sections: none.

Deferred TODOs: none.

Companion change: .specify/Arch-inception-canvas.md updated in the same amendment (stack, API
budget table, staleness note, write-volume figure, glossary "Cycle").

--- Previous amendment ---

Version change: 1.0.0 → 2.0.0 (MAJOR)

Rationale for MAJOR: Principle I is redefined in a backward-incompatible way. v1.0.0 required
driver targets to be met "even when doing so requires grid import at an unfavourable tariff".
The Architecture Inception Canvas establishes the opposite precedence: the ban on grid charging
during high-price windows outranks the deadline. Work built against v1.0.0's ordering is no
longer compliant.

Modified principles:
- I. User Targets Are Authoritative → I. Load-Management Safety & Rule Precedence (NON-NEGOTIABLE)
  (redefined: the precedence ladder is now the authority, and external dynamic load management
  always wins; targets no longer override the tariff policy)
- II. Auditable Charge Decisions → III. Auditable, Reproducible Charge Decisions
  (expanded: per-command audit trail, delivered-current read-back recorded)
- III. Resilient External Integrations → IV. Resilient, Budgeted Integrations
  (expanded: named fail-safe behaviour, per-provider call budgets, stale-tolerance/anti-oscillation)
- IV. Stateless Serverless Units → V. Stateless, Single-Flight Serverless Units
  (expanded: overlapping-run prevention for the one-minute loop; Cloud SQL removed as a store)
- V. Type-Safe Simplicity → VII. Type-Safe Simplicity (renumbered; substance unchanged)

Added sections:
- II. Deadline Commitment Within the Price Policy (successor to v1.0.0's feasibility duty, now
  correctly subordinated to the high-price rule)
- VI. Free-Tier Frugality & Data Minimalism (new: GCP free tier is a stated quality goal with
  hard write-volume and retention consequences)

Removed content:
- Cloud SQL as a permitted persistence option (incompatible with the free-tier constraint)
- Open-ended retention ("long enough to investigate user complaints") replaced by the canvas's
  explicit policy: five sessions user-visible, one month admin monitoring data
- The claim that a schedule may require grid import at an unfavourable tariff

Deferred TODOs: none.

Source of amendment: .specify/Arch-inception-canvas.md
-->

# easeeSolarCharger Constitution

## Core Principles

### I. Load-Management Safety & Rule Precedence (NON-NEGOTIABLE)

This system schedules charging on an installation it does not own and does not control alone. The
existing dynamic load management stays in place; this system MUST NOT bypass, reconfigure, or
destabilise it. Because both act on the same chargers, a setpoint this system writes MAY be
silently overruled — therefore the optimizer MUST read back the actually delivered current and
reconcile against its intent rather than assuming its command took effect.

Every scheduling decision MUST resolve conflicts in exactly this order, highest first:

1. Existing dynamic load management (external, always wins).
2. A user's "charge now" override — overrides everything below, including the high-price rule.
3. No grid charging during high-price windows (11:00–13:00 and 18:00–20:00 Europe/Zurich).
4. The user's deadline must be met (grid top-up permitted during low-price times).
5. Maximize solar self-consumption.
6. Fairness between users competing for the same surplus.

This ladder is the specification of correctness for the optimizer. Code MUST NOT introduce an
implicit rule that reorders it, and any proposed reordering is a constitutional amendment, not an
implementation decision.

Rationale: the ladder encodes a physical safety boundary (the line limits enforced by the external
load manager), then the owner's cost policy, then optimization goals. Reordering it silently is how
a scheduling change turns into a tripped breaker or an expensive high-tariff import.

### II. Deadline Commitment Within the Price Policy

A user target is a pair: an energy amount in kWh and a deadline. Both are user-declared inputs, not
estimates the system may quietly revise. For any schedule it produces, the optimizer MUST be able to
answer, per charger, whether the declared target is still reachable under the Principle I ladder. A
target that has become unreachable MUST be surfaced to the user and to the admin view; the system
MUST NOT silently deliver less than requested.

Reachability is evaluated *within* the price policy, not around it: grid top-up is permitted only
during low-price windows, so a target may legitimately be unreachable. That is a reportable outcome,
not a licence to import during a high-price window. Only an explicit "charge now" override lifts that
constraint, and the override MUST clear itself automatically when the session ends.

Scheduling logic MUST respect the hardware's modulation floor (~6 A, i.e. ~4.1 kW three-phase): while in solar mode the scheduler MUST wait for sufficient surplus rather than
top up from the grid to reach the floor. The deadline fallback still applies once the target is at
risk. During the winter window (1 October – end of February) solar optimization is disabled and
scheduling is purely deadline-driven, but the high-price rule (ladder rule 3) still applies.

All deadlines, price windows, winter-window boundaries, and daylight calculations MUST be evaluated
in Europe/Zurich and MUST remain correct across DST transitions. Storing or comparing these as naive
local timestamps is a defect.

Rationale: users depend on their cars being charged, so unreachability must be visible rather than
discovered at the deadline. But the owner's cost policy is the reason the system exists — honouring a
deadline by importing at peak tariff would defeat it.

### III. Auditable, Reproducible Charge Decisions

Every charger command MUST be logged with who or what triggered it and why. Every optimizer cycle
MUST record a structured entry containing: the decision output (target current or on/off per
charger), the inputs that produced it (surplus estimate with its age, site production and
consumption, tariff window, winter/summer mode, forecast-derived defer decision, per-charger target
and state), the delivered current read back from the previous cycle, the scheduler version, and a
correlation ID linking the decision to the API calls it triggered.

Logs MUST be JSON in Cloud Logging's structured format so they are queryable without reprocessing.
Any past decision MUST be reproducible: given a recorded input set, re-running the scheduler MUST
yield the same output. This forbids hidden non-determinism — wall-clock reads, randomness (including
the fairness draw), and ambient mutable state MUST be injected as explicit, recorded inputs.

Rationale: with no test installation and a noisy site-level surplus signal, recorded inputs are the
only way to answer "why did my car not charge last night?" and the only way to build regression tests
for the optimizer. A weighted-random fairness rule that is not seeded and recorded is not debuggable.

### IV. Resilient, Budgeted Integrations

The Easee API, SolarEdge monitoring API, and OpenWeatherMap MUST all be treated as unreliable,
rate-limited, and metered. Every outbound call MUST have an explicit timeout, bounded retry with
exponential backoff and jitter, and MUST respect documented rate limits and `429`/`Retry-After`
responses.

Call volume is a correctness constraint, not a tuning detail. The polling cadence budget MUST be
honoured and MUST be enforced in code, not merely documented:

- SolarEdge site power: every ~5 minutes, daylight only (Europe/Zurich sunrise–sunset), staying
  inside the ~300 requests/day/site limit; reducible or skippable during the winter window.
- Easee chargers: polled for chargers with an active schedule or running session; any sweep covering
  all 30 chargers MUST be low-frequency and explicitly budgeted.
- OpenWeatherMap: four times per day for the day-ahead forecast.
- Optimizer loop: every 5 minutes, acting on the last known surplus value. The loop cadence is
  derived from the SolarEdge budget above and MUST NOT be shortened without re-deriving that budget.

Because loop and poll share the same cadence, the surplus reading is normally one cycle old but is
never guaranteed fresh — a failed, rate-limited, skipped or night-time poll means the previous value
is reused. The optimizer MUST therefore be stale-tolerant: readings carry an age, that age MUST be
part of the decision, and setpoint changes MUST be damped by an explicit smoothing or hysteresis rule
so a stale value cannot cause oscillation. The surplus formula MUST subtract the system's own charging
power, since only site-level metering exists.

When any provider is unavailable or rate-limited, the system MUST fail safe to charging from the grid
while still respecting the high-price rule. Failure MUST NOT surface as an unhandled exception or an
implicit zero surplus.

Each provider MUST be isolated behind its own client module exposing an internal domain model, so the
scheduler never depends on a vendor payload shape. Each client MUST have contract tests against
recorded real responses, and those fixtures MUST be refreshed when a provider contract changes.

Rationale: the system's correctness depends entirely on third parties it does not control, and one of
them has a daily call quota tight enough that a careless retry loop blinds the optimizer for the rest
of the day.

### V. Stateless, Single-Flight Serverless Units

The deployable unit is a Cloud Run service or function deployed from this repository. Each unit MUST
be stateless: all persistent state lives in Firestore or Cloud Storage, never in instance memory or
local disk across requests. Units MUST tolerate cold starts, concurrent instances, and at-least-once
delivery from Cloud Scheduler or Pub/Sub, so every trigger handler MUST be idempotent for a given
trigger key.

The five-minute optimizer additionally MUST be single-flight: a new cycle MUST NOT begin while the
previous cycle is still running, enforced by a durable lock or lease rather than by assuming the run
finishes within the cycle interval. A skipped cycle MUST be logged.

Configuration and secrets MUST come from environment variables and Secret Manager — Easee
credentials (including the dedicated technical optimizer account), SolarEdge keys, OpenWeatherMap
keys, and the shared admin credential. Committing a secret is a violation that requires rotation, not
just removal. Deployment MUST be reproducible from repository contents alone, with no manual console
steps.

Rationale: Cloud Run can start, stop, and duplicate instances at any moment. Overlapping optimizer
cycles would issue contradictory charger commands and corrupt the fairness accounting that carries
state between cycles.

### VI. Free-Tier Frugality & Data Minimalism

Staying inside the GCP free tier is a hard design constraint, and its main consequence is write
volume. The system MUST NOT persist one record per charger per cycle. Persistence MUST be limited to
state changes plus a periodic snapshot (~15 minutes) per *active* charger, and any feature that
raises steady-state write volume MUST state its projected writes per month in the feature plan.

Retention MUST be explicit in configuration and enforced by automated deletion, never left to a
provider default: users see their last five sessions; admin monitoring data is kept for one month and
then deleted. A logged-in user MUST be able to delete all of their data on the Google Cloud side with
a single action, and that deletion MUST be complete rather than a soft flag.

Only data needed to operate the system is stored. `UserId` from the Easee token is the user reference
key; the system MUST NOT accumulate personal data beyond what the token and the owner-provided
parking-lot mapping supply.

Rationale: cost is a stated quality goal for a single-operator private installation. At 30 chargers
even a five-minute loop writing per charger per cycle is ~260k writes/month for no added insight, so
write discipline and retention are architectural requirements rather than later optimizations.

### VII. Type-Safe Simplicity

Code MUST be TypeScript compiled under `strict` mode; `any` and non-null assertions (`!`) are
permitted only with an inline comment justifying them. All external input — HTTP bodies, Pub/Sub
messages, provider responses, environment variables, JWT claims — MUST be validated at the boundary
with a runtime schema validator, so a static type never asserts more than has been checked.

Solutions MUST start with the simplest structure that satisfies the specification: no added
abstraction layer, queue, cache, or configuration knob without a written justification in the
feature's plan. Fewer, well-named modules are preferred over speculative extensibility (YAGNI).

Rationale: types are the cheapest available check on a system that manipulates numeric current
limits; unvalidated boundaries make those types a false promise. Complexity added ahead of need is
the main source of unreviewable scheduling logic — and there is one developer to review it.

## Technology & Deployment Constraints

- **Frontend**: Vue.js progressive web app, responsive and mobile-first, served as static assets from
  Cloud Storage or Firebase Hosting. The admin view is a separate desktop-only surface; it need not
  be responsive. Firebase Hosting is permitted because Cloud Storage cannot serve HTTPS on a custom
  domain without a load balancer that has no free tier; any *other* static host requires an
  amendment.
- **Backend**: TypeScript on Node.js (current active LTS) running as Cloud Run functions.
  `tsconfig.json` MUST enable `strict`. One package manager and one committed lockfile, used by CI.
- **Storage**: Firebase/Firestore for charger, session, and monitoring data; Cloud Storage for static
  hosting and blobs. Introducing another storage or messaging primitive requires an amendment.
- **Scheduling**: Cloud Scheduler drives the five-minute optimizer cycle (subject to Principle V's
  single-flight rule) and the day-ahead forecast fetches.
- **Deployment**: from this GitHub repository only, via committed build and deploy configuration. No
  configuration drift — what is in the repository is what runs.
- **Authentication**: users log in with their Easee account. The backend MUST verify the JWT
  signature and expiry locally on every call, and MUST re-check the token against the Easee API at
  most once per five minutes per user and always on login. Authorization matches `UserId` from the
  token against the owner-provided parking-lot ↔ user mapping. Admin access uses a single shared
  basic-auth credential; the accepted consequence — no per-admin identity in the audit trail — MUST
  NOT be extended to charger commands, which are always attributed per Principle III.
- **Physical limits**: chargers deliver at most 11 kW; two supply lines of 15 chargers each, 63 A per
  line and 126 A total, enforced externally by the dynamic load manager. Metering is site-level only;
  no submetering separates house load, heat pumps, and chargers.
- **Observability**: structured JSON logging to Cloud Logging (Principle III), plus metrics for cycle
  outcomes and per-provider error and latency rates. A log-based metric and an email alerting policy
  MUST exist for optimizer errors and for cycles that fail or produce no schedule; the configuration
  steps MUST be documented in the repository, since there is no ops team to rediscover them.
- **Out of scope** (adding any of these requires an amendment): billing and per-user cost allocation,
  push or email notification of end users, home battery storage, dynamic hourly tariffs, replacing or
  reconfiguring the existing dynamic load management.

## Development Workflow & Quality Gates

- **Specification first**: features are developed through the Spec Kit flow — specification, then
  plan, then tasks, then implementation. Scheduling and optimization behaviour MUST be written down
  before it is coded.
- **Automated gates**: CI MUST run and pass on every pull request: type check, lint, unit tests, and
  provider contract tests. A red pipeline blocks merge.
- **Required test coverage areas**: the optimizer MUST have unit tests covering the Principle I
  precedence ladder, including the high-price-versus-deadline conflict, the modulation floor, the
  winter window, and DST boundaries; every provider client MUST have contract tests per Principle IV;
  every trigger handler MUST have an idempotency test and the optimizer a single-flight test per
  Principle V. Tests MUST NOT call live third-party APIs.
- **Regression corpus**: recorded real API responses and historical PV and charging data MUST be
  committed as fixtures and used as the regression suite for optimization changes. Any optimizer
  change MUST be run against that corpus, and behavioural differences MUST be explained in the pull
  request rather than accepted silently.
- **Review**: every change reaches `main` via pull request. With a single developer, self-review is
  permitted, but the reviewer role MUST still verify compliance with the Core Principles and reject
  unjustified complexity, unvalidated boundaries, unbudgeted write volume, and unattributed charger
  commands.
- **Hardware-affecting changes**: any change altering current limits, charger start/stop behaviour,
  or cycle execution MUST state in the pull request how it was validated. The only real hardware
  available is the owner's own parking lot; a change MUST be exercised there, or against fixtures,
  before it reaches the other stations.
- **Complexity justification**: deviations from Principle VII MUST be recorded in the feature plan's
  complexity-tracking section with the simpler alternative that was rejected and why.

## Governance

This constitution supersedes other conventions and ad-hoc practices in this repository. Where a tool
default, template, or habit conflicts with a principle here, this document wins. The Architecture
Inception Canvas (`.specify/Arch-inception-canvas.md`) is the source of the domain decisions encoded
above; if the two diverge, this constitution governs implementation and the divergence MUST be
resolved by amending one of them.

**Amendment procedure**: amendments are proposed as a pull request that edits this file, states the
motivation, and lists the impact on existing specifications, plans, and tasks. An amendment is
adopted when that pull request is approved and merged by the owner. If an amendment invalidates work
already in flight, the pull request MUST include the migration steps for that work.

**Versioning policy**: semantic versioning. MAJOR for backward-incompatible governance changes —
removing or redefining a principle in a way that invalidates existing compliance, including any
reordering of the Principle I precedence ladder. MINOR for a new principle or section, or materially
expanded requirements. PATCH for clarifications, wording, and non-semantic refinements. Every merged
amendment MUST update the version and the Last Amended date below.

**Compliance review**: pull request review is the primary compliance gate (see Development Workflow &
Quality Gates). Additionally, the principles here are the checklist used by `/speckit-analyze` and by
plan-time constitution checks; a plan that cannot show compliance MUST be revised before
implementation begins.

**Version**: 2.2.0 | **Ratified**: 2026-08-14 | **Last Amended**: 2026-08-15

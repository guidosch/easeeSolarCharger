<!--
Sync Impact Report
==================
Version change: none (unfilled template) → 1.0.0

Modified principles:
- [PRINCIPLE_1_NAME] (placeholder) → I. User Targets Are Authoritative
- [PRINCIPLE_2_NAME] (placeholder) → II. Auditable Charge Decisions
- [PRINCIPLE_3_NAME] (placeholder) → III. Resilient External Integrations
- [PRINCIPLE_4_NAME] (placeholder) → IV. Stateless Serverless Units
- [PRINCIPLE_5_NAME] (placeholder) → V. Type-Safe Simplicity

Added sections:
- Technology & Deployment Constraints (was [SECTION_2_NAME])
- Development Workflow & Quality Gates (was [SECTION_3_NAME])
- Governance (rules filled in)

Removed sections: none

Deferred TODOs:
- None. Ratification date set to the date of initial project adoption (2026-08-14).
-->

# easeeSolarCharger Constitution

## Core Principles

### I. User Targets Are Authoritative

Driver-declared targets — departure deadline and minimum state of charge — MUST be met even when
doing so requires grid import at an unfavourable tariff. Optimization for solar self-consumption is
a secondary objective that MUST only reorder or reshape charging within the feasible region defined
by those targets. Every scheduling algorithm MUST be able to answer, for any produced schedule,
whether each declared target is still reachable; a schedule that cannot meet a target MUST surface
that fact rather than silently degrade.

Rationale: the system serves 30 stations whose users depend on their cars being charged. A cost- or
PV-optimal schedule that leaves a driver stranded is a defect, not a trade-off.

### II. Auditable Charge Decisions

Every charge decision MUST be recorded as a structured log entry containing: the decision output
(target current or on/off per charger), the decision inputs that produced it (PV production, site
load, tariff window, per-car target and current state), the scheduler version, and a correlation ID
linking the decision to the API calls it triggered. Logs MUST be JSON in Cloud Logging's structured
format so they are queryable in BigQuery/Log Explorer without reprocessing. Any past decision MUST
be reproducible: given a recorded input set, re-running the scheduler MUST yield the same output.
This forbids hidden non-determinism — wall-clock reads, randomness, and ambient mutable state MUST
be injected as explicit inputs.

Rationale: charging behaviour is judged after the fact by users and by the site operator ("why did
my car not charge last night?"). Without recorded inputs, such questions are unanswerable and bugs
in the optimizer are undiagnosable.

### III. Resilient External Integrations

The Easee cloud API, PV/inverter telemetry, weather forecasts, and tariff sources MUST all be
treated as unreliable and rate-limited. Every outbound call MUST have an explicit timeout, bounded
retry with exponential backoff and jitter, and MUST respect documented rate limits and `429`/
`Retry-After` responses. Integration code MUST be isolated behind a per-provider client module so
that the scheduler depends on an internal domain model, never on a vendor payload shape. Each client
MUST have contract tests exercised against recorded real responses (fixtures), and those fixtures
MUST be refreshed when a provider contract changes. Stale or missing external data MUST resolve to
an explicit, documented fallback behaviour — never to an unhandled exception or an implicit zero.

Rationale: the system's correctness depends entirely on third-party services it does not control.
Untimed, unbounded, or vendor-coupled calls turn a transient provider outage into a site-wide
charging failure.

### IV. Stateless Serverless Units

The deployable unit is a Cloud Run service or function deployed from this repository. Each unit MUST
be stateless: all persistent state lives in managed Google Cloud services (Firestore, Cloud SQL, or
Cloud Storage), never in instance memory or local disk across requests. Units MUST tolerate cold
starts, concurrent instances, and at-least-once delivery from Cloud Scheduler or Pub/Sub — therefore
every scheduling trigger handler MUST be idempotent for a given trigger key. Configuration and
secrets MUST come from environment variables and Secret Manager; secrets MUST NOT be committed to
this repository. Deployment MUST be reproducible from repository contents alone, with no manual
console steps.

Rationale: Cloud Run can start, stop, and duplicate instances at any moment. Code that assumes a
single long-lived process will double-charge, lose state, or drift from what the repository says is
deployed.

### V. Type-Safe Simplicity

Code MUST be TypeScript compiled under `strict` mode; `any` and non-null assertions (`!`) are
permitted only with an inline comment justifying them. All external input — HTTP bodies, Pub/Sub
messages, provider responses, environment variables — MUST be validated at the boundary with a
runtime schema validator, so that a static type never asserts more than has been checked. Solutions
MUST start with the simplest structure that satisfies the specification: no added abstraction layer,
queue, cache, or configuration knob without a written justification in the feature's plan. Fewer,
well-named modules are preferred over speculative extensibility (YAGNI).

Rationale: types are the cheapest available check on a system that manipulates numeric power limits;
unvalidated boundaries make those types a false promise. Complexity added ahead of need is the main
source of unreviewable scheduling logic.

## Technology & Deployment Constraints

- **Language and runtime**: TypeScript on Node.js (current active LTS). `tsconfig.json` MUST enable
  `strict`. A single package manager and lockfile MUST be committed and used by CI.
- **Platform**: Google Cloud. Compute is Cloud Run (services and functions). Time-based triggers use
  Cloud Scheduler; asynchronous work uses Pub/Sub. Introducing a different compute or messaging
  primitive requires an amendment to this section.
- **Deployment**: from this repository only, via committed build and deploy configuration
  (Dockerfile or buildpacks plus a declarative service definition). No configuration drift: what is
  in the repository is what runs.
- **Secrets and credentials**: Easee API credentials, PV endpoint keys, and tariff API keys MUST be
  stored in Secret Manager and injected at runtime. Committing a credential is a constitutional
  violation and requires rotation, not just removal.
- **Observability stack**: structured JSON logging to Cloud Logging (Principle II), plus metrics for
  scheduler run outcomes and per-provider error and latency rates. Alerting MUST exist for scheduler
  runs that fail or produce no schedule.
- **Data retention**: recorded decision inputs and outputs MUST be retained long enough to
  investigate user complaints; the retention period MUST be stated explicitly in configuration, not
  left to a provider default.

## Development Workflow & Quality Gates

- **Specification first**: features are developed through the Spec Kit flow — specification, then
  plan, then tasks, then implementation. Scheduling and optimization logic MUST have its intended
  behaviour written down before it is coded.
- **Automated gates**: CI MUST run, and MUST pass, on every pull request: type check, lint, unit
  tests, and provider contract tests. A red pipeline blocks merge.
- **Required test coverage areas**: scheduling/optimization logic MUST have unit tests covering the
  target-feasibility boundary cases from Principle I; every external provider client MUST have
  contract tests per Principle III; every trigger handler MUST have an idempotency test per
  Principle IV. Tests MUST NOT call live third-party APIs.
- **Review**: every change reaches `main` via pull request. Reviewers MUST verify compliance with
  the Core Principles and MUST reject unjustified complexity, unvalidated boundaries, and
  unstructured logging of charge decisions.
- **Hardware-affecting changes**: any change altering current limits, charger start/stop behaviour,
  or schedule execution MUST state in the pull request description how it was validated before
  reaching production stations.
- **Complexity justification**: deviations from Principle V MUST be recorded in the feature plan's
  complexity-tracking section with the simpler alternative that was rejected and why.

## Governance

This constitution supersedes other conventions and ad-hoc practices in this repository. Where a
tool default, template, or habit conflicts with a principle here, this document wins.

**Amendment procedure**: amendments are proposed as a pull request that edits this file, states the
motivation, and lists the impact on existing specifications, plans, and tasks. An amendment is
adopted when that pull request is approved and merged. If an amendment invalidates work already in
flight, the pull request MUST include the migration steps for that work.

**Versioning policy**: this constitution uses semantic versioning. MAJOR for backward-incompatible
governance changes — removing or redefining a principle in a way that invalidates existing
compliance. MINOR for a new principle or section, or materially expanded requirements. PATCH for
clarifications, wording, and non-semantic refinements. Every merged amendment MUST update the
version and the Last Amended date below.

**Compliance review**: pull request review is the primary compliance gate (see Development Workflow
& Quality Gates). Additionally, the principles here are the checklist used by `/speckit-analyze` and
by plan-time constitution checks; a plan that cannot show compliance MUST be revised before
implementation begins.

**Version**: 1.0.0 | **Ratified**: 2026-08-14 | **Last Amended**: 2026-08-14

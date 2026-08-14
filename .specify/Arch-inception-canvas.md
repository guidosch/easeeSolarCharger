# Architecture Inception Canvas

## Business Case

Optimize self-consumption of the electricity produced by our own PV installation on the roof.

A web app that allows users to set an end time by which their car should be fully charged. The system automatically optimizes for using as much solar power as possible. When no solar power is available, it charges with grid power.

## Business Context

- We have 30 charging stations for EV cars; around 15 owners already have an EV.
- From spring to autumn we normally have around 200 kWh left every day that we feed into the grid.
- Our current price plan from the local electricity provider has two price tiers:
  - **High price:** 11:00–13:00 and 18:00–20:00
  - **Low price:** all other times

### Stakeholders

| Role | Who | Interest |
| --- | --- | --- |
| Owner / product decisions / admin | Guido Schnider | Signs off on scope and behaviour; operates the system |
| End users | ~15 EV owners in the building (growing towards 30) | Car charged by the deadline, as much solar as possible |
| Building / installation | existing dynamic load management (not owned by this system) | Must not be bypassed or destabilised |

## Functional Overview

### Authentication

- App access is protected by a login. Users can access their own charger only after login.
- Users log in with their Easee account.

### Charging

- Allow the user to set a time in the future by which the car should be fully charged and the amount of energy needed in kWh. Both are entered with a slider for ease of use.
- When the deadline cannot be met with solar alone, charge from the grid during low-price times.
- Show whether the car is currently charging, and whether it is charging with solar or with grid power.
- When charging is done, show a summary of how much was charged with solar power and how much from the grid.
- Keep the last five charging sessions in a history.
- Provide a **"charge now"** override mode that ignores the optimization.
- Provide a **delete-my-data** button that removes all data of the logged-in user from the Google Cloud side.

### Multiple chargers

- Users with multiple chargers in their account should be able to set multiple end times.
- Chargers are identified by their parking lot number.
- The default is one charger per user; multiple chargers is an edge case.

### Admin view

- Detailed view to track and monitor whether everything works as expected.
- Desktop layout is sufficient; does not have to be responsive.

## Optimization Policy

- Charge from surplus solar power whenever possible; the target is to reach the requested kWh by the requested deadline.
- **High-price windows (11:00–13:00, 18:00–20:00):** charge only if surplus solar power is available. Never draw from the grid in these windows.
- **Deadline fallback:** if the deadline cannot be reached from solar alone, top up from the grid during low-price times.
- **Below minimum modulation:** Easee cannot modulate below ~6 A (~1.4 kW single-phase / ~4.1 kW three-phase). While in solar mode, wait until enough surplus is available rather than topping up from the grid. (The deadline fallback above still applies once the schedule is at risk.)
- **Fairness:** when several users compete for the same surplus, assign the next charger randomly, but weighted by how much each user has already received — round-robin with memory. Available power may also be split (e.g. half output to two cars) instead of serving only one.
- **Winter window (1 October – end of February):** no solar optimization. Charging is purely deadline-driven and ignores solar, but the high-price avoidance rule still applies.
- **Day-ahead weather forecast:** used to decide whether charging can be deferred to the next day.
- **"Charge now" override:** ignores the solar optimization *and* the high-price rule. It is switched off automatically when the session ends.

### Rule precedence (highest first)

1. Existing dynamic load management (external, always wins).
2. "Charge now" user override — overrides everything below, including the high-price rule.
3. No grid charging during high-price windows.
4. Deadline must be met (grid top-up at low price).
5. Maximize solar self-consumption.
6. Fairness between users.

## Quality Goals

1. **Usability** — ease of use for end users.
2. **Observability** — a detailed admin view to track and monitor whether everything works as expected.
3. **Cost** — stay within the GCP free tier.

## Organisational Constraints

- Single developer / operator; no separate ops team.
- No dedicated test installation — the owner's own parking lot is the only real hardware available for testing.

## Technical Constraints

### Stack

- Vue.js web app, responsive design (mobile first).
- Google Cloud Run functions with TypeScript on Node.js.
- Google Cloud Firebase for storage.
- Google Cloud buckets for static web page hosting.
- Deploy everything from the git repo.
- A system cloud function scheduled to run regularly (every 5 minutes) that performs all optimization and assigns / connects / disconnects chargers.
- Passwords and API tokens are stored in Google Secret Manager.
- Code is stored on GitHub, in the repository where this file lives.

### External APIs

| Purpose | Source |
| --- | --- |
| Easee chargers | https://developer.easee.com/docs/integrations |
| PV installation (SolarEdge monitoring API) | https://knowledge-center.solaredge.com/sites/kc/files/se_monitoring_api.pdf |
| Weather forecast (for Zürich) | https://api.openweathermap.org |

### API budget & polling cadence

The SolarEdge monitoring API allows only ~300 requests per day per site. The control loop cadence is chosen to match that budget: at 5 minutes, daylight only, the loop can read the site power once per cycle and still stay inside the limit.

| Source | Cadence | Rationale |
| --- | --- | --- |
| SolarEdge site power | every **5 min**, **daylight only** (sunrise–sunset, Europe/Zurich) | 288 calls/day worst case, inside the ~300/day limit; no production at night |
| Easee chargers | only for chargers with an **active schedule or running session** | avoids 30 × 1440 calls/day |
| OpenWeatherMap | four times per day (day-ahead forecast) | forecast only changes the defer/no-defer decision, but a stale morning forecast would strand a deferred target; four refreshes keep the decision current at negligible call cost |
| Optimizer loop | every **5 min** | matches the SolarEdge cadence; fast enough for the optimization cycle, and slow enough to stay inside the API budget |

- The control loop and the SolarEdge poll run at the same 5-minute cadence, so the surplus value is normally at most one cycle old. It is not guaranteed fresh: a failed, rate-limited or skipped poll means the previous value is reused. The optimizer must therefore treat the surplus reading as stale-tolerant (carrying its age) and avoid rapid setpoint oscillation.
- During the winter window no solar optimization happens, so SolarEdge polling can be reduced or skipped entirely from 1 October to the end of February.

### Physical constraints

- Chargers have a maximum output of 11 kW.
- A **dynamic load management system is already installed and stays in place.** This system will not replace it. Two lines with 15 chargers each, max 63 A per line, max 126 A in total. The owner will provide a list of all parking lots with their charger and their line assignment.
- PV power is measured **per site only.** There is **no** meter separating house load, heat pumps and chargers, so surplus has to be derived from site-level production and consumption figures.

## Non-Functional Requirements

- **Failure mode:** if Easee, SolarEdge or OpenWeatherMap is unavailable or rate-limited, fail safe to "charge from grid" (respecting the high-price rule).
- **Cost:** stay inside the GCP free tier. Delete old data; keep only recent data.
- **Idempotency:** the scheduled function must not start a new run while the previous one is still working.
- **Time zone:** all deadlines and price windows are evaluated in Europe/Zurich, including DST transitions.

## Data & Privacy

- The Easee token provides the user identity:
  ```json
  { "UserId": "12345", "email": "test@gmail.com" }
  ```
  `UserId` is the reference key for the user. The rest of the data model will evolve during implementation and testing.
- **Write volume:** do not persist one record per charger per cycle. At a 5-minute cadence that is 30 × 288 ≈ 8,600 writes/day (~260k/month) for no added insight, a large share of the Firestore free tier before sessions and state changes are counted. Persist **state changes** plus a **periodic snapshot (~15 min)** per active charger.
- **Retention:** users see their last five sessions; admin monitoring data is kept for one month, then deleted.
- **Deletion:** a user can delete all of their data on the Google Cloud side with a single button.

## Security

- **User authentication:** login with the Easee account. The backend verifies the JWT signature and expiry locally on every call, and re-checks the token against the Easee API at most once every 5 minutes per user (and always on login).
- **Authorization:** `UserId` from the token is matched against the owner-provided parking lot ↔ user mapping.
- **Optimizer identity:** a dedicated technical Easee account is used by the scheduled optimizer, since it must act while no user is logged in. Its credentials live in Secret Manager and are rotated manually by the owner.
- **Admin access:** a single shared basic-auth credential to start with. Accepted consequence: no per-admin identity in the audit trail.

## Architecture Hypotheses

- Progressive web app for the user-facing page, with a Cloud Run function backend.
- A second function with a UI for admin purposes, protected by basic auth login. Desktop layout only.
- Data stored per charger in a Firebase database.
- Detailed information about each charging process is also stored in Firebase, so that an admin can monitor whether everything works as expected.
- Authorization is backed by an owner-provided mapping of chargers to users (parking lot ↔ user).

## Operations

- **Alerting:** the optimizer writes structured errors to Cloud Logging. The spec must document how to configure a log-based metric plus an email alerting policy in GCP for those errors.
- **Audit trail:** every charger command is logged with who/what triggered it and why.
- **Environments:** no separate test installation. The owner's own parking lot is used for real-hardware testing; everything else is covered by tests against mocked Easee and SolarEdge responses.
- **Test data:** capture real API responses and historical PV/charging data and build regression tests for the optimization algorithm on top of them.

## Technical Challenges & Risks

- Users log in only with their Easee account. The Easee token is reused to authenticate against the cloud functions (re-checked by calling the Easee API). The user ID from the token is the user reference.
- Some users have multiple chargers, so a user must be able to own several chargers.
- Surplus has to be inferred from site-level metering only, with heat pumps and house load in the same measurement — the surplus signal will be noisy and the optimizer must tolerate that.
- This system and the existing dynamic load management both act on the same chargers; commands may be silently overruled. The optimizer must read back the actually delivered current instead of assuming its setpoint took effect.

## Out of Scope

- Billing and cost allocation per user.
- Push notifications / email to end users.
- Home battery storage.
- Dynamic (hourly) electricity tariffs.
- Replacing or reconfiguring the existing dynamic load management.

## Glossary

| Term | Meaning |
| --- | --- |
| **Surplus** | PV production minus site consumption, i.e. the power that would otherwise be exported to the grid. |
| **Session** | One charging process, from plug-in (or first energy delivered) until the requested kWh is reached or the car is unplugged. |
| **Cycle** | One run of the scheduled optimizer function (every 5 minutes). |
| **Parking lot number** | The physical identifier of a charger; used as the user-facing charger name. |
| **Line** | One of the two 63 A supply lines, each serving 15 chargers. |
| **High-price window** | 11:00–13:00 and 18:00–20:00 Europe/Zurich. |
| **Winter window** | 1 October – end of February; no solar optimization. |

## To Settle During Planning

All inception-level questions are answered. Two design details follow from the answers above and belong in the plan phase, not here:

1. **Plug-in and session-end detection.** Chargers are only polled while a schedule or session is active, but the system still has to notice a car being plugged in when nothing is scheduled, and has to detect session end to auto-clear the "charge now" override. Options to evaluate against the Easee docs: a low-frequency sweep of all chargers (e.g. every 15 min) versus Easee's real-time observation/streaming API, which would remove the need for polling here.
2. **Surplus estimation from site-level metering.** With no submetering, surplus = site production − site consumption, where consumption includes the heat pumps and the chargers themselves. The plan needs an explicit formula that subtracts the system's own charging power, plus a smoothing/hysteresis rule so a stale reading does not cause setpoint oscillation.

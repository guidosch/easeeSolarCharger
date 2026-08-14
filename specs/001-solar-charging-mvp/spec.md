# Feature Specification: Solar-Optimized EV Charging (MVP)

**Feature Branch**: `main` (no branch created — no `before_specify` hook configured)

**Feature Directory**: `specs/001-solar-charging-mvp`

**Created**: 2026-08-14

**Status**: Draft

**Input**: User description: "Full MVP in one spec — the complete scope of the Architecture Inception Canvas: EV owners in a 30-charger building set a deadline and an energy amount, and the system charges their cars using as much of the building's own PV surplus as possible, avoids grid import during high-price windows, meets deadlines from cheap grid power when solar is not enough, and gives the operator a monitoring view."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Get my car charged by a deadline (Priority: P1)

An EV owner opens the app on their phone, signs in with their charging-account credentials, sees the charger belonging to their parking lot, and sets two things with sliders: how much energy the car needs (kWh) and the time by which it must be ready. The system takes over from there and delivers the requested energy by the deadline, never importing from the grid during the operator's high-price windows.

**Why this priority**: This is the whole promise of the product from the user's side. Without it there is no product. It is also viable on its own: deadline-driven charging that ignores solar entirely is exactly the behaviour the system must exhibit during the winter window, so this slice ships as a complete, useful system.

**Independent Test**: Sign in as a user with a mapped parking lot, set a target of e.g. 20 kWh by 07:00 tomorrow, and verify that charging is scheduled and executed outside the high-price windows and that the requested energy is delivered before the deadline. No solar data is required for this test.

**Acceptance Scenarios**:

1. **Given** a signed-in user whose charger is idle and whose car is plugged in, **When** they set 20 kWh by 07:00 tomorrow, **Then** the target is stored and the app confirms the deadline is reachable.
2. **Given** an active target with a deadline at 07:00, **When** the current time falls inside a high-price window (11:00–13:00 or 18:00–20:00 Europe/Zurich) and no surplus is available, **Then** the system does not draw grid power for that charger.
3. **Given** an active target that can still be met later at low price, **When** a low-price period begins and the target is at risk, **Then** the system starts charging from the grid and the app shows the car as charging from grid.
4. **Given** an active target, **When** the requested kWh has been delivered, **Then** the system stops requesting charge for that charger and marks the session complete.
5. **Given** an active target, **When** the remaining time and available charging power make the requested kWh unreachable under the price policy, **Then** the app shows the user that the target cannot be met and by how much it is expected to fall short, rather than silently under-delivering.
6. **Given** a user who is not mapped to any parking lot, **When** they sign in, **Then** they are told no charger is assigned to them and can perform no charging actions.
7. **Given** a signed-out visitor, **When** they open any charger view or attempt any charging action, **Then** access is refused.

---

### User Story 2 - Charge from the building's own solar surplus (Priority: P2)

Instead of taking whatever power is cheapest, the system watches how much PV power the building is producing beyond its own consumption and preferentially spends that surplus on the cars that have an open target — deferring grid charging for as long as the deadline allows, including deferring to the next day when the weather forecast says tomorrow will be sunnier.

**Why this priority**: This is the business case — roughly 200 kWh/day is currently exported instead of used. It layers on top of P1 without changing its contract: the deadline guarantee and the price policy stay exactly as specified in P1.

**Independent Test**: With P1 in place, replay a day of recorded site production and consumption values against a set of open targets and verify that charging follows the surplus curve, that grid charging only occurs when the deadline is at risk, and that the delivered energy is attributed to solar vs grid.

**Acceptance Scenarios**:

1. **Given** an open target and a surplus above the charger's minimum modulation level, **When** an optimization cycle runs, **Then** the charger is set to a current that consumes the available surplus and the app shows the car as charging from solar.
2. **Given** an open target and a surplus below the minimum modulation level, **When** an optimization cycle runs and the deadline is not yet at risk, **Then** the system waits rather than topping up from the grid.
3. **Given** an open target during a high-price window, **When** surplus is available, **Then** the system charges from that surplus (the high-price rule bans grid import, not solar use).
4. **Given** the latest surplus reading is stale because the production reading failed or was skipped, **When** a cycle runs, **Then** the decision accounts for the reading's age and the resulting setpoint does not oscillate between cycles.
5. **Given** a target whose deadline is more than a day away, **When** the day-ahead forecast predicts substantially more production tomorrow than today, **Then** the system may defer charging to the next day while still keeping the target reachable.
6. **Given** the date falls in the winter window (1 October – end of February), **When** cycles run, **Then** no solar optimization is attempted, scheduling is purely deadline-driven, and the high-price rule still applies.
7. **Given** any production, charger or forecast data source is unavailable or rate-limited, **When** a cycle runs, **Then** the system falls back to grid charging within the price policy and records the degraded condition, rather than assuming zero surplus or failing the cycle.

---

### User Story 3 - See what my car is doing and what it did (Priority: P3)

A user opens the app during or after a charging session and sees whether the car is charging right now and from which source, how much of the target is already delivered, and — once the session is over — a summary splitting the delivered energy into solar and grid. The last five sessions remain available.

**Why this priority**: Solar optimization is invisible without it; users cannot trust a system that never tells them what it did. It is not P1 because charging works without it.

**Independent Test**: Run a session to completion and verify the live view during the session and the summary and history entries after it, including the solar/grid split.

**Acceptance Scenarios**:

1. **Given** a running session, **When** the user opens the app, **Then** they see charging state (idle, waiting for surplus, charging from solar, charging from grid), energy delivered so far, and remaining energy to reach the target.
2. **Given** a session that has just ended, **When** the user opens the app, **Then** they see a summary with total energy delivered, the split between solar and grid, and whether the target was met.
3. **Given** a user with six or more completed sessions, **When** they open the history, **Then** exactly the five most recent are shown and older ones are no longer retained.
4. **Given** a session where the car was unplugged before the target was reached, **When** the session summary is shown, **Then** it is marked as ended early with the energy actually delivered.

---

### User Story 4 - Charge now, ignore the optimization (Priority: P4)

A user in a hurry presses "charge now". The car charges immediately at full available power, regardless of surplus, price window, or deadline. The override switches itself off when the session ends.

**Why this priority**: The escape hatch that makes the optimization socially acceptable — but it only matters once the optimization exists and can get in someone's way.

**Independent Test**: Activate the override during a high-price window with no surplus and verify charging starts immediately and that the override is cleared automatically at session end.

**Acceptance Scenarios**:

1. **Given** a charger with no surplus available during a high-price window, **When** the user activates "charge now", **Then** charging starts immediately at the maximum current the external load management permits.
2. **Given** an active "charge now" override, **When** the session ends (target reached or car unplugged), **Then** the override is cleared automatically without user action.
3. **Given** an active "charge now" override, **When** the app is opened, **Then** the override is clearly visible as active, with the reason charging is not being optimized.
4. **Given** an active "charge now" override, **When** the external load management reduces the available current, **Then** the system accepts that reduction and does not attempt to work around it.

---

### User Story 5 - Fair sharing of surplus between competing users (Priority: P5)

When several cars have an open target and there is not enough surplus for all of them, the system shares it: it may split the available power between cars, and when it must choose, it prefers users who have received less solar energy recently.

**Why this priority**: Only matters when several users are active at once — real, but not on day one. It changes the optimizer's allocation step without changing any user-facing contract.

**Independent Test**: Replay a scenario with three open targets and a surplus sufficient for one and a half cars, repeated over several days, and verify that solar energy is distributed across users rather than always going to the same charger, and that each allocation decision is reproducible from its recorded inputs.

**Acceptance Scenarios**:

1. **Given** three chargers with open targets and surplus sufficient for one, **When** a cycle runs, **Then** the surplus is assigned to one charger and the decision, including the weighting inputs and the seed of any random draw, is recorded.
2. **Given** the same three chargers over several days, **When** allocations are compared, **Then** a user who has received less solar energy has a higher chance of being served next.
3. **Given** surplus sufficient for more than one charger above the minimum modulation level, **When** a cycle runs, **Then** the surplus may be split across chargers rather than concentrated on one.
4. **Given** a recorded set of cycle inputs, **When** the allocation is recomputed, **Then** it yields exactly the same result.

---

### User Story 6 - Operator monitoring and troubleshooting (Priority: P6)

The operator opens a desktop admin view and can see, at a glance, whether the system is healthy: recent cycles and their outcomes, the current surplus estimate and its age, every charger with its target, state and delivered current, recent failures against external data sources, and the decision trail explaining why a given charger did or did not charge.

**Why this priority**: With one operator, no test installation, and a noisy surplus signal, this is how any user complaint is answered — but it depends on the system already producing decisions worth inspecting.

**Independent Test**: With cycles running against recorded data, open the admin view and answer the question "why did charger 12 not charge between 14:00 and 15:00?" using only what the view shows.

**Acceptance Scenarios**:

1. **Given** the operator is authenticated for admin access, **When** they open the admin view, **Then** they see the most recent cycles with timestamp, outcome, surplus estimate and its age, and the number of chargers acted on.
2. **Given** a charger with an open target, **When** the operator inspects it, **Then** they see the requested energy and deadline, the energy delivered, the current state, the last commanded current, and the current actually delivered as read back from the charger.
3. **Given** a command whose read-back shows the charger did not follow it, **When** the operator inspects that charger, **Then** the discrepancy is visible rather than hidden.
4. **Given** a cycle that failed or produced no schedule, **When** it occurs, **Then** it is visible in the admin view and raises an alert to the operator by email.
5. **Given** an unauthenticated visitor, **When** they open the admin view, **Then** access is refused.
6. **Given** monitoring data older than one month, **When** retention runs, **Then** it is deleted automatically.

---

### User Story 7 - Delete all my data (Priority: P7)

A user presses a single button and every piece of data the system holds about them is removed.

**Why this priority**: A privacy commitment made in the inception canvas; low implementation risk but it must exist before the system is used by neighbours.

**Independent Test**: Create a user with targets, sessions and history, press delete, and verify that no user-identifiable record remains and that the user can still sign in afterwards as a fresh user.

**Acceptance Scenarios**:

1. **Given** a signed-in user with sessions and history, **When** they confirm deletion, **Then** all of their targets, sessions, history and fairness accounting are removed permanently, not flagged as deleted.
2. **Given** a user who has deleted their data, **When** they sign in again, **Then** they can set new targets and have no residual history.
3. **Given** an active session, **When** the user deletes their data, **Then** any running override or target for their chargers is cancelled as part of the deletion.

---

### User Story 8 - Multiple chargers on one account (Priority: P8)

A user who owns more than one parking lot sees all of their chargers, identified by parking lot number, and sets an independent target for each.

**Why this priority**: An acknowledged edge case — the default is one charger per user — but it must not require reworking the target model later.

**Independent Test**: Sign in as a user mapped to two parking lots, set different targets on each, and verify both are scheduled independently.

**Acceptance Scenarios**:

1. **Given** a user mapped to two parking lots, **When** they open the app, **Then** both chargers are listed by parking lot number.
2. **Given** two chargers on one account, **When** the user sets a different target on each, **Then** both targets are tracked and scheduled independently.
3. **Given** a user mapped to exactly one parking lot, **When** they open the app, **Then** they go straight to that charger without a selection step.

---

### Edge Cases

- **Car not plugged in when a target is set**: the target is stored and becomes active as soon as the car is plugged in; the app shows that it is waiting for the car.
- **Car unplugged mid-session**: the session ends early, the delivered energy is recorded, any override is cleared, and the target is closed rather than resumed silently on the next plug-in.
- **Deadline passes with the target unmet**: the shortfall is reported to the user and to the operator; the system does not extend the deadline on its own.
- **Deadline set in the past or within a period too short to deliver anything**: rejected at input time with the earliest feasible deadline shown.
- **Target larger than the car or charger can absorb before the deadline**: accepted but immediately reported as unreachable, with the reachable amount shown.
- **Two overlapping targets on the same charger**: the newer target replaces the older one; only one target per charger is active at a time.
- **External load management reduces or removes the current the system asked for**: the read-back value, not the setpoint, is treated as truth; the schedule is re-evaluated against what is actually being delivered.
- **Surplus reading stale, missing, or from the middle of the night**: the reading's age is part of the decision; no charging decision treats a missing reading as zero surplus, and setpoints are damped so a stale value cannot cause oscillation.
- **Surplus turns negative (house load exceeds production)**: solar charging stops; the deadline fallback still applies at low price.
- **A previous optimization cycle is still running when the next is due**: the new cycle is skipped and the skip is recorded.
- **A cycle is delivered twice for the same scheduled time**: the second delivery changes nothing.
- **Daylight-saving transitions**: deadlines, price windows and the winter-window boundary stay correct on the days clocks change, including the ambiguous and non-existent local hours.
- **Winter-window boundary crossed while a target is open**: the open target continues under the rules in force at each cycle; no target is lost at the boundary.
- **A user's sign-in credentials expire mid-session**: the running schedule continues; the user is asked to sign in again for any new action.
- **A user is removed from the parking-lot mapping while a target is open**: no new actions are accepted for that charger and the operator sees the orphaned target.
- **All chargers request surplus at once with none available**: nothing is charged from solar; the deadline fallback governs.

## Requirements *(mandatory)*

### Functional Requirements

**Access and identity**

- **FR-001**: The system MUST require users to sign in with their existing charging-provider account before showing any charger data or accepting any charging action.
- **FR-002**: The system MUST verify a user's credentials on every request, and MUST re-confirm them against the identity provider at least on sign-in and at most once per five minutes per user thereafter.
- **FR-003**: The system MUST determine which chargers a user may act on from an operator-maintained mapping of parking lot to user, and MUST refuse any action on a charger not mapped to the signed-in user.
- **FR-004**: The system MUST identify chargers to users by parking lot number.
- **FR-005**: The system MUST protect the operator's admin surface behind its own authentication, separate from end-user sign-in.

**Setting a target**

- **FR-006**: Users MUST be able to set, for each of their chargers, an energy amount in kWh and a deadline, both entered with sliders.
- **FR-007**: The system MUST reject a deadline in the past and MUST show the earliest deadline for which any energy can be delivered.
- **FR-008**: The system MUST allow a user to change or cancel an open target at any time before it completes, with the change taking effect no later than the next optimization cycle.
- **FR-009**: The system MUST treat a newly set target for a charger as replacing any open target on that charger.
- **FR-010**: The system MUST store a target set while the car is unplugged and activate it when the car is plugged in.
- **FR-011**: The system MUST support users who are mapped to more than one parking lot, with an independent target per charger.

**Scheduling and optimization**

- **FR-012**: The system MUST re-evaluate all chargers with an open target or a running session on a fixed cycle of five minutes.
- **FR-013**: The system MUST resolve every scheduling conflict in this order, highest first: (1) the external dynamic load management, (2) a user's "charge now" override, (3) no grid import during high-price windows, (4) meet the user's deadline using low-price grid energy, (5) maximize solar self-consumption, (6) fairness between users.
- **FR-014**: The system MUST NOT bypass, reconfigure, or attempt to work around the existing dynamic load management.
- **FR-015**: The system MUST estimate available surplus as site production minus site consumption, excluding the charging power the system itself is causing, since only site-level metering exists.
- **FR-016**: The system MUST carry the age of the surplus estimate into every decision that uses it, and MUST NOT treat a missing or failed reading as zero surplus.
- **FR-017**: The system MUST damp setpoint changes between cycles so that a stale or noisy surplus estimate cannot cause charging to oscillate on and off.
- **FR-018**: The system MUST NOT draw grid power for a charger during the high-price windows 11:00–13:00 and 18:00–20:00 Europe/Zurich, except under an active "charge now" override.
- **FR-019**: The system MUST charge from available surplus during high-price windows, since the restriction applies to grid import only.
- **FR-020**: The system MUST NOT top up from the grid to reach the charger's minimum modulation level while in solar mode; it MUST wait for sufficient surplus unless the deadline fallback applies.
- **FR-021**: The system MUST top up from the grid during low-price periods when the target would otherwise become unreachable.
- **FR-022**: The system MUST use a day-ahead weather forecast to decide whether charging can be deferred to the next day, and MUST only defer while the target remains reachable.
- **FR-023**: The system MUST disable solar optimization between 1 October and the end of February, scheduling purely by deadline while still enforcing the high-price rule.
- **FR-024**: When several chargers compete for insufficient surplus, the system MUST allocate it by a draw weighted by how much solar energy each user has already received, and MAY split available power across several chargers rather than serving only one.
- **FR-025**: The system MUST evaluate all deadlines, price windows, winter-window boundaries and daylight periods in Europe/Zurich and MUST remain correct across daylight-saving transitions.
- **FR-026**: The system MUST NOT start a new optimization cycle while the previous one is still running, and MUST record every skipped cycle.
- **FR-027**: The system MUST produce the same scheduling decision when re-run against a recorded set of cycle inputs, including the fairness draw.

**Executing and verifying commands**

- **FR-028**: The system MUST read back the current actually delivered by each charger and reconcile it against what it commanded, rather than assuming a command took effect.
- **FR-029**: The system MUST detect that a car has been plugged in even when no target is set for that charger, and MUST detect the end of a session.
- **FR-030**: The system MUST stop requesting charge for a charger once its target energy has been delivered.
- **FR-031**: The system MUST log every charger command with what triggered it, why, the inputs that produced the decision, and an identifier linking the decision to the calls it caused.

**Overrides**

- **FR-032**: Users MUST be able to activate a "charge now" override for their charger, which charges at the maximum current the external load management permits, ignoring surplus, price windows and deadline.
- **FR-033**: The system MUST clear a "charge now" override automatically when the session ends.
- **FR-034**: The system MUST show an active override, and the fact that optimization is suspended, in both the user app and the admin view.

**Reporting to users**

- **FR-035**: The system MUST show each user, per charger, the current state — idle, waiting for the car, waiting for surplus, charging from solar, charging from grid, complete — together with energy delivered and energy remaining.
- **FR-036**: The system MUST tell the user when an open target has become unreachable under the price policy, including the expected shortfall, and MUST NOT silently deliver less than requested.
- **FR-037**: The system MUST show a summary at the end of each session with total energy delivered, the split between solar and grid, and whether the target was met.
- **FR-038**: The system MUST retain and show each user their five most recent sessions, and MUST delete older ones.

**Operator view and alerting**

- **FR-039**: The admin surface MUST show recent cycles with their outcome, the surplus estimate and its age, and the chargers acted on.
- **FR-040**: The admin surface MUST show, per charger, the open target, the state, the last commanded current, the current read back, and any discrepancy between them.
- **FR-041**: The admin surface MUST show recent failures and rate-limit responses per external data source.
- **FR-042**: The admin surface MUST let the operator trace why a specific charger did or did not charge in a given period, from the recorded decision inputs.
- **FR-043**: The system MUST alert the operator by email when optimization cycles fail or produce no schedule.

**Resilience and data**

- **FR-044**: When any external data source is unavailable or rate-limited, the system MUST fall back to charging from the grid within the price policy, and MUST NOT surface the failure as an unhandled error or an implicit zero surplus.
- **FR-045**: The system MUST respect the documented call budget of each external data source: production readings at the cycle cadence during daylight only, charger polling limited to chargers with an active target or session plus a low-frequency sweep, and forecast retrieval at most four times per day.
- **FR-046**: The system MUST NOT persist one record per charger per cycle; it MUST persist state changes plus a periodic snapshot of roughly fifteen minutes per active charger.
- **FR-047**: The system MUST delete operator monitoring data older than one month automatically.
- **FR-048**: Users MUST be able to delete all data the system holds about them with a single confirmed action, and that deletion MUST be complete rather than a soft flag.
- **FR-049**: The system MUST store only the data needed to operate: the user reference from the sign-in token, the operator-maintained parking lot mapping, targets, sessions and monitoring records.
- **FR-050**: Repeated delivery of the same scheduled trigger MUST have the same effect as a single delivery.

### Key Entities

- **User**: an EV owner, referenced by the identifier carried in their charging-provider sign-in token. Holds no personal data beyond that identifier and the email in the token.
- **Charger**: a physical charging station at a parking lot, on one of two supply lines. Attributes: parking lot number, supply line, maximum output, current state, last commanded current, last delivered current.
- **Parking Lot Mapping**: the operator-maintained association of parking lot to user; the sole basis for authorization.
- **Target**: a user's declared intent for one charger — energy amount in kWh, deadline, creation time, and current reachability assessment. At most one open target per charger.
- **Session**: one charging process from plug-in or first energy delivered until the target is reached or the car is unplugged. Attributes: start, end, energy delivered split into solar and grid, whether the target was met, end reason.
- **Override**: an active "charge now" state on a charger, with who activated it, when, and its automatic clearing at session end.
- **Cycle Decision**: the record of one optimization run — inputs (surplus estimate and its age, production and consumption, tariff window, seasonal mode, forecast-derived defer decision, per-charger target and state, fairness weights and draw seed), outputs (per-charger commanded current or on/off), read-back of the previous cycle, and a correlation identifier.
- **Surplus Estimate**: a derived value with a timestamp and an age — site production minus site consumption, less the system's own charging power.
- **Forecast**: the day-ahead production outlook used for the defer decision.
- **Fairness Ledger**: per-user accounting of solar energy already received, used to weight the allocation draw.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can go from opening the app to a confirmed charging target in under 60 seconds, using only two sliders and one confirmation.
- **SC-002**: At least 95% of targets that were reported as reachable when set are fully delivered by their deadline.
- **SC-003**: Every target that becomes unreachable is reported to the user before its deadline, with no case of silent under-delivery.
- **SC-004**: Zero grid energy is drawn during high-price windows across a full month of operation, except where a user activated the "charge now" override.
- **SC-005**: Over the March–September period, at least 60% of the energy delivered to cars comes from on-site surplus rather than the grid.
- **SC-006**: Daily exported surplus is reduced by at least 50% on days with at least three open targets, compared with the pre-system baseline of roughly 200 kWh exported per day.
- **SC-007**: Over any month with several concurrently active users, no user receives more than twice the share of surplus energy of any other user with comparable open targets.
- **SC-008**: At least 99% of scheduled optimization cycles complete and produce a schedule; every failed or skipped cycle appears in the operator view and triggers an email alert within 15 minutes.
- **SC-009**: The operator can explain why any individual charger did or did not charge in any five-minute window of the last month using only the recorded decision trail, in under 5 minutes.
- **SC-010**: Any recorded cycle can be replayed to produce a byte-identical scheduling decision.
- **SC-011**: No external data source is called more often than its documented budget on any day of operation, verified over a full month.
- **SC-012**: Running the system costs the operator nothing per month at 30 chargers with 15 concurrently active users — hosting, storage and data volume all stay within the free allowance of the chosen platform.
- **SC-013**: A user's delete action removes all of their data within one minute, verified by finding no record referencing their identifier afterwards.
- **SC-014**: Charging behaviour remains correct across both daylight-saving transitions, with no target missed or price window misapplied on those days.
- **SC-015**: When any external data source is unavailable for a full cycle, charging continues under the price policy with no user-visible error and no missed reachable deadline.

## Assumptions

- **Scope**: this specification covers the complete MVP described in the Architecture Inception Canvas. Billing and per-user cost allocation, push or email notification of end users, home battery storage, dynamic hourly tariffs, and any change to the existing dynamic load management are out of scope.
- **Tariff structure is fixed**: the two-tier price plan with high-price windows at 11:00–13:00 and 18:00–20:00 is a constant of the installation, not user-configurable in the MVP.
- **Targets are one-off**: a target applies to the current or next session; there are no recurring or weekly schedules in the MVP. A completed session clears its target.
- **One open target per charger**: setting a new target replaces the previous one. Queued or sequential targets are not supported.
- **Energy is user-declared**: the user states how many kWh they need; the system does not read the car's state of charge and does not infer "full".
- **Unplugging ends the session**: the system does not resume a partially delivered target automatically on the next plug-in; the user sets a new target.
- **The parking-lot mapping is maintained by the operator** outside the app, and is the authoritative source for who may act on which charger. Self-service claiming of a charger is out of scope.
- **Admin access is a single shared credential** for the MVP; the accepted consequence is that admin actions carry no per-admin identity, while charger commands remain individually attributed.
- **A dedicated technical account** is used by the scheduler to act on chargers while no user is signed in.
- **Surplus is derived, not measured**: with no submetering, the surplus figure is an estimate carrying real noise from house load and heat pumps; success criteria on solar share are stated at that accuracy.
- **Charger modulation floor**: approximately 6 A, i.e. roughly 1.4 kW single-phase and 4.1 kW three-phase; below that a charger cannot be modulated and must either run at the floor or be off.
- **Physical limits**: chargers deliver at most 11 kW, on two supply lines of 15 chargers each, 63 A per line and 126 A in total, all enforced externally by the dynamic load management.
- **Forecast cadence**: the day-ahead outlook is refreshed four times per day, so a deferral decision is never based on a forecast more than six hours old.
- **Real-hardware validation** is limited to the operator's own parking lot; all other behaviour is validated against recorded data from the external services.
- **Users have a smartphone with internet access** and an existing charging-provider account; no separate account creation exists in this system.

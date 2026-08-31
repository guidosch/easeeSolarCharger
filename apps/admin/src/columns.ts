/**
 * What every column of the operator tables means (todo: "Tooltipps auf den Spalten der Admin-Page").
 *
 * The tables are deliberately dense, which leaves most columns as one word of jargon — `opMode`,
 * `capped`, `unusable`. Each entry therefore carries both halves of the answer: what the column is,
 * and what its values mean. The value vocabulary is the half that tells an operator whether a row
 * is a problem, so the enums that appear in more than one table are declared once here rather than
 * re-typed per view.
 */

export type ColumnHelp = {
  label: string
  description: string
  /** `[value, meaning]`, in the order an operator should read them. */
  values?: readonly (readonly [string, string])[]
}

/** Which rule of the Principle I precedence ladder decided a cycle, highest precedence first. */
export const LADDER_RULES: Record<string, string> = {
  '1': 'line headroom',
  '2': 'override',
  '3': 'high price',
  '4': 'deadline',
  '5': 'solar',
  '6': 'fairness',
}

const DISCREPANCY_VALUES = [
  ['none', 'Commanded and delivered agree within 1 A, or nothing is being commanded.'],
  [
    'capped',
    'The setpoint stuck, but the car is drawing more than 1 A less while charging — normally the external load manager overruling this system, which it is allowed to do.',
  ],
  [
    'lost',
    'The charger is not holding the setpoint at all. Most often a plug-in reset it; occasionally the write never landed. It is re-applied on the next cycle.',
  ],
] as const

const REACHABILITY_VALUES = [
  [
    'reachable',
    'The remaining low-price time can still deliver the target with headroom to spare.',
  ],
  [
    'at_risk',
    'Less than 25% headroom left, so the deadline fallback (rule 4) imports low-price grid energy rather than waiting for sun.',
  ],
  [
    'unreachable',
    'The target cannot be met before its deadline. The figure in brackets is the expected shortfall in kWh.',
  ],
] as const

const OP_MODE_VALUES = [
  ['0', 'Offline — not reachable; left alone.'],
  ['1', 'Disconnected — no car plugged in.'],
  ['2', 'AwaitingStart — plugged in, not yet drawing.'],
  ['3', 'Charging — current is flowing.'],
  ['4', 'Completed — the car stopped the session itself.'],
  ['5', 'Error — reported by the charger; deliberately not retried.'],
  ['6', 'ReadyToCharge — plugged in and waiting for a setpoint.'],
] as const

const CHARGER_STATE_VALUES = [
  ['idle', 'No car and no target, or plugged in with nothing asked of it.'],
  ['waiting_for_car', 'A target exists but nothing is plugged in.'],
  ['waiting_for_surplus', 'Plugged in with an open target, but no current commanded this cycle.'],
  ['charging_solar', 'Drawing current that was attributed to PV surplus.'],
  ['charging_grid', 'Drawing current that was attributed to the grid (override or deadline).'],
  ['complete', 'The charger reports the session finished (opMode 4).'],
  ['error', 'The charger reports an error (opMode 5).'],
  ['offline', 'The charger could not be reached (opMode 0).'],
] as const

/** `GET /admin/chargers` — the all-chargers table (FR-040). */
export const CHARGER_COLUMNS = {
  lot: {
    label: 'Lot',
    description:
      'The parking lot number — how both operators and users refer to a charger. It maps to exactly one Easee charger ID. A row shaded pink is an orphaned mapping: the lot points at no user, so nobody can drive that charger.',
  },
  line: {
    label: 'Line',
    description:
      'Which of the two supply lines feeds this charger. Each line has its own current limit, plus a limit on the sum of both, and ladder rule 1 caps everything on a line that is running out of headroom.',
    values: [
      ['L1', 'Supply line 1.'],
      ['L2', 'Supply line 2.'],
    ],
  },
  state: {
    label: 'State',
    description:
      'The charger state, derived server-side from opMode and the open target so this page and the user PWA cannot disagree about what "waiting" means.',
    values: CHARGER_STATE_VALUES,
  },
  opMode: {
    label: 'opMode',
    description:
      "Raw Easee observation 109 — the charger's own operating mode. State is derived from it; this is the unfiltered number to cross-check against the Easee portal.",
    values: OP_MODE_VALUES,
  },
  commanded: {
    label: 'Commanded',
    description:
      'The setpoint this system last wrote to the charger (dynamicChargerCurrent), in amps. 0 A means the scheduler is deliberately asking for no current — the trace says why.',
  },
  delivered: {
    label: 'Delivered',
    description:
      'The current the car is actually drawing, read back from the charger (observation 114), in amps. This, not Commanded, is what the optimizer and the energy accounting believe.',
  },
  believes: {
    label: 'Charger believes',
    description:
      'The dynamic current limit the charger itself is currently holding, in amps. It should equal Commanded; when it does not, the setpoint was reset or the write never landed — which is what makes Discrepancy "lost".',
  },
  discrepancy: {
    label: 'Discrepancy',
    description:
      'The read-back reconciliation: commanded versus what actually happened. A charger that could not be read this cycle keeps its previous verdict rather than inventing one from a network failure.',
    values: DISCREPANCY_VALUES,
  },
  target: {
    label: 'Target',
    description:
      'The open target on this charger: energy delivered so far / energy the user asked for, in kWh. A dash means there is no open target at all — usually the answer when a user says "nothing happened".',
  },
  reachability: {
    label: 'Reachability',
    description:
      'Whether the open target can still be met before its deadline, recomputed every cycle from the low-price time that remains.',
    values: REACHABILITY_VALUES,
  },
  user: {
    label: 'User',
    description:
      'The Easee user this lot is mapped to — the email address when known, otherwise the raw user ID. "orphaned mapping" means the mapping points at no user: an operator data problem, not a charger fault.',
  },
  trace: {
    label: 'Trace',
    description:
      'Opens the per-charger decision trail — one row per cycle, each naming the ladder rule that decided it. This is the "why did lot 12 not charge between 14:00 and 15:00?" view.',
  },
} as const satisfies Record<string, ColumnHelp>

/** `GET /admin/cycles` — the recent-cycles table (FR-039). */
export const CYCLE_COLUMNS = {
  cycle: {
    label: 'Cycle',
    description:
      'The start time of one scheduler run, shown in Europe/Zurich local time; the cycle runs every 5 minutes and its ID is that start instant. Click through for the complete recorded input set, which is copyable straight into a regression fixture.',
  },
  outcome: {
    label: 'Outcome',
    description: 'How the run ended. Every run leaves a record, including the ones that failed.',
    values: [
      ['completed', 'Ran end to end: every charger was read and every setpoint write succeeded.'],
      [
        'degraded',
        'Decided and applied, but on incomplete data — a charger could not be read, the surplus reading was not fresh, or a setpoint write failed.',
      ],
      [
        'failed',
        'The run threw and applied nothing. The record exists so the failure is visible rather than simply absent.',
      ],
      [
        'skipped_locked',
        'Another instance already held the cycle lease, so this run deliberately did nothing. Normal on a retried trigger.',
      ],
    ],
  },
  duration: {
    label: 'Duration',
    description:
      'Wall-clock time of the run, in milliseconds. The plan budgets 90 seconds; a worst case that has to re-apply all thirty setpoints spreads them over at least two minutes, because Easee allows only 20 setpoint writes a minute.',
  },
  surplus: {
    label: 'Surplus',
    description:
      'The EWMA-smoothed PV surplus available for car charging, in kW (α = 0.4, so a single spike cannot move it far). A dash means there was no usable reading — which is not the same as zero surplus: the scheduler then runs deadline-only rather than assuming there is no sun.',
  },
  age: {
    label: 'Age',
    description:
      'How old the underlying surplus reading was when the cycle ran, in minutes. Quality is derived from exactly this number.',
  },
  quality: {
    label: 'Quality',
    description:
      'Whether the surplus reading was good enough to make solar decisions with. This is the column that answers "why did nothing charge from solar this afternoon".',
    values: [
      ['fresh', 'No older than one cycle (5 minutes); used as it stands.'],
      [
        'stale',
        'Older than 5 minutes but inside the 15-minute cutoff. Still used, and the age is flagged in the cycle notes.',
      ],
      [
        'unusable',
        'Older than 15 minutes, or missing entirely. Solar optimization is switched off for the cycle and scheduling falls back to deadlines only.',
      ],
    ],
  },
  tariff: {
    label: 'Tariff',
    description:
      'Which electricity tariff window the cycle fell into. High windows are 11:00–13:00 and 18:00–20:00 local. Ladder rule 3 bans grid import inside a high window — it does not stop charging on solar.',
    values: [
      ['low', 'Grid import is permitted, so the deadline fallback may run.'],
      ['high', 'No grid import: only solar charging and an explicit user override get current.'],
    ],
  },
  season: {
    label: 'Season',
    description:
      'Which seasonal mode was in force. The winter window runs from 1 October to 1 March (FR-023).',
    values: [
      ['solar', 'Surplus-driven scheduling, with the deadline fallback behind it.'],
      [
        'winter',
        'Solar optimization is disabled outright; every unmet target charges on every low-price cycle.',
      ],
    ],
  },
  actedOn: {
    label: 'Acted on',
    description:
      'How many chargers this cycle actually wrote a new setpoint to. It is meant to be far below thirty: a setpoint is only rewritten when it moves by at least 1 A (the deadband) or when a plug-in reset it.',
  },
  easee: {
    label: 'Easee',
    description:
      'Easee API calls made by this cycle, with the failed ones in brackets. The limits — 100 observation reads per rolling 5 minutes and 20 setpoint writes per minute — are enforced before the request is made.',
  },
  solaredge: {
    label: 'SolarEdge',
    description:
      'SolarEdge API calls made by this cycle, then how much of the daily budget is still unspent. The cap is 300 calls a day and the daylight gate keeps the worst case near 192; a retry loop that burns the budget blinds the optimizer for the rest of the day.',
  },
} as const satisfies Record<string, ColumnHelp>

/** `GET /admin/providers` — 24-hour provider health (FR-041). */
export const PROVIDER_COLUMNS = {
  provider: {
    label: 'Provider',
    description: 'The external API this row accounts for.',
    values: [
      ['easee', 'The chargers: observations (state, current) and setpoint writes.'],
      [
        'solaredge',
        'The PV inverter: production and grid export, from which the surplus is computed.',
      ],
      [
        'openweather',
        'The cloud-cover forecast, used only to decide whether a target may be deferred to a sunnier tomorrow.',
      ],
    ],
  },
  calls: {
    label: 'Calls (24 h)',
    description:
      'Calls to this provider, summed over the cycle records of the last 24 hours. Counted from the records rather than from memory because both services scale to zero, so an in-process counter is gone by the time anyone looks. Turns red above 80% of Budget.',
  },
  budget: {
    label: 'Budget',
    description:
      'The cap that is enforced before a call is made. The windows differ per provider: Easee 100 observation reads per rolling 5 minutes, SolarEdge 300 calls per day, OpenWeather 4 fetches per day. Only the last two are directly comparable with a 24-hour call count.',
  },
  errors: {
    label: 'Errors',
    description:
      'Failed calls in the last 24 hours, from any cause — upstream errors, timeouts, rejected credentials. Anything above zero is worth following into Last error.',
  },
  rateLimited: {
    label: 'Rate limited',
    description:
      'Requests the provider answered with HTTP 429 in the last 24 hours. Budgets are checked before the request goes out, so this should stay at zero; a non-zero count means calls are happening outside the budgeted paths.',
  },
  daylightGate: {
    label: 'Daylight gate',
    description:
      'Whether SolarEdge is being polled at all right now. The gate is checked before the call, so a night-time cycle costs no budget — and is not counted as degraded, because it is running exactly as specified.',
    values: [
      ['open', 'The sun is up, so the inverter is polled each cycle.'],
      ['closed', 'Before sunrise or after sunset: SolarEdge is skipped entirely.'],
      ['n/a', 'This provider has no daylight gate.'],
    ],
  },
  lastError: {
    label: 'Last error',
    description:
      'The most recent cycle in the window that either failed or recorded an error for this provider: its time, its notes, and its correlation ID. Search the correlation ID in the logs to pull up every line that cycle wrote.',
  },
} as const satisfies Record<string, ColumnHelp>

/** `GET /admin/chargers/{lotNumber}/trace` — the per-charger decision trail (FR-042, SC-009). */
export const TRACE_COLUMNS = {
  cycle: {
    label: 'Cycle',
    description:
      'The start time of the cycle this row describes, in Europe/Zurich local time. Every cycle in the window gets a row, whether or not anything happened to this charger.',
  },
  commanded: {
    label: 'Commanded',
    description:
      'The current this cycle decided this charger should get, in amps. 0 A is a deliberate "no charging" decision, and Reason says which one.',
  },
  delivered: {
    label: 'Delivered',
    description:
      'The current the car was actually drawing, in amps. It is read back at the start of the cycle, so it shows what the *previous* cycle’s command achieved.',
  },
  reason: {
    label: 'Reason',
    description: 'Why the charger got the current it got — the recorded decision, not a guess.',
    values: [
      [
        'override',
        'The user pressed "charge now": full current, ignoring both the price policy and the deadline.',
      ],
      ['solar_surplus', "Charging on this charger's share of the PV surplus."],
      [
        'deadline_fallback',
        'The target would otherwise miss its deadline, so full current from low-price grid energy.',
      ],
      [
        'high_price_blocked',
        'Inside a high-price window with no solar to spend, so nothing was permitted.',
      ],
      [
        'below_modulation_floor',
        'The share of surplus stayed under the 6 A floor, so the session stopped rather than topping it up from the grid.',
      ],
      [
        'awaiting_surplus',
        'No usable surplus to charge on, or the two-cycle start delay has not elapsed yet. Waiting.',
      ],
      ['no_target', 'Nobody asked for energy on this charger: no open target and no override.'],
      [
        'target_met',
        'The declared energy has been delivered; the system stops asking for current, override or not.',
      ],
      ['not_plugged_in', 'No car connected (opMode 1).'],
      [
        'charger_error',
        'The charger is offline or reporting an error, and is deliberately not retried.',
      ],
      [
        'deferred_to_tomorrow',
        'The forecast says tomorrow is sunnier and the deadline still allows the wait, so the target was deferred.',
      ],
      [
        'fairness_not_selected',
        'There was surplus but not enough to go round, and this cycle’s draw gave it to someone else.',
      ],
    ],
  },
  ladderRule: {
    label: 'Decided by',
    description:
      'Which rule of the precedence ladder produced this row — the one-glance answer to "why". A dash means no rule was reached at all: the charger was in a state that cannot be commanded, and Reason says which. Rule 1 is applied last in code and first in precedence: it is a ceiling on whatever the rules below asked for, never a floor.',
    values: [
      ['1', 'Line headroom — the advisory cap from external load management.'],
      ['2', 'Override — the user asked to charge now.'],
      ['3', 'High price — no grid import inside a high-tariff window.'],
      ['4', 'Deadline — low-price grid energy to save a target at risk.'],
      ['5', 'Solar — maximize self-consumption of the surplus.'],
      ['6', 'Fairness — the surplus went to whoever has had less of it.'],
    ],
  },
  discrepancy: {
    label: 'Discrepancy',
    description:
      'The read-back reconciliation for the previous cycle’s command on this charger. A dash means nothing was read back for it in that cycle.',
    values: DISCREPANCY_VALUES,
  },
  events: {
    label: 'Events',
    description:
      'Charger events recorded inside this cycle’s window, by type. They are the physical story behind the decision.',
    values: [
      [
        'plugged_in / unplugged',
        'A car was connected or disconnected. A plug-in also resets the setpoint.',
      ],
      ['charging_started / charging_stopped', 'Current began or ceased to flow.'],
      ['target_set', 'The user declared a new energy target and deadline.'],
      ['override_on / override_off', '"Charge now" was switched on, or expired.'],
      [
        'command_lost / command_capped',
        'The setpoint did not stick, or less current flowed than was commanded.',
      ],
      ['error', 'The charger reported an error.'],
    ],
  },
} as const satisfies Record<string, ColumnHelp>

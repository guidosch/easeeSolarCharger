import { z } from 'zod'
import { Discrepancy, IsoInstant, OpMode, Phases, SupplyLine } from './common.js'
import { TargetView } from './target.js'

/**
 * Derived server-side so the two frontends cannot disagree about what "waiting" means
 * (contracts/user-api.md). `waiting_for_surplus` versus `charging_grid` is exactly the distinction
 * FR-035 requires the user to see.
 */
export const ChargerState = z.enum([
  'idle',
  'waiting_for_car',
  'waiting_for_surplus',
  'charging_solar',
  'charging_grid',
  'complete',
  'error',
  'offline',
])
export type ChargerState = z.infer<typeof ChargerState>

export const OverrideView = z.object({
  active: z.boolean(),
  since: IsoInstant.nullish(),
})
export type OverrideView = z.infer<typeof OverrideView>

/** `GET /chargers` — one entry per charger mapped to the caller. */
export const ChargerView = z.object({
  lotNumber: z.string(),
  chargerId: z.string(),
  state: ChargerState,
  phases: Phases,
  /** Read back from the charger, not the setpoint (FR-028). */
  deliveredCurrentA: z.number(),
  target: TargetView.nullable(),
  override: OverrideView,
  observedAt: IsoInstant.nullable(),
})
export type ChargerView = z.infer<typeof ChargerView>

/** `PUT /chargers/{lotNumber}/override`. */
export const SetOverrideRequest = z.object({ active: z.boolean() })
export type SetOverrideRequest = z.infer<typeof SetOverrideRequest>

/** `GET /admin/chargers` — all 30, whether or not they have a target (FR-040). */
export const AdminChargerView = z.object({
  lotNumber: z.string(),
  chargerId: z.string(),
  line: SupplyLine,
  phases: Phases,
  opMode: OpMode,
  state: ChargerState,
  commandedCurrentA: z.number(),
  deliveredCurrentA: z.number(),
  dynamicChargerCurrentA: z.number(),
  discrepancy: Discrepancy,
  target: TargetView.nullable(),
  user: z.object({ userId: z.string(), email: z.string().optional() }).nullable(),
  orphaned: z.boolean(),
  observedAt: IsoInstant.nullable(),
})
export type AdminChargerView = z.infer<typeof AdminChargerView>

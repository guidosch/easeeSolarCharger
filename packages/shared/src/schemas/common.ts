import { z } from 'zod'

/**
 * An ISO-8601 instant. Stored and transported as an instant everywhere; every *interpretation*
 * (deadline, tariff window, winter boundary, daylight) happens in Europe/Zurich inside
 * `packages/core`. Storing a naive local timestamp is a defect (FR-025).
 */
export const IsoInstant = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'must be an ISO-8601 instant' })

export const Reachability = z.object({
  state: z.enum(['reachable', 'at_risk', 'unreachable']),
  expectedShortfallKwh: z.number().min(0),
})
export type Reachability = z.infer<typeof Reachability>

/**
 * Easee observation 109 — the charger operating mode (research R1).
 *
 * 7 and 8 belong to the authorisation flow and only appear on chargers that require an RFID/app
 * authorisation; they were seen in production on 2026-09-01. Every value the documented Easee
 * enumeration defines is listed here: an unlisted value makes the whole observation `malformed`,
 * which costs the charger a cycle.
 */
export const OpMode = z.union([
  z.literal(0), // Offline
  z.literal(1), // Disconnected
  z.literal(2), // AwaitingStart
  z.literal(3), // Charging
  z.literal(4), // Completed
  z.literal(5), // Error
  z.literal(6), // ReadyToCharge
  z.literal(7), // AwaitingAuthentication — plugged in, waiting for RFID/app authorisation
  z.literal(8), // De-authenticating — the authorisation is being torn down
])
export type OpMode = z.infer<typeof OpMode>

export const Phases = z.union([z.literal(1), z.literal(3)])
export type Phases = z.infer<typeof Phases>

export const SupplyLine = z.enum(['L1', 'L2'])
export type SupplyLine = z.infer<typeof SupplyLine>

/** Read-back reconciliation outcome (FR-028, Principle I). */
export const Discrepancy = z.enum(['none', 'capped', 'lost'])
export type Discrepancy = z.infer<typeof Discrepancy>

/** The error codes in the user-API contract's error table. */
export const ApiErrorCode = z.enum([
  'validation_failed',
  'deadline_too_soon',
  'token_expired',
  'token_invalid',
  'no_charger_mapped',
  'not_your_charger',
  'not_found',
  'upstream_rate_limited',
  'upstream_unavailable',
  'internal_error',
])
export type ApiErrorCode = z.infer<typeof ApiErrorCode>

export const ApiError = z.object({
  error: ApiErrorCode,
  message: z.string().optional(),
  details: z.unknown().optional(),
  earliestFeasibleDeadline: IsoInstant.optional(),
})
export type ApiError = z.infer<typeof ApiError>

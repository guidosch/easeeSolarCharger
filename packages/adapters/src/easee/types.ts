import { z } from 'zod'

/** The observation IDs this system consumes (contracts/external-providers.md). */
export const OBSERVATION_IDS = {
  chargerOpMode: 109,
  outputCurrent: 114,
  totalPower: 120,
  sessionEnergy: 121,
  lifetimeEnergy: 124,
  dynamicChargerCurrent: 48,
  reasonForNoCurrent: 96,
  cableLocked: 103,
} as const

export const OBSERVATION_ID_LIST = Object.values(OBSERVATION_IDS)

/**
 * One observation as Easee returns it.
 *
 * The id field is accepted under either documented name, but nothing else is relaxed: an entry
 * that matches neither shape is a `malformed` error rather than a silently dropped reading.
 */
export const RawObservation = z.union([
  z.object({
    id: z.number(),
    value: z.union([z.string(), z.number(), z.boolean()]),
    timestamp: z.string().optional(),
  }),
  z.object({
    observationId: z.number(),
    value: z.union([z.string(), z.number(), z.boolean()]),
    timestamp: z.string().optional(),
    dataType: z.number().optional(),
  }),
])
export type RawObservation = z.infer<typeof RawObservation>

export const RawObservationList = z.array(RawObservation)

/**
 * The envelope the endpoint actually returns: `{ "observations": [ … ] }`, not a bare array
 * (`Current_Device_State_API_MultiObservationResponse` in the Easee OpenAPI definition). A bare
 * array is still accepted so an older recording keeps parsing.
 */
export const ObservationsResponse = z.union([
  z.object({ observations: RawObservationList }),
  RawObservationList.transform((observations) => ({ observations })),
])

/** The internal domain model — `packages/core` never sees an Easee payload (Principle IV). */
export type ChargerObservation = {
  opMode: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8
  deliveredCurrentA: number
  dynamicCurrentA: number
  totalPowerKw: number
  sessionEnergyKwh: number
  lifetimeEnergyKwh: number
  reasonForNoCurrent: number
  cableLocked: boolean
  observedAt: string
}

export const EaseeTokenResponse = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresIn: z.number().int().positive(),
  tokenType: z.string().optional(),
})
export type EaseeTokenResponse = z.infer<typeof EaseeTokenResponse>

export function observationId(raw: RawObservation): number {
  return 'id' in raw ? raw.id : raw.observationId
}

export function observationNumber(raw: RawObservation | undefined, fallback: number): number {
  if (!raw) return fallback
  const value = typeof raw.value === 'boolean' ? Number(raw.value) : Number(raw.value)
  return Number.isFinite(value) ? value : fallback
}

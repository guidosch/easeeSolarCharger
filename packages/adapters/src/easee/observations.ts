import type { HttpClient } from '../http/client.js'
import type { BudgetLimiter } from '../http/budget.js'
import type { Result } from '../http/errors.js'
import { err, ok } from '../http/errors.js'
import type { ChargerObservation } from './types.js'
import {
  OBSERVATION_ID_LIST,
  OBSERVATION_IDS,
  ObservationsResponse,
  observationId,
  observationNumber,
} from './types.js'

/**
 * The Easee observations client (T031, research R1).
 *
 * `GET /api/chargers/{id}/state` is **removed on 2026-09-01** and is deliberately not implemented
 * anywhere in this package — all reads go through the observations endpoint.
 */
export class EaseeObservationsClient {
  constructor(
    private readonly http: HttpClient,
    private readonly baseUrl: string,
    private readonly budget: BudgetLimiter,
  ) {}

  /**
   * Note the missing `/api` segment: the observations endpoint sits at the root of the Easee Cloud
   * API (`servers: https://api.easee.com` + path `/state/{serialNumber}/observations`), unlike the
   * older `/api/chargers/...` routes. Sending `/api/state/...` reaches a different API Gateway
   * route that answers `403 Forbidden` for every charger — an authorization-shaped error with an
   * addressing cause, which is why it looked like a credentials problem in production.
   */
  observationsUrl(serialNumber: string): string {
    return `${this.baseUrl}/state/${encodeURIComponent(serialNumber)}/observations?ids=${OBSERVATION_ID_LIST.join(',')}`
  }

  async read(
    serialNumber: string,
    accessToken: string,
    observedAtFallback: string,
  ): Promise<Result<ChargerObservation>> {
    return this.http.request<ChargerObservation>(
      {
        provider: 'easee',
        url: this.observationsUrl(serialNumber),
        headers: { authorization: `Bearer ${accessToken}` },
        timeoutMs: 8_000,
        parse: (payload) => parseObservations(payload, observedAtFallback),
      },
      this.budget,
    )
  }
}

/** The documented Easee `ChargerOpMode` enumeration in full — 7/8 are the authorisation flow. */
const VALID_OP_MODES = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const

export function parseObservations(
  payload: unknown,
  observedAtFallback: string,
): Result<ChargerObservation> {
  const parsed = ObservationsResponse.safeParse(payload)
  if (!parsed.success) {
    return err({
      kind: 'malformed',
      provider: 'easee',
      message: `observations payload did not match the contract: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
    })
  }

  const byId = new Map(parsed.data.observations.map((entry) => [observationId(entry), entry]))
  const opModeRaw = byId.get(OBSERVATION_IDS.chargerOpMode)
  if (!opModeRaw) {
    return err({
      kind: 'malformed',
      provider: 'easee',
      message: 'observation 109 (chargerOpMode) is missing; the charger state is unknowable',
    })
  }

  const opModeValue = observationNumber(opModeRaw, -1)
  const opMode = VALID_OP_MODES.find((m) => m === opModeValue)
  if (opMode === undefined) {
    return err({
      kind: 'malformed',
      provider: 'easee',
      message: `observation 109 carried an unknown opMode: ${opModeValue}`,
    })
  }

  const cableLockedRaw = byId.get(OBSERVATION_IDS.cableLocked)

  return ok({
    opMode,
    deliveredCurrentA: observationNumber(byId.get(OBSERVATION_IDS.outputCurrent), 0),
    dynamicCurrentA: observationNumber(byId.get(OBSERVATION_IDS.dynamicChargerCurrent), 0),
    totalPowerKw: observationNumber(byId.get(OBSERVATION_IDS.totalPower), 0),
    sessionEnergyKwh: observationNumber(byId.get(OBSERVATION_IDS.sessionEnergy), 0),
    lifetimeEnergyKwh: observationNumber(byId.get(OBSERVATION_IDS.lifetimeEnergy), 0),
    reasonForNoCurrent: observationNumber(byId.get(OBSERVATION_IDS.reasonForNoCurrent), 0),
    cableLocked: observationNumber(cableLockedRaw, 0) === 1,
    observedAt: opModeRaw.timestamp ?? observedAtFallback,
  })
}

/**
 * Did the charger lose the setpoint this system wrote?
 *
 * Easee resets `dynamicChargerCurrent` when a car is plugged in or the charger reboots (research
 * R5), so a mismatch here is expected behaviour to be re-applied — not an anomaly to alert on.
 */
export function wasReset(charger: {
  commandedCurrentA: number
  dynamicChargerCurrentA: number
}): boolean {
  return (
    charger.commandedCurrentA > 0 && charger.dynamicChargerCurrentA !== charger.commandedCurrentA
  )
}

import type { Phases } from './types.js'

/**
 * kW ↔ A conversion (research R2). Easee is commanded in amps; SolarEdge reports kilowatts.
 *
 *   I(A) = kW × 1000 / (√3 × 400) = kW × 1.443   (three-phase)
 *   I(A) = kW × 1000 / 230        = kW × 4.348   (single-phase)
 *
 * The factors are written out rather than derived from √3 at runtime so that the recorded
 * regression corpus cannot drift with a floating-point library change (Principle III).
 */
export const AMPS_PER_KW_THREE_PHASE = 1.443
export const AMPS_PER_KW_SINGLE_PHASE = 4.348

export function ampsPerKw(phases: Phases): number {
  return phases === 3 ? AMPS_PER_KW_THREE_PHASE : AMPS_PER_KW_SINGLE_PHASE
}

/** Current needed to absorb a given power. */
export function kwToAmps(kw: number, phases: Phases): number {
  return kw * ampsPerKw(phases)
}

/** Power drawn at a given current. */
export function ampsToKw(amps: number, phases: Phases): number {
  return amps / ampsPerKw(phases)
}

/**
 * Charger setpoints are whole amps: Easee takes an integer `dynamicChargerCurrent`, and asking for
 * a fractional current would mean rewriting the setpoint on every rounding wobble.
 */
export function floorToWholeAmps(amps: number): number {
  return Math.floor(amps + 1e-9)
}

/** Energy delivered at `amps` over `minutes`, in kWh. */
export function energyKwh(amps: number, phases: Phases, minutes: number): number {
  return ampsToKw(amps, phases) * (minutes / 60)
}

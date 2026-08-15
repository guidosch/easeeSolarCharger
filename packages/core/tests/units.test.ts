import { describe, expect, it } from 'vitest'
import { ampsToKw, energyKwh, floorToWholeAmps, kwToAmps } from '../src/units.js'

describe('kW ↔ A conversion (research R2)', () => {
  it('reproduces the canvas modulation-floor figures', () => {
    expect(ampsToKw(6, 3)).toBeCloseTo(4.16, 2)
    expect(ampsToKw(6, 1)).toBeCloseTo(1.38, 2)
  })

  it('puts an 11 kW charger at 16 A three-phase', () => {
    // 16 A three-phase is 11.09 kW; "11 kW" is the nameplate rounding, not the arithmetic.
    expect(ampsToKw(16, 3)).toBeCloseTo(11.09, 2)
    expect(Math.round(ampsToKw(16, 3))).toBe(11)
    expect(kwToAmps(11, 3)).toBeCloseTo(15.87, 2)
  })

  it('round-trips', () => {
    expect(kwToAmps(ampsToKw(12, 3), 3)).toBeCloseTo(12, 6)
    expect(kwToAmps(ampsToKw(12, 1), 1)).toBeCloseTo(12, 6)
  })
})

describe('setpoint rounding', () => {
  it('floors to whole amps, so a fractional surplus never asks for more than is available', () => {
    expect(floorToWholeAmps(9.99)).toBe(9)
    expect(floorToWholeAmps(6)).toBe(6)
    expect(floorToWholeAmps(5.999999999)).toBe(6) // absorbs float noise, not a real 0.5 A
  })
})

describe('energyKwh', () => {
  it('gives the energy delivered over one five-minute cycle', () => {
    // 16 A three-phase ≈ 11.09 kW for 5 minutes ≈ 0.924 kWh.
    expect(energyKwh(16, 3, 5)).toBeCloseTo(0.924, 3)
    expect(energyKwh(0, 3, 5)).toBe(0)
  })
})

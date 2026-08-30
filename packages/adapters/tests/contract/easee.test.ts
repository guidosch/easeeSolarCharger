import { describe, expect, it } from 'vitest'
import { BudgetLimiter, PROVIDER_BUDGETS } from '../../src/http/budget.js'
import { HttpClient } from '../../src/http/client.js'
import {
  EaseeObservationsClient,
  parseObservations,
  wasReset,
} from '../../src/easee/observations.js'
import { EaseeSettingsClient, assertOnlyDynamicCurrent } from '../../src/easee/settings.js'
import { loadRecording, stubFetch, testDeps } from './support/recordings.js'

const START = Date.parse('2026-08-14T14:35:00Z')
const OBSERVED_AT = '2026-08-14T14:35:00Z'

const observationBudget = () =>
  new BudgetLimiter({
    provider: 'easee',
    dailyLimit: null,
    burst: PROVIDER_BUDGETS.easeeObservations,
    startedAtMs: START,
  })

const settingsBudget = () =>
  new BudgetLimiter({
    provider: 'easee',
    dailyLimit: null,
    burst: PROVIDER_BUDGETS.easeeSettings,
    startedAtMs: START,
  })

describe('Easee observations — happy-path parse of the committed recording', () => {
  it('maps a charging charger onto the domain model', async () => {
    const recording = loadRecording('providers/easee/observations-opmode-3.json')
    const { fetch, calls } = stubFetch([recording])
    const client = new EaseeObservationsClient(
      new HttpClient(testDeps(fetch)),
      'https://api.easee.com',
      observationBudget(),
    )

    const result = await client.read('EH123456', 'token', OBSERVED_AT)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual({
        opMode: 3,
        deliveredCurrentA: 12,
        dynamicCurrentA: 12,
        totalPowerKw: 8.31,
        sessionEnergyKwh: 6.4,
        lifetimeEnergyKwh: 1240.9,
        reasonForNoCurrent: 0,
        cableLocked: true,
        observedAt: '2026-08-14T14:35:12.123Z',
      })
    }
    // The deprecated /api/chargers/{id}/state endpoint (removed 2026-09-01) must never be called,
    // and the observations endpoint is addressed *without* an `/api` segment — with one, the Easee
    // API Gateway answers 403 for every charger.
    expect(calls[0]?.url).toBe(
      'https://api.easee.com/state/EH123456/observations?ids=109,114,120,121,124,48,96,103',
    )
    expect(calls[0]?.url).not.toMatch(/\/api\/chargers\/[^/]+\/state/)
  })

  it('parses every opMode the charger can report', () => {
    for (const mode of [0, 1, 2, 3, 4, 5, 6]) {
      const recording = loadRecording(`providers/easee/observations-opmode-${mode}.json`)
      const parsed = parseObservations(recording.body, OBSERVED_AT)
      expect(parsed.ok).toBe(true)
      if (parsed.ok) expect(parsed.value.opMode).toBe(mode)
    }
  })
})

describe('Easee observations — failure behaviour', () => {
  it('reports a malformed payload as a typed error, never a silent default', async () => {
    const recording = loadRecording('providers/easee/observations-malformed.json')
    const { fetch } = stubFetch([recording])
    const client = new EaseeObservationsClient(
      new HttpClient(testDeps(fetch)),
      'https://api.easee.com',
      observationBudget(),
    )

    const result = await client.read('EH123456', 'token', OBSERVED_AT)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('malformed')
  })

  it('treats a missing observation 109 as unknowable rather than assuming a state', () => {
    const parsed = parseObservations([{ id: 114, value: '12' }], OBSERVED_AT)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error.message).toContain('109')
  })

  it('honours a 429 with Retry-After from the committed recording', async () => {
    const rateLimited = loadRecording('providers/easee/rate-limited-429.json')
    const okRecording = loadRecording('providers/easee/observations-opmode-3.json')
    const { fetch } = stubFetch([rateLimited, okRecording])
    const deps = testDeps(fetch)
    const client = new EaseeObservationsClient(
      new HttpClient(deps),
      'https://api.easee.com',
      observationBudget(),
    )

    const result = await client.read('EH123456', 'token', OBSERVED_AT)

    expect(result.ok).toBe(true)
    expect(deps.slept).toEqual([30_000])
  })

  it('refuses to call once the rolling read budget is exhausted', async () => {
    const budget = observationBudget()
    for (let i = 0; i < PROVIDER_BUDGETS.easeeObservations.capacity; i += 1) budget.consume(START)

    const { fetch, calls } = stubFetch([
      loadRecording('providers/easee/observations-opmode-3.json'),
    ])
    const client = new EaseeObservationsClient(
      new HttpClient(testDeps(fetch)),
      'https://api.easee.com',
      budget,
    )

    const result = await client.read('EH123456', 'token', OBSERVED_AT)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('budget_exhausted')
    expect(calls).toHaveLength(0)
  })
})

describe('Easee setpoint reset after a plug-in (research R5)', () => {
  it('detects the reset from the observation the charger reports after plug-in', () => {
    // opMode 2 (AwaitingStart) is what a plug-in looks like, and its dynamicChargerCurrent has
    // been reset to 0 while this system still believes it commanded 12 A.
    const recording = loadRecording('providers/easee/observations-opmode-2.json')
    const parsed = parseObservations(recording.body, OBSERVED_AT)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(parsed.value.dynamicCurrentA).toBe(0)
    expect(
      wasReset({ commandedCurrentA: 12, dynamicChargerCurrentA: parsed.value.dynamicCurrentA }),
    ).toBe(true)
  })

  it('does not cry reset when the setpoint stuck', () => {
    expect(wasReset({ commandedCurrentA: 12, dynamicChargerCurrentA: 12 })).toBe(false)
    expect(wasReset({ commandedCurrentA: 0, dynamicChargerCurrentA: 0 })).toBe(false)
  })
})

describe('Easee settings — only dynamicChargerCurrent may ever be written (Principle I)', () => {
  it('rejects any other setting at the code level, not by convention', () => {
    const attempt = assertOnlyDynamicCurrent({ maxChargerCurrent: 32 })
    expect(attempt.ok).toBe(false)
    if (!attempt.ok) expect(attempt.error.message).toContain('maxChargerCurrent')

    const alsoRejected = assertOnlyDynamicCurrent({
      dynamicChargerCurrent: 12,
      maxCircuitCurrentP1: 63,
    })
    expect(alsoRejected.ok).toBe(false)
  })

  it('rejects a nonsensical current instead of sending it to the hardware', () => {
    expect(assertOnlyDynamicCurrent({ dynamicChargerCurrent: -1 }).ok).toBe(false)
    expect(assertOnlyDynamicCurrent({ dynamicChargerCurrent: Number.NaN }).ok).toBe(false)
    expect(assertOnlyDynamicCurrent({ dynamicChargerCurrent: 0 }).ok).toBe(true)
  })

  it('writes the setpoint and sends nothing else in the body', async () => {
    const { fetch, calls } = stubFetch([
      loadRecording('providers/easee/settings-accepted-202.json'),
    ])
    const client = new EaseeSettingsClient(
      new HttpClient(testDeps(fetch)),
      'https://api.easee.com',
      settingsBudget(),
    )

    const result = await client.setDynamicCurrent('EH123456', 12, 'token')

    expect(result.ok).toBe(true)
    expect(calls[0]?.url).toBe('https://api.easee.com/api/chargers/EH123456/settings')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ dynamicChargerCurrent: 12 })
  })

  it('refuses the 21st write in a minute before making it', async () => {
    const budget = settingsBudget()
    const { fetch, calls } = stubFetch([
      loadRecording('providers/easee/settings-accepted-202.json'),
    ])
    const client = new EaseeSettingsClient(
      new HttpClient(testDeps(fetch)),
      'https://api.easee.com',
      budget,
    )

    for (let i = 0; i < 20; i += 1) budget.consume(START)
    const result = await client.setDynamicCurrent('EH123456', 12, 'token')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('budget_exhausted')
    expect(calls).toHaveLength(0)
  })
})

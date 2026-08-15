import { DEFAULT_SCHEDULER_CONFIG } from '@app/core'
import { describe, expect, it } from 'vitest'
import { BudgetLimiter, PROVIDER_BUDGETS } from '../../src/http/budget.js'
import { HttpClient } from '../../src/http/client.js'
import { SolarEdgeClient, parseCurrentPowerFlow } from '../../src/solaredge/index.js'
import { callsPerDay, checkDaylightGate, daylightGate } from '../../src/solaredge/budget.js'
import { loadRecording, stubFetch, testDeps } from './support/recordings.js'

const START = Date.parse('2026-06-10T12:00:00Z')
const OBSERVED_AT = '2026-06-10T12:00:00Z'
const SITE = { latitude: 47.3769, longitude: 8.5417 }

const budget = (spentToday = 0) =>
  new BudgetLimiter({
    provider: 'solaredge',
    dailyLimit: PROVIDER_BUDGETS.solarEdgeDaily,
    spentToday,
    startedAtMs: START,
  })

const client = (fetchStub: typeof globalThis.fetch, spentToday = 0) =>
  new SolarEdgeClient(
    new HttpClient(testDeps(fetchStub, '2026-06-10T12:00:00Z')),
    'https://monitoringapi.solaredge.com',
    'key',
    '12345',
    budget(spentToday),
  )

describe('SolarEdge — direction comes from `connections`, never from the sign', () => {
  it('reads an export as positive surplus', async () => {
    const { fetch, calls } = stubFetch([
      loadRecording('providers/solaredge/currentPowerFlow-export.json'),
    ])

    const result = await client(fetch).currentPowerFlow(OBSERVED_AT)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual({
        gridExportKw: 4.2,
        loadKw: 3.1,
        pvKw: 7.3,
        observedAt: OBSERVED_AT,
      })
    }
    expect(calls[0]?.url).toContain('/site/12345/currentPowerFlow')
  })

  it('reads an import as negative surplus, from the same positive magnitude', async () => {
    const { fetch } = stubFetch([loadRecording('providers/solaredge/currentPowerFlow-import.json')])

    const result = await client(fetch).currentPowerFlow(OBSERVED_AT)

    expect(result.ok).toBe(true)
    // The payload says `currentPower: 2.5` in *both* directions. Getting this wrong would tell the
    // optimizer there is 2.5 kW of surplus while the building is drawing 2.5 kW from the grid.
    if (result.ok) expect(result.value.gridExportKw).toBe(-2.5)
  })

  it('refuses a payload that states no direction at all', () => {
    const result = parseCurrentPowerFlow(
      {
        siteCurrentPowerFlow: {
          connections: [{ from: 'PV', to: 'Load' }],
          GRID: { currentPower: 3 },
        },
      },
      OBSERVED_AT,
    )
    expect(result.ok).toBe(false)
  })
})

describe('SolarEdge — failure behaviour', () => {
  it('reports a missing GRID element as a typed error (open item O1)', async () => {
    const { fetch } = stubFetch([
      loadRecording('providers/solaredge/currentPowerFlow-no-grid.json'),
    ])

    const result = await client(fetch).currentPowerFlow(OBSERVED_AT)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('malformed')
      expect(result.error.message).toContain('GRID')
    }
  })

  it('honours a 429 with Retry-After from the committed recording', async () => {
    const { fetch } = stubFetch([
      loadRecording('providers/solaredge/rate-limited-429.json'),
      loadRecording('providers/solaredge/currentPowerFlow-export.json'),
    ])
    const deps = testDeps(fetch, '2026-06-10T12:00:00Z')
    const solarEdge = new SolarEdgeClient(
      new HttpClient(deps),
      'https://monitoringapi.solaredge.com',
      'key',
      '12345',
      budget(),
    )

    const result = await solarEdge.currentPowerFlow(OBSERVED_AT)

    expect(result.ok).toBe(true)
    expect(deps.slept).toEqual([60_000])
  })

  it('refuses to call once the 300/day budget is spent', async () => {
    const { fetch, calls } = stubFetch([
      loadRecording('providers/solaredge/currentPowerFlow-export.json'),
    ])

    const result = await client(fetch, PROVIDER_BUDGETS.solarEdgeDaily).currentPowerFlow(
      OBSERVED_AT,
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('budget_exhausted')
    expect(calls).toHaveLength(0)
  })
})

describe('SolarEdge — the daylight gate (FR-045, research R3)', () => {
  const config = DEFAULT_SCHEDULER_CONFIG

  it('is open at midday in June and closed at night', () => {
    expect(daylightGate({ nowIso: '2026-06-10T12:00:00Z', ...SITE, config }).open).toBe(true)
    expect(daylightGate({ nowIso: '2026-06-10T01:00:00Z', ...SITE, config }).open).toBe(false)
  })

  it('is closed for the whole winter window, whatever the sun is doing', () => {
    const verdict = daylightGate({ nowIso: '2026-01-15T12:00:00Z', ...SITE, config })
    expect(verdict.open).toBe(false)
    expect(verdict.reason).toBe('winter')
  })

  it('refuses the call outside the gate rather than spending budget on it', () => {
    const refused = checkDaylightGate({ nowIso: '2026-06-10T01:00:00Z', ...SITE, config })
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error.kind).toBe('gated')
  })

  it('keeps the worst case inside the 300/day limit (research R3)', () => {
    // The longest day of the year at a five-minute cadence — R3's 192-call figure.
    const calls = callsPerDay({
      dayStartIso: '2026-06-21T00:00:00Z',
      stepMinutes: 5,
      ...SITE,
      config,
    })
    expect(calls).toBeLessThanOrEqual(192)
    expect(calls).toBeGreaterThan(150) // and it is not accidentally gating out the whole day
  })
})

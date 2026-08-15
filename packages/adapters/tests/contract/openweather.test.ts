import { describe, expect, it } from 'vitest'
import { BudgetLimiter, PROVIDER_BUDGETS } from '../../src/http/budget.js'
import { HttpClient } from '../../src/http/client.js'
import { OpenWeatherClient, parseForecast } from '../../src/openweather/index.js'
import { loadRecording, stubFetch, testDeps } from './support/recordings.js'

const START = Date.parse('2026-06-10T06:00:00Z')
const NOW = '2026-06-10T06:00:00Z'
const SITE = { latitude: 47.3769, longitude: 8.5417 }

const budget = (spentToday = 0) =>
  new BudgetLimiter({
    provider: 'openweather',
    dailyLimit: PROVIDER_BUDGETS.openWeatherDaily,
    spentToday,
    startedAtMs: START,
  })

const client = (fetchStub: typeof globalThis.fetch, spentToday = 0) =>
  new OpenWeatherClient(
    new HttpClient(testDeps(fetchStub, '2026-06-10T06:00:00Z')),
    'https://api.openweathermap.org',
    'key',
    SITE,
    budget(spentToday),
  )

describe('OpenWeatherMap — parsing the committed recording', () => {
  it('averages the daytime cloud cover for the rest of today and for tomorrow', async () => {
    const { fetch, calls } = stubFetch([
      loadRecording('providers/openweather/forecast-clear-tomorrow.json'),
    ])

    const result = await client(fetch).forecast(NOW)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.cloudCoverRestOfTodayPct).toBe(85)
      expect(result.value.cloudCoverTomorrowPct).toBe(20)
      expect(result.value.fetchedAt).toBe(NOW)
    }
    expect(calls[0]?.url).toContain('/data/2.5/forecast')
    expect(calls[0]?.url).toContain('lat=47.3769')
  })
})

describe('OpenWeatherMap — deferRecommended (research R4)', () => {
  it('is true when tomorrow is at least 25 points less cloudy', async () => {
    const { fetch } = stubFetch([
      loadRecording('providers/openweather/forecast-clear-tomorrow.json'),
    ])
    const result = await client(fetch).forecast(NOW)
    expect(result.ok && result.value.deferRecommended).toBe(true)
  })

  it('is false when tomorrow is no better', async () => {
    const { fetch } = stubFetch([
      loadRecording('providers/openweather/forecast-no-improvement.json'),
    ])
    const result = await client(fetch).forecast(NOW)
    expect(result.ok && result.value.deferRecommended).toBe(false)
  })

  it('is false at a margin of exactly 24 points, and true at 25', () => {
    const build = (todayPct: number, tomorrowPct: number) => ({
      list: [...blocksFor('2026-06-10', todayPct), ...blocksFor('2026-06-11', tomorrowPct)],
    })

    const justUnder = parseForecast(build(60, 36), NOW, 'Europe/Zurich')
    expect(justUnder.ok && justUnder.value.deferRecommended).toBe(false)

    const justOver = parseForecast(build(60, 35), NOW, 'Europe/Zurich')
    expect(justOver.ok && justOver.value.deferRecommended).toBe(true)
  })

  it('never recommends deferring when today has no daylight left to compare against', () => {
    const lateEvening = '2026-06-10T20:00:00Z'
    const result = parseForecast(
      { list: [...blocksFor('2026-06-10', 90), ...blocksFor('2026-06-11', 5)] },
      lateEvening,
      'Europe/Zurich',
    )
    expect(result.ok && result.value.deferRecommended).toBe(false)
  })

  it('leaves the other two R4 conditions to the core', () => {
    // A client cannot know how far away a deadline is or whether the target stays reachable — those
    // are applied by `decide` (T082). This test exists to pin that boundary, not to duplicate it.
    const result = parseForecast(
      { list: [...blocksFor('2026-06-10', 90), ...blocksFor('2026-06-11', 5)] },
      NOW,
      'Europe/Zurich',
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(Object.keys(result.value)).not.toContain('deadline')
  })
})

describe('OpenWeatherMap — failure behaviour', () => {
  it('reports a malformed payload as a typed error, never as a silent zero', async () => {
    const { fetch } = stubFetch([loadRecording('providers/openweather/forecast-malformed.json')])

    const result = await client(fetch).forecast(NOW)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('malformed')
  })

  it('refuses the fifth call of the day (FR-045)', async () => {
    const { fetch, calls } = stubFetch([
      loadRecording('providers/openweather/forecast-clear-tomorrow.json'),
    ])

    const result = await client(fetch, PROVIDER_BUDGETS.openWeatherDaily).forecast(NOW)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('budget_exhausted')
    expect(calls).toHaveLength(0)
  })

  it('fails rather than guessing when the forecast covers no daytime block tomorrow', () => {
    const result = parseForecast({ list: blocksFor('2026-06-10', 50) }, NOW, 'Europe/Zurich')
    expect(result.ok).toBe(false)
  })
})

/** Three-hourly blocks covering the local daytime window of one day. */
function blocksFor(
  localDate: string,
  cloudsPct: number,
): { dt: number; clouds: { all: number } }[] {
  return [9, 12, 15].map((hour) => ({
    dt: Date.parse(`${localDate}T${String(hour).padStart(2, '0')}:00:00+02:00`) / 1000,
    clouds: { all: cloudsPct },
  }))
}

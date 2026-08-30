import { describe, expect, it } from 'vitest'
import { BudgetLimiter, TokenBucket } from '../../src/http/budget.js'
import { HttpClient } from '../../src/http/client.js'
import { emptyCallStats, ok } from '../../src/http/errors.js'
import { stubFetch, testDeps } from './support/recordings.js'

const START = Date.parse('2026-08-14T14:35:00Z')
const passthrough = () => ok({ fine: true })

describe('HttpClient — 429 handling (Principle IV)', () => {
  it('honours Retry-After, counts the rate limit, and surfaces it typed', async () => {
    const { fetch } = stubFetch([
      { status: 429, headers: { 'retry-after': '2' }, body: { title: 'Too Many Requests' } },
      { status: 200, body: { fine: true } },
    ])
    const deps = testDeps(fetch)
    const stats = { easee: emptyCallStats(100) }
    const client = new HttpClient(deps, stats)

    const result = await client.request({
      provider: 'easee',
      url: 'https://api.easee.com/state/X/observations',
      parse: passthrough,
    })

    expect(result.ok).toBe(true)
    expect(deps.slept).toEqual([2000]) // exactly what Retry-After asked for, not our own backoff
    expect(stats.easee.rateLimited).toBe(1)
    expect(stats.easee.calls).toBe(2)
  })

  it('does not retry early when Retry-After exceeds the backoff ceiling', async () => {
    const { fetch, calls } = stubFetch([
      { status: 429, headers: { 'retry-after': '300' }, body: {} },
    ])
    const deps = testDeps(fetch)
    const result = await new HttpClient(deps).request({
      provider: 'solaredge',
      url: 'https://monitoringapi.solaredge.com/site/1/currentPowerFlow',
      parse: passthrough,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('rate_limited')
    expect(calls).toHaveLength(1)
    expect(deps.slept).toEqual([])
  })
})

describe('HttpClient — timeouts and retries', () => {
  it('retries a timeout a bounded number of times with jittered backoff, then fails typed', async () => {
    const { fetch, calls } = stubFetch([{ fail: 'timeout' }])
    const deps = testDeps(fetch)
    const result = await new HttpClient(deps).request({
      provider: 'openweather',
      url: 'https://api.openweathermap.org/data/2.5/forecast',
      retries: 2,
      parse: passthrough,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('timeout')
      expect(result.error.attempts).toBe(3)
    }
    expect(calls).toHaveLength(3) // the first attempt plus two retries — bounded, not endless
    // 500ms and 1000ms exponential, each scaled by the injected jitter factor of 0.75.
    expect(deps.slept).toEqual([375, 750])
  })

  it('does not retry a 4xx that will never succeed', async () => {
    const { fetch, calls } = stubFetch([{ status: 400, body: { error: 'bad request' } }])
    const result = await new HttpClient(testDeps(fetch)).request({
      provider: 'easee',
      url: 'https://api.easee.com/api/accounts/login',
      parse: passthrough,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('http_error')
    expect(calls).toHaveLength(1)
  })

  it('reports a non-JSON body as malformed rather than defaulting silently', async () => {
    const { fetch } = stubFetch([])
    const client = new HttpClient({
      ...testDeps(fetch),
      fetch: (async () =>
        new Response('<html>maintenance</html>', { status: 200 })) as typeof globalThis.fetch,
    })
    const result = await client.request({
      provider: 'solaredge',
      url: 'https://monitoringapi.solaredge.com/site/1/currentPowerFlow',
      parse: passthrough,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('malformed')
  })
})

describe('BudgetLimiter — budgets are refused before the call is made', () => {
  it('refuses once the daily cap is spent, without issuing a request', async () => {
    const budget = new BudgetLimiter({
      provider: 'solaredge',
      dailyLimit: 300,
      spentToday: 300,
      startedAtMs: START,
    })
    const { fetch, calls } = stubFetch([{ status: 200, body: {} }])
    const result = await new HttpClient(testDeps(fetch)).request(
      {
        provider: 'solaredge',
        url: 'https://monitoringapi.solaredge.com/site/1/currentPowerFlow',
        parse: passthrough,
      },
      budget,
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('budget_exhausted')
    expect(calls).toHaveLength(0) // the cap was never discovered from a 429
  })

  it('carries the day already spent, so a cold start does not reset the budget', () => {
    const budget = new BudgetLimiter({
      provider: 'solaredge',
      dailyLimit: 300,
      spentToday: 191,
      startedAtMs: START,
    })
    expect(budget.remainingToday(START)).toBe(109)
    budget.consume(START)
    expect(budget.remainingToday(START)).toBe(108)
  })

  it('rolls over at the day boundary', () => {
    const budget = new BudgetLimiter({
      provider: 'openweather',
      dailyLimit: 4,
      spentToday: 4,
      startedAtMs: START,
    })
    expect(budget.check(START).ok).toBe(false)
    expect(budget.check(Date.parse('2026-08-15T00:05:00Z')).ok).toBe(true)
  })

  it('enforces the Easee 20-writes-per-minute burst limit', () => {
    const budget = new BudgetLimiter({
      provider: 'easee',
      dailyLimit: null,
      burst: { capacity: 20, perMs: 60_000 },
      startedAtMs: START,
    })
    for (let i = 0; i < 20; i += 1) {
      expect(budget.check(START).ok).toBe(true)
      budget.consume(START)
    }
    expect(budget.check(START).ok).toBe(false)
    // Spreading the writes across the cycle is what a 30-charger worst case has to do (research R5).
    expect(budget.msUntilNext(START)).toBeGreaterThan(0)
    expect(budget.check(START + 60_000).ok).toBe(true)
  })
})

describe('TokenBucket', () => {
  it('refills continuously rather than in steps', () => {
    const bucket = new TokenBucket(20, 20 / 60_000, START, 0)
    expect(bucket.available(START)).toBe(0)
    expect(bucket.available(START + 30_000)).toBeCloseTo(10, 6)
    expect(bucket.available(START + 120_000)).toBe(20) // capped at capacity
  })
})

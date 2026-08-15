import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { HttpDeps } from '../../../src/http/client.js'

export type Recording = {
  status: number
  headers?: Record<string, string>
  body: unknown
}

const FIXTURES = fileURLToPath(new URL('../../../../../fixtures/', import.meta.url))

export function loadRecording(relativePath: string): Recording {
  return JSON.parse(readFileSync(`${FIXTURES}${relativePath}`, 'utf8')) as Recording
}

/** A bare body (the format the Phase 0 spikes wrote) rather than an HTTP envelope. */
export function loadBody(relativePath: string): unknown {
  return JSON.parse(readFileSync(`${FIXTURES}${relativePath}`, 'utf8'))
}

export function responseFrom(recording: Recording): Response {
  const body = recording.body === null ? null : JSON.stringify(recording.body)
  return new Response(body, {
    status: recording.status,
    headers: recording.headers ?? {},
  })
}

export type FetchStep = Recording | { fail: 'timeout' | 'network' }

/**
 * A `fetch` stub that replays a fixed sequence. The last step repeats, so a test only has to list
 * the steps it cares about.
 */
export function stubFetch(steps: FetchStep[]): {
  fetch: typeof globalThis.fetch
  calls: { url: string; init?: RequestInit }[]
} {
  const calls: { url: string; init?: RequestInit }[] = []
  let index = 0
  type FetchInput = Parameters<typeof globalThis.fetch>[0]
  const fetchStub = (async (input: FetchInput, init?: RequestInit) => {
    calls.push({ url: String(input), ...(init ? { init } : {}) })
    const step = steps[Math.min(index, steps.length - 1)]
    index += 1
    if (step && 'fail' in step) {
      const error = new Error(step.fail === 'timeout' ? 'aborted' : 'socket hang up')
      error.name = step.fail === 'timeout' ? 'AbortError' : 'TypeError'
      throw error
    }
    return responseFrom(step as Recording)
  }) as typeof globalThis.fetch
  return { fetch: fetchStub, calls }
}

/**
 * Deterministic dependencies: no real waiting (so a bounded-retry test runs in milliseconds), and
 * a fixed jitter source so the backoff sequence is assertable.
 */
export function testDeps(
  fetchStub: typeof globalThis.fetch,
  startedAtIso = '2026-08-14T14:35:00Z',
): HttpDeps & { slept: number[] } {
  const slept: number[] = []
  // The clock must agree with any BudgetLimiter under test: daily budgets roll on the UTC date, so
  // a clock in a different day than the limiter's start silently hands back a fresh quota.
  let clock = Date.parse(startedAtIso)
  return {
    fetch: fetchStub,
    sleep: async (ms: number) => {
      slept.push(ms)
      clock += ms
    },
    now: () => clock,
    random: () => 0.5,
    slept,
  }
}

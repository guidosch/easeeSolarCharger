import { REACHABILITY_HORIZON_DAYS, TARIFF_WALK_STEP_MINUTES } from './config.js'
import type { SchedulerConfig, SeasonMode, TariffWindow } from './types.js'

/**
 * The calendar (T024, FR-025).
 *
 * Every function here takes an *instant* and interprets it in `config.timezone` via the ICU time
 * zone database. There is no manual UTC-offset arithmetic anywhere in this file, which is what
 * makes the two DST days — 2026-10-25 (a doubled 02:00) and 2027-03-28 (a missing 02:00) — behave
 * without special cases: a step of five minutes is always five real minutes, and the local
 * wall-clock time it lands on is whatever the tz database says it is.
 */

const MS_PER_MINUTE = 60_000

/**
 * `Intl.DateTimeFormat` construction is expensive and the reachability walk calls it thousands of
 * times per cycle. The cache is a pure memo — it cannot influence a decision, only its cost.
 */
const formatterCache = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone)
  if (cached) return cached
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  formatterCache.set(timeZone, created)
  return created
}

export type ZonedParts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

/** Parses an ISO instant. Throws only on input that never passed boundary validation. */
export function parseInstant(iso: string): number {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) throw new TypeError(`not an ISO-8601 instant: ${iso}`)
  return ms
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString()
}

/** The local wall-clock reading of an instant, in the given zone. */
export function zonedParts(instantMs: number, timeZone: string): ZonedParts {
  const parts = formatter(timeZone).formatToParts(new Date(instantMs))
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type)
    return found ? Number(found.value) : 0
  }
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  }
}

function hhmmToMinutes(hhmm: string): number {
  const [h = '0', m = '0'] = hhmm.split(':')
  return Number(h) * 60 + Number(m)
}

function mmddToNumber(mmdd: string): number {
  const [m = '0', d = '0'] = mmdd.split('-')
  return Number(m) * 100 + Number(d)
}

function tariffWindowAtMs(instantMs: number, config: SchedulerConfig): TariffWindow {
  const { hour, minute } = zonedParts(instantMs, config.timezone)
  const minutes = hour * 60 + minute
  for (const [start, end] of config.highPriceWindows) {
    // Half-open [start, end): 11:00 is high, 13:00 is already low.
    if (minutes >= hhmmToMinutes(start) && minutes < hhmmToMinutes(end)) return 'high'
  }
  return 'low'
}

/** High-price windows are 11:00–13:00 and 18:00–20:00 Europe/Zurich (FR-018). */
export function tariffWindowAt(nowIso: string, config: SchedulerConfig): TariffWindow {
  return tariffWindowAtMs(parseInstant(nowIso), config)
}

/** Solar optimization is disabled from 1 October to the end of February (FR-023). */
export function seasonModeAt(nowIso: string, config: SchedulerConfig): SeasonMode {
  const { month, day } = zonedParts(parseInstant(nowIso), config.timezone)
  const md = month * 100 + day
  const from = mmddToNumber(config.winterWindow.from)
  const toExclusive = mmddToNumber(config.winterWindow.toExclusive)
  // The window wraps the year end, so "inside" means at/after 10-01 or before 03-01. 29 February
  // needs no special case: it is simply another date below 03-01.
  return md >= from || md < toExclusive ? 'winter' : 'solar'
}

// --- Daylight -------------------------------------------------------------------------------

const ZENITH_OFFICIAL_DEG = 90.833

const toRad = (deg: number): number => (deg * Math.PI) / 180
const toDeg = (rad: number): number => (rad * 180) / Math.PI
const sinDeg = (deg: number): number => Math.sin(toRad(deg))
const cosDeg = (deg: number): number => Math.cos(toRad(deg))
const tanDeg = (deg: number): number => Math.tan(toRad(deg))

function normalise(value: number, range: number): number {
  const wrapped = value % range
  return wrapped < 0 ? wrapped + range : wrapped
}

function dayOfYearUtc(instantMs: number): number {
  const d = new Date(instantMs)
  const startOfYear = Date.UTC(d.getUTCFullYear(), 0, 1)
  const startOfDay = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  return Math.round((startOfDay - startOfYear) / 86_400_000) + 1
}

type SunEvent =
  { kind: 'time'; utcHours: number } | { kind: 'never_rises' } | { kind: 'never_sets' }

/**
 * Sunrise/sunset in UTC hours for the UTC calendar date of `instantMs` — the standard almanac
 * algorithm, accurate to about a minute, which is ample for a gate that only decides whether to
 * spend one SolarEdge call.
 *
 * Computed locally on purpose: R3 makes the daylight gate a *correctness* requirement (it is what
 * keeps the day's call count at ≤192 against a 300/day limit), so it must not itself depend on an
 * API call.
 */
function sunEvent(
  instantMs: number,
  latitude: number,
  longitude: number,
  rising: boolean,
): SunEvent {
  const N = dayOfYearUtc(instantMs)
  const lngHour = longitude / 15
  const t = N + ((rising ? 6 : 18) - lngHour) / 24

  const M = 0.9856 * t - 3.289
  const L = normalise(M + 1.916 * sinDeg(M) + 0.02 * sinDeg(2 * M) + 282.634, 360)

  let RA = normalise(toDeg(Math.atan(0.91764 * tanDeg(L))), 360)
  // Right ascension must land in the same quadrant as the sun's true longitude.
  RA += Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90
  RA /= 15

  const sinDec = 0.39782 * sinDeg(L)
  const cosDec = Math.cos(Math.asin(sinDec))

  const cosH =
    (cosDeg(ZENITH_OFFICIAL_DEG) - sinDec * sinDeg(latitude)) / (cosDec * cosDeg(latitude))
  if (cosH > 1) return { kind: 'never_rises' }
  if (cosH < -1) return { kind: 'never_sets' }

  const H = (rising ? 360 - toDeg(Math.acos(cosH)) : toDeg(Math.acos(cosH))) / 15
  const T = H + RA - 0.06571 * t - 6.622
  return { kind: 'time', utcHours: normalise(T - lngHour, 24) }
}

/**
 * Is the sun up at this instant? Gates the SolarEdge call (FR-045, research R3).
 *
 * Official sunrise/sunset (zenith 90.833°) rather than civil twilight: Zürich's longest day is
 * ~15.9 h of official daylight, which is what makes the worst case 192 calls/day. Civil twilight
 * would add roughly an hour at each end and break that budget.
 */
export function isDaylight(nowIso: string, latitude: number, longitude: number): boolean {
  const ms = parseInstant(nowIso)
  const sunrise = sunEvent(ms, latitude, longitude, true)
  const sunset = sunEvent(ms, latitude, longitude, false)
  if (sunrise.kind === 'never_sets' || sunset.kind === 'never_sets') return true
  if (sunrise.kind === 'never_rises' || sunset.kind === 'never_rises') return false

  const d = new Date(ms)
  const nowHours = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600
  return nowHours >= sunrise.utcHours && nowHours <= sunset.utcHours
}

// --- Low-price time ------------------------------------------------------------------------

/**
 * Minutes of low-price time between two instants, walked one optimizer cycle at a time.
 *
 * Walking real instants and asking the tz database for each one is what makes this correct on both
 * DST days: on 2026-10-25 the 02:00–03:00 wall-clock hour is counted twice because it really does
 * happen twice, and on 2027-03-28 it is not counted at all because it does not exist.
 */
export function lowPriceMinutesBetween(
  fromIso: string,
  toIso: string,
  config: SchedulerConfig,
): number {
  const from = parseInstant(fromIso)
  const horizonEnd = from + REACHABILITY_HORIZON_DAYS * 24 * 60 * MS_PER_MINUTE
  const to = Math.min(parseInstant(toIso), horizonEnd)
  if (to <= from) return 0

  const stepMs = TARIFF_WALK_STEP_MINUTES * MS_PER_MINUTE
  let minutes = 0
  for (let t = from; t < to; t += stepMs) {
    const spanMs = Math.min(stepMs, to - t)
    if (tariffWindowAtMs(t + spanMs / 2, config) === 'low') minutes += spanMs / MS_PER_MINUTE
  }
  return minutes
}

/**
 * The earliest deadline for which any energy can be delivered (FR-007).
 *
 * A target set now first takes effect at the next cycle (FR-008), and the charger cannot be
 * modulated below the floor — so the earliest useful deadline is the end of the first whole
 * low-price cycle that starts after that.
 */
export function earliestFeasibleDeadline(nowIso: string, config: SchedulerConfig): string {
  const stepMs = TARIFF_WALK_STEP_MINUTES * MS_PER_MINUTE
  const from = parseInstant(nowIso) + stepMs // one cycle of scheduling latency
  const horizonEnd = from + REACHABILITY_HORIZON_DAYS * 24 * 60 * MS_PER_MINUTE
  for (let t = from; t < horizonEnd; t += stepMs) {
    if (tariffWindowAtMs(t + stepMs / 2, config) === 'low') return toIso(t + stepMs)
  }
  // Unreachable in practice: the high-price windows cover four hours of any day.
  return toIso(from + stepMs)
}

/**
 * Time for the operator surface.
 *
 * Every instant this system stores is UTC, and every question an operator asks about one is in
 * site-local time: "why did lot 12 not charge between 14:00 and 15:00?" means 14:00 in Zurich,
 * which is what the tariff windows, the seasonal window and the cycle IDs are all reckoned in. The
 * zone is therefore pinned to the site rather than taken from the browser — an operator on holiday
 * in another zone must still read the same table as the one at their desk.
 *
 * `datetime-local` inputs are the part that needs care: the control has no zone at all, so a value
 * put into it is displayed as-is and a value read out of it has to be interpreted. Feeding it
 * `toISOString().slice(0, 16)` — which is UTC — is what made the trace view's range read two hours
 * behind the times in the table next to it, and then query a two-hour-shifted window on top.
 */
export const SITE_TIMEZONE = 'Europe/Zurich'

const LOCALE = 'en-GB'

/** Full date and time, for a table where the calendar day matters. */
export function formatInstant(iso: string): string {
  return new Date(iso).toLocaleString(LOCALE, { timeZone: SITE_TIMEZONE })
}

/** Time of day only, for a table that already covers a single chosen range. */
export function formatTimeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString(LOCALE, { timeZone: SITE_TIMEZONE })
}

const PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: SITE_TIMEZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

/** The site-local wall-clock reading of an instant, as a `datetime-local` value. */
export function toDateTimeLocal(instantMs: number): string {
  const parts = PARTS.formatToParts(new Date(instantMs))
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '00'
  return `${value('year')}-${value('month')}-${value('day')}T${value('hour')}:${value('minute')}`
}

/**
 * The instant a `datetime-local` value names in site-local time, as an ISO string.
 *
 * Read as UTC first, then corrected by the zone's offset *at that instant* — which is why the
 * correction runs twice: on a DST changeover the offset at the guess is not the offset at the
 * answer, and one more pass settles it. There is no manual offset arithmetic anywhere: the numbers
 * come from the tz database via `Intl`, so the two Swiss changeover days need no special case.
 */
export function fromDateTimeLocal(value: string): string {
  const asUtc = Date.parse(`${value}:00Z`)
  if (Number.isNaN(asUtc)) return new Date().toISOString()

  let instant = asUtc
  for (let pass = 0; pass < 2; pass += 1) {
    const offsetMs = Date.parse(`${toDateTimeLocal(instant)}:00Z`) - instant
    instant = asUtc - offsetMs
  }
  return new Date(instant).toISOString()
}

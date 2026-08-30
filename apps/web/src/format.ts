/**
 * Date wording for the user surface.
 *
 * The app is German-only, so the locale is pinned rather than taken from the browser: a device set
 * to English would otherwise render "Mon, 02:30 PM" inside a German sentence.
 */
const LOCALE = 'de-CH'

/**
 * A deadline reaches up to three days out, so the weekday alone is ambiguous only beyond a week —
 * the calendar day is carried alongside it to keep "Do 07:00" from reading as today's Thursday.
 */
export function formatDeadline(value: string | Date): string {
  return new Date(value).toLocaleString(LOCALE, {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** A past moment in the history list, where the calendar day matters. */
export function formatMoment(value: string | null): string {
  return value
    ? new Date(value).toLocaleString(LOCALE, {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—'
}

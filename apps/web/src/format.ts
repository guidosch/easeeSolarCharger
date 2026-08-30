/**
 * Date wording for the user surface.
 *
 * The app is German-only, so the locale is pinned rather than taken from the browser: a device set
 * to English would otherwise render "Mon, 02:30 PM" inside a German sentence.
 */
const LOCALE = 'de-CH'

/** A deadline is always within the next two days, so weekday and time say enough. */
export function formatDeadline(value: string | Date): string {
  return new Date(value).toLocaleString(LOCALE, {
    weekday: 'short',
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

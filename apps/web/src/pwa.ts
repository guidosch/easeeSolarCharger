import { ref } from 'vue'
import { registerSW } from 'virtual:pwa-register'

/**
 * Service-worker update handling.
 *
 * The worker is registered with `registerType: 'prompt'` (vite.config.ts), so a newly deployed
 * worker installs and then *waits* instead of seizing the page mid-session. That keeps the running
 * app on the bundle it was loaded with — the alternative is an app whose next asset request 404s
 * because the deploy replaced the hashed files it still points at.
 *
 * Handing over is therefore a deliberate act: `updateAvailable` raises the banner, `applyUpdate`
 * tells the waiting worker to take over, and workbox reloads the page once it does.
 */

/** True once a newer version has finished installing and is waiting to take over. */
export const updateAvailable = ref(false)

/** How often a long-lived install re-checks. A phone left on the charger list must still notice. */
const UPDATE_INTERVAL_MS = 60 * 60 * 1000

let update: (() => Promise<void>) | null = null

export function setupPwa(): void {
  const updateServiceWorker = registerSW({
    immediate: true,
    onNeedRefresh() {
      updateAvailable.value = true
    },
    onRegisteredSW(_url, registration) {
      if (!registration) return

      // Without this, an installed PWA only ever checks for a new worker on a cold launch. On a
      // phone the app is far more often resumed than launched, so a deploy could go unnoticed for
      // days. Checking when the app comes back to the foreground is what actually catches it;
      // the interval only covers a session left open in the foreground.
      const check = (): void => {
        if (navigator.onLine) void registration.update()
      }
      setInterval(check, UPDATE_INTERVAL_MS)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check()
      })
    },
  })

  // `true` reloads the page — but only after the waiting worker has actually taken control, which
  // workbox handles. Reloading any earlier would just reload the old version.
  update = () => updateServiceWorker(true)
}

export async function applyUpdate(): Promise<void> {
  updateAvailable.value = false
  await update?.()
}

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    vue(),
    VitePWA({
      // `prompt`, not `autoUpdate`. `autoUpdate` sets `skipWaiting()` + `clientsClaim()` in the
      // service worker, so a deploy makes the new worker seize the page that is already open and
      // `cleanupOutdatedCaches()` deletes the bundle that page is still running from — the app
      // then asks for an asset hash that no longer exists anywhere and dies. With `prompt` the new
      // worker waits, the running page keeps its own consistent cache, and src/pwa.ts asks the
      // user before handing over.
      registerType: 'prompt',
      // Copied verbatim into dist/ so the browser can fetch them for the install prompt.
      includeAssets: ['favicon.png', 'apple-touch-icon.png', 'icon.svg'],
      workbox: {
        // Never answer a navigation from the precache. The precached index.html names one exact
        // asset hash, and after a deploy those files are gone from Hosting, so serving a stale
        // shell is serving a broken app. Going to the network first means a launch with signal
        // always gets the shell that matches what is deployed.
        navigateFallback: null,
        runtimeCaching: [
          {
            urlPattern: ({ request }) => request.mode === 'navigate',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'app-shell',
              // Long enough to ride out a slow mobile connection, short enough that a dead
              // network does not look like a hung app. Offline falls back to the last shell seen.
              networkTimeoutSeconds: 5,
              // Every route rewrites to the same index.html, but the cache is keyed by request
              // URL, so allow one entry per screen the user has visited.
              expiration: { maxEntries: 20 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
      manifest: {
        lang: 'de',
        name: 'Solarladen',
        short_name: 'Solarladen',
        description:
          'Energiemenge und Termin festlegen – das Gebäude lädt Ihr Auto aus dem eigenen Solarüberschuss.',
        theme_color: '#0b6e4f',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        // Without these the install prompt falls back to a generated placeholder.
        // 'any' covers the launcher/task switcher, 'maskable' lets Android crop the
        // full-bleed artwork to whatever shape the launcher uses.
        icons: [
          { src: '/pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    // The PWA never talks to Firestore directly (data-model.md, "Security rules") — everything
    // goes through services/api.
    proxy: { '/api': { target: 'http://localhost:8081', changeOrigin: true } },
  },
})

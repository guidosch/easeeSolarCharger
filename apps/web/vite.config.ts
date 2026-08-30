import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    vue(),
    VitePWA({
      registerType: 'autoUpdate',
      // Copied verbatim into dist/ so the browser can fetch them for the install prompt.
      includeAssets: ['favicon.png', 'apple-touch-icon.png', 'icon.svg'],
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

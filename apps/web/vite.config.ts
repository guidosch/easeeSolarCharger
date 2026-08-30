import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    vue(),
    VitePWA({
      registerType: 'autoUpdate',
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

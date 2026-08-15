import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    vue(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Solar Charging',
        short_name: 'Charging',
        description:
          'Set an energy target and a deadline; the building charges your car from its own solar surplus.',
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

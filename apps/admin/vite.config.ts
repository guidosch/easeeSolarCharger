import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// Desktop-only operator surface (constitution, Technology & Deployment Constraints): no PWA, no
// responsive work, and a separate bundle so the admin view is never shipped to end users' phones.
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5174,
    proxy: { '/api': { target: 'http://localhost:8081', changeOrigin: true } },
  },
})

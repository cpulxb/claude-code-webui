import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const shared = fileURLToPath(new URL('../shared/src', import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Consume the shared package as source so its .ts goes through Vite's
    // transform instead of being treated as a prebuilt dependency.
    alias: { '@ccw/shared': `${shared}/index.ts` },
  },
  server: {
    host: '127.0.0.1',
    port: 5190,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3090', ws: true },
    },
  },
})

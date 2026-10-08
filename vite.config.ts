import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

/** Detected by the shadcn CLI. electron-vite reads electron.vite.config.ts. */
export default defineConfig({
  test: { include: ['src/**/*.test.{ts,tsx}'] },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve('src/renderer/src')
    }
  }
})

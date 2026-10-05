/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const src = fileURLToPath(new URL('./src', import.meta.url))
const shared = fileURLToPath(new URL('../shared', import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': src,
      '@shared': shared,
    },
  },
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
    fs: { allow: ['..'] },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
})

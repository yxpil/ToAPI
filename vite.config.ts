import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  plugins: [react()],
  base: './',
  root: 'src',
  resolve: {
    alias: {
      '@shared': r('./shared'),
      '@renderer': r('./src'),
    },
  },
  build: {
    outDir: r('./dist'),
    emptyOutDir: true,
    target: 'es2023',
  },
  server: {
    port: 5199,
    strictPort: true,
  },
})

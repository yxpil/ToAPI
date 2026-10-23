import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

const alias = {
  '@shared': r('./shared'),
  '@main': r('./electron'),
  '@renderer': r('./src'),
}

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          testTimeout: 20000,
        },
      },
    ],
    coverage: {
      include: ['electron/**', 'shared/**'],
      reporter: ['text', 'html'],
    },
  },
})

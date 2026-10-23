import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  sourcemap: true,
  external: ['electron'],
  alias: {
    '@shared': resolve(root, 'shared'),
    '@main': resolve(root, 'electron'),
  },
  logLevel: 'warning',
}

const ENTRIES = [
  ['electron/main.ts', 'dist-electron/main.cjs'],
  ['electron/preload.ts', 'dist-electron/preload.cjs'],
  ['electron/script/worker.ts', 'dist-electron/script-worker.cjs'],
]

for (const [entry, outfile] of ENTRIES) {
  await build({
    ...common,
    entryPoints: [resolve(root, entry)],
    outfile: resolve(root, outfile),
  })
}

console.log('electron bundle built -> dist-electron/')

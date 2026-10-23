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

await build({
  ...common,
  entryPoints: [resolve(root, 'electron/main.ts')],
  outfile: resolve(root, 'dist-electron/main.cjs'),
})
await build({
  ...common,
  entryPoints: [resolve(root, 'electron/preload.ts')],
  outfile: resolve(root, 'dist-electron/preload.cjs'),
})

console.log('electron bundle built -> dist-electron/')

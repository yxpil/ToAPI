import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))

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

// 无头 CLI（23 号文档 §5.3）：纯 Node 运行，不依赖 electron 运行时
await build({
  ...common,
  entryPoints: [resolve(root, 'electron/cli/main.ts')],
  outfile: resolve(root, 'dist-electron/cli.cjs'),
  define: { __TOAPI_VERSION__: JSON.stringify(pkg.version) },
})

console.log('electron bundle built -> dist-electron/')

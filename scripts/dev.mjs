// @author yxpil
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createServer } from 'vite'
import { context } from 'esbuild'

const require = createRequire(import.meta.url)
const electronBin = require('electron')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const port = 5199

const alias = {
  '@shared': resolve(root, 'shared'),
  '@main': resolve(root, 'electron'),
}
const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  sourcemap: true,
  external: ['electron'],
  alias,
  logLevel: 'warning',
}

// 主进程、preload 与脚本 worker 用 esbuild 重建；渲染层由 vite HMR 负责
const mainCtx = await context({
  ...common,
  entryPoints: [resolve(root, 'electron/main.ts')],
  outfile: resolve(root, 'dist-electron/main.cjs'),
})
const preloadCtx = await context({
  ...common,
  entryPoints: [resolve(root, 'electron/preload.ts')],
  outfile: resolve(root, 'dist-electron/preload.cjs'),
})
const workerCtx = await context({
  ...common,
  entryPoints: [resolve(root, 'electron/script/worker.ts')],
  outfile: resolve(root, 'dist-electron/script-worker.cjs'),
})
await mainCtx.rebuild()
await preloadCtx.rebuild()
await workerCtx.rebuild()

const vite = await createServer({
  configFile: resolve(root, 'vite.config.ts'),
  server: { port, strictPort: true },
  logLevel: 'warn',
})
await vite.listen(port)
console.log(`vite dev server on http://localhost:${port}`)

const child = spawn(electronBin, [resolve(root, '.')], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: `http://localhost:${port}` },
})

const shutdown = async () => {
  child.kill()
  await mainCtx.dispose()
  await preloadCtx.dispose()
  await workerCtx.dispose()
  await vite.close()
  process.exit(0)
}
child.on('exit', (code) => {
  console.log(`electron exited with ${code}`)
  process.exit(code ?? 0)
})
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

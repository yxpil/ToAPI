import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** 集成/沙箱测试前把脚本 worker 打出来，保证被测代码与真机走同一份产物 */
export default async function setup(): Promise<void> {
  await build({
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    entryPoints: [resolve(root, 'electron/script/worker.ts')],
    outfile: resolve(root, 'dist-electron/script-worker.cjs'),
    external: ['electron'],
    alias: { '@shared': resolve(root, 'shared'), '@main': resolve(root, 'electron') },
    logLevel: 'warning',
  })
}

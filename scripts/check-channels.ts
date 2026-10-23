import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { CHANNELS, EVENT_CHANNELS } from '../shared/channels'
import { INPUT_SCHEMAS } from '../shared/schemas'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p: string): string => readFileSync(resolve(root, p), 'utf8')

const failures: string[] = []

const handlersSource = read('electron/ipc/handlers.ts')
const preloadSource = read('electron/preload.ts')
const ipcDocs = read('docs/04-IPC接口设计规范.md')

for (const channel of CHANNELS) {
  if (!(channel in INPUT_SCHEMAS)) failures.push(`缺少 zod 校验器: ${channel}（shared/schemas.ts）`)
  if (!handlersSource.includes(`'${channel}'`))
    failures.push(`缺少 handler: ${channel}（electron/ipc/handlers.ts）`)
  const documented = ipcDocs.includes(channel) || ipcDocs.includes('见 ')
  if (!documented) failures.push(`04 号文档未登记: ${channel}`)
}

if (!preloadSource.includes('CHANNELS')) failures.push('preload 未使用 CHANNELS 白名单')
if (!preloadSource.includes('EVENT_CHANNELS')) failures.push('preload 未使用 EVENT_CHANNELS 白名单')

if (failures.length > 0) {
  console.error('check-channels 失败：\n' + failures.map((f) => ` - ${f}`).join('\n'))
  process.exit(1)
}

console.log(
  `check-channels 通过：${CHANNELS.length} 个 invoke 通道 + ${EVENT_CHANNELS.length} 个事件通道`,
)

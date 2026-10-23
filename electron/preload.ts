import { contextBridge, ipcRenderer } from 'electron'
import { CHANNELS, EVENT_CHANNELS } from '@shared/channels'

const ALLOWED_CHANNELS = new Set<string>(CHANNELS)
const ALLOWED_EVENTS = new Set<string>(EVENT_CHANNELS)

type Listener = (payload: unknown) => void

const toapi = {
  async invoke(channel: string, payload?: unknown): Promise<unknown> {
    if (!ALLOWED_CHANNELS.has(channel)) {
      throw new Error(`channel 不在白名单: ${channel}`)
    }
    return ipcRenderer.invoke(channel, payload ?? {})
  },

  on(channel: string, listener: Listener): () => void {
    if (!ALLOWED_EVENTS.has(channel)) throw new Error(`event 不在白名单: ${channel}`)
    const wrapped = (_event: unknown, payload: unknown): void => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  },
} as const

contextBridge.exposeInMainWorld('toapi', toapi)

export type ToapiBridge = typeof toapi

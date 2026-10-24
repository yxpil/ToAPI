// @author yxpil
import type { IpcResult } from '@shared/types'

declare global {
  interface Window {
    /** preload 暴露的唯一通信入口（06/19 号文档：白名单 + contextIsolation） */
    toapi: {
      invoke(channel: string, payload?: unknown): Promise<IpcResult<unknown>>
      on(channel: string, listener: (payload: unknown) => void): () => void
    }
  }
}

export {}

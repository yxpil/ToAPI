// @author yxpil
import { useEffect, useRef } from 'react'
import type { ChannelName, EventName, EventPayload, ReqOf, ResOf } from '@shared/channels'
import type { IpcError, IpcResult } from '@shared/types'

export class IpcFailure extends Error {
  constructor(readonly payload: IpcError) {
    super(payload.message)
    this.name = 'IpcFailure'
  }
}

/** 组件不直接调 window.toapi，一律经 store（19 号文档 §2.1） */
export async function invoke<K extends ChannelName>(channel: K, req: ReqOf<K>): Promise<ResOf<K>> {
  const result = (await window.toapi.invoke(channel, req)) as IpcResult<ResOf<K>>
  if (!result.ok) throw new IpcFailure(result.error)
  return result.data
}

/** 事件订阅：卸载自动退订，StrictMode 双挂载安全 */
export function useEvent<K extends EventName>(
  channel: K,
  handler: (payload: EventPayload<K>) => void,
): void {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    const off = window.toapi.on(channel, (payload) => ref.current(payload as EventPayload<K>))
    return () => off()
  }, [channel])
}

export const newCancelId = (): string =>
  crypto.randomUUID().replace(/-/g, '').toUpperCase().slice(0, 26)

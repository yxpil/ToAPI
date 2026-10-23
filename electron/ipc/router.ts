import { createHash } from 'node:crypto'
import {
  CHANNELS,
  type AppHello,
  type ChannelName,
  type EventName,
  type EventPayload,
  type ReqOf,
  type ResOf,
} from '@shared/channels'
import { err, IpcErrorRaised, ok, type IpcResult } from '@shared/types'
import { INPUT_SCHEMAS } from '@shared/schemas'
import { createLogger } from '../infra/logger'

const log = createLogger('ipc')

export type HandlerMap = {
  [K in ChannelName]: (req: ReqOf<K>) => ResOf<K> | Promise<ResOf<K>>
}

export interface RouterDeps {
  hello: AppHello
  handlers: HandlerMap
}

export const channelsHashOf = (): string =>
  createHash('sha256').update(CHANNELS.join('|')).digest('hex').slice(0, 16)

/** zod 校验 → 业务调用 → IpcResult 包装（18 号文档 §1.1） */
export async function invokeGuard<K extends ChannelName>(
  channel: K,
  handlers: HandlerMap,
  payload: unknown,
): Promise<IpcResult<ResOf<K>>> {
  const parsed = INPUT_SCHEMAS[channel].safeParse(payload ?? {})
  if (!parsed.success) {
    return err(
      'VALIDATION',
      `入参不合法: ${channel}`,
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    )
  }
  // 校验器与 ReqOf<K> 同源定义，此处窄化由 INPUT_SCHEMAS 的 satisfies 约束保证
  const req = parsed.data as ReqOf<K>
  try {
    // 同步与异步抛错都要收敛为 IpcResult，不能让异常穿透 IPC 边界
    const data = await handlers[channel](req)
    return ok(data)
  } catch (e) {
    if (e instanceof IpcErrorRaised)
      return err(e.payload.code, e.payload.message, e.payload.details)
    const message = e instanceof Error ? e.message : String(e)
    log.error(`${channel} 未预期异常`, { message })
    return err('INTERNAL', message)
  }
}

export interface IpcMainLike {
  handle: (
    channel: string,
    listener: (event: unknown, payload: unknown) => Promise<IpcResult<unknown>>,
  ) => void
}

export function registerAll(ipcMain: IpcMainLike, deps: RouterDeps): void {
  for (const channel of CHANNELS) {
    ipcMain.handle(channel, async (_event, payload) => invokeGuard(channel, deps.handlers, payload))
  }
}

export interface EmitterLike {
  send: (channel: string, payload: unknown) => void
}

export const makeEmitter =
  (target: EmitterLike) =>
  <K extends EventName>(channel: K, payload: EventPayload<K>) => {
    target.send(channel, payload)
  }

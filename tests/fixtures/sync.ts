// @author yxpil
import type { HandlerMap } from '@main/ipc/router'
import type { ChannelName, ReqOf, ResOf } from '@shared/channels'

/**
 * HandlerMap 的返回值类型是 `ResOf | Promise<ResOf>`，同步 handler 在测试里要显式收窄。
 * 哪天通道改成异步，这里会立刻失败，而不是把 Promise 当成结果去断言。
 */
export const makeSyncCall =
  (getHandlers: () => HandlerMap) =>
  <K extends ChannelName>(channel: K, req: ReqOf<K>): ResOf<K> => {
    const out = getHandlers()[channel](req)
    if (out instanceof Promise)
      throw new Error(`${channel} 是异步通道，测试请用 await kernel.invoke`)
    return out as ResOf<K>
  }

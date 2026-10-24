// @author yxpil
import { randomBytes } from 'node:crypto'
import { IpcErrorRaised } from '@shared/types'
import type { NodeProbe, NodeRunStatus, NodeTree } from '@shared/channels'
import {
  NODE_PROTOCOL,
  deriveChannelKey,
  fingerprintOf,
  seal,
  unseal,
  type Sealed,
} from './channel'

/** 节点协议客户端（24 号文档 §2.3）：明文只用于握手拿盐，其余全部走加密帧 */

const DEFAULT_TIMEOUT_MS = 15_000

export interface NodeTarget {
  /** http://host:port */
  base: string
  deviceId: string
  key: Buffer
  /** 防重放轮次：每次配对换一个新的，对端按「设备 + 轮次」分序号链 */
  epoch: string
  /** 取下一个严格递增的序号：由调用方落库，保证重启后也不回退 */
  nextSeq: () => number
}

export interface HelloInfo {
  deviceId: string
  salt: string
  protocol: number
  version: string
  platform: string
}

interface Envelope {
  ok: boolean
  data: unknown
  error?: { code?: string; message?: string }
}

const rpc = (message: string, code?: string): IpcErrorRaised =>
  new IpcErrorRaised({ code: (code ?? 'INTERNAL') as never, message })

const network = (message: string): IpcErrorRaised =>
  new IpcErrorRaised({ code: 'NETWORK', message })

export interface ClientDeps {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export class NodeClient {
  constructor(
    private readonly target: NodeTarget,
    private readonly selfDeviceId: string,
    private readonly deps: ClientDeps = {},
  ) {}

  /** 加密往返：请求 dir=req、响应 dir=res，两端各自递增序号 */
  async call<T>(path: string, payload: unknown): Promise<T> {
    const fetchImpl = this.deps.fetchImpl ?? fetch
    const frame = seal(this.target.key, 'req', this.target.nextSeq(), path, {
      from: this.selfDeviceId,
      epoch: this.target.epoch,
      ...((payload ?? {}) as object),
    })
    let res: Response
    try {
      res = await fetchImpl(`${this.target.base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-toapi-node': String(NODE_PROTOCOL) },
        body: JSON.stringify(frame),
        signal: AbortSignal.timeout(this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      })
    } catch (e) {
      throw network(`节点不可达：${(e as Error).message}`)
    }
    const envelope = (await res.json().catch(() => null)) as (Envelope & Partial<Sealed>) | null
    if (envelope === null)
      throw network(`节点 ${this.target.base} 返回空响应（HTTP ${res.status}）`)
    if (!envelope.ok) {
      throw rpc(envelope.error?.message ?? '节点调用失败', envelope.error?.code)
    }
    const { iv, ct, seq } = envelope
    if (typeof iv !== 'string' || typeof ct !== 'string' || typeof seq !== 'number') {
      throw rpc('节点响应缺少加密帧')
    }
    const opened = unseal<{ ok: boolean; data?: T; error?: { code?: string; message?: string } }>(
      this.target.key,
      'res',
      { iv, ct, seq },
      path,
    )
    if (!opened.ok) throw rpc(opened.error?.message ?? '节点执行失败', opened.error?.code)
    return opened.data as T
  }

  state(): Promise<NodeProbe> {
    return this.call<NodeProbe>('/v1/node/state', {})
  }

  tree(projectId: string): Promise<NodeTree> {
    return this.call('/v1/node/tree', { projectId })
  }

  pull(projectId: string): Promise<{ content: string; apis: number; collections: number }> {
    return this.call('/v1/node/pull', { projectId })
  }

  push(
    content: string,
    strategy: { mode: 'new' | 'into'; targetProjectId?: string; apiConflict?: string },
  ): Promise<{ projectId: string; projectName: string; imported: unknown }> {
    return this.call('/v1/node/push', { content, ...strategy })
  }

  run(input: {
    scopeType: string
    scopeId: string
    envId?: string | null
    opId: string
  }): Promise<{ runId: string; total: number }> {
    return this.call('/v1/node/run', input)
  }

  runGet(runId: string): Promise<NodeRunStatus> {
    return this.call('/v1/node/run-get', { runId })
  }

  runCancel(runId: string): Promise<void> {
    return this.call('/v1/node/run-cancel', { runId })
  }
}

/** 配对：明文拿盐 → 派生密钥 → 用一次加密探活证明口令正确 */
export async function pair(args: {
  base: string
  password: string
  selfDeviceId: string
  deps?: ClientDeps
}): Promise<{
  key: Buffer
  fingerprint: string
  probe: NodeProbe
  hello: HelloInfo
  epoch: string
  seq: number
}> {
  const fetchImpl = args.deps?.fetchImpl ?? fetch
  let res: Response
  try {
    res = await fetchImpl(
      `${args.base}/v1/node/hello?deviceId=${encodeURIComponent(args.selfDeviceId)}`,
      { signal: AbortSignal.timeout(args.deps?.timeoutMs ?? DEFAULT_TIMEOUT_MS) },
    )
  } catch (e) {
    throw network(`连不上 ${args.base}：${(e as Error).message}`)
  }
  const envelope = (await res.json().catch(() => null)) as Envelope | null
  if (envelope === null || !envelope.ok) {
    throw rpc(
      envelope?.error?.message ??
        `对端未开启可配对状态（HTTP ${res.status}）：请在对方「设置 → 开放调用」里设置口令并启用`,
      envelope?.error?.code,
    )
  }
  const hello = envelope.data as HelloInfo
  if (hello.protocol !== NODE_PROTOCOL) {
    throw rpc(`节点协议版本不匹配（对端 ${String(hello.protocol)}，本机 ${String(NODE_PROTOCOL)}）`)
  }
  const key = deriveChannelKey(args.password, hello.salt)
  const epoch = randomBytes(4).toString('hex')
  let seq = 0
  const client = new NodeClient(
    { base: args.base, deviceId: hello.deviceId, key, epoch, nextSeq: () => ++seq },
    args.selfDeviceId,
    args.deps,
  )
  // 这一次加密探活就是配对的凭据：解得开说明口令与对端一致
  const probe = await client.state()
  return { key, fingerprint: fingerprintOf(key), probe, hello, epoch, seq }
}

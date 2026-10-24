// @author yxpil
import { randomUUID } from 'node:crypto'
import type { NodeProbe, NodeRunStatus, NodeTree } from '@shared/channels'
import { IpcErrorRaised } from '@shared/types'
import { NODE_PROTOCOL, fingerprintOf, unseal, seal, type Sealed } from './channel'
import { ReplayGuard } from './channel'
import type { OpenConfig } from '../open/config'

/**
 * 节点协议的服务端（24 号文档 §2）：明文只回一次握手信息（deviceId + 盐 + 版本），
 * 之后每个动作都必须是能用本端信道密钥解开的 AES-GCM 帧，且序号严格递增。
 * 业务动作由 NodeService 注入回调，这里只管协议与闸门。
 */

export interface NodeFrame {
  from?: string
  [key: string]: unknown
}

export interface NodeHandlers {
  config: OpenConfig
  deviceId: () => string
  platform: () => string
  appVersion: () => string
  probe: () => NodeProbe
  pull: (projectId: string) => { content: string; apis: number; collections: number }
  push: (input: {
    content: string
    mode: 'new' | 'into'
    targetProjectId?: string
    apiConflict?: 'skip' | 'overwrite' | 'duplicate'
  }) => { projectId: string; projectName: string; imported: unknown }
  run: (input: {
    scopeType: 'collection' | 'project' | 'api'
    scopeId: string
    envId?: string | null
    opId: string
  }) => Promise<{ runId: string; total: number }>
  runGet: (runId: string) => NodeRunStatus
  tree: (projectId: string) => NodeTree
  runCancel: (runId: string) => void
  /** 谁连过来做了什么，写审计（24 号文档 §9）：peer 是解密帧里的 deviceId，ip 是连接来源 */
  audit: (entry: {
    action: string
    ok: boolean
    errorCode?: string
    peer: string
    ip: string
    timeMs: number
  }) => void
}

const STATUS_OF: Record<string, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  UNAUTHORIZED: 401,
  RATE_LIMIT: 429,
}

const errorOf = (e: unknown): { code: string; message: string; status: number } => {
  if (e instanceof IpcErrorRaised) {
    return {
      code: e.payload.code,
      message: e.payload.message,
      status: STATUS_OF[e.payload.code] ?? 500,
    }
  }
  return { code: 'INTERNAL', message: (e as Error).message, status: 500 }
}

export interface PlainResult {
  status: number
  body: Record<string, unknown>
}

export class NodeServer {
  private readonly replay = new ReplayGuard()
  /** 连续认证失败的锁表：peer → 到期时间与次数（24 号文档 §9） */
  private readonly failures = new Map<string, { count: number; until: number }>()

  constructor(private readonly h: NodeHandlers) {}

  /** 本机对外信息：指纹随口令变化，界面据此提示"口令已改，需重新配对" */
  private selfInfo():
    { deviceId: string; salt: string; protocol: number; fingerprint: string } | PlainResult {
    const salt = this.h.config.saltHex()
    const key = this.h.config.nodeKey()
    if (!this.h.config.isEnabled() || salt === null || key === null) {
      return {
        status: 403,
        body: {
          ok: false,
          error: {
            code: 'FORBIDDEN',
            message: '本机未启用开放通道或未设置调用密码，无法被配对',
          },
        },
      }
    }
    return {
      deviceId: this.h.deviceId(),
      salt,
      protocol: NODE_PROTOCOL,
      fingerprint: fingerprintOf(key),
    }
  }

  /**
   * 握手：只报身份与盐，不报指纹。
   * 指纹由信道密钥派生，明文发出去等于给抓包者一个可离线验证口令的判据；
   * 配对双方各自用「口令 + 对端盐」算出同一个指纹，再上屏人工核对（§2.1）。
   */
  hello(queryPeer: string | null): PlainResult {
    const info = this.selfInfo()
    if ('status' in info) return info
    return {
      status: 200,
      body: {
        ok: true,
        data: {
          deviceId: info.deviceId,
          salt: info.salt,
          protocol: info.protocol,
          version: this.h.appVersion(),
          platform: this.h.platform(),
          peer: queryPeer ?? '',
        },
      },
    }
  }

  /** 失败锁按来源地址算：每次新连接换了临时端口不算新攻击者 */
  private lockKeyOf(peer: string): string {
    return peer.replace(/:\d+$/, '')
  }

  private locked(peer: string): boolean {
    const hit = this.failures.get(peer)
    if (!hit) return false
    if (Date.now() >= hit.until) {
      this.failures.delete(peer)
      return false
    }
    return hit.count >= 3
  }

  private noteFailure(peer: string): void {
    const hit = this.failures.get(peer) ?? { count: 0, until: 0 }
    this.failures.set(peer, { count: hit.count + 1, until: Date.now() + 60_000 })
  }

  /** 处理一个加密帧：解不出＝口令错，一律 401 且不回显任何业务信息 */
  async frame(path: string, body: string, ip: string): Promise<PlainResult> {
    const startedAt = Date.now()
    const info = this.selfInfo()
    if ('status' in info) return info
    const key = this.h.config.nodeKey()
    if (key === null) return { status: 403, body: { ok: false, error: { code: 'FORBIDDEN' } } }

    let sealed: Sealed
    try {
      sealed = JSON.parse(body) as Sealed
      if (typeof sealed.iv !== 'string' || typeof sealed.ct !== 'string')
        throw new Error('帧格式不合法')
    } catch (e) {
      return {
        status: 400,
        body: {
          ok: false,
          error: { code: 'VALIDATION', message: `节点信道只接受加密帧：${(e as Error).message}` },
        },
      }
    }

    let payload: NodeFrame
    try {
      payload = unseal<NodeFrame>(key, 'req', sealed, path)
    } catch {
      const audit = (errorCode: string): void => {
        this.h.audit({
          action: path,
          ok: false,
          errorCode,
          peer: '',
          ip,
          timeMs: Date.now() - startedAt,
        })
      }
      if (this.locked(this.lockKeyOf(ip))) {
        audit('LOCKED')
        return {
          status: 429,
          body: {
            ok: false,
            error: { code: 'RATE_LIMIT', message: '该地址连续认证失败，60 秒内拒绝再试' },
          },
        }
      }
      this.noteFailure(this.lockKeyOf(ip))
      audit('UNAUTHORIZED')
      return {
        status: 401,
        body: {
          ok: false,
          error: { code: 'UNAUTHORIZED', message: '口令不正确或配对已失效（对端口令可能已更换）' },
        },
      }
    }

    const from = typeof payload.from === 'string' ? payload.from : ''
    const epoch = typeof payload.epoch === 'string' ? payload.epoch : ''
    if (!this.replay.check(`${from}|${epoch}`, sealed.seq)) {
      this.h.audit({
        action: path,
        ok: false,
        errorCode: 'REPLAY',
        peer: from,
        ip,
        timeMs: Date.now() - startedAt,
      })
      return {
        status: 400,
        body: {
          ok: false,
          error: { code: 'VALIDATION', message: '节点帧序号回退，已拒绝（疑似重放）' },
        },
      }
    }
    this.failures.delete(this.lockKeyOf(ip))

    try {
      const data = await this.dispatch(path, payload)
      this.h.audit({
        action: path,
        ok: true,
        peer: from,
        ip,
        timeMs: Date.now() - startedAt,
      })
      const res = seal(key, 'res', sealed.seq, path, { ok: true, data })
      return { status: 200, body: { ok: true, ...res } }
    } catch (e) {
      const err = errorOf(e)
      this.h.audit({
        action: path,
        ok: false,
        errorCode: err.code,
        peer: from,
        ip,
        timeMs: Date.now() - startedAt,
      })
      return {
        status: err.status,
        body: { ok: false, error: { code: err.code, message: err.message } },
      }
    }
  }

  private async dispatch(path: string, payload: NodeFrame): Promise<unknown> {
    const str = (value: unknown): string => (typeof value === 'string' ? value : '')
    switch (path) {
      case '/v1/node/state':
        return this.h.probe()
      case '/v1/node/tree':
        return this.h.tree(str(payload.projectId))
      case '/v1/node/pull':
        return this.h.pull(str(payload.projectId))
      case '/v1/node/push':
        return this.h.push({
          content: str(payload.content),
          mode: payload.mode === 'into' ? 'into' : 'new',
          ...(typeof payload.targetProjectId === 'string'
            ? { targetProjectId: payload.targetProjectId }
            : {}),
          ...(payload.apiConflict === 'skip' ||
          payload.apiConflict === 'overwrite' ||
          payload.apiConflict === 'duplicate'
            ? { apiConflict: payload.apiConflict }
            : {}),
        })
      case '/v1/node/run': {
        const scopeType = str(payload.scopeType)
        if (scopeType !== 'collection' && scopeType !== 'project' && scopeType !== 'api') {
          throw new IpcErrorRaised({ code: 'VALIDATION', message: '未知的运行范围' })
        }
        return this.h.run({
          scopeType,
          scopeId: str(payload.scopeId),
          ...(payload.envId === null
            ? { envId: null }
            : typeof payload.envId === 'string'
              ? { envId: payload.envId }
              : {}),
          opId: str(payload.opId) || randomUUID(),
        })
      }
      case '/v1/node/run-get':
        return this.h.runGet(str(payload.runId))
      case '/v1/node/run-cancel':
        this.h.runCancel(str(payload.runId))
        return null
      default:
        throw new IpcErrorRaised({ code: 'NOT_FOUND', message: `未知节点端点 ${path}` })
    }
  }
}

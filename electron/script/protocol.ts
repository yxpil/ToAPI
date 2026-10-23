import type { Auth, FakeConfig, HttpMethod } from '@shared/types'

/** 脚本宿主 ↔ worker 的消息协议（05 号文档 §2，17 号文档 §3.1 第 3/6 步） */

export type ScriptKind = 'pre' | 'post'

/** 沙箱视图：headers 为键值对象，宿主负责与 KvRow 互转 */
export interface ScriptRequest {
  method: HttpMethod
  url: string
  headers: Record<string, string>
  body: string
  bodyType: string
}

export interface ScriptResponse {
  status: number
  statusText: string
  headers: [string, string][]
  body: string
  timeMs: number
}

export interface ScriptJob {
  kind: ScriptKind
  code: string
  timeoutMs: number
  request: ScriptRequest
  response?: ScriptResponse
  /** 已解析的只读变量快照（runtime > 环境 > 全局 合并后） */
  vars: Record<string, string>
  projectId: string
  auth: Auth
}

export interface SubRequestCall {
  method: HttpMethod
  url: string
  headers?: Record<string, string>
  body?: string
  fake?: FakeConfig
}

/** 宿主返回的子请求结果（沙箱侧再包一层 json() 便捷方法） */
export interface SubRequestResult {
  status: number
  statusText: string
  headers: [string, string][]
  body: string
  timeMs: number
}

export type HostToWorker =
  | { type: 'job'; job: ScriptJob }
  | { type: 'subResponse'; id: number; ok: boolean; result?: SubRequestResult; error?: string }
  | { type: 'varWriteAck'; id: number }

export type WorkerToHost =
  | { type: 'subRequest'; id: number; call: SubRequestCall }
  | {
      type: 'varWrite'
      id: number
      scope: 'env' | 'global'
      key: string
      value: string
    }
  | { type: 'log'; level: 'log' | 'warn' | 'error'; text: string }
  | {
      type: 'done'
      request?: ScriptRequest
      auth?: Auth
      fake?: FakeConfig
      skip?: string
      /** 脚本内 toapi.vars.set 的运行时变量，需回传宿主供后续接口插值（05 号文档 §2） */
      runtimeWrites?: Record<string, string>
      assertions: { name: string; pass: boolean; error?: string }[]
    }
  | { type: 'fail'; message: string }

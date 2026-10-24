import type { Auth, FakeConfig, HttpMethod } from '@shared/types'

/** 脚本宿主 ↔ worker 的消息协议（05 号文档 §2，17 号文档 §3.1 第 3/6 步） */

export type ScriptKind = 'pre' | 'post'
export type ScriptVarScope = 'env' | 'global' | 'collection'

/** Postman 作用域快照（23 号文档 §4.2）：脚本按各自作用域读写 */
export interface ScriptScopes {
  globals: Record<string, string>
  project: Record<string, string>
  collection: Record<string, string>
  environment: Record<string, string>
  local: Record<string, string>
}

export interface ScriptCookie {
  name: string
  value: string
}

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
  scopes: ScriptScopes
  cookies: ScriptCookie[]
  requestName: string
  requestId: string | null
  iteration: number
  iterationCount: number
  /** 当前迭代的数据行（23 号文档 §5.1）；无数据文件时为 {} */
  iterationData: Record<string, string>
  /** 仅 Runner/CLI 内 pm.execution.setNextRequest 生效 */
  runner: boolean
  collectionId: string | null
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
  | { type: 'varWriteAck'; id: number; ok?: boolean; error?: string }

export type WorkerToHost =
  | { type: 'subRequest'; id: number; call: SubRequestCall }
  | {
      type: 'varWrite'
      id: number
      scope: ScriptVarScope
      key: string
      value: string
      collectionId?: string
    }
  | { type: 'varUnset'; id: number; scope: ScriptVarScope; key: string; collectionId?: string }
  | { type: 'cookieWrite'; id: number; op: 'set' | 'unset'; name: string; value?: string }
  | { type: 'log'; level: 'log' | 'warn' | 'error'; text: string }
  | {
      type: 'done'
      request?: ScriptRequest
      auth?: Auth
      fake?: FakeConfig
      skip?: string
      /** 脚本内 toapi.vars.set 的运行时变量，需回传宿主供后续接口插值（05 号文档 §2） */
      runtimeWrites?: Record<string, string>
      /** pm.variables.set 的请求级 local 变量，仅在本请求后续脚本可见 */
      localWrites?: Record<string, string>
      /** pm.execution.setNextRequest：字符串跳转、null 结束本轮；未调用时缺省 */
      nextRequest?: string | null
      assertions: { name: string; pass: boolean; skipped?: boolean; error?: string }[]
    }
  | { type: 'fail'; message: string }

// 跨进程共享类型唯一事实源（18 号文档 §0）。
// 禁止在 electron/ 或 src/ 内重复定义这些结构。

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS'

export const HTTP_METHODS: readonly HttpMethod[] = [
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'HEAD',
  'OPTIONS',
]

export interface KvRow {
  key: string
  value: string
  enabled: boolean
  desc: string
}

export type BodyType = 'none' | 'json' | 'form' | 'urlencoded' | 'raw' | 'binary'

export type Auth =
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'apikey'; key: string; value: string; addTo: 'header' | 'query' }

export interface FakeConfig {
  ua?: string
  headers?: KvRow[]
  proxy?: { enabled: boolean; url: string }
  followRedirects?: boolean
  maxRedirects?: number
  timeoutMs?: number
  ignoreTlsErrors?: boolean
}

export type ExtractorScope = 'runtime' | 'env' | 'global'

export interface Extractor {
  name: string
  source: 'body' | 'header' | 'status'
  type: 'jsonpath' | 'regex'
  expr: string
  scope: ExtractorScope
}

export interface ProjectSettings {
  fake?: FakeConfig
}

export interface Project {
  id: string
  name: string
  description: string
  sortOrder: number
  settings: ProjectSettings
  createdAt: number
  updatedAt: number
}

export interface Collection {
  id: string
  projectId: string
  parentId: string | null
  name: string
  preScript: string
  postScript: string
  sortOrder: number
  createdAt: number
  updatedAt: number
}

export interface Api {
  id: string
  collectionId: string
  name: string
  method: HttpMethod
  url: string
  params: KvRow[]
  headers: KvRow[]
  bodyType: BodyType
  body: string
  auth: Auth
  fake: FakeConfig
  preScript: string
  postScript: string
  extractors: Extractor[]
  sortOrder: number
  createdAt: number
  updatedAt: number
}

export interface Environment {
  id: string
  projectId: string
  name: string
  isActive: boolean
}

export type VarScope = 'global' | 'environment'

export interface Variable {
  id: string
  scope: VarScope
  environmentId: string | null
  key: string
  value: string
  secret: boolean
}

export interface TreeApiNode {
  id: string
  name: string
  method: HttpMethod
  url: string
  sortOrder: number
}

export interface TreeCollectionNode {
  id: string
  name: string
  parentId: string | null
  sortOrder: number
  children: TreeCollectionNode[]
  apis: TreeApiNode[]
}

export interface ProjectNode {
  project: Project
  collections: TreeCollectionNode[]
}

// ── 发送链路 ──

export interface FinalRequest {
  method: HttpMethod
  url: string
  headers: [string, string][]
  bodyBase64?: string
}

export interface RedirectHop {
  status: number
  location: string
}

export interface ResponseView {
  status: number
  statusText: string
  headers: [string, string][]
  bodyText?: string
  bodyPath?: string
  bodySizeBytes: number
  timeMs: number
  redirects: RedirectHop[]
}

export interface LogEntry {
  level: 'log' | 'warn' | 'error'
  text: string
  ts: number
}

export interface AssertionResult {
  name: string
  pass: boolean
  error?: string
}

export interface ExtractedValue {
  name: string
  scope: ExtractorScope
  valuePreview: string
}

export interface SendResult {
  finalRequest: FinalRequest
  response: ResponseView
  script: {
    preLogs: LogEntry[]
    postLogs: LogEntry[]
    assertions: AssertionResult[]
  }
  extracted: ExtractedValue[]
  historyId: string
  skipped: boolean
  skipReason?: string
}

export interface HistorySummary {
  id: string
  apiId: string | null
  projectId: string
  method: HttpMethod
  url: string
  status: number
  timeMs: number
  sizeBytes: number
  isSubRequest: boolean
  createdAt: number
}

// ── IPC 信封（04 号文档 §2）──

export type IpcErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'SCRIPT_ERROR'
  | 'SCRIPT_TIMEOUT'
  | 'CANCELLED'
  | 'DB'
  | 'FORBIDDEN'
  | 'INTERNAL'

export interface IpcError {
  code: IpcErrorCode
  message: string
  details?: unknown
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError }

export const ok = <T>(data: T): IpcResult<T> => ({ ok: true, data })
export const err = (code: IpcErrorCode, message: string, details?: unknown): IpcResult<never> => ({
  ok: false,
  error: { code, message, details },
})

export class IpcErrorRaised extends Error {
  constructor(readonly payload: IpcError) {
    super(payload.message)
    this.name = 'IpcErrorRaised'
  }
}

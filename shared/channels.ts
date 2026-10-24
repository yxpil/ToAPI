import type {
  Api,
  AssertionResult,
  Auth,
  BodyType,
  Collection,
  CollectionVariable,
  Environment,
  Extractor,
  FakeConfig,
  HistorySummary,
  HttpMethod,
  KvRow,
  LogEntry,
  PostmanExportResult,
  PostmanImportReport,
  PostmanInspect,
  Project,
  ProjectNode,
  ProjectSettings,
  SendResult,
  Variable,
} from './types'

// ── 入参类型 ──

export interface IdInput {
  id: string
}

export interface NewProject {
  name: string
  description?: string
}

export interface UpdateProject {
  id: string
  name?: string
  description?: string
  settings?: ProjectSettings
  auth?: Auth
  variables?: CollectionVariable[]
  preScript?: string
  postScript?: string
}

export interface NewCollection {
  projectId: string
  parentId?: string | null
  name: string
}

export interface UpdateCollection {
  id: string
  name?: string
  description?: string
  auth?: Auth
  variables?: CollectionVariable[]
  preScript?: string
  postScript?: string
}

export interface NewApi {
  collectionId: string
  name: string
  method?: HttpMethod
  url?: string
}

export interface UpdateApi {
  id: string
  name?: string
  description?: string
  method?: HttpMethod
  url?: string
  params?: KvRow[]
  headers?: KvRow[]
  bodyType?: BodyType
  body?: string
  auth?: Auth
  fake?: FakeConfig
  preScript?: string
  postScript?: string
  extractors?: Extractor[]
}

export interface DuplicateApi {
  id: string
  targetCollectionId?: string
}

export interface MoveTarget {
  nodeType: 'collection' | 'api'
  id: string
  targetParentId: string
  beforeSortOrder?: number | null
  afterSortOrder?: number | null
}

export interface NewEnvironment {
  projectId: string
  name: string
}

export interface UpdateEnvironment {
  id: string
  name?: string
}

export interface ActivateEnvironment {
  projectId: string
  environmentId: string | null
}

export interface SetVariable {
  scope: Variable['scope']
  environmentId?: string | null
  key: string
  value: string
  secret?: boolean
  enabled?: boolean
}

export interface DeleteVariable {
  id: string
}

export interface SendInput {
  apiId?: string
  draft?: RequestDraft
  envId?: string | null
  cancelId: string
  /** Runner 数据行（23 号文档 §5.1）：高于 environment、低于 local */
  iterationData?: Record<string, string>
  iteration?: number
  iterationCount?: number
  /** 仅 Runner 内允许 pm.execution.setNextRequest */
  runner?: boolean
  /** Runner --timeout 覆盖接口自身的超时设置 */
  timeoutMs?: number
}

/** 未保存请求（cURL 预览、临时调试） */
export interface RequestDraft {
  method: HttpMethod
  url: string
  params?: KvRow[]
  headers?: KvRow[]
  bodyType?: BodyType
  body?: string
  auth?: Auth
  fake?: FakeConfig
  projectId?: string
  collectionId?: string
}

export interface CancelInput {
  cancelId: string
}

export interface HistoryListInput {
  projectId?: string
  apiId?: string
  cursor?: string | null
  limit?: number
}

export interface HistoryPage {
  items: HistorySummary[]
  nextCursor: string | null
}

export interface RunnerStartInput {
  scopeType: 'collection' | 'api' | 'project'
  scopeId: string
  envId?: string | null
  cancelId: string
  stopOnFail?: boolean
  delayMs?: number
  /** 数据行；未指定 iterationCount 时迭代次数等于行数 */
  iterationData?: Record<string, string>[]
  iterationCount?: number
  /** 覆盖本轮所有请求的超时（CLI --timeout） */
  timeoutMs?: number
}

/** 无边框窗口的最大化状态（06 号文档 §4） */
export interface WindowState {
  maximized: boolean
}

/** 数据文件粘贴解析（渲染进程无 fs 权限，解析只在主进程做） */
export interface DataParseInput {
  content: string
}

export interface DataParseResult {
  rows: Record<string, string>[]
  format: 'csv' | 'json'
}

export interface RunnerItemView {
  id: string
  runId: string
  apiId: string | null
  apiName: string
  status: 'passed' | 'failed' | 'skipped' | 'error'
  historyId: string | null
  timeMs: number
  assertions: AssertionResult[]
  logs: LogEntry[]
  error: string | null
  sortOrder: number
  /** 数据驱动迭代序号，从 1 开始；无数据文件时为 1 */
  iteration: number
}

export interface RunnerRunView {
  id: string
  scopeType: string
  scopeId: string
  scopeName: string
  envId: string | null
  startedAt: number
  finishedAt: number | null
  total: number
  passed: number
  failed: number
  skipped: number
  iterationCount: number
  items: RunnerItemView[]
}

// ── Postman 兼容（23 号文档 §8）──

export interface PostmanSource {
  content?: string
  filePath?: string
}

export interface PostmanImportInput extends PostmanSource {
  targetProjectId?: string
  mode?: 'new' | 'into'
}

export interface PostmanExportCollectionInput {
  projectId: string
  collectionIds?: string[]
  filePath?: string
}

export interface PostmanImportEnvironmentInput extends PostmanSource {
  projectId: string
  mode?: 'new' | 'overwrite'
}

export interface PostmanExportEnvironmentInput {
  environmentId: string
  filePath?: string
}

// ── channel → 载荷映射（18 号文档 §1.2）──

export interface ChannelMap {
  'app:hello': { req: Record<string, never>; res: AppHello }
  'project:list': { req: Record<string, never>; res: ProjectNode[] }
  'project:create': { req: NewProject; res: Project }
  'project:update': { req: UpdateProject; res: Project }
  'project:delete': { req: IdInput; res: void }
  'collection:create': { req: NewCollection; res: Collection }
  'collection:update': { req: UpdateCollection; res: Collection }
  'collection:delete': { req: IdInput; res: void }
  'api:get': { req: IdInput; res: Api }
  'api:create': { req: NewApi; res: Api }
  'api:update': { req: UpdateApi; res: Api }
  'api:duplicate': { req: DuplicateApi; res: Api }
  'api:delete': { req: IdInput; res: void }
  'tree:move': { req: MoveTarget; res: { sortOrder: number } }
  'env:list': { req: { projectId: string }; res: { envs: Environment[]; vars: Variable[] } }
  'env:create': { req: NewEnvironment; res: Environment }
  'env:update': { req: UpdateEnvironment; res: Environment }
  'env:delete': { req: IdInput; res: void }
  'env:activate': { req: ActivateEnvironment; res: void }
  'var:set': { req: SetVariable; res: Variable }
  'var:delete': { req: DeleteVariable; res: void }
  'api:send': { req: SendInput; res: SendResult }
  'api:cancel': { req: CancelInput; res: void }
  'history:list': { req: HistoryListInput; res: HistoryPage }
  'runner:start': { req: RunnerStartInput; res: { runId: string; total: number } }
  'runner:cancel': { req: { runId: string }; res: void }
  'runner:get': { req: IdInput; res: RunnerRunView }
  'runner:list': { req: { limit?: number }; res: Omit<RunnerRunView, 'items'>[] }
  'data:parse': { req: DataParseInput; res: DataParseResult }
  'postman:inspect': { req: PostmanSource; res: PostmanInspect }
  'postman:import': { req: PostmanImportInput; res: PostmanImportReport }
  'postman:export-collection': {
    req: PostmanExportCollectionInput
    res: PostmanExportResult
  }
  'postman:import-environment': {
    req: PostmanImportEnvironmentInput
    res: PostmanImportReport
  }
  'postman:export-environment': {
    req: PostmanExportEnvironmentInput
    res: PostmanExportResult
  }
  'window:get-state': { req: Record<string, never>; res: WindowState }
  'window:minimize': { req: Record<string, never>; res: void }
  'window:toggle-maximize': { req: Record<string, never>; res: WindowState }
  'window:close': { req: Record<string, never>; res: void }
}

export interface AppHello {
  mainVersion: string
  schemaVersion: number
  channelsHash: string
  platform: string
  /** 主库文件字节数，底栏展示（06 号文档 §4）；内存库为 0 */
  dbSizeBytes: number
}

export const CHANNELS = [
  'app:hello',
  'project:list',
  'project:create',
  'project:update',
  'project:delete',
  'collection:create',
  'collection:update',
  'collection:delete',
  'api:get',
  'api:create',
  'api:update',
  'api:duplicate',
  'api:delete',
  'tree:move',
  'env:list',
  'env:create',
  'env:update',
  'env:delete',
  'env:activate',
  'var:set',
  'var:delete',
  'api:send',
  'api:cancel',
  'history:list',
  'runner:start',
  'runner:cancel',
  'runner:get',
  'runner:list',
  'data:parse',
  'postman:inspect',
  'postman:import',
  'postman:export-collection',
  'postman:import-environment',
  'postman:export-environment',
  'window:get-state',
  'window:minimize',
  'window:toggle-maximize',
  'window:close',
] as const satisfies readonly (keyof ChannelMap)[]

export type ChannelName = (typeof CHANNELS)[number]

/** 编译期保证 CHANNELS 覆盖 ChannelMap 全部键，漏登记直接编译失败 */
export const CHANNELS_ARE_EXHAUSTIVE: keyof ChannelMap extends ChannelName ? true : never = true

export type ReqOf<K extends ChannelName> = ChannelMap[K]['req']
export type ResOf<K extends ChannelName> = ChannelMap[K]['res']

// ── 事件通道（主进程 → 渲染进程）──

export interface EventMap {
  'event:send-progress': { cancelId: string; phase: 'script' | 'sending' | 'receiving' }
  'event:runner-progress': { runId: string; item: RunnerItemView; finished: boolean }
  /** 最大化/还原后同步标题栏图标；双击拖拽区触发的系统行为也要覆盖 */
  'event:window-state': WindowState
}

export const EVENT_CHANNELS = [
  'event:send-progress',
  'event:runner-progress',
  'event:window-state',
] as const satisfies readonly (keyof EventMap)[]

export type EventName = (typeof EVENT_CHANNELS)[number]
export type EventPayload<K extends EventName> = EventMap[K]

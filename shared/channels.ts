import type {
  Api,
  AssertionResult,
  Auth,
  BodyType,
  Collection,
  Environment,
  Extractor,
  FakeConfig,
  HistorySummary,
  HttpMethod,
  KvRow,
  LogEntry,
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
}

export interface NewCollection {
  projectId: string
  parentId?: string | null
  name: string
}

export interface UpdateCollection {
  id: string
  name?: string
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
}

export interface DeleteVariable {
  id: string
}

export interface SendInput {
  apiId?: string
  draft?: RequestDraft
  envId?: string | null
  cancelId: string
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
  scopeType: 'collection' | 'api'
  scopeId: string
  envId?: string | null
  cancelId: string
  stopOnFail?: boolean
  delayMs?: number
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
  items: RunnerItemView[]
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
}

export interface AppHello {
  mainVersion: string
  schemaVersion: number
  channelsHash: string
  platform: string
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
}

export const EVENT_CHANNELS = [
  'event:send-progress',
  'event:runner-progress',
] as const satisfies readonly (keyof EventMap)[]

export type EventName = (typeof EVENT_CHANNELS)[number]
export type EventPayload<K extends EventName> = EventMap[K]

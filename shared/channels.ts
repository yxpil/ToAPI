// @author yxpil
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

// ── 定时任务（12 号文档 §1）──

/** 触发方式：cron 表达式 / 固定间隔 / 单次时刻 */
export type ScheduleSpec =
  | { kind: 'cron'; expr: string }
  | { kind: 'interval'; everyMs: number }
  | { kind: 'once'; at: number }

/** case / mddoc / macro 目标尚未落地，12 号文档 §6 记为未实现 */
export type ScheduleTargetType = 'collection' | 'project' | 'api'
export type OverlapPolicy = 'skip' | 'queue' | 'parallel'
export type MisfirePolicy = 'run-on-launch' | 'skip'
export type ReportFormat = 'json' | 'junit' | 'html'

export interface TaskNotifyOptions {
  onSuccess: boolean
  onFail: boolean
  /** 每次触发落一份报告文件，路径写进通知正文（15 号文档 §1） */
  report: ReportFormat | 'none'
}

export interface ScheduleTaskView {
  id: string
  name: string
  enabled: boolean
  targetType: ScheduleTargetType
  targetId: string
  targetName: string
  spec: ScheduleSpec
  envId: string | null
  envName: string
  overlap: OverlapPolicy
  misfire: MisfirePolicy
  notify: TaskNotifyOptions
  lastRunAt: number | null
  lastRunId: string | null
  /** 上次触发的失败项数，null = 还没跑过 */
  lastFailed: number | null
  nextRunAt: number | null
  running: boolean
}

export interface NewScheduleTask {
  name: string
  targetType: ScheduleTargetType
  targetId: string
  spec: ScheduleSpec
  envId?: string | null
  overlap?: OverlapPolicy
  misfire?: MisfirePolicy
  notify?: TaskNotifyOptions
  enabled?: boolean
}

export interface UpdateScheduleTask {
  id: string
  name?: string
  targetType?: ScheduleTargetType
  targetId?: string
  spec?: ScheduleSpec
  envId?: string | null
  overlap?: OverlapPolicy
  misfire?: MisfirePolicy
  notify?: TaskNotifyOptions
  enabled?: boolean
}

export interface TaskPreviewInput {
  spec: ScheduleSpec
  /** 起算时刻，缺省为当前时间 */
  from?: number
}

export interface TaskPreviewResult {
  /** 未来 5 次触发时间（毫秒），非法表达式时为空 */
  times: number[]
  error: string | null
}

// ── 消息通知（15 号文档 §2/§3）──

export type NotifyLevel = 'info' | 'warn' | 'error'

/** 当前版本会真实触发的事件类型；宏与压测事件等特性落地后再补 */
export const NOTIFY_EVENT_TYPES = [
  'runner.finished',
  'runner.failed',
  'task.finished',
  'task.misfire',
  'node.finished',
  'open.denied',
  'db.failed',
] as const

export type NotifyEventType = (typeof NOTIFY_EVENT_TYPES)[number]

export interface NotificationView {
  id: string
  type: NotifyEventType
  level: NotifyLevel
  title: string
  body: string
  sourceType: string | null
  sourceId: string | null
  read: boolean
  /** 60s 窗口内合并的条数（15 号文档 §3.2） */
  count: number
  createdAt: number
}

export interface NotifyListInput {
  cursor?: string | null
  unreadOnly?: boolean
  type?: NotifyEventType | null
  limit?: number
}

export interface NotifyPage {
  items: NotificationView[]
  nextCursor: string | null
  unread: number
}

export interface NotifyChannelFlags {
  toast: boolean
  os: boolean
  sound: boolean
  webhook: boolean
}

export type NotifyRuleMap = Record<NotifyEventType, NotifyChannelFlags>

export type WebhookTemplate = 'raw' | 'wecom' | 'dingtalk' | 'feishu'

export interface NotifySettingsView {
  rules: NotifyRuleMap
  /** 关闭窗口最小化到托盘（15 号文档 §4） */
  closeToTray: boolean
  /** 定时任务只在结果翻转时通知（15 号文档 §3.2） */
  stateChangeOnly: boolean
  webhookUrl: string
  webhookTemplate: WebhookTemplate
  unread: number
}

export interface SetNotifySettingsInput {
  /** 只覆盖给出的通道位，其余保持原值（订阅矩阵逐格勾选） */
  rules?: Partial<Record<NotifyEventType, Partial<NotifyChannelFlags>>>
  closeToTray?: boolean
  stateChangeOnly?: boolean
  webhookUrl?: string
  webhookTemplate?: WebhookTemplate
}

export interface TestWebhookInput {
  url: string
  template: WebhookTemplate
}

export interface TestWebhookResult {
  ok: boolean
  status: number
  error: string | null
}

// ── 局域网节点（24 号文档 §1–§4）──

/** 探活回包：对端身份、能力与项目摘要 */
export interface NodeProbe {
  deviceId: string
  version: string
  platform: string
  protocol: number
  busy: boolean
  projects: { id: string; name: string; hash: string; apis: number }[]
}

export interface NodeView {
  id: string
  name: string
  host: string
  port: number
  deviceId: string
  /** 由信道密钥算出的校验指纹，两屏核对用 */
  fingerprint: string
  confirmedFingerprint: string
  /** 指纹已当面锁定且未变化：才允许 push/run 这类写操作 */
  trusted: boolean
  labels: string[]
  enabled: boolean
  addedAt: number
  lastSeenAt: number | null
  lastError: string | null
}

export interface NodeListItem extends NodeView {
  /** 列表页并发探活的最新结果，失败为 null */
  probe: NodeProbe | null
}

export interface AddNodeInput {
  name: string
  host: string
  port?: number
  /** 对端「开放调用」里设置的口令；只用于派生信道密钥，不落明文 */
  password: string
  labels?: string[]
}

export interface UpdateNodeInput {
  id: string
  name?: string
  host?: string
  port?: number
  labels?: string[]
  enabled?: boolean
  /** 给了口令就重新配对（旧的指纹锁定作废） */
  password?: string
}

/** 拉取远端项目：落地为本机 .tapi 导入，密钥一律不带 */
export interface NodePullInput {
  nodeId: string
  projectId: string
  mode: 'new' | 'into'
  targetProjectId?: string
  apiConflict?: 'skip' | 'overwrite' | 'duplicate'
}

export interface NodePushInput {
  nodeId: string
  projectId: string
  apiConflict?: 'skip' | 'overwrite' | 'duplicate'
}

export interface NodeRunInput {
  nodeId: string
  scopeType: 'collection' | 'project' | 'api'
  /** 远端对象的 id（来自 node:projects 与远端结构） */
  scopeId: string
  /** 远端环境 id：代为测试必须显式指定，不跟随对端当前激活 */
  envId?: string | null
}

/** 代为测试前的远端结构：只能跑对端真实存在的集合与环境 */
export interface NodeTree {
  collections: { id: string; name: string; apis: number }[]
  envs: { id: string; name: string }[]
}

export interface NodeRunStatus {
  runId: string
  finished: boolean
  total: number
  passed: number
  failed: number
  skipped: number
  startedAt: number
  finishedAt: number | null
  items: {
    apiName: string
    status: 'passed' | 'failed' | 'skipped' | 'error'
    timeMs: number
    iteration: number
    error: string | null
  }[]
}

/** 本机作为"被配对的一方"的对外信息（24 号文档 §2.1 第 1 步：把 IP:端口 与指纹念给对方核对） */
export interface NodeSelfView {
  deviceId: string
  /** 由信道密钥派生；口令一改就变，未设口令为 null */
  fingerprint: string | null
  /** 开放通道已启用且已设口令 = 处于可被配对状态 */
  pairable: boolean
  running: boolean
  access: OpenAccessMode
  port: number
  /** 本机非回环 IPv4，只有监听局域网时才对端可达 */
  addresses: string[]
}

/** 节点调用留痕（24 号文档 §9）：in = 别人调本机，out = 本机调节点 */
export interface NodeCallLogView {
  id: string
  nodeId: string
  nodeName: string
  peer: string
  direction: 'in' | 'out'
  action: string
  ok: boolean
  errorCode: string | null
  timeMs: number
  items: number
  createdAt: number
}

// ── 运行报告导出（07/23 号文档）──

export interface RunnerReportInput {
  runId: string
  format: ReportFormat
  /** 缺省写到 reports 目录 */
  filePath?: string
}

export interface RunnerReportResult {
  filePath: string
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

// ── .tapi 项目互传（08 号文档 §7）──

export interface TapiStats {
  collections: number
  apis: number
  environments: number
  globals: number
}

export interface TapiSource {
  content?: string
  filePath?: string
}

/** 导入预览：不写库，供 UI 决定策略（08 号文档 §5） */
export interface TapiInspection {
  name: string
  description?: string
  appVersion: string
  exportedAt: number
  formatVersion: string
  supported: boolean
  checksumOk: boolean
  containsSecrets: boolean
  /** 被剔除的敏感变量个数，导入后需自行填写 */
  redactedCount: number
  stats: TapiStats
  sameNameProjectId: string | null
  sameNameProject: string | null
}

export interface TapiExportInput {
  projectId: string
  collectionIds?: string[]
  secrets?: 'strip' | 'plain'
  name?: string
  description?: string
  filePath?: string
}

export interface TapiExportResult {
  filePath: string
  stats: TapiStats
  containsSecrets: boolean
}

export interface TapiImportInput extends TapiSource {
  mode?: 'new' | 'into'
  targetProjectId?: string
  apiConflict?: 'skip' | 'overwrite' | 'duplicate'
}

export interface TapiImportResult {
  projectId: string
  projectName: string
  imported: TapiStats
  skipped: number
  warnings: string[]
  inspection: TapiInspection
}

// ── 开放调用通道（11 号文档 §6）──

/** loopback 只监听 127.0.0.1；lan 需要用户在设置里二次确认 */
export type OpenAccessMode = 'loopback' | 'lan'

export interface OpenConfigView {
  enabled: boolean
  running: boolean
  port: number
  access: OpenAccessMode
  ratePerMin: number
  hasPassword: boolean
  passwordSetAt: number | null
  baseUrl: string
}

export interface OpenClientView {
  id: string
  name: string
  kind: 'http' | 'mcp'
  authorizedAt: number
  lastSeenAt: number
}

export interface OpenCallLogView {
  id: string
  channel: 'http' | 'mcp'
  tool: string
  client: string
  paramsSummary: string
  ok: boolean
  errorCode: string | null
  timeMs: number
  createdAt: number
}

export interface OpenSetConfigInput {
  enabled?: boolean
  port?: number
  access?: OpenAccessMode
  ratePerMin?: number
  /** 非空 = 自定义调用密码；空串 = 清除密码并关闭通道 */
  password?: string
}

export interface OpenApprovalInput {
  clientId: string
  approve: boolean
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
  'runner:report': { req: RunnerReportInput; res: RunnerReportResult }
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
  'tapi:export': { req: TapiExportInput; res: TapiExportResult }
  'tapi:inspect': { req: TapiSource; res: TapiInspection }
  'tapi:import': { req: TapiImportInput; res: TapiImportResult }
  'open:get-config': { req: Record<string, never>; res: OpenConfigView }
  'open:set-config': { req: OpenSetConfigInput; res: OpenConfigView }
  'open:rotate-token': { req: Record<string, never>; res: { password: string } }
  'open:list-clients': { req: Record<string, never>; res: OpenClientView[] }
  'open:revoke-client': { req: IdInput; res: void }
  'open:call-log': { req: { limit?: number }; res: OpenCallLogView[] }
  'open:approval-result': { req: OpenApprovalInput; res: void }
  'task:list': { req: Record<string, never>; res: ScheduleTaskView[] }
  'task:create': { req: NewScheduleTask; res: ScheduleTaskView }
  'task:update': { req: UpdateScheduleTask; res: ScheduleTaskView }
  'task:delete': { req: IdInput; res: void }
  'task:toggle': { req: { id: string; enabled: boolean }; res: ScheduleTaskView }
  'task:preview': { req: TaskPreviewInput; res: TaskPreviewResult }
  'task:run-now': { req: IdInput; res: { runId: string } }
  'notify:list': { req: NotifyListInput; res: NotifyPage }
  'notify:mark-read': { req: { ids: string[] }; res: { unread: number } }
  'notify:mark-all-read': { req: Record<string, never>; res: { unread: number } }
  'notify:get-settings': { req: Record<string, never>; res: NotifySettingsView }
  'notify:set-settings': { req: SetNotifySettingsInput; res: NotifySettingsView }
  'notify:test-webhook': { req: TestWebhookInput; res: TestWebhookResult }
  'node:list': { req: Record<string, never>; res: NodeListItem[] }
  'node:self': { req: Record<string, never>; res: NodeSelfView }
  'node:log': { req: { limit?: number }; res: NodeCallLogView[] }
  'node:add': { req: AddNodeInput; res: NodeListItem }
  'node:update': { req: UpdateNodeInput; res: NodeListItem }
  'node:remove': { req: IdInput; res: void }
  'node:probe': { req: IdInput; res: NodeProbe }
  'node:tree': { req: { nodeId: string; projectId: string }; res: NodeTree }
  'node:confirm': { req: IdInput; res: NodeListItem }
  'node:pull': { req: NodePullInput; res: TapiImportResult }
  'node:push': { req: NodePushInput; res: { imported: number; message: string } }
  'node:run': { req: NodeRunInput; res: { runId: string } }
  'node:run-get': { req: { nodeId: string; runId: string }; res: NodeRunStatus }
  'node:run-cancel': { req: { nodeId: string; runId: string }; res: void }
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
  'runner:report',
  'data:parse',
  'postman:inspect',
  'postman:import',
  'postman:export-collection',
  'postman:import-environment',
  'postman:export-environment',
  'tapi:export',
  'tapi:inspect',
  'tapi:import',
  'open:get-config',
  'open:set-config',
  'open:rotate-token',
  'open:list-clients',
  'open:revoke-client',
  'open:call-log',
  'open:approval-result',
  'task:list',
  'task:create',
  'task:update',
  'task:delete',
  'task:toggle',
  'task:preview',
  'task:run-now',
  'notify:list',
  'notify:mark-read',
  'notify:mark-all-read',
  'notify:get-settings',
  'notify:set-settings',
  'notify:test-webhook',
  'node:list',
  'node:self',
  'node:log',
  'node:add',
  'node:update',
  'node:remove',
  'node:probe',
  'node:tree',
  'node:confirm',
  'node:pull',
  'node:push',
  'node:run',
  'node:run-get',
  'node:run-cancel',
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
  /** 外部客户端首次连接，等待用户在 GUI 授权（11 号文档 §2.3） */
  'event:open-approval': {
    clientId: string
    name: string
    kind: 'http' | 'mcp'
    /** 授权原因说明：新客户端接入或越界 host 确认 */
    detail: string
    /** 授权通过后自动随附的 Skill 说明书摘要，让用户知道会交出什么内容 */
    /** 授权通过后自动随附的 Skill 说明书摘要，让用户知道会交出什么内容 */
    skillPreview: string
    createdAt: number
  }
  /** 新通知 / 合并计数更新：Toast、角标与通知中心实时刷新（15 号文档 §6） */
  'event:notify': NotificationView
  /** 定时任务的运行态与下次触发时间变化（12 号文档 §1） */
  'event:task-state': {
    taskId: string
    running: boolean
    nextRunAt: number | null
    lastRunAt: number | null
    lastRunId: string | null
    lastFailed: number | null
  }
  /** 节点探活/配对/远端运行进度（24 号文档 §8） */
  'event:node-state': {
    nodeId: string
    /** idle | probing | busy | error | paired */
    state: 'idle' | 'probing' | 'busy' | 'error' | 'paired'
    detail: string
    runId: string | null
  }
}

export const EVENT_CHANNELS = [
  'event:send-progress',
  'event:runner-progress',
  'event:window-state',
  'event:open-approval',
  'event:notify',
  'event:task-state',
  'event:node-state',
] as const satisfies readonly (keyof EventMap)[]

export type EventName = (typeof EVENT_CHANNELS)[number]
export type EventPayload<K extends EventName> = EventMap[K]

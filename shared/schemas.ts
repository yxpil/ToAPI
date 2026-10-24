// @author yxpil
import { z } from 'zod'
import type { ChannelName } from './channels'
import { HTTP_METHODS } from './types'

export const kvRowSchema = z.object({
  key: z.string().max(200),
  value: z.string().max(20000),
  enabled: z.boolean(),
  desc: z.string().max(2000),
})

export const methodSchema = z.enum(HTTP_METHODS)

export const bodyTypeSchema = z.enum(['none', 'json', 'form', 'urlencoded', 'raw', 'binary'])

export const authSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('inherit') }),
  z.object({ type: z.literal('bearer'), token: z.string().max(8000) }),
  z.object({
    type: z.literal('basic'),
    username: z.string().max(500),
    password: z.string().max(500),
  }),
  z.object({
    type: z.literal('apikey'),
    key: z.string().max(500),
    value: z.string().max(8000),
    addTo: z.enum(['header', 'query']),
  }),
])

export const collectionVariableSchema = z.object({
  key: z.string().max(200),
  value: z.string().max(20000),
  enabled: z.boolean(),
  secret: z.boolean(),
  desc: z.string().max(2000),
})

export const fakeSchema = z.object({
  ua: z.string().max(2000).optional(),
  headers: z.array(kvRowSchema).max(200).optional(),
  proxy: z.object({ enabled: z.boolean(), url: z.string().max(2000) }).optional(),
  followRedirects: z.boolean().optional(),
  maxRedirects: z.number().int().min(0).max(20).optional(),
  timeoutMs: z.number().int().min(100).max(600000).optional(),
  ignoreTlsErrors: z.boolean().optional(),
})

export const extractorSchema = z.object({
  name: z.string().min(1).max(200),
  source: z.enum(['body', 'header', 'status']),
  type: z.enum(['jsonpath', 'regex']),
  expr: z.string().min(1).max(4000),
  scope: z.enum(['runtime', 'env', 'global']),
})

export const projectSettingsSchema = z.object({
  fake: fakeSchema.optional(),
})

const idSchema = z.string().min(1).max(64)
const nameSchema = z.string().min(1).max(200)
const urlSchema = z.string().min(1).max(8000)
/** 草稿可以暂不填 URL，发送时由 buildUrl 给出 VALIDATION 提示 */
const draftUrlSchema = z.string().max(8000)

const iterationDataSchema = z.record(z.string().max(200), z.string().max(20000))

// ── 定时任务与通知（12 / 15 号文档）──

/** 表达式故意放宽到 1 字符：非法写法要能进 handler 拿到中文原因，而不是被 schema 挡成通用 VALIDATION */
const scheduleSpecSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cron'), expr: z.string().min(1).max(200) }),
  z.object({
    kind: z.literal('interval'),
    everyMs: z.number().int().min(1000).max(31_536_000_000),
  }),
  z.object({ kind: z.literal('once'), at: z.number().int().min(0).max(8_640_000_000_000_000) }),
])

const targetTypeSchema = z.enum(['collection', 'project', 'api'])
const overlapSchema = z.enum(['skip', 'queue', 'parallel'])
const misfireSchema = z.enum(['run-on-launch', 'skip'])
const reportFormatSchema = z.enum(['json', 'junit', 'html', 'none'])

const taskNotifySchema = z.object({
  onSuccess: z.boolean(),
  onFail: z.boolean(),
  report: reportFormatSchema,
})

const scheduleSpecSource = { spec: scheduleSpecSchema }

const channelFlagsSchema = z.object({
  toast: z.boolean(),
  os: z.boolean(),
  sound: z.boolean(),
  webhook: z.boolean(),
})

const notifyRulesSchema = z.object({
  'runner.finished': channelFlagsSchema.partial().optional(),
  'runner.failed': channelFlagsSchema.partial().optional(),
  'task.finished': channelFlagsSchema.partial().optional(),
  'task.misfire': channelFlagsSchema.partial().optional(),
  'open.denied': channelFlagsSchema.partial().optional(),
  'db.failed': channelFlagsSchema.partial().optional(),
})

const webhookUrlSchema = z.string().max(2000)
const webhookTemplateSchema = z.enum(['raw', 'wecom', 'dingtalk', 'feishu'])
const notifyTypeSchema = z.enum([
  'runner.finished',
  'runner.failed',
  'task.finished',
  'task.misfire',
  'open.denied',
  'db.failed',
])

const empty = z.object({})

export const draftSchema = z.object({
  method: methodSchema,
  url: urlSchema,
  params: z.array(kvRowSchema).max(500).optional(),
  headers: z.array(kvRowSchema).max(500).optional(),
  bodyType: bodyTypeSchema.optional(),
  body: z.string().max(2_000_000).optional(),
  auth: authSchema.optional(),
  fake: fakeSchema.optional(),
  projectId: idSchema.optional(),
  collectionId: idSchema.optional(),
})

/** channel → 入参校验器。新增 channel 未在此登记时类型检查失败。 */
export const INPUT_SCHEMAS = {
  'app:hello': empty,
  'project:list': empty,
  'project:create': z.object({ name: nameSchema, description: z.string().max(4000).optional() }),
  'project:update': z.object({
    id: idSchema,
    name: nameSchema.optional(),
    description: z.string().max(4000).optional(),
    settings: projectSettingsSchema.optional(),
    auth: authSchema.optional(),
    variables: z.array(collectionVariableSchema).max(500).optional(),
    preScript: z.string().max(100000).optional(),
    postScript: z.string().max(100000).optional(),
  }),
  'project:delete': z.object({ id: idSchema }),
  'collection:create': z.object({
    projectId: idSchema,
    parentId: idSchema.nullable().optional(),
    name: nameSchema,
  }),
  'collection:update': z.object({
    id: idSchema,
    name: nameSchema.optional(),
    description: z.string().max(4000).optional(),
    auth: authSchema.optional(),
    variables: z.array(collectionVariableSchema).max(500).optional(),
    preScript: z.string().max(100000).optional(),
    postScript: z.string().max(100000).optional(),
  }),
  'collection:delete': z.object({ id: idSchema }),
  'api:get': z.object({ id: idSchema }),
  'api:create': z.object({
    collectionId: idSchema,
    name: nameSchema,
    method: methodSchema.optional(),
    url: z.string().max(8000).optional(),
  }),
  'api:update': z.object({
    id: idSchema,
    name: nameSchema.optional(),
    description: z.string().max(4000).optional(),
    method: methodSchema.optional(),
    url: draftUrlSchema.optional(),
    params: z.array(kvRowSchema).max(500).optional(),
    headers: z.array(kvRowSchema).max(500).optional(),
    bodyType: bodyTypeSchema.optional(),
    body: z.string().max(2_000_000).optional(),
    auth: authSchema.optional(),
    fake: fakeSchema.optional(),
    preScript: z.string().max(100000).optional(),
    postScript: z.string().max(100000).optional(),
    extractors: z.array(extractorSchema).max(100).optional(),
  }),
  'api:duplicate': z.object({ id: idSchema, targetCollectionId: idSchema.optional() }),
  'api:delete': z.object({ id: idSchema }),
  'tree:move': z.object({
    nodeType: z.enum(['collection', 'api']),
    id: idSchema,
    targetParentId: idSchema,
    beforeSortOrder: z.number().nullable().optional(),
    afterSortOrder: z.number().nullable().optional(),
  }),
  'env:list': z.object({ projectId: idSchema }),
  'env:create': z.object({ projectId: idSchema, name: nameSchema }),
  'env:update': z.object({ id: idSchema, name: nameSchema.optional() }),
  'env:delete': z.object({ id: idSchema }),
  'env:activate': z.object({ projectId: idSchema, environmentId: idSchema.nullable() }),
  'var:set': z.object({
    scope: z.enum(['global', 'environment']),
    environmentId: idSchema.nullable().optional(),
    key: z.string().min(1).max(200),
    value: z.string().max(20000),
    secret: z.boolean().optional(),
    enabled: z.boolean().optional(),
  }),
  'var:delete': z.object({ id: idSchema }),
  'api:send': z
    .object({
      apiId: idSchema.optional(),
      draft: draftSchema.optional(),
      envId: idSchema.nullable().optional(),
      cancelId: idSchema,
      iterationData: iterationDataSchema.optional(),
      iteration: z.number().int().min(1).max(1_000_000).optional(),
      iterationCount: z.number().int().min(1).max(1_000_000).optional(),
      runner: z.boolean().optional(),
      timeoutMs: z.number().int().min(100).max(600000).optional(),
    })
    .refine((v) => Boolean(v.apiId) !== Boolean(v.draft), {
      message: 'apiId 与 draft 必须二选一',
    }),
  'api:cancel': z.object({ cancelId: idSchema }),
  'history:list': z.object({
    projectId: idSchema.optional(),
    apiId: idSchema.optional(),
    cursor: z.string().max(200).nullable().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  'runner:start': z.object({
    scopeType: z.enum(['collection', 'api', 'project']),
    scopeId: idSchema,
    envId: idSchema.nullable().optional(),
    cancelId: idSchema,
    stopOnFail: z.boolean().optional(),
    delayMs: z.number().int().min(0).max(60000).optional(),
    iterationData: z.array(iterationDataSchema).max(100000).optional(),
    iterationCount: z.number().int().min(1).max(1_000_000).optional(),
    timeoutMs: z.number().int().min(100).max(600000).optional(),
  }),
  'runner:cancel': z.object({ runId: idSchema }),
  'runner:get': z.object({ id: idSchema }),
  'runner:list': z.object({ limit: z.number().int().min(1).max(100).optional() }),
  'runner:report': z.object({
    runId: idSchema,
    format: z.enum(['json', 'junit', 'html']),
    filePath: z.string().max(4096).optional(),
  }),
  'data:parse': z.object({ content: z.string().min(1).max(2_000_000) }),
  'postman:inspect': z
    .object({
      content: z.string().max(50_000_000).optional(),
      filePath: z.string().max(4096).optional(),
    })
    .refine((v) => Boolean(v.content) !== Boolean(v.filePath), {
      message: 'content 与 filePath 必须二选一',
    }),
  'postman:import': z
    .object({
      content: z.string().max(50_000_000).optional(),
      filePath: z.string().max(4096).optional(),
      targetProjectId: idSchema.optional(),
      mode: z.enum(['new', 'into']).optional(),
    })
    .refine((v) => Boolean(v.content) !== Boolean(v.filePath), {
      message: 'content 与 filePath 必须二选一',
    }),
  'postman:export-collection': z.object({
    projectId: idSchema,
    collectionIds: z.array(idSchema).max(200).optional(),
    filePath: z.string().max(4096).optional(),
  }),
  'postman:import-environment': z
    .object({
      content: z.string().max(50_000_000).optional(),
      filePath: z.string().max(4096).optional(),
      projectId: idSchema,
      mode: z.enum(['new', 'overwrite']).optional(),
    })
    .refine((v) => Boolean(v.content) !== Boolean(v.filePath), {
      message: 'content 与 filePath 必须二选一',
    }),
  'postman:export-environment': z.object({
    environmentId: idSchema,
    filePath: z.string().max(4096).optional(),
  }),
  'tapi:export': z.object({
    projectId: idSchema,
    collectionIds: z.array(idSchema).max(500).optional(),
    secrets: z.enum(['strip', 'plain']).optional(),
    name: z.string().max(200).optional(),
    description: z.string().max(4000).optional(),
    filePath: z.string().max(4096).optional(),
  }),
  'tapi:inspect': z
    .object({
      content: z.string().max(50_000_000).optional(),
      filePath: z.string().max(4096).optional(),
    })
    .refine((v) => Boolean(v.content) !== Boolean(v.filePath), {
      message: 'content 与 filePath 必须二选一',
    }),
  'tapi:import': z
    .object({
      content: z.string().max(50_000_000).optional(),
      filePath: z.string().max(4096).optional(),
      mode: z.enum(['new', 'into']).optional(),
      targetProjectId: idSchema.optional(),
      apiConflict: z.enum(['skip', 'overwrite', 'duplicate']).optional(),
    })
    .refine((v) => Boolean(v.content) !== Boolean(v.filePath), {
      message: 'content 与 filePath 必须二选一',
    }),
  'open:get-config': empty,
  'open:set-config': z.object({
    enabled: z.boolean().optional(),
    port: z.number().int().min(1024).max(65535).optional(),
    access: z.enum(['loopback', 'lan']).optional(),
    ratePerMin: z.number().int().min(1).max(10000).optional(),
    password: z.string().max(256).optional(),
  }),
  'open:rotate-token': empty,
  'open:list-clients': empty,
  'open:revoke-client': z.object({ id: idSchema }),
  'open:call-log': z.object({ limit: z.number().int().min(1).max(1000).optional() }),
  'open:approval-result': z.object({ clientId: idSchema, approve: z.boolean() }),
  'task:list': empty,
  'task:create': z.object({
    name: nameSchema,
    targetType: targetTypeSchema,
    targetId: idSchema,
    ...scheduleSpecSource,
    envId: idSchema.nullable().optional(),
    overlap: overlapSchema.optional(),
    misfire: misfireSchema.optional(),
    notify: taskNotifySchema.optional(),
    enabled: z.boolean().optional(),
  }),
  'task:update': z.object({
    id: idSchema,
    name: nameSchema.optional(),
    targetType: targetTypeSchema.optional(),
    targetId: idSchema.optional(),
    spec: scheduleSpecSchema.optional(),
    envId: idSchema.nullable().optional(),
    overlap: overlapSchema.optional(),
    misfire: misfireSchema.optional(),
    notify: taskNotifySchema.optional(),
    enabled: z.boolean().optional(),
  }),
  'task:delete': z.object({ id: idSchema }),
  'task:toggle': z.object({ id: idSchema, enabled: z.boolean() }),
  'task:preview': z.object({
    ...scheduleSpecSource,
    from: z.number().int().min(0).max(8_640_000_000_000_000).optional(),
  }),
  'task:run-now': z.object({ id: idSchema }),
  'notify:list': z.object({
    cursor: z.string().max(200).nullable().optional(),
    unreadOnly: z.boolean().optional(),
    type: notifyTypeSchema.nullable().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  'notify:mark-read': z.object({ ids: z.array(idSchema).max(500) }),
  'notify:mark-all-read': empty,
  'notify:get-settings': empty,
  'notify:set-settings': z.object({
    rules: notifyRulesSchema.optional(),
    closeToTray: z.boolean().optional(),
    stateChangeOnly: z.boolean().optional(),
    webhookUrl: webhookUrlSchema.optional(),
    webhookTemplate: webhookTemplateSchema.optional(),
  }),
  'notify:test-webhook': z.object({ url: webhookUrlSchema, template: webhookTemplateSchema }),
  'window:get-state': empty,
  'window:minimize': empty,
  'window:toggle-maximize': empty,
  'window:close': empty,
} satisfies Record<ChannelName, z.ZodType>

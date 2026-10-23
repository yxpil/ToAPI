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
  }),
  'var:delete': z.object({ id: idSchema }),
  'api:send': z
    .object({
      apiId: idSchema.optional(),
      draft: draftSchema.optional(),
      envId: idSchema.nullable().optional(),
      cancelId: idSchema,
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
    scopeType: z.enum(['collection', 'api']),
    scopeId: idSchema,
    envId: idSchema.nullable().optional(),
    cancelId: idSchema,
    stopOnFail: z.boolean().optional(),
    delayMs: z.number().int().min(0).max(60000).optional(),
  }),
  'runner:cancel': z.object({ runId: idSchema }),
  'runner:get': z.object({ id: idSchema }),
  'runner:list': z.object({ limit: z.number().int().min(1).max(100).optional() }),
} satisfies Record<ChannelName, z.ZodType>

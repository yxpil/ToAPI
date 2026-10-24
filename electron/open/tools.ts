// @author yxpil
import type { SendInput, RunnerStartInput } from '@shared/channels'
import type { Repos } from '../db/repo'
import type { RequestFlow } from '../flow/request'
import type { RunnerFlow } from '../flow/runner'
import { buildTapi } from '../tapi/export'
import { buildSkillFiles } from './skill'

/** 开放通道的能力清单（11 号文档 §2.2）：读 + 跑 + 会话内变量，删除与写 secret 一律不暴露 */

export interface ToolHosts {
  repos: Repos
  flow: RequestFlow
  runner: RunnerFlow
  appVersion: string
  newCancelId: () => string
}

export type FieldType =
  'string' | 'number' | 'boolean' | 'stringArray' | 'object' | 'recordArray' | 'draft'

export interface FieldSpec {
  type: FieldType
  required?: boolean
  max?: number
  enum?: readonly string[]
  description?: string
}

export interface OpenTool {
  name: string
  title: string
  description: string
  kind: 'read' | 'exec'
  params: Record<string, FieldSpec>
  /** 执行类工具的目标 host 取自哪里，用于 host 白名单闸门（§2.3） */
  targetUrl?: (input: Record<string, unknown>, hosts: ToolHosts) => Promise<string | null>
  run: (input: Record<string, unknown>, hosts: ToolHosts) => unknown
}

const MAX_LEN: Record<FieldType, number> = {
  string: 4000,
  number: 0,
  boolean: 0,
  stringArray: 200,
  object: 20000,
  recordArray: 20000,
  draft: 20000,
}

export class ToolInputError extends Error {}

const isPlainObject = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const check = (spec: FieldSpec, value: unknown, label: string): unknown => {
  if (value === undefined || value === null) {
    if (spec.required) throw new ToolInputError(`缺少参数 ${label}`)
    return undefined
  }
  switch (spec.type) {
    case 'string': {
      if (typeof value !== 'string') throw new ToolInputError(`${label} 需要字符串`)
      if (value.length > (spec.max ?? MAX_LEN.string)) throw new ToolInputError(`${label} 过长`)
      if (spec.enum && !spec.enum.includes(value))
        throw new ToolInputError(`${label} 只能是 ${spec.enum.join(' / ')}`)
      return value
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value))
        throw new ToolInputError(`${label} 需要数字`)
      return value
    }
    case 'boolean': {
      if (typeof value !== 'boolean') throw new ToolInputError(`${label} 需要布尔值`)
      return value
    }
    case 'stringArray': {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string'))
        throw new ToolInputError(`${label} 需要字符串数组`)
      return value
    }
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new ToolInputError(`${label} 需要对象`)
      if (JSON.stringify(value).length > (spec.max ?? MAX_LEN.object))
        throw new ToolInputError(`${label} 超过大小限制`)
      return value
    }
    case 'recordArray': {
      if (!Array.isArray(value) || value.some((item) => !isPlainObject(item)))
        throw new ToolInputError(`${label} 需要对象数组（每行一个对象）`)
      if (JSON.stringify(value).length > (spec.max ?? MAX_LEN.recordArray))
        throw new ToolInputError(`${label} 超过大小限制`)
      return value
    }
    case 'draft': {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new ToolInputError(`${label} 需要请求草稿对象`)
      const draft = value as Record<string, unknown>
      if (typeof draft['method'] !== 'string' || typeof draft['url'] !== 'string')
        throw new ToolInputError('draft 至少要有 method 与 url')
      if (draft['url'].length > 8000) throw new ToolInputError('draft.url 过长')
      return draft
    }
  }
}

export const validateParams = (
  spec: Record<string, FieldSpec>,
  params: unknown,
): Record<string, unknown> => {
  const source =
    params && typeof params === 'object' && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {}
  if (
    params !== undefined &&
    params !== null &&
    (typeof params !== 'object' || Array.isArray(params))
  )
    throw new ToolInputError('参数必须是对象')
  const out: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(spec)) {
    const value = check(field, source[key], key)
    if (value !== undefined) out[key] = value
  }
  for (const key of Object.keys(source)) {
    if (!(key in spec)) throw new ToolInputError(`不支持的参数 ${key}`)
  }
  return out
}

const id = (description: string): FieldSpec => ({
  type: 'string',
  required: true,
  max: 64,
  description,
})
const optionalId = (description: string): FieldSpec => ({ type: 'string', max: 64, description })

/** 变量浅解析：只用于开放通道的 host 判定与白名单，不参与真实发送 */
const varPool = (repos: Repos, projectId: string): Record<string, string> => {
  const pool: Record<string, string> = {}
  const put = (list: { key: string; value: string; enabled: boolean }[]): void => {
    for (const v of list) if (v.enabled) pool[v.key] = v.value
  }
  const project = repos.project.get(projectId)
  put(repos.variable.listGlobals())
  if (project) {
    put(project.variables)
    for (const c of repos.collection.listByProject(project.id)) put(c.variables)
    const env = repos.environment.activeFor(project.id)
    if (env) put(repos.variable.listForEnv(env.id))
  }
  return pool
}

const resolveShallow = (template: string, pool: Record<string, string>): string =>
  template.replace(/\{\{\s*([\w:.-]+)\s*\}\}/g, (all, key: string) => pool[key] ?? all)

const hostOf = (url: string): string | null => {
  try {
    const parsed = new URL(url)
    return /^https?:$/.test(parsed.protocol) ? parsed.host : null
  } catch {
    return null
  }
}

/** 项目内所有接口在各环境取值下可能落到的 host（11 号文档 §2.3 白名单） */
export const declaredHosts = (repos: Repos, projectId: string): string[] => {
  const out = new Set<string>()
  const pool = varPool(repos, projectId)
  for (const c of repos.collection.listByProject(projectId)) {
    for (const api of repos.api.listByCollection(c.id)) {
      const host = hostOf(resolveShallow(api.url, pool))
      if (host) out.add(host)
    }
  }
  for (const env of repos.environment.listByProject(projectId)) {
    for (const v of repos.variable.listForEnv(env.id)) {
      const host = hostOf(v.value)
      if (host) out.add(host)
    }
  }
  return [...out]
}

const sendTargetHost = (input: Record<string, unknown>, hosts: ToolHosts): string | null => {
  const draft = input['draft'] as { url?: string } | undefined
  if (draft?.url) {
    const direct = hostOf(draft.url)
    if (direct) return direct
  }
  const apiId = input['apiId']
  if (typeof apiId === 'string') {
    const api = hosts.repos.api.get(apiId)
    if (!api) return null
    const collection = hosts.repos.collection.get(api.collectionId)
    const projectId = collection?.projectId ?? ''
    return hostOf(resolveShallow(api.url, varPool(hosts.repos, projectId)))
  }
  return null
}

export const OPEN_TOOLS: OpenTool[] = [
  {
    name: 'toapi_list_projects',
    title: '项目与接口树',
    description: '列出全部项目、集合与接口的 id / 名称 / 方法 / URL（浅层，不含脚本正文）',
    kind: 'read',
    params: {},
    run: (_input, hosts) => hosts.repos.project.listTree(),
  },
  {
    name: 'toapi_get_project',
    title: '单个项目详情',
    description: '按 projectId 返回项目定义（根集合认证、变量、前置/后置脚本、settings）',
    kind: 'read',
    params: { projectId: id('项目 id') },
    run: (input, hosts) => {
      const project = hosts.repos.project.get(String(input['projectId']))
      if (!project) throw new ToolInputError('项目不存在')
      return project
    },
  },
  {
    name: 'toapi_list_apis',
    title: '项目内接口清单',
    description: '列项目内全部接口；可选 collectionId 只取某集合直属接口',
    kind: 'read',
    params: { projectId: id('项目 id'), collectionId: optionalId('集合 id') },
    run: (input, hosts) => {
      const projectId = String(input['projectId'])
      const collectionId = input['collectionId'] ? String(input['collectionId']) : null
      const collections = collectionId
        ? [hosts.repos.collection.get(collectionId)].filter((c): c is NonNullable<typeof c> => !!c)
        : hosts.repos.collection.listByProject(projectId)
      return collections
        .filter((c) => c.projectId === projectId)
        .map((c) => ({
          collection: { id: c.id, name: c.name },
          apis: hosts.repos.api.listByCollection(c.id),
        }))
    },
  },
  {
    name: 'toapi_get_api',
    title: '接口完整定义',
    description: '返回接口的脚本、提取器、伪装、鉴权等全部定义字段',
    kind: 'read',
    params: { apiId: id('接口 id') },
    run: (input, hosts) => {
      const api = hosts.repos.api.get(String(input['apiId']))
      if (!api) throw new ToolInputError('接口不存在')
      return api
    },
  },
  {
    name: 'toapi_list_envs',
    title: '环境清单',
    description: '列项目的环境与激活状态（不含变量值）',
    kind: 'read',
    params: { projectId: id('项目 id') },
    run: (input, hosts) => hosts.repos.environment.listByProject(String(input['projectId'])),
  },
  {
    name: 'toapi_get_env',
    title: '环境变量',
    description: '返回环境变量；secret 变量值一律以 *** 呈现',
    kind: 'read',
    params: { projectId: id('项目 id'), environmentId: optionalId('环境 id，缺省取激活环境') },
    run: (input, hosts) => {
      const projectId = String(input['projectId'])
      const env = input['environmentId']
        ? hosts.repos.environment.get(String(input['environmentId']))
        : hosts.repos.environment.activeFor(projectId)
      if (!env) throw new ToolInputError('环境不存在或未激活')
      const vars = hosts.repos.variable.listForEnv(env.id).map((v) => ({
        ...v,
        value: v.secret && v.value !== '' ? '***' : v.value,
      }))
      return { environment: env, vars }
    },
  },
  {
    name: 'toapi_send_request',
    title: '发送请求',
    description: '按 apiId 或临时 draft 发送一次请求，返回最终请求、响应、断言与提取值',
    kind: 'exec',
    params: {
      apiId: optionalId('接口 id（与 draft 二选一）'),
      draft: { type: 'draft', description: '未保存的请求草稿' },
      envId: { type: 'string', max: 64, description: '临时指定环境' },
    },
    targetUrl: async (input, hosts) => Promise.resolve(sendTargetHost(input, hosts)),
    run: async (input, hosts) => {
      const send: SendInput = {
        cancelId: hosts.newCancelId(),
        ...(typeof input['apiId'] === 'string' ? { apiId: input['apiId'] as string } : {}),
        ...(input['draft'] ? { draft: input['draft'] as SendInput['draft'] } : {}),
        ...(typeof input['envId'] === 'string' ? { envId: input['envId'] as string } : {}),
      }
      if (!send.apiId && !send.draft) throw new ToolInputError('apiId 与 draft 必须二选一')
      return hosts.flow.send(send)
    },
  },
  {
    name: 'toapi_run_collection',
    title: '跑集合 Runner',
    description: '串行执行集合/项目/单接口，支持数据行与迭代次数；同步返回逐项结果',
    kind: 'exec',
    params: {
      scopeType: {
        type: 'string',
        required: true,
        enum: ['collection', 'project', 'api'] as const,
      },
      scopeId: id('范围 id'),
      envId: optionalId('环境 id'),
      stopOnFail: { type: 'boolean' },
      delayMs: { type: 'number' },
      iterationCount: { type: 'number' },
      iterationData: { type: 'recordArray', description: '数据行数组，每行一次迭代' },
    },
    run: async (input, hosts) => {
      const req: RunnerStartInput = {
        scopeType: input['scopeType'] as RunnerStartInput['scopeType'],
        scopeId: String(input['scopeId']),
        cancelId: hosts.newCancelId(),
        ...(typeof input['envId'] === 'string' ? { envId: input['envId'] as string } : {}),
        ...(typeof input['stopOnFail'] === 'boolean' ? { stopOnFail: input['stopOnFail'] } : {}),
        ...(typeof input['delayMs'] === 'number' ? { delayMs: input['delayMs'] } : {}),
        ...(typeof input['iterationCount'] === 'number'
          ? { iterationCount: input['iterationCount'] }
          : {}),
        ...(input['iterationData']
          ? { iterationData: input['iterationData'] as Record<string, string>[] }
          : {}),
      }
      const { runId } = await hosts.runner.start(req)
      const done = hosts.runner.whenDone(runId)
      if (done) await done
      const run = hosts.repos.runner.get(runId)
      if (!run) throw new ToolInputError('运行记录缺失')
      return run
    },
  },
  {
    name: 'toapi_get_run',
    title: '运行结果',
    description: '按 runId 返回逐项断言与通过率',
    kind: 'read',
    params: { runId: id('运行 id') },
    run: (input, hosts) => {
      const run = hosts.repos.runner.get(String(input['runId']))
      if (!run) throw new ToolInputError('运行记录不存在')
      return run
    },
  },
  {
    name: 'toapi_list_runs',
    title: '最近运行',
    description: '列最近的 Runner 记录（不含逐项明细）',
    kind: 'read',
    params: { limit: { type: 'number' } },
    run: (input, hosts) =>
      hosts.repos.runner.list(
        Math.min(Math.max(Math.round(Number(input['limit'] ?? 20)) || 20, 1), 100),
      ),
  },
  {
    name: 'toapi_get_history',
    title: '请求历史',
    description: '按项目或接口查最近的请求/响应摘要，用于确认改动生效',
    kind: 'read',
    params: {
      projectId: optionalId('项目 id'),
      apiId: optionalId('接口 id'),
      limit: { type: 'number' },
    },
    run: (input, hosts) =>
      hosts.repos.history.list({
        ...(typeof input['projectId'] === 'string' ? { projectId: input['projectId'] } : {}),
        ...(typeof input['apiId'] === 'string' ? { apiId: input['apiId'] } : {}),
        limit: Math.min(Math.max(Math.round(Number(input['limit'] ?? 20)) || 20, 1), 100),
      }),
  },
  {
    name: 'toapi_set_runtime_var',
    title: '设置运行时变量',
    description: '只写本会话内存里的运行时变量（不落库、不写 secret），供后续请求 {{var}} 插值',
    kind: 'exec',
    params: {
      projectId: id('项目 id'),
      key: { type: 'string', required: true, max: 200 },
      value: { type: 'string', required: true, max: 20000 },
    },
    run: (input, hosts) => {
      const projectId = String(input['projectId'])
      if (!hosts.repos.project.get(projectId)) throw new ToolInputError('项目不存在')
      hosts.flow.runtimeFor(projectId).set(String(input['key']), String(input['value']))
      return { ok: true, projectId, key: String(input['key']) }
    },
  },
  {
    name: 'toapi_export_tapi',
    title: '导出 .tapi',
    description: '导出项目或集合子集的 .tapi 内容；敏感变量恒定剔除，不回传明文密钥',
    kind: 'read',
    params: {
      projectId: id('项目 id'),
      collectionIds: { type: 'stringArray', description: '只导出这些集合子树' },
    },
    run: (input, hosts) => {
      const { file } = buildTapi(hosts.repos, {
        projectId: String(input['projectId']),
        ...(Array.isArray(input['collectionIds'])
          ? { collectionIds: input['collectionIds'] as string[] }
          : {}),
        secrets: 'strip',
        appVersion: hosts.appVersion,
      })
      return { content: JSON.stringify(file, null, 2) }
    },
  },
  {
    name: 'toapi_get_skill',
    title: '取 AI Skill 说明书',
    description:
      '生成项目的 SKILL.md 与示例代码清单；没有 MCP 的 AI 可照此手工调用（11 号文档 §3）',
    kind: 'read',
    params: { projectId: id('项目 id'), environmentName: optionalId('环境名，缺省用激活环境') },
    run: (input, hosts) => {
      const files = buildSkillFiles(hosts.repos, String(input['projectId']), {
        ...(typeof input['environmentName'] === 'string'
          ? { environmentName: input['environmentName'] }
          : {}),
      })
      const skill = files.find((f) => f.path === 'SKILL.md')
      return {
        skill: skill?.content ?? '',
        files: files.map((f) => f.path),
        examples: files.filter((f) => f.path.startsWith('examples/')),
      }
    },
  },
]

export const toolByName = (name: string): OpenTool | undefined =>
  OPEN_TOOLS.find((t) => t.name === name)

// @author yxpil
import type {
  Api,
  Auth,
  BodyType,
  Collection,
  CollectionVariable,
  HttpMethod,
  KvRow,
  ProjectSettings,
} from '@shared/types'
import { IpcErrorRaised } from '@shared/types'
import type { TapiImportResult, TapiInspection, TapiStats } from '@shared/channels'
import type { Db } from '../db/database'
import { transaction } from '../db/database'
import type { Repos } from '../db/repo'
import {
  TAPI_SUPPORTED_VERSION,
  checksumOf,
  type TapiApi,
  type TapiCollection,
  type TapiFile,
  type TapiPayload,
  type TapiProject,
  type TapiVariable,
} from './format'

export type { TapiInspection }

export type ApiConflict = 'skip' | 'overwrite' | 'duplicate'

export interface ImportTapiInput {
  file: TapiFile
  mode: 'new' | 'into'
  targetProjectId?: string
  apiConflict?: ApiConflict
}

export type TapiImportReport = Omit<TapiImportResult, 'inspection'>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function bad(message: string): never {
  throw new IpcErrorRaised({ code: 'VALIDATION', message })
}

const text = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback

const num = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

const bool = (value: unknown, fallback = false): boolean =>
  typeof value === 'boolean' ? value : fallback

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

const readVars = (value: unknown): TapiVariable[] =>
  asList(value)
    .filter(isRecord)
    .filter((v) => typeof v['key'] === 'string')
    .map((v) => ({
      key: v['key'] as string,
      value: text(v['value']),
      secret: bool(v['secret']),
      enabled: bool(v['enabled'], true),
      ...(bool(v['redacted']) ? { redacted: true as const } : {}),
    }))

const readKvRows = (value: unknown): KvRow[] =>
  asList(value)
    .filter(isRecord)
    .map((r) => ({
      key: text(r['key']),
      value: text(r['value']),
      enabled: bool(r['enabled'], true),
      desc: text(r['desc']),
    }))
    .filter((r) => r.key !== '')

const readAuth = (value: unknown): Auth => {
  if (!isRecord(value) || typeof value['type'] !== 'string') return { type: 'none' }
  return value as unknown as Auth
}

const BODY_TYPES: BodyType[] = ['none', 'json', 'form', 'urlencoded', 'raw', 'binary']

const readApi = (value: unknown): TapiApi => {
  const v = isRecord(value) ? value : {}
  return {
    key: text(v['key']),
    name: text(v['name'], '未命名接口'),
    description: text(v['description']),
    method: (text(v['method'], 'GET') as HttpMethod).toUpperCase() as HttpMethod,
    url: text(v['url']),
    params: readKvRows(v['params']),
    headers: readKvRows(v['headers']),
    body_type: BODY_TYPES.includes(v['body_type'] as BodyType)
      ? (v['body_type'] as BodyType)
      : 'none',
    body: text(v['body']),
    auth: readAuth(v['auth']),
    fake: isRecord(v['fake']) ? (v['fake'] as unknown as ProjectSettings['fake']) : {},
    pre_script: text(v['pre_script']),
    post_script: text(v['post_script']),
    extractors: asList(v['extractors']),
  }
}

const readCollection = (value: unknown): TapiCollection => {
  const v = isRecord(value) ? value : {}
  return {
    key: text(v['key']),
    name: text(v['name'], '未命名集合'),
    description: text(v['description']),
    auth: readAuth(v['auth']),
    variables: readVars(v['variables']),
    pre_script: text(v['pre_script']),
    post_script: text(v['post_script']),
    children: asList(v['children']).map(readCollection),
    apis: asList(v['apis']).map(readApi),
  }
}

const readPayload = (raw: Record<string, unknown>): TapiPayload => {
  const payload = isRecord(raw['payload']) ? (raw['payload'] as Record<string, unknown>) : {}
  const project = isRecord(payload['project'])
    ? (payload['project'] as Record<string, unknown>)
    : undefined
  if (!project) bad('payload.project 缺失')
  return {
    project: {
      name: text(project['name'], '未命名项目'),
      description: text(project['description']),
      settings: isRecord(project['settings'])
        ? (project['settings'] as unknown as TapiProject['settings'])
        : {},
      auth: readAuth(project['auth']),
      variables: readVars(project['variables']),
      pre_script: text(project['pre_script']),
      post_script: text(project['post_script']),
      collections: asList(project['collections']).map(readCollection),
    },
    environments: asList(payload['environments'])
      .filter(isRecord)
      .map((e) => ({ name: text(e['name'], '未命名环境'), variables: readVars(e['variables']) })),
    globals: readVars(payload['globals']),
    cases: asList(payload['cases']),
  }
}

/** 结构校验 + format_version 判定（08 号文档 §5）；外部输入逐字段收窄，绝不直接 cast */
export const readTapi = (source: string): TapiFile => {
  let raw: unknown
  try {
    raw = JSON.parse(source) as unknown
  } catch (e) {
    bad(`文件不是合法 JSON：${(e as Error).message}`)
  }
  if (!isRecord(raw) || raw['format'] !== 'tapi') bad('这不是 .tapi 文件（缺少 format: "tapi"）')
  const formatVersion = text(raw['format_version'])
  const version = Number.parseFloat(formatVersion)
  if (!Number.isFinite(version)) bad('format_version 无法解析')
  if (version > TAPI_SUPPORTED_VERSION)
    bad(`该文件由更新版本导出（format_version ${formatVersion}），请升级 ToAPI`)
  const meta = isRecord(raw['meta']) ? (raw['meta'] as Record<string, unknown>) : {}
  return {
    format: 'tapi',
    format_version: formatVersion,
    meta: {
      exported_at: num(meta['exported_at']),
      app_version: text(meta['app_version']),
      name: text(meta['name']),
      ...(typeof meta['description'] === 'string' ? { description: meta['description'] } : {}),
      ...(bool(meta['contains_secrets']) ? { contains_secrets: true as const } : {}),
      checksum: text(meta['checksum']),
    },
    payload: readPayload(raw),
  }
}

const countApis = (collections: TapiCollection[]): number =>
  collections.reduce((n, c) => n + c.apis.length + countApis(c.children), 0)

const countCollections = (collections: TapiCollection[]): number =>
  collections.reduce((n, c) => n + 1 + countCollections(c.children), 0)

const countRedacted = (vars: TapiVariable[]): number =>
  vars.reduce((n, v) => n + (v.redacted ? 1 : 0), 0)

export const inspectTapi = (repos: Repos, file: TapiFile): TapiInspection => {
  const envVars = file.payload.environments.flatMap((e) => e.variables)
  const allVars = [
    ...file.payload.project.variables,
    ...file.payload.globals,
    ...envVars,
    ...file.payload.project.collections.flatMap((c) => c.variables),
  ]
  const same = repos.project.list().find((p) => p.name === file.payload.project.name)
  const stats: TapiStats = {
    collections: countCollections(file.payload.project.collections),
    apis: countApis(file.payload.project.collections),
    environments: file.payload.environments.length,
    globals: file.payload.globals.length,
  }
  return {
    name: file.meta.name || file.payload.project.name,
    ...(file.meta.description ? { description: file.meta.description } : {}),
    appVersion: file.meta.app_version,
    exportedAt: file.meta.exported_at,
    formatVersion: file.format_version,
    supported: Number.parseFloat(file.format_version) <= TAPI_SUPPORTED_VERSION,
    // 旧版本导出没有 checksum 时降级为跳过校验（08 号文档 §6）
    checksumOk: file.meta.checksum === '' || file.meta.checksum === checksumOf(file.payload),
    containsSecrets: file.meta.contains_secrets === true,
    redactedCount: countRedacted(allVars),
    stats,
    sameNameProjectId: same?.id ?? null,
    sameNameProject: same?.name ?? null,
  }
}

const uniqueProjectName = (repos: Repos, wanted: string): string => {
  const taken = new Set(repos.project.list().map((p) => p.name))
  if (!taken.has(wanted)) return wanted
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${wanted} (${String(i)})`
    if (!taken.has(candidate)) return candidate
  }
  return `${wanted} (${String(Date.now())})`
}

/** 被剔除的敏感变量：secret 且值为空（08 号文档 §4） */
const isRedacted = (v: TapiVariable): boolean => v.secret === true && v.value === ''

const toCollectionVars = (vars: TapiVariable[]): CollectionVariable[] =>
  vars.map((v) => ({
    key: v.key,
    value: v.value,
    secret: v.secret,
    enabled: v.enabled,
    desc: isRedacted(v) ? '导入时已剔除，需自行填写' : '',
  }))

const apiSignature = (api: Pick<Api, 'name' | 'method' | 'url'>): string =>
  `${api.method}|${api.url}|${api.name}`

export const importTapi = (db: Db, repos: Repos, input: ImportTapiInput): TapiImportReport =>
  transaction(db, () => {
    const file = input.file
    const warnings: string[] = []
    if (file.payload.cases.length > 0)
      warnings.push(
        `文件含 ${String(file.payload.cases.length)} 个测试案例，当前版本尚不导入案例（09 号文档），已忽略`,
      )
    const conflict: ApiConflict = input.apiConflict ?? 'skip'
    const source = file.payload.project

    let projectId: string
    if (input.mode === 'into') {
      const target = input.targetProjectId ? repos.project.get(input.targetProjectId) : null
      if (!target) bad('导入到现有项目需要有效的 targetProjectId')
      projectId = (target as { id: string }).id
    } else {
      projectId = repos.project.create({
        name: uniqueProjectName(repos, source.name),
        description: source.description,
      }).id
    }

    const project = repos.project.get(projectId)
    if (!project) throw new IpcErrorRaised({ code: 'NOT_FOUND', message: '项目不存在' })
    const mergedProjectVars = project.variables.slice()
    for (const v of source.variables) {
      const at = mergedProjectVars.findIndex((x) => x.key === v.key)
      if (at < 0) mergedProjectVars.push(...toCollectionVars([v]))
      else if (isRedacted(v)) warnings.push(`项目变量 ${v.key} 在文件中已剔除，保留本地值`)
    }
    repos.project.update(projectId, {
      description: project.description || source.description,
      settings: input.mode === 'into' ? project.settings : source.settings,
      auth: input.mode === 'into' && project.auth.type !== 'none' ? project.auth : source.auth,
      variables: mergedProjectVars,
      preScript: project.preScript || source.pre_script,
      postScript: project.postScript || source.post_script,
    })

    const imported: TapiStats = { collections: 0, apis: 0, environments: 0, globals: 0 }
    let skipped = 0

    const byPath = new Map<string, string>()
    const indexTree = (
      parentId: string | null,
      list: Collection[] = repos.collection.listByProject(projectId),
    ): void => {
      for (const node of list.filter((c) => (c.parentId ?? '') === (parentId ?? ''))) {
        byPath.set(`${parentId ?? ''}\u0000${node.name}`, node.id)
        indexTree(node.id, list)
      }
    }
    indexTree(null)

    const writeApi = (collectionId: string, api: TapiApi, name: string): void => {
      const created = repos.api.create({
        collectionId,
        name,
        method: api.method,
        url: api.url,
      })
      repos.api.update(created.id, {
        name,
        description: api.description,
        params: api.params,
        headers: api.headers,
        bodyType: api.body_type,
        body: api.body,
        auth: api.auth,
        fake: api.fake ?? {},
        preScript: api.pre_script,
        postScript: api.post_script,
        extractors: api.extractors as never,
      })
      imported.apis += 1
    }

    const importApi = (collectionId: string, api: TapiApi): void => {
      const signature = apiSignature({ name: api.name, method: api.method, url: api.url })
      const hit = repos.api
        .listByCollection(collectionId)
        .find((a) => apiSignature(a) === signature)
      if (!hit) {
        writeApi(collectionId, api, api.name)
        return
      }
      if (conflict === 'skip') {
        skipped += 1
        return
      }
      if (conflict === 'overwrite') {
        repos.api.update(hit.id, {
          description: api.description,
          params: api.params,
          headers: api.headers,
          bodyType: api.body_type,
          body: api.body,
          auth: api.auth,
          fake: api.fake ?? {},
          preScript: api.pre_script,
          postScript: api.post_script,
          extractors: api.extractors as never,
        })
        imported.apis += 1
        return
      }
      writeApi(collectionId, api, `${api.name} (2)`)
    }

    const walk = (nodes: TapiCollection[], parentId: string | null): void => {
      for (const node of nodes) {
        const lookupKey = `${parentId ?? ''}\u0000${node.name}`
        const known = byPath.get(lookupKey)
        const collectionId =
          known ?? repos.collection.create({ projectId, parentId, name: node.name }).id
        if (!known) {
          byPath.set(lookupKey, collectionId)
          repos.collection.update(collectionId, {
            description: node.description,
            auth: node.auth,
            variables: toCollectionVars(node.variables),
            preScript: node.pre_script,
            postScript: node.post_script,
          })
          imported.collections += 1
        } else {
          const current = repos.collection.get(known)
          if (current) {
            repos.collection.update(known, {
              description: current.description || node.description,
              auth: current.auth.type === 'inherit' ? node.auth : current.auth,
              variables:
                current.variables.length === 0
                  ? toCollectionVars(node.variables)
                  : current.variables,
              preScript: current.preScript || node.pre_script,
              postScript: current.postScript || node.post_script,
            })
          }
        }
        for (const api of node.apis) importApi(collectionId, api)
        walk(node.children, collectionId)
      }
    }
    walk(source.collections, null)

    for (const env of file.payload.environments) {
      let target = repos.environment.listByProject(projectId).find((e) => e.name === env.name)
      if (!target) {
        target = repos.environment.create({ projectId, name: env.name })
        imported.environments += 1
      }
      for (const v of env.variables) {
        if (isRedacted(v)) warnings.push(`环境「${env.name}」的 ${v.key} 已剔除，导入后需自行填写`)
        repos.variable.upsert({
          scope: 'environment',
          environmentId: target.id,
          key: v.key,
          value: v.value,
          secret: v.secret,
          enabled: v.enabled,
        })
      }
    }

    for (const v of file.payload.globals) {
      if (repos.variable.find('global', null, v.key)) {
        skipped += 1
        continue
      }
      if (isRedacted(v)) warnings.push(`全局变量 ${v.key} 已剔除，导入后需自行填写`)
      repos.variable.upsert({
        scope: 'global',
        key: v.key,
        value: v.value,
        secret: v.secret,
        enabled: v.enabled,
      })
      imported.globals += 1
    }

    return {
      projectId,
      projectName: repos.project.get(projectId)?.name ?? source.name,
      imported,
      skipped,
      warnings,
    }
  })

// @author yxpil
import type { Collection, CollectionVariable } from '@shared/types'
import { IpcErrorRaised } from '@shared/types'
import type { TapiStats } from '@shared/channels'
import type { Repos } from '../db/repo'
import {
  TAPI_FORMAT,
  TAPI_FORMAT_VERSION,
  checksumOf,
  type TapiApi,
  type TapiCollection,
  type TapiEnvironment,
  type TapiFile,
  type TapiPayload,
  type TapiVariable,
} from './format'

export type { TapiStats }

export interface BuildTapiInput {
  projectId: string
  /** 只导出这些集合及其子树；缺省导出整个项目 */
  collectionIds?: string[]
  /** secret 变量默认剔除（08 号文档 §4） */
  secrets: 'strip' | 'plain'
  appVersion: string
  name?: string
  description?: string
}

interface VarLike {
  key: string
  value: string
  secret: boolean
  enabled: boolean
}

const toTapiVar = (v: VarLike, strip: boolean): TapiVariable => ({
  key: v.key,
  value: strip && v.secret ? '' : v.value,
  secret: v.secret,
  enabled: v.enabled,
  ...(strip && v.secret ? { redacted: true } : {}),
})

const hasSecretValue = (vars: VarLike[]): boolean => vars.some((v) => v.secret && v.value !== '')

export const buildTapi = (
  repos: Repos,
  input: BuildTapiInput,
): { file: TapiFile; stats: TapiStats; containsSecrets: boolean } => {
  const project = repos.project.get(input.projectId)
  if (!project) throw new IpcErrorRaised({ code: 'NOT_FOUND', message: '项目不存在' })

  const strip = input.secrets !== 'plain'
  const byId = new Map<string, Collection>()
  const childrenOf = new Map<string, Collection[]>()
  for (const c of repos.collection.listByProject(project.id)) {
    byId.set(c.id, c)
    const key = c.parentId ?? ''
    const bucket = childrenOf.get(key)
    if (bucket) bucket.push(c)
    else childrenOf.set(key, [c])
  }
  for (const list of childrenOf.values()) list.sort((a, b) => a.sortOrder - b.sortOrder)

  let colSeq = 0
  let apiSeq = 0
  const buildCollection = (node: Collection): TapiCollection => {
    colSeq += 1
    const apis: TapiApi[] = repos.api.listByCollection(node.id).map((api) => {
      apiSeq += 1
      return {
        key: `api-${apiSeq}`,
        name: api.name,
        description: api.description,
        method: api.method,
        url: api.url,
        params: api.params,
        headers: api.headers,
        body_type: api.bodyType,
        body: api.body,
        auth: api.auth,
        fake: api.fake,
        pre_script: api.preScript,
        post_script: api.postScript,
        extractors: api.extractors,
      }
    })
    return {
      key: `col-${colSeq}`,
      name: node.name,
      description: node.description,
      auth: node.auth,
      variables: node.variables.map((v: CollectionVariable) => toTapiVar(v, strip)),
      pre_script: node.preScript,
      post_script: node.postScript,
      children: (childrenOf.get(node.id) ?? []).map(buildCollection),
      apis,
    }
  }

  const roots: Collection[] =
    input.collectionIds && input.collectionIds.length > 0
      ? input.collectionIds.map((id) => byId.get(id)).filter((c): c is Collection => !!c)
      : (childrenOf.get('') ?? []).slice()
  const collections = roots.map(buildCollection)

  let containsSecrets = hasSecretValue(project.variables)
  for (const c of byId.values()) if (hasSecretValue(c.variables)) containsSecrets = true
  for (const v of repos.variable.listGlobals())
    if (v.secret && v.value !== '') containsSecrets = true

  const environments: TapiEnvironment[] = repos.environment.listByProject(project.id).map((env) => {
    const vars = repos.variable.listForEnv(env.id)
    if (hasSecretValue(vars)) containsSecrets = true
    return { name: env.name, variables: vars.map((v) => toTapiVar(v, strip)) }
  })
  const globals = repos.variable.listGlobals().map((v) => toTapiVar(v, strip))

  const payload: TapiPayload = {
    project: {
      name: project.name,
      description: project.description,
      settings: project.settings,
      auth: project.auth,
      variables: project.variables.map((v) => toTapiVar(v, strip)),
      pre_script: project.preScript,
      post_script: project.postScript,
      collections,
    },
    environments,
    globals,
    cases: [],
  }

  const file: TapiFile = {
    format: TAPI_FORMAT,
    format_version: TAPI_FORMAT_VERSION,
    meta: {
      exported_at: Date.now(),
      app_version: input.appVersion,
      name: input.name?.trim() || project.name,
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      ...(strip || !containsSecrets ? {} : { contains_secrets: true as const }),
      // checksum 对 payload 规范化 JSON 计算，meta 不参与（08 号文档 §6）
      checksum: checksumOf(payload),
    },
    payload,
  }

  return {
    file,
    containsSecrets: strip ? false : containsSecrets,
    stats: {
      collections: colSeq,
      apis: apiSeq,
      environments: environments.length,
      globals: globals.length,
    },
  }
}

// @author yxpil
import { createHash } from 'node:crypto'
import type { Auth, BodyType, HttpMethod, KvRow, ProjectSettings } from '@shared/types'

/** `.tapi` 文件结构与校验和（08 号文档 §2、§6） */

export const TAPI_FORMAT = 'tapi'
export const TAPI_FORMAT_VERSION = '1.0'
/** 本应用能导入的最高 format_version；高于它直接拒绝（08 号文档 §5） */
export const TAPI_SUPPORTED_VERSION = 1.0

export interface TapiApi {
  key: string
  name: string
  description: string
  method: HttpMethod
  url: string
  params: KvRow[]
  headers: KvRow[]
  body_type: BodyType
  body: string
  auth: Auth
  fake: ProjectSettings['fake']
  pre_script: string
  post_script: string
  extractors: unknown[]
}

export interface TapiCollection {
  key: string
  name: string
  description: string
  auth: Auth
  variables: TapiVariable[]
  pre_script: string
  post_script: string
  children: TapiCollection[]
  apis: TapiApi[]
}

export interface TapiProject {
  name: string
  description: string
  settings: ProjectSettings
  auth: Auth
  variables: TapiVariable[]
  pre_script: string
  post_script: string
  collections: TapiCollection[]
}

export interface TapiVariable {
  key: string
  value: string
  secret: boolean
  enabled: boolean
  /** secret 变量被剔除时置 true，导入方 UI 据此提示"需自行填写"（08 号文档 §4） */
  redacted?: boolean
}

export interface TapiEnvironment {
  name: string
  variables: TapiVariable[]
}

export interface TapiPayload {
  project: TapiProject
  environments: TapiEnvironment[]
  globals: TapiVariable[]
  /** 测试案例随 09 号文档落地后填充；当前导出为空数组 */
  cases: unknown[]
}

export interface TapiMeta {
  exported_at: number
  app_version: string
  name: string
  description?: string
  contains_secrets?: true
  checksum: string
}

export interface TapiFile {
  format: typeof TAPI_FORMAT
  format_version: string
  meta: TapiMeta
  payload: TapiPayload
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** key 字典序递归排序、无空白 —— 导出与导入必须用同一算法（08 号文档 §6） */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  return JSON.stringify(value ?? null)
}

export const checksumOf = (payload: TapiPayload): string =>
  `sha256:${createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex')}`

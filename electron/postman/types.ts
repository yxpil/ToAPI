// @author yxpil
import type { Api, Auth, CollectionVariable, Extractor, FakeConfig } from '@shared/types'
import type { PostmanWarning } from '@shared/types'

/** 内部导入模型：与 Repo 解耦，先解析成纯数据再落库（23 号文档 §12） */
export interface ImportedApi {
  name: string
  description: string
  method: Api['method']
  url: string
  params: Api['params']
  headers: Api['headers']
  bodyType: Api['bodyType']
  body: string
  auth: Auth
  fake: FakeConfig
  preScript: string
  postScript: string
  extractors: Extractor[]
  sortOrder: number
  source: Record<string, unknown>
}

export interface ImportedCollection {
  name: string
  description: string
  auth: Auth
  variables: CollectionVariable[]
  preScript: string
  postScript: string
  sortOrder: number
  source: Record<string, unknown>
  children: ImportedCollection[]
  apis: ImportedApi[]
}

export interface ImportedCollectionModel {
  name: string
  description: string
  schema: string
  auth: Auth
  variables: CollectionVariable[]
  preScript: string
  postScript: string
  source: Record<string, unknown>
  rootApis: ImportedApi[]
  collections: ImportedCollection[]
}

export interface ImportedEnvironmentModel {
  name: string
  variables: {
    key: string
    value: string
    enabled: boolean
    secret: boolean
    desc: string
  }[]
  source: Record<string, unknown>
}

export interface ParseResult<T> {
  model: T
  warnings: PostmanWarning[]
}

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export const asString = (v: unknown, fallback = ''): string =>
  typeof v === 'string' ? v : fallback

export const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

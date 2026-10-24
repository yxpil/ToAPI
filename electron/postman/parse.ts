// @author yxpil
import type { Api, Auth, CollectionVariable, Extractor, KvRow } from '@shared/types'
import type { PostmanWarning } from '@shared/types'
import {
  asArray,
  asString,
  isObject,
  type ImportedApi,
  type ImportedCollection,
  type ImportedCollectionModel,
  type ImportedEnvironmentModel,
  type ParseResult,
} from './types'

const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'])

const describe = (v: unknown): string => {
  if (typeof v === 'string') return v
  if (isObject(v) && typeof v['content'] === 'string') return v['content']
  return ''
}

const warn = (warnings: PostmanWarning[], path: string, code: string, message: string): void => {
  warnings.push({ path, code, message })
}

const kvRows = (value: unknown): { key: string; value: string; enabled: boolean; desc: string }[] =>
  asArray(value)
    .filter(isObject)
    .map((row) => ({
      key: asString(row['key']),
      value: asString(row['value']),
      enabled: row['disabled'] !== true,
      desc: describe(row['description']),
    }))

const headerRows = (value: unknown, path: string, warnings: PostmanWarning[]): KvRow[] => {
  if (typeof value === 'string') {
    return value
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '')
      .map((line) => {
        const at = line.indexOf(':')
        return at < 0
          ? { key: line.trim(), value: '', enabled: true, desc: '' }
          : {
              key: line.slice(0, at).trim(),
              value: line.slice(at + 1).trim(),
              enabled: true,
              desc: '',
            }
      })
  }
  if (value !== undefined && !Array.isArray(value)) {
    warn(warnings, path, 'HEADER_SHAPE', 'header 既不是字符串也不是数组，已忽略')
  }
  return kvRows(value)
}

const authOption = (list: unknown, key: string): string => {
  const hit = asArray(list)
    .filter(isObject)
    .find((row) => asString(row['key']) === key)
  return hit ? asString(hit['value']) : ''
}

export const parseAuth = (value: unknown, path: string, warnings: PostmanWarning[]): Auth => {
  if (value === undefined) return { type: 'inherit' }
  if (typeof value === 'string') {
    if (value === 'noauth') return { type: 'none' }
    if (value === 'inherit') return { type: 'inherit' }
    warn(warnings, path, 'AUTH_UNSUPPORTED', `认证类型 ${value} 暂不支持，已保留原文`)
    return { type: 'none' }
  }
  if (!isObject(value)) {
    warn(warnings, path, 'AUTH_SHAPE', 'auth 结构无法识别，已保留原文')
    return { type: 'none' }
  }
  const type = asString(value['type'], 'noauth')
  switch (type) {
    case 'noauth':
      return { type: 'none' }
    case 'inherit':
      return { type: 'inherit' }
    case 'bearer':
      return { type: 'bearer', token: authOption(value['bearer'], 'token') }
    case 'basic':
      return {
        type: 'basic',
        username: authOption(value['basic'], 'username'),
        password: authOption(value['basic'], 'password'),
      }
    case 'apikey': {
      const location = authOption(value['apikey'], 'in')
      return {
        type: 'apikey',
        key: authOption(value['apikey'], 'key'),
        value: authOption(value['apikey'], 'value'),
        addTo: location === 'query' ? 'query' : 'header',
      }
    }
    default:
      warn(warnings, path, 'AUTH_UNSUPPORTED', `认证类型 ${type} 将在 B4 支持，当前仅保留原文`)
      return { type: 'none' }
  }
}

export const parseVariables = (value: unknown): CollectionVariable[] =>
  asArray(value)
    .filter(isObject)
    .filter((row) => asString(row['key']) !== '')
    .map((row) => ({
      key: asString(row['key']),
      value: asString(row['value']),
      enabled: row['disabled'] !== true,
      secret: asString(row['type']) === 'secret',
      desc: describe(row['description']),
    }))

export const parseEvents = (
  value: unknown,
): { preScript: string; postScript: string; scripts: number } => {
  const scripts = asArray(value).filter(isObject)
  const collect = (listen: string): string =>
    scripts
      .filter((event) => asString(event['listen']) === listen)
      .map((event) => {
        const script = event['script']
        if (!isObject(script)) return ''
        const exec = script['exec']
        if (typeof exec === 'string') return exec
        return asArray(exec)
          .map((line) => asString(line))
          .join('\n')
      })
      .filter((code) => code !== '')
      .join('\n')
  return {
    preScript: collect('prerequest'),
    postScript: collect('test'),
    scripts: scripts.length,
  }
}

interface UrlResult {
  url: string
  params: KvRow[]
  variables: CollectionVariable[]
}

const pathVars = (value: unknown): CollectionVariable[] =>
  asArray(value)
    .filter(isObject)
    .filter((row) => asString(row['key']) !== '')
    .map((row) => ({
      key: asString(row['key']),
      value: asString(row['value']),
      enabled: true,
      secret: false,
      desc: describe(row['description']),
    }))

const substitutePath = (text: string, vars: CollectionVariable[]): string => {
  let next = text
  for (const v of vars) {
    if (v.value !== '') next = next.replaceAll(`:${v.key}`, `{{${v.key}}}`)
  }
  return next
}

export const parseUrl = (value: unknown, path: string, warnings: PostmanWarning[]): UrlResult => {
  if (typeof value === 'string') return { url: value, params: [], variables: [] }
  if (!isObject(value)) {
    warn(warnings, path, 'URL_SHAPE', 'url 结构无法识别')
    return { url: '', params: [], variables: [] }
  }
  const variables = pathVars(value['variable'])
  const params = kvRows(value['query'])
  let raw = asString(value['raw'])
  if (raw === '') {
    const protocol = asString(value['protocol'], 'https')
    const host = Array.isArray(value['host'])
      ? asArray(value['host'])
          .map((h) => asString(h))
          .join('.')
      : asString(value['host'])
    const pathPart = Array.isArray(value['path'])
      ? asArray(value['path'])
          .map((p) => asString(p))
          .join('/')
      : asString(value['path'])
    const port = asString(value['port'])
    raw = `${protocol}://${host}${port ? `:${port}` : ''}/${pathPart}`
  }
  const q = raw.indexOf('?')
  if (q >= 0) raw = raw.slice(0, q)
  const hash = raw.indexOf('#')
  if (hash >= 0) raw = raw.slice(0, hash)
  return { url: substitutePath(raw, variables), params, variables }
}

interface BodyResult {
  bodyType: Api['bodyType']
  body: string
}

export const parseBody = (value: unknown, path: string, warnings: PostmanWarning[]): BodyResult => {
  if (!isObject(value)) return { bodyType: 'none', body: '' }
  const mode = asString(value['mode'])
  switch (mode) {
    case '':
      return { bodyType: 'none', body: '' }
    case 'raw': {
      const raw = asString(value['raw'])
      const options = value['options']
      const language =
        isObject(options) && isObject(options['raw']) ? asString(options['raw']['language']) : ''
      return { bodyType: language === 'json' ? 'json' : 'raw', body: raw }
    }
    case 'urlencoded': {
      const rows = kvRows(value['urlencoded'])
      return {
        bodyType: 'urlencoded',
        body: new URLSearchParams(
          rows.filter((r) => r.enabled).map((r) => [r.key, r.value] as [string, string]),
        ).toString(),
      }
    }
    case 'formdata': {
      const rows = asArray(value['formdata']).filter(isObject)
      const files = rows.filter((row) => asString(row['type']) === 'file')
      if (files.length > 0) {
        warn(
          warnings,
          `${path}/formdata`,
          'FILE_FIELD',
          `包含 ${files.length} 个文件字段，B1 仅保留文本字段与原文`,
        )
      }
      const text = rows.filter((row) => asString(row['type']) !== 'file')
      return {
        bodyType: 'form',
        body: new URLSearchParams(
          text
            .filter((row) => row['disabled'] !== true)
            .map((row) => [asString(row['key']), asString(row['value'])] as [string, string]),
        ).toString(),
      }
    }
    case 'graphql': {
      const graphql = value['graphql']
      const query = isObject(graphql) ? asString(graphql['query']) : ''
      warn(
        warnings,
        `${path}/graphql`,
        'GRAPHQL_DEFERRED',
        'GraphQL body 将在 B3 启用，当前按 raw 导入并保留原文',
      )
      return { bodyType: 'raw', body: query }
    }
    case 'file': {
      const file = value['file']
      const src = isObject(file) ? asString(file['src']) : ''
      warn(
        warnings,
        `${path}/file`,
        'FILE_BODY',
        '文件 body 不随 Collection 传输，已保留路径与原文',
      )
      return { bodyType: 'binary', body: src }
    }
    default:
      warn(warnings, path, 'BODY_UNSUPPORTED', `body 模式 ${mode} 暂不支持，已保留原文`)
      return { bodyType: 'none', body: '' }
  }
}

const parseMethod = (value: unknown, path: string, warnings: PostmanWarning[]): Api['method'] => {
  const method = asString(value, 'GET').toUpperCase()
  if (METHODS.has(method)) return method as Api['method']
  warn(
    warnings,
    path,
    'METHOD_UNSUPPORTED',
    `方法 ${method} 不在 ToAPI 支持范围，按 GET 导入并保留原文`,
  )
  return 'GET'
}

export const parseItem = (
  item: Record<string, unknown>,
  path: string,
  counter: { n: number },
  warnings: PostmanWarning[],
): { api: ImportedApi | null; folder: ImportedCollection | null } => {
  counter.n += 1
  const sortOrder = counter.n * 1000
  const name = asString(item['name'], '未命名')
  const description = describe(item['description'])
  const event = parseEvents(item['event'])
  const source: Record<string, unknown> = { item }

  if (Array.isArray(item['item'])) {
    if (item['request'] !== undefined) {
      warn(warnings, path, 'ITEM_AMBIGUOUS', '同时存在 item 与 request，按文件夹处理')
    }
    const folder: ImportedCollection = {
      name,
      description,
      auth: parseAuth(item['auth'], `${path}/auth`, warnings),
      variables: parseVariables(item['variable']),
      preScript: event.preScript,
      postScript: event.postScript,
      sortOrder,
      source,
      children: [],
      apis: [],
    }
    asArray(item['item']).forEach((child) => {
      if (!isObject(child)) {
        warn(warnings, path, 'ITEM_SHAPE', '子项不是对象，已跳过')
        return
      }
      const parsed = parseItem(child, `${path}/item/${counter.n}`, counter, warnings)
      if (parsed.folder) folder.children.push(parsed.folder)
      if (parsed.api) folder.apis.push(parsed.api)
    })
    return { api: null, folder }
  }

  const requestValue = item['request']
  const request = isObject(requestValue) ? requestValue : {}
  const url =
    typeof requestValue === 'string'
      ? { url: requestValue, params: [], variables: [] }
      : parseUrl(request['url'], `${path}/request/url`, warnings)
  const body = parseBody(request['body'], `${path}/request/body`, warnings)
  const api: ImportedApi = {
    name,
    description,
    method: parseMethod(
      typeof requestValue === 'string' ? 'GET' : request['method'],
      path,
      warnings,
    ),
    url: url.url,
    params: url.params,
    headers: headerRows(request['header'], `${path}/request/header`, warnings),
    bodyType: body.bodyType,
    body: body.body,
    auth: parseAuth(request['auth'] ?? item['auth'], `${path}/request/auth`, warnings),
    fake: {},
    preScript: event.preScript,
    postScript: event.postScript,
    extractors: [],
    sortOrder,
    source: {
      ...source,
      ...(isObject(requestValue) ? { request: requestValue } : {}),
    },
  }
  return { api, folder: null }
}

export const parseCollection = (raw: unknown): ParseResult<ImportedCollectionModel> => {
  const warnings: PostmanWarning[] = []
  if (!isObject(raw)) throw new Error('不是有效的 JSON 对象')
  const info = isObject(raw['info']) ? raw['info'] : {}
  const schema = asString(info['schema'])
  if (schema !== '' && !/collection\/v2\.[01]/i.test(schema)) {
    throw new Error(`不支持的 Collection schema：${schema}`)
  }
  if (raw['item'] === undefined) throw new Error('缺少 item 数组，不是 Postman Collection')
  const event = parseEvents(raw['event'])
  const counter = { n: 0 }
  const model: ImportedCollectionModel = {
    name: asString(info['name'], '导入的集合'),
    description: describe(info['description']),
    schema,
    auth: parseAuth(raw['auth'], '/auth', warnings),
    variables: parseVariables(raw['variable']),
    preScript: event.preScript,
    postScript: event.postScript,
    source: { info },
    rootApis: [],
    collections: [],
  }
  asArray(raw['item']).forEach((item, index) => {
    if (!isObject(item)) {
      warn(warnings, `/item/${index}`, 'ITEM_SHAPE', 'item 不是对象，已跳过')
      return
    }
    if (item['request'] !== undefined && !Array.isArray(item['item'])) {
      const parsed = parseItem(item, `/item/${index}`, counter, warnings)
      if (parsed.api) model.rootApis.push(parsed.api)
      return
    }
    const parsed = parseItem(item, `/item/${index}`, counter, warnings)
    if (parsed.folder) model.collections.push(parsed.folder)
    if (parsed.api) model.rootApis.push(parsed.api)
  })
  return { model, warnings }
}

export const parseEnvironment = (raw: unknown): ParseResult<ImportedEnvironmentModel> => {
  const warnings: PostmanWarning[] = []
  if (!isObject(raw)) throw new Error('不是有效的 JSON 对象')
  const scope = asString(raw['_postman_variable_scope'])
  if (scope !== '' && scope !== 'environment') {
    throw new Error(`不是 Postman Environment 文件（scope=${scope}）`)
  }
  if (!Array.isArray(raw['values'])) throw new Error('缺少 values 数组，不是 Postman Environment')
  const variables = asArray(raw['values'])
    .filter(isObject)
    .filter((row) => asString(row['key']) !== '')
    .map((row) => ({
      key: asString(row['key']),
      value: asString(row['value']),
      enabled: row['enabled'] !== false,
      secret: asString(row['type']) === 'secret',
      desc: '',
    }))
  for (const row of asArray(raw['values'])) {
    if (
      isObject(row) &&
      asString(row['type']) !== '' &&
      !['default', 'secret'].includes(asString(row['type']))
    ) {
      warn(warnings, '/values', 'VAR_TYPE', `变量类型 ${asString(row['type'])} 按文本导入`)
    }
  }
  return {
    model: {
      name: asString(raw['name'], '导入的环境'),
      variables,
      source: raw,
    },
    warnings,
  }
}

export const countCollection = (
  model: ImportedCollectionModel,
): { collections: number; apis: number; variables: number; scripts: number } => {
  let collections = model.collections.length
  let apis = model.rootApis.length
  let variables = model.variables.length
  let scripts = (model.preScript ? 1 : 0) + (model.postScript ? 1 : 0)
  const walk = (node: ImportedCollection): void => {
    apis += node.apis.length
    variables += node.variables.length
    scripts += (node.preScript ? 1 : 0) + (node.postScript ? 1 : 0)
    for (const api of node.apis) {
      scripts += (api.preScript ? 1 : 0) + (api.postScript ? 1 : 0)
    }
    collections += node.children.length
    for (const child of node.children) walk(child)
  }
  for (const api of model.rootApis) {
    scripts += (api.preScript ? 1 : 0) + (api.postScript ? 1 : 0)
  }
  for (const node of model.collections) walk(node)
  return { collections, apis, variables, scripts }
}

export const extractorsOf = (api: ImportedApi): Extractor[] => api.extractors

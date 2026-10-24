// @author yxpil
import type { Api, Auth, Collection, CollectionVariable, Environment, Project } from '@shared/types'
import type { Repos } from '../db/repo'
import { isObject } from './types'

const asRecord = (v: unknown): Record<string, unknown> => (isObject(v) ? v : {})

const scriptEvent = (listen: 'prerequest' | 'test', code: string): Record<string, unknown> => ({
  listen,
  script: {
    type: 'text/javascript',
    exec: code.split(/\r?\n/),
  },
})

const eventsOf = (preScript: string, postScript: string): Record<string, unknown>[] => {
  const events: Record<string, unknown>[] = []
  if (preScript.trim() !== '') events.push(scriptEvent('prerequest', preScript))
  if (postScript.trim() !== '') events.push(scriptEvent('test', postScript))
  return events
}

const authOption = (key: string, value: string): Record<string, unknown>[] => [
  { key, value, type: 'string' },
]

const postmanAuth = (auth: Auth): Record<string, unknown> => {
  switch (auth.type) {
    case 'none':
      return { type: 'noauth' }
    case 'inherit':
      return { type: 'inherit' }
    case 'bearer':
      return { type: 'bearer', bearer: authOption('token', auth.token) }
    case 'basic':
      return {
        type: 'basic',
        basic: [...authOption('username', auth.username), ...authOption('password', auth.password)],
      }
    case 'apikey':
      return {
        type: 'apikey',
        apikey: [
          ...authOption('key', auth.key),
          ...authOption('value', auth.value),
          ...authOption('in', auth.addTo),
        ],
      }
  }
}

const variablesOf = (vars: CollectionVariable[]): Record<string, unknown>[] =>
  vars.map((v) => ({
    key: v.key,
    value: v.value,
    ...(v.desc ? { description: v.desc } : {}),
    ...(v.enabled ? {} : { disabled: true }),
    ...(v.secret ? { type: 'secret' } : {}),
  }))

const headerArray = (api: Api): Record<string, unknown>[] =>
  api.headers.map((row) => ({
    key: row.key,
    value: row.value,
    type: 'text',
    ...(row.desc ? { description: row.desc } : {}),
    ...(row.enabled ? {} : { disabled: true }),
  }))

const queryArray = (api: Api): Record<string, unknown>[] =>
  api.params.map((row) => ({
    key: row.key,
    value: row.value,
    ...(row.desc ? { description: row.desc } : {}),
    ...(row.enabled ? {} : { disabled: true }),
  }))

const bodyOf = (
  api: Api,
  sourceRequest: Record<string, unknown>,
): Record<string, unknown> | undefined => {
  if (api.bodyType === 'none') return undefined
  const sourceBody = asRecord(sourceRequest['body'])
  const sourceMode = typeof sourceBody['mode'] === 'string' ? sourceBody['mode'] : ''
  if (api.bodyType === 'json' || api.bodyType === 'raw') {
    return {
      mode: 'raw',
      raw: api.body,
      options: { raw: { language: api.bodyType === 'json' ? 'json' : 'text' } },
    }
  }
  if (api.bodyType === 'urlencoded') {
    if (sourceMode === 'urlencoded' && Array.isArray(sourceBody['urlencoded']))
      return { ...sourceBody, mode: 'urlencoded' }
    return {
      mode: 'urlencoded',
      urlencoded: [...new URLSearchParams(api.body).entries()].map(([key, value]) => ({
        key,
        value,
        type: 'text',
      })),
    }
  }
  if (api.bodyType === 'form') {
    if (sourceMode === 'formdata' && Array.isArray(sourceBody['formdata']))
      return { ...sourceBody, mode: 'formdata' }
    return {
      mode: 'formdata',
      formdata: [...new URLSearchParams(api.body).entries()].map(([key, value]) => ({
        key,
        value,
        type: 'text',
      })),
    }
  }
  return { mode: 'file', file: { src: api.body } }
}

const requestObject = (api: Api, source: Record<string, unknown>): Record<string, unknown> => {
  const sourceRequest = asRecord(source['request'])
  const body = bodyOf(api, sourceRequest)
  return {
    ...sourceRequest,
    method: api.method,
    header: headerArray(api),
    ...(api.description ? { description: api.description } : {}),
    url: { raw: api.url.split('?')[0] ?? api.url, query: queryArray(api) },
    ...(body ? { body } : {}),
    auth: postmanAuth(api.auth),
  }
}

const itemOfApi = (api: Api, source: Record<string, unknown>): Record<string, unknown> => {
  const item: Record<string, unknown> = {
    ...asRecord(source['item']),
    name: api.name,
    request: requestObject(api, source),
  }
  if (api.description) item['description'] = api.description
  else delete item['description']
  const events = eventsOf(api.preScript, api.postScript)
  if (events.length > 0) item['event'] = events
  else delete item['event']
  delete item['item']
  return item
}

interface Counts {
  apis: number
  collections: number
  variables: number
}

interface BuiltFolder {
  item: Record<string, unknown>
  counts: Counts
}

const mergeByOrder = (
  entries: { sortOrder: number; item: Record<string, unknown> }[],
): Record<string, unknown>[] =>
  [...entries].sort((a, b) => a.sortOrder - b.sortOrder).map((e) => e.item)

const folderItem = (
  repos: Repos,
  collection: Collection,
  all: Collection[],
  depth: number,
): BuiltFolder => {
  if (depth > 64) throw new Error('集合嵌套过深，疑似循环引用')
  const source = repos.source.get('collection', collection.id)
  const entries: { sortOrder: number; item: Record<string, unknown> }[] = []
  let apis = 0
  let collections = 1
  let variables = collection.variables.length

  for (const api of repos.api.listByCollection(collection.id)) {
    entries.push({
      sortOrder: api.sortOrder,
      item: itemOfApi(api, repos.source.get('api', api.id)),
    })
    apis += 1
  }
  for (const child of all.filter((c) => c.parentId === collection.id)) {
    const built = folderItem(repos, child, all, depth + 1)
    entries.push({ sortOrder: child.sortOrder, item: built.item })
    apis += built.counts.apis
    collections += built.counts.collections
    variables += built.counts.variables
  }

  const item: Record<string, unknown> = {
    ...asRecord(source['item']),
    name: collection.name,
    item: mergeByOrder(entries),
  }
  if (collection.description) item['description'] = collection.description
  else delete item['description']
  const events = eventsOf(collection.preScript, collection.postScript)
  if (events.length > 0) item['event'] = events
  else delete item['event']
  if (collection.variables.length > 0) item['variable'] = variablesOf(collection.variables)
  else delete item['variable']
  if (collection.auth.type !== 'inherit' || source['item'] !== undefined)
    item['auth'] = postmanAuth(collection.auth)
  else delete item['auth']
  return { item, counts: { apis, collections, variables } }
}

const isPlaceholder = (source: Record<string, unknown>): boolean =>
  source['__toapiRootPlaceholder'] === true

export interface ExportCollectionResult {
  json: Record<string, unknown>
  counts: { collections: number; apis: number; variables: number }
}

export const buildCollectionExport = (
  repos: Repos,
  project: Project,
  collectionIds?: string[],
): ExportCollectionResult => {
  const all = repos.collection.listByProject(project.id)
  const allow = collectionIds ? new Set(collectionIds) : null
  const infoSource = asRecord(repos.source.get('project', project.id)['info'])
  const entries: { sortOrder: number; item: Record<string, unknown> }[] = []
  const counts: Counts = {
    apis: 0,
    collections: 0,
    variables: project.variables.length,
  }

  for (const root of all.filter((c) => c.parentId === null)) {
    const source = repos.source.get('collection', root.id)
    if (isPlaceholder(source)) {
      for (const api of repos.api.listByCollection(root.id)) {
        entries.push({
          sortOrder: api.sortOrder,
          item: itemOfApi(api, repos.source.get('api', api.id)),
        })
        counts.apis += 1
      }
      counts.variables += root.variables.length
      continue
    }
    if (allow && !allow.has(root.id)) continue
    const built = folderItem(repos, root, all, 0)
    entries.push({ sortOrder: root.sortOrder, item: built.item })
    counts.apis += built.counts.apis
    counts.collections += built.counts.collections
    counts.variables += built.counts.variables
  }

  const info: Record<string, unknown> = {
    ...infoSource,
    name: project.name,
    ...(project.description ? { description: project.description } : {}),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  }
  const json: Record<string, unknown> = { info, item: mergeByOrder(entries) }
  if (project.auth.type !== 'none' || infoSource['auth'] !== undefined)
    json['auth'] = postmanAuth(project.auth)
  if (project.variables.length > 0) json['variable'] = variablesOf(project.variables)
  const events = eventsOf(project.preScript, project.postScript)
  if (events.length > 0) json['event'] = events
  return { json, counts }
}

export const buildEnvironmentExport = (
  repos: Repos,
  env: Environment,
): { json: Record<string, unknown>; counts: { variables: number } } => {
  const source = repos.source.get('environment', env.id)
  const vars = repos.variable.listForEnv(env.id)
  const json: Record<string, unknown> = {
    ...source,
    id: env.id,
    name: env.name,
    values: vars.map((v) => ({
      key: v.key,
      value: v.value,
      type: v.secret ? 'secret' : 'default',
      enabled: v.enabled,
    })),
    _postman_variable_scope: 'environment',
    _postman_exported_at: new Date().toISOString(),
    _postman_exported_using: 'ToAPI',
  }
  return { json, counts: { variables: vars.length } }
}

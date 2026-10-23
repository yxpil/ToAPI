import type { AppHello } from '@shared/channels'
import { IpcErrorRaised } from '@shared/types'
import type { Repos } from '../db/repo'
import type { RequestFlow } from '../flow/request'
import type { CancelRegistry } from '../infra/cancel-registry'
import { midpoint } from '../db/repo/rows'
import type { HandlerMap } from './router'

export interface HandlerDeps {
  repos: Repos
  flow: RequestFlow
  cancel: CancelRegistry
  hello: AppHello
}

/** 存在性校验：缺失即 NOT_FOUND（19 号文档 §2.1 的 UI 错误分流依赖 code） */
const must = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) {
    throw new IpcErrorRaised({ code: 'NOT_FOUND', message: `${what}不存在` })
  }
  return value
}

const invalid = (message: string): never => {
  throw new IpcErrorRaised({ code: 'VALIDATION', message })
}

export function buildHandlers(deps: HandlerDeps): HandlerMap {
  const { repos } = deps

  const requireProject = (id: string) => must(repos.project.get(id), '项目')
  const requireCollection = (id: string) => must(repos.collection.get(id), '集合')

  const moveApi = (
    id: string,
    targetParentId: string,
    before: number | null,
    after: number | null,
  ): number => {
    const target = requireCollection(targetParentId)
    const api = must(repos.api.get(id), '接口')
    const sortOrder = midpoint(before, after)
    if (api.collectionId !== target.id) repos.api.moveToCollection(id, target.id)
    repos.api.setSortOrder(id, sortOrder)
    return sortOrder
  }

  const moveCollection = (
    id: string,
    targetParentId: string,
    before: number | null,
    after: number | null,
  ): number => {
    const moving = must(repos.collection.get(id), '集合')
    if (id === targetParentId) invalid('不能把集合移动到自身之下')
    const parent = repos.collection.get(targetParentId)
    const underSameProject = parent !== null && parent.projectId === moving.projectId
    const toRoot = parent === null && repos.project.get(targetParentId) !== null
    if (!underSameProject && !toRoot) invalid('目标父节点不属于当前项目')
    const sortOrder = midpoint(before, after)
    repos.collection.setSortOrder(id, sortOrder)
    return sortOrder
  }

  const handlers: HandlerMap = {
    'app:hello': () => deps.hello,

    'project:list': () => repos.project.listTree(),
    'project:create': (req) => repos.project.create(req),
    'project:update': (req) => {
      const { id, ...patch } = req
      requireProject(id)
      return must(repos.project.update(id, patch), '项目')
    },
    'project:delete': (req) => {
      requireProject(req.id)
      repos.project.remove(req.id)
    },

    'collection:create': (req) => {
      requireProject(req.projectId)
      if (req.parentId) requireCollection(req.parentId)
      return repos.collection.create(req)
    },
    'collection:update': (req) => {
      const { id, ...patch } = req
      requireCollection(id)
      return must(repos.collection.update(id, patch), '集合')
    },
    'collection:delete': (req) => {
      requireCollection(req.id)
      repos.collection.remove(req.id)
    },

    'api:get': (req) => must(repos.api.get(req.id), '接口'),
    'api:create': (req) => {
      requireCollection(req.collectionId)
      return repos.api.create(req)
    },
    'api:update': (req) => {
      const { id, ...patch } = req
      must(repos.api.get(id), '接口')
      return must(repos.api.update(id, patch), '接口')
    },
    'api:duplicate': (req) => {
      const source = must(repos.api.get(req.id), '接口')
      if (req.targetCollectionId) requireCollection(req.targetCollectionId)
      return must(repos.api.duplicate(source.id, req.targetCollectionId), '接口')
    },
    'api:delete': (req) => {
      must(repos.api.get(req.id), '接口')
      repos.api.remove(req.id)
    },

    'tree:move': (req) => {
      const before = req.beforeSortOrder ?? null
      const after = req.afterSortOrder ?? null
      const sortOrder =
        req.nodeType === 'api'
          ? moveApi(req.id, req.targetParentId, before, after)
          : moveCollection(req.id, req.targetParentId, before, after)
      return { sortOrder }
    },

    'env:list': (req) => {
      requireProject(req.projectId)
      return {
        envs: repos.environment.listByProject(req.projectId),
        vars: [...repos.variable.listGlobals(), ...repos.variable.listInProjectEnvs(req.projectId)],
      }
    },
    'env:create': (req) => {
      requireProject(req.projectId)
      return repos.environment.create(req)
    },
    'env:update': (req) => {
      const { id, ...patch } = req
      must(repos.environment.get(id), '环境')
      return must(repos.environment.rename(id, patch.name ?? ''), '环境')
    },
    'env:delete': (req) => {
      must(repos.environment.get(req.id), '环境')
      repos.environment.remove(req.id)
    },
    'env:activate': (req) => {
      requireProject(req.projectId)
      if (req.environmentId) {
        const env = must(repos.environment.get(req.environmentId), '环境')
        if (env.projectId !== req.projectId) invalid('环境不属于该项目')
      }
      repos.environment.activate(req.projectId, req.environmentId)
    },

    'var:set': (req) => {
      if (req.scope === 'environment' && !req.environmentId)
        invalid('环境变量必须指定 environmentId')
      return repos.variable.upsert(req)
    },
    'var:delete': (req) => {
      must(repos.variable.get(req.id), '变量')
      repos.variable.remove(req.id)
    },

    'api:send': (req) => deps.flow.send(req),
    'api:cancel': (req) => {
      deps.cancel.abort(req.cancelId)
    },
    'history:list': (req) => repos.history.list(req),
  }

  return handlers
}

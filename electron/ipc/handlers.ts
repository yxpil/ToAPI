// @author yxpil
import type { AppHello } from '@shared/channels'
import { IpcErrorRaised } from '@shared/types'
import type { Repos } from '../db/repo'
import type { RequestFlow } from '../flow/request'
import type { RunnerFlow } from '../flow/runner'
import { parseDataAuto } from '../flow/data-file'
import type { CancelRegistry } from '../infra/cancel-registry'
import type { FileStore } from '../infra/filestore'
import type { PostmanService } from '../postman/service'
import type { TapiService } from '../tapi/service'
import type { OpenService } from '../open/service'
import type { NotifyService } from '../notify/service'
import { assertWebhookUrl } from '../notify/webhook'
import type { ScheduleService } from '../schedule/service'
import { writeReport } from '../report/export'
import { midpoint } from '../db/repo/rows'
import type { HandlerMap } from './router'

/** 主进程窗口能力；无窗口环境（集成测试、无头 CLI）不注入，走空实现 */
export interface WindowControls {
  minimize: () => void
  toggleMaximize: () => boolean
  close: () => void
  isMaximized: () => boolean
}

export interface HandlerDeps {
  repos: Repos
  flow: RequestFlow
  runner: RunnerFlow
  postman: PostmanService
  tapi: TapiService
  open: OpenService
  notify: NotifyService
  schedule: ScheduleService
  files: FileStore
  /** 起停 Local HTTP API；改完配置必须调它，端口/开关才会真正生效 */
  syncOpenEndpoint: () => Promise<{ running: boolean; port: number }>
  cancel: CancelRegistry
  hello: AppHello
  /** 每次握手实时读取，底栏显示当前库大小（06 号文档 §4） */
  dbSize: () => number
  window?: WindowControls
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
  const win = deps.window ?? {
    minimize: () => {},
    toggleMaximize: () => false,
    close: () => {},
    isMaximized: () => false,
  }

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
    'app:hello': () => ({ ...deps.hello, dbSizeBytes: deps.dbSize() }),

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

    'runner:start': (req) => deps.runner.start(req),
    'runner:cancel': (req) => {
      deps.runner.cancel(req.runId)
    },
    'runner:get': (req) => must(deps.repos.runner.get(req.id), '运行记录'),
    'runner:list': (req) => deps.repos.runner.list(req.limit ?? 20),
    'runner:report': (req) => {
      const run = must(deps.repos.runner.get(req.runId), '运行记录')
      return { filePath: writeReport(deps.files, run, req.format, req.filePath) }
    },
    'data:parse': (req) => parseDataAuto(req.content),

    'postman:inspect': (req) => deps.postman.inspect(req),
    'postman:import': (req) => deps.postman.importCollection(req),
    'postman:export-collection': (req) => deps.postman.exportCollection(req),
    'postman:import-environment': (req) => deps.postman.importEnvironment(req),
    'postman:export-environment': (req) => deps.postman.exportEnvironment(req),

    'tapi:export': (req) => deps.tapi.export(req),
    'tapi:inspect': (req) => deps.tapi.inspect(req),
    'tapi:import': (req) => deps.tapi.import(req),

    'open:get-config': () => deps.open.view(),
    'open:set-config': async (req) => {
      const config = deps.open.config
      if (typeof req.password === 'string') config.setPassword(req.password)
      if (typeof req.port === 'number') config.setPort(req.port)
      if (typeof req.access === 'string') config.setAccess(req.access)
      if (typeof req.ratePerMin === 'number') config.setRatePerMin(req.ratePerMin)
      if (typeof req.enabled === 'boolean') config.setEnabled(req.enabled)
      await deps.syncOpenEndpoint()
      return deps.open.view()
    },
    'open:rotate-token': async () => {
      // 新密码只在这里返回一次，UI 显示后不再可取（11 号文档 §1.1）
      const password = deps.open.config.generatePassword()
      await deps.syncOpenEndpoint()
      return { password }
    },
    'open:list-clients': () => deps.open.clients(),
    'open:revoke-client': (req) => {
      deps.open.config.revokeClient(req.id)
    },
    'open:call-log': (req) => deps.open.callLog(req.limit ?? 100),
    'open:approval-result': (req) => {
      deps.open.approvalResult(req)
    },

    'task:list': () => deps.schedule.list(),
    'task:create': (req) => deps.schedule.create(req),
    'task:update': (req) => deps.schedule.update(req),
    'task:delete': (req) => {
      deps.schedule.remove(req.id)
    },
    'task:toggle': (req) => deps.schedule.toggle(req.id, req.enabled),
    'task:preview': (req) => deps.schedule.preview(req.spec, req.from),
    'task:run-now': (req) => deps.schedule.runNow(req.id),

    'notify:list': (req) => deps.notify.list(req),
    'notify:mark-read': (req) => {
      deps.notify.markRead(req.ids)
      return { unread: deps.notify.unread() }
    },
    'notify:mark-all-read': () => {
      deps.notify.markAllRead()
      return { unread: deps.notify.unread() }
    },
    'notify:get-settings': () => deps.notify.settings(),
    'notify:set-settings': (req) => {
      if (typeof req.webhookUrl === 'string' && req.webhookUrl.trim() !== '') {
        try {
          assertWebhookUrl(req.webhookUrl)
        } catch (e) {
          invalid((e as Error).message)
        }
      }
      return deps.notify.setSettings(req)
    },
    'notify:test-webhook': (req) => deps.notify.testWebhook(req),

    'window:get-state': () => ({ maximized: win.isMaximized() }),
    'window:minimize': () => {
      win.minimize()
    },
    'window:toggle-maximize': () => ({ maximized: win.toggleMaximize() }),
    'window:close': () => {
      win.close()
    },
  }

  return handlers
}

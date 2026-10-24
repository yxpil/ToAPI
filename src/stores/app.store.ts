// @author yxpil
import { create } from 'zustand'
import type { MoveTarget } from '@shared/channels'
import type {
  Api,
  Environment,
  HistorySummary,
  IpcError,
  PostmanImportReport,
  PostmanInspect,
  ProjectNode,
  SendResult,
  Variable,
} from '@shared/types'
import type {
  PostmanImportEnvironmentInput,
  PostmanImportInput,
  PostmanSource,
} from '@shared/channels'
import { invoke, newCancelId } from '../lib/ipc'
import { IpcFailure } from '../lib/ipc'

export interface Toast {
  kind: 'ok' | 'error'
  text: string
}

interface AppState {
  tree: ProjectNode[]
  activeProjectId: string | null
  selectedApiId: string | null
  api: Api | null
  response: SendResult | null
  responseError: IpcError | null
  history: HistorySummary[]
  historyNextCursor: string | null
  historyLoading: boolean
  envs: Environment[]
  vars: Variable[]
  sendPending: boolean
  savePending: boolean
  toast: Toast | null
  cancelId: string | null
  postmanImportOpen: boolean

  boot(): Promise<void>
  refreshTree(): Promise<void>
  selectProject(projectId: string): Promise<void>
  selectApi(id: string): Promise<void>
  createProject(name: string): Promise<void>
  createCollection(name: string): Promise<void>
  createApi(name: string, collectionId?: string): Promise<void>
  removeApi(id: string): Promise<void>
  removeProject(id: string): Promise<void>
  removeCollection(id: string): Promise<void>
  duplicateApi(id: string): Promise<void>
  renameNode(kind: 'project' | 'collection' | 'api', id: string, name: string): Promise<void>
  moveNode(target: MoveTarget): Promise<void>
  patchApi(patch: Partial<Api>): void
  saveApi(): Promise<void>
  send(): Promise<void>
  cancelSend(): Promise<void>
  activateEnv(environmentId: string | null): Promise<void>
  setVar(key: string, value: string, environmentId: string | null): Promise<void>
  refreshHistory(): Promise<void>
  loadMoreHistory(): Promise<void>
  inspectPostman(source: PostmanSource): Promise<PostmanInspect | null>
  importPostman(input: PostmanImportInput): Promise<PostmanImportReport | null>
  importEnvironment(input: PostmanImportEnvironmentInput): Promise<PostmanImportReport | null>
  exportCollection(projectId: string, collectionIds?: string[]): Promise<void>
  exportEnvironment(environmentId: string): Promise<void>
  openPostmanImport(): void
  closePostmanImport(): void
  dismissToast(): void
}

const FALLBACK_API: Partial<Api> = {
  method: 'GET',
  url: '',
  params: [],
  headers: [],
  bodyType: 'none',
  body: '',
  auth: { type: 'none' },
  fake: {},
  extractors: [],
}

/** 错误分流表（19 号文档 §2.1） */
const routeError = (
  state: { set: Partial<AppState> },
  set: (p: Partial<AppState>) => void,
  e: IpcError,
): void => {
  if (e.code === 'CANCELLED') {
    set({ sendPending: false, cancelId: null })
    return
  }
  if (e.code === 'NETWORK' || e.code === 'TIMEOUT' || e.code === 'SCRIPT_ERROR') {
    set({ responseError: e, sendPending: false, cancelId: null })
    return
  }
  set({
    toast: { kind: 'error', text: `${e.code}: ${e.message}` },
    sendPending: false,
    savePending: false,
  })
}

export const useApp = create<AppState>((set, get) => {
  const call = async <T>(p: Promise<T>, onErr?: (e: IpcError) => void): Promise<T | undefined> => {
    try {
      return await p
    } catch (e) {
      if (e instanceof IpcFailure) {
        if (onErr) onErr(e.payload)
        else routeError({ set: {} }, (patch) => set(patch), e.payload)
        return undefined
      }
      set({ toast: { kind: 'error', text: (e as Error).message } })
      return undefined
    }
  }

  return {
    tree: [],
    activeProjectId: null,
    selectedApiId: null,
    api: null,
    response: null,
    responseError: null,
    history: [],
    historyNextCursor: null,
    historyLoading: false,
    envs: [],
    vars: [],
    sendPending: false,
    savePending: false,
    toast: null,
    cancelId: null,
    postmanImportOpen: false,

    async boot() {
      await get().refreshTree()
      const first = get().tree[0]
      if (first) await get().selectProject(first.project.id)
    },

    async refreshTree() {
      const tree = await call(invoke('project:list', {}))
      if (!tree) return
      set({ tree })
      if (!get().activeProjectId && tree[0]) void get().selectProject(tree[0].project.id)
    },

    async selectProject(projectId) {
      set({ activeProjectId: projectId, selectedApiId: null, api: null })
      const data = await call(invoke('env:list', { projectId }))
      if (data) set({ envs: data.envs, vars: data.vars })
      await get().refreshHistory()
    },

    async selectApi(id) {
      const api = await call(invoke('api:get', { id }))
      if (!api) return
      set({ api: { ...api }, selectedApiId: api.id, response: null, responseError: null })
    },

    async createProject(name) {
      const project = await call(invoke('project:create', { name }))
      if (!project) return
      await get().refreshTree()
      set({ activeProjectId: project.id })
      const collection = await call(
        invoke('collection:create', { projectId: project.id, name: '默认集合' }),
      )
      if (collection) await get().refreshTree()
    },

    async createCollection(name) {
      const projectId = get().activeProjectId
      if (!projectId) return
      await call(invoke('collection:create', { projectId, name }))
      await get().refreshTree()
    },

    async createApi(name, collectionId) {
      const { tree, activeProjectId } = get()
      const target = collectionId ?? firstCollectionOf(tree, activeProjectId)
      if (!target) {
        set({ toast: { kind: 'error', text: '请先创建集合' } })
        return
      }
      const api = await call(invoke('api:create', { collectionId: target, name, ...FALLBACK_API }))
      if (!api) return
      await get().refreshTree()
      await get().selectApi(api.id)
    },

    async removeApi(id) {
      let ok = true
      await call(invoke('api:delete', { id }), () => {
        ok = false
      })
      if (!ok) return
      if (get().selectedApiId === id) set({ selectedApiId: null, api: null, response: null })
      await get().refreshTree()
    },

    async removeProject(id) {
      let ok = true
      await call(invoke('project:delete', { id }), () => {
        ok = false
      })
      if (!ok) return
      if (get().activeProjectId === id) {
        set({
          activeProjectId: null,
          selectedApiId: null,
          api: null,
          response: null,
          responseError: null,
          history: [],
          historyNextCursor: null,
          envs: [],
          vars: [],
        })
      }
      await get().refreshTree()
    },

    async removeCollection(id) {
      let ok = true
      await call(invoke('collection:delete', { id }), () => {
        ok = false
      })
      if (!ok) return
      if (get().api?.collectionId === id) {
        set({ selectedApiId: null, api: null, response: null, responseError: null })
      }
      await get().refreshTree()
    },

    async duplicateApi(id) {
      const copy = await call(invoke('api:duplicate', { id }))
      if (!copy) return
      await get().refreshTree()
      await get().selectApi(copy.id)
    },

    async renameNode(kind, id, name) {
      let ok = true
      if (kind === 'api') await call(invoke('api:update', { id, name }), () => (ok = false))
      else if (kind === 'collection')
        await call(invoke('collection:update', { id, name }), () => (ok = false))
      else await call(invoke('project:update', { id, name }), () => (ok = false))
      if (!ok) return
      // 只改当前打开接口的名字时同步编辑器草稿，避免重新拉取把用户未存改动冲掉
      if (kind === 'api' && get().selectedApiId === id) get().patchApi({ name })
      await get().refreshTree()
      set({ toast: { kind: 'ok', text: `已重命名为「${name}」` } })
    },

    async moveNode(target) {
      await call(invoke('tree:move', target))
      await get().refreshTree()
    },

    patchApi(patch) {
      const current = get().api
      if (!current) return
      set({ api: { ...current, ...patch } })
    },

    async saveApi() {
      const api = get().api
      if (!api) return
      set({ savePending: true })
      const saved = await call(
        invoke('api:update', {
          id: api.id,
          name: api.name,
          method: api.method,
          url: api.url,
          params: api.params,
          headers: api.headers,
          bodyType: api.bodyType,
          body: api.body,
          auth: api.auth,
          fake: api.fake,
          preScript: api.preScript,
          postScript: api.postScript,
          extractors: api.extractors,
        }),
        (e) =>
          set({ savePending: false, toast: { kind: 'error', text: `${e.code}: ${e.message}` } }),
      )
      if (!saved) return
      set({ api: { ...saved }, savePending: false, toast: { kind: 'ok', text: '已保存' } })
      await get().refreshTree()
    },

    async send() {
      const api = get().api
      if (!api) {
        set({ toast: { kind: 'error', text: '请先选择或新建接口' } })
        return
      }
      const cancelId = newCancelId()
      set({ sendPending: true, cancelId, responseError: null })
      const result = await call(invoke('api:send', { apiId: api.id, cancelId }), (e) =>
        routeError({ set: {} }, (patch) => set(patch), e),
      )
      if (!result) return
      set({ response: result, sendPending: false, cancelId: null })
      await get().refreshHistory()
    },

    async cancelSend() {
      const cancelId = get().cancelId
      if (!cancelId) return
      await call(invoke('api:cancel', { cancelId }))
    },

    async activateEnv(environmentId) {
      const projectId = get().activeProjectId
      if (!projectId) return
      await call(invoke('env:activate', { projectId, environmentId }))
      const data = await call(invoke('env:list', { projectId }))
      if (data) set({ envs: data.envs, vars: data.vars })
    },

    async setVar(key, value, environmentId) {
      const variable = await call(
        invoke('var:set', {
          scope: environmentId ? 'environment' : 'global',
          environmentId,
          key,
          value,
        }),
      )
      if (!variable) return
      const projectId = get().activeProjectId
      if (projectId) {
        const data = await call(invoke('env:list', { projectId }))
        if (data) set({ envs: data.envs, vars: data.vars })
      }
    },

    async refreshHistory() {
      const projectId = get().activeProjectId
      if (!projectId) {
        set({ history: [], historyNextCursor: null })
        return
      }
      set({ historyLoading: true })
      const page = await call(invoke('history:list', { projectId, limit: 200 }))
      if (!page) {
        set({ historyLoading: false })
        return
      }
      set({
        history: page.items,
        historyNextCursor: page.nextCursor,
        historyLoading: false,
      })
    },

    async loadMoreHistory() {
      const { activeProjectId, historyNextCursor, historyLoading } = get()
      if (!activeProjectId || !historyNextCursor || historyLoading) return
      set({ historyLoading: true })
      const page = await call(
        invoke('history:list', {
          projectId: activeProjectId,
          cursor: historyNextCursor,
          limit: 200,
        }),
      )
      if (!page) {
        set({ historyLoading: false })
        return
      }
      set({
        history: [...get().history, ...page.items],
        historyNextCursor: page.nextCursor,
        historyLoading: false,
      })
    },

    async inspectPostman(source) {
      const inspected = await call(invoke('postman:inspect', source))
      return inspected ?? null
    },

    async importPostman(input) {
      const report = await call(invoke('postman:import', input))
      if (!report) return null
      await get().refreshTree()
      await get().selectProject(report.projectId)
      set({ toast: { kind: 'ok', text: importSummary(report) } })
      return report
    },

    async importEnvironment(input) {
      const report = await call(invoke('postman:import-environment', input))
      if (!report) return null
      const projectId = get().activeProjectId
      if (projectId) {
        const data = await call(invoke('env:list', { projectId }))
        if (data) set({ envs: data.envs, vars: data.vars })
      }
      set({ toast: { kind: 'ok', text: importSummary(report) } })
      return report
    },

    async exportCollection(projectId, collectionIds) {
      const result = await call(
        invoke('postman:export-collection', {
          projectId,
          ...(collectionIds && collectionIds.length > 0 ? { collectionIds } : {}),
        }),
        (e) => {
          if (e.code !== 'CANCELLED')
            set({ toast: { kind: 'error', text: `${e.code}: ${e.message}` } })
        },
      )
      if (result) set({ toast: { kind: 'ok', text: `已导出到 ${result.filePath}` } })
    },

    async exportEnvironment(environmentId) {
      const result = await call(invoke('postman:export-environment', { environmentId }), (e) => {
        if (e.code !== 'CANCELLED')
          set({ toast: { kind: 'error', text: `${e.code}: ${e.message}` } })
      })
      if (result) set({ toast: { kind: 'ok', text: `已导出到 ${result.filePath}` } })
    },

    openPostmanImport() {
      set({ postmanImportOpen: true })
    },

    closePostmanImport() {
      set({ postmanImportOpen: false })
    },

    dismissToast() {
      set({ toast: null })
    },
  }
})

const importSummary = (report: PostmanImportReport): string => {
  const { collections, apis, variables } = report.counts
  const base = `导入完成：${collections} 集合 · ${apis} 接口 · ${variables} 变量`
  return report.warnings.length > 0 ? `${base} · ${report.warnings.length} 条提示` : base
}

const firstCollectionOf = (tree: ProjectNode[], projectId: string | null): string | null => {
  if (!projectId) return null
  const node = tree.find((p) => p.project.id === projectId)
  return node?.collections[0]?.id ?? null
}

import { create } from 'zustand'
import type {
  Api,
  Environment,
  HistorySummary,
  IpcError,
  ProjectNode,
  SendResult,
  Variable,
} from '@shared/types'
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
  envs: Environment[]
  vars: Variable[]
  sendPending: boolean
  savePending: boolean
  toast: Toast | null
  cancelId: string | null

  boot(): Promise<void>
  refreshTree(): Promise<void>
  selectProject(projectId: string): Promise<void>
  selectApi(id: string): Promise<void>
  createProject(name: string): Promise<void>
  createCollection(name: string): Promise<void>
  createApi(name: string): Promise<void>
  removeApi(id: string): Promise<void>
  patchApi(patch: Partial<Api>): void
  saveApi(): Promise<void>
  send(): Promise<void>
  cancelSend(): Promise<void>
  activateEnv(environmentId: string | null): Promise<void>
  setVar(key: string, value: string, environmentId: string | null): Promise<void>
  refreshHistory(): Promise<void>
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
    envs: [],
    vars: [],
    sendPending: false,
    savePending: false,
    toast: null,
    cancelId: null,

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

    async createApi(name) {
      const { tree, activeProjectId } = get()
      const collectionId = firstCollectionOf(tree, activeProjectId)
      if (!collectionId) {
        set({ toast: { kind: 'error', text: '请先创建集合' } })
        return
      }
      const api = await call(invoke('api:create', { collectionId, name, ...FALLBACK_API }))
      if (!api) return
      await get().refreshTree()
      await get().selectApi(api.id)
    },

    async removeApi(id) {
      await call(invoke('api:delete', { id }))
      if (get().selectedApiId === id) set({ selectedApiId: null, api: null, response: null })
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
      if (!projectId) return
      const page = await call(invoke('history:list', { projectId, limit: 50 }))
      if (page) set({ history: page.items })
    },

    dismissToast() {
      set({ toast: null })
    },
  }
})

const firstCollectionOf = (tree: ProjectNode[], projectId: string | null): string | null => {
  if (!projectId) return null
  const node = tree.find((p) => p.project.id === projectId)
  return node?.collections[0]?.id ?? null
}

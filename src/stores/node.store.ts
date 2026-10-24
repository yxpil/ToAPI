// @author yxpil
import { create } from 'zustand'
import type {
  AddNodeInput,
  NodeCallLogView,
  NodeListItem,
  NodePullInput,
  NodePushInput,
  NodeRunInput,
  NodeSelfView,
  NodeTree,
  NodeView,
  UpdateNodeInput,
} from '@shared/channels'
import { invoke } from '../lib/ipc'

/** 局域网节点面板状态（24 号文档 §7） */

interface NodeState {
  items: NodeListItem[]
  self: NodeSelfView | null
  log: NodeCallLogView[]
  busy: string | null
  error: string | null
  /** 一次动作完成后的提示，界面显示一次即清 */
  message: string | null
  editorOpen: boolean
  editing: NodeView | null
  pullFor: NodeListItem | null
  pushFor: NodeListItem | null
  runFor: { node: NodeListItem; tree: NodeTree; projectId: string } | null
  /** 节点最近一次远端运行状态文本，来自 event:node-state */
  activity: Record<string, string>

  load(): Promise<void>
  clearMessage(): void
  setEditor(open: boolean, node?: NodeView): void
  openPull(node: NodeListItem): void
  openPush(node: NodeListItem): void
  closeDialogs(): void
  add(input: AddNodeInput): Promise<boolean>
  update(input: UpdateNodeInput): Promise<boolean>
  remove(id: string): Promise<void>
  probe(id: string): Promise<void>
  confirm(id: string): Promise<void>
  pull(input: NodePullInput): Promise<boolean>
  push(input: NodePushInput): Promise<boolean>
  prepareRun(nodeId: string, projectId: string): Promise<void>
  run(input: NodeRunInput): Promise<boolean>
  applyState(payload: {
    nodeId: string
    state: 'idle' | 'probing' | 'busy' | 'error' | 'paired'
    detail: string
    runId: string | null
  }): void
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export const useNodes = create<NodeState>((set, get) => ({
  items: [],
  self: null,
  log: [],
  busy: null,
  error: null,
  message: null,
  editorOpen: false,
  editing: null,
  pullFor: null,
  pushFor: null,
  runFor: null,
  activity: {},

  async load() {
    try {
      const [items, self, log] = await Promise.all([
        invoke('node:list', {}),
        invoke('node:self', {}),
        invoke('node:log', { limit: 12 }),
      ])
      set({ items, self, log })
    } catch (e) {
      set({ error: errText(e) })
    }
  },

  clearMessage() {
    set({ message: null })
  },

  setEditor(open, node) {
    set({ editorOpen: open, editing: node ?? null, error: null })
  },

  openPull(node) {
    set({ pullFor: node, error: null })
  },

  openPush(node) {
    set({ pushFor: node, error: null })
  },

  closeDialogs() {
    set({ pullFor: null, pushFor: null, runFor: null })
  },

  async add(input) {
    set({ busy: 'add', error: null })
    try {
      const created = await invoke('node:add', input)
      set({ items: [...get().items, created], editorOpen: false, editing: null, busy: null })
      return true
    } catch (e) {
      set({ error: errText(e), busy: null })
      return false
    }
  },

  async update(input) {
    set({ busy: input.id, error: null })
    try {
      const next = await invoke('node:update', input)
      set({
        items: get().items.map((n) => (n.id === next.id ? next : n)),
        editorOpen: false,
        editing: null,
        busy: null,
      })
      return true
    } catch (e) {
      set({ error: errText(e), busy: null })
      return false
    }
  },

  async remove(id) {
    set({ error: null })
    try {
      await invoke('node:remove', { id })
      set({ items: get().items.filter((n) => n.id !== id) })
    } catch (e) {
      set({ error: errText(e) })
    }
  },

  async probe(id) {
    set({ busy: id, error: null })
    try {
      const probe = await invoke('node:probe', { id })
      set({
        items: get().items.map((n) =>
          n.id === id ? { ...n, probe, lastSeenAt: Date.now(), lastError: null } : n,
        ),
        busy: null,
      })
    } catch (e) {
      set({ error: errText(e), busy: null })
      await get().load()
    }
  },

  async confirm(id) {
    set({ error: null })
    try {
      const next = await invoke('node:confirm', { id })
      set({ items: get().items.map((n) => (n.id === id ? { ...next, probe: n.probe } : n)) })
    } catch (e) {
      set({ error: errText(e) })
    }
  },

  async pull(input) {
    set({ busy: input.nodeId, error: null })
    try {
      const result = await invoke('node:pull', input)
      set({
        busy: null,
        pullFor: null,
        message: `已拉取项目「${result.projectName}」：${String(result.imported.collections)} 个集合 · ${String(result.imported.apis)} 个接口${result.inspection.redactedCount > 0 ? `；${String(result.inspection.redactedCount)} 个密钥需本机补填` : ''}`,
      })
      return true
    } catch (e) {
      set({ error: errText(e), busy: null })
      return false
    }
  },

  async push(input: NodePushInput) {
    set({ busy: input.nodeId, error: null })
    try {
      const result = await invoke('node:push', input)
      set({ busy: null, pushFor: null, message: result.message })
      return true
    } catch (e) {
      set({ error: errText(e), busy: null })
      return false
    }
  },

  async prepareRun(nodeId, projectId) {
    const node = get().items.find((n) => n.id === nodeId)
    if (!node) return
    set({ busy: nodeId, error: null })
    try {
      const tree = await invoke('node:tree', { nodeId, projectId })
      set({ runFor: { node, tree, projectId }, busy: null })
    } catch (e) {
      set({ error: errText(e), busy: null })
    }
  },

  async run(input) {
    set({ busy: input.nodeId, error: null })
    try {
      const { runId } = await invoke('node:run', input)
      set({
        busy: null,
        runFor: null,
        activity: {
          ...get().activity,
          [input.nodeId]: `已下发远端运行 ${runId.slice(-6)}，等待结果…`,
        },
      })
      return true
    } catch (e) {
      set({ error: errText(e), busy: null })
      return false
    }
  },

  applyState(payload) {
    set({ activity: { ...get().activity, [payload.nodeId]: payload.detail } })
    if (payload.state === 'idle' || payload.state === 'error') void get().load()
  },
}))

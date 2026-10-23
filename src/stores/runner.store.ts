import { create } from 'zustand'
import type { RunnerRunView } from '@shared/channels'
import { invoke, newCancelId } from '../lib/ipc'

interface RunnerState {
  runs: Omit<RunnerRunView, 'items'>[]
  current: RunnerRunView | null
  running: boolean
  activeRunId: string | null
  error: string | null

  loadRuns(): Promise<void>
  runCollection(collectionId: string, collectionName: string): Promise<void>
  selectRun(runId: string): Promise<void>
  cancel(): Promise<void>
  applyProgress(payload: {
    runId: string
    item: RunnerRunView['items'][number]
    finished: boolean
  }): void
}

export const useRunner = create<RunnerState>((set, get) => ({
  runs: [],
  current: null,
  running: false,
  activeRunId: null,
  error: null,

  async loadRuns() {
    try {
      set({ runs: await invoke('runner:list', { limit: 20 }) })
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  async runCollection(collectionId, collectionName) {
    if (get().running) return
    set({ running: true, error: null, activeRunId: null, current: null })
    try {
      const { runId } = await invoke('runner:start', {
        scopeType: 'collection',
        scopeId: collectionId,
        cancelId: newCancelId(),
      })
      set({ activeRunId: runId })
      await get().selectRun(runId)
      // 首帧先出结构，逐项结果由 event:runner-progress 增量补
      void collectionName
    } catch (e) {
      set({ running: false, error: (e as Error).message })
    }
  },

  async selectRun(runId) {
    try {
      set({ current: await invoke('runner:get', { id: runId }) })
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  async cancel() {
    const runId = get().activeRunId
    if (!runId) return
    await invoke('runner:cancel', { runId }).catch(() => undefined)
  },

  applyProgress(payload) {
    const current = get().current
    if (payload.finished) {
      // 收尾时以库内结果为准，避免事件与首帧拉取竞态导致条目缺失
      set({ running: false, activeRunId: null })
      void get().selectRun(payload.runId)
      void get().loadRuns()
      return
    }
    if (!current || current.id !== payload.runId) return
    const withoutDup = current.items.filter((i) => i.id !== payload.item.id)
    set({ current: { ...current, items: [...withoutDup, payload.item] } })
  },
}))

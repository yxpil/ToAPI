// @author yxpil
import { create } from 'zustand'
import type { RunnerRunView } from '@shared/channels'
import { invoke, newCancelId } from '../lib/ipc'

interface RunnerState {
  runs: Omit<RunnerRunView, 'items'>[]
  current: RunnerRunView | null
  running: boolean
  activeRunId: string | null
  error: string | null

  /** 数据驱动（23 号文档 §5.1）：粘贴的 CSV/JSON 文本与解析出的行 */
  dataText: string
  dataRows: Record<string, string>[]
  dataFormat: 'csv' | 'json' | null
  dataError: string | null
  /** null = 跟随行数 */
  iterationCount: number | null

  loadRuns(): Promise<void>
  runCollection(collectionId: string, collectionName: string): Promise<void>
  selectRun(runId: string): Promise<void>
  cancel(): Promise<void>
  parseData(): Promise<void>
  setDataText(value: string): void
  clearData(): void
  setIterationCount(value: number | null): void
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
  dataText: '',
  dataRows: [],
  dataFormat: null,
  dataError: null,
  iterationCount: null,

  async loadRuns() {
    try {
      set({ runs: await invoke('runner:list', { limit: 20 }) })
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  async parseData() {
    const content = get().dataText.trim()
    if (content === '') {
      set({ dataRows: [], dataFormat: null, dataError: null })
      return
    }
    try {
      const { rows, format } = await invoke('data:parse', { content })
      set({ dataRows: rows, dataFormat: format, dataError: null })
    } catch (e) {
      set({ dataRows: [], dataFormat: null, dataError: (e as Error).message })
    }
  },

  setDataText(value) {
    set({ dataText: value })
  },

  clearData() {
    set({ dataText: '', dataRows: [], dataFormat: null, dataError: null, iterationCount: null })
  },

  setIterationCount(value) {
    set({ iterationCount: value })
  },

  async runCollection(collectionId, collectionName) {
    if (get().running) return
    const { dataRows, iterationCount } = get()
    const count = iterationCount ?? (dataRows.length > 0 ? dataRows.length : undefined)
    set({ running: true, error: null, activeRunId: null, current: null })
    try {
      const { runId } = await invoke('runner:start', {
        scopeType: 'collection',
        scopeId: collectionId,
        cancelId: newCancelId(),
        ...(dataRows.length > 0 ? { iterationData: dataRows } : {}),
        ...(count ? { iterationCount: count } : {}),
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

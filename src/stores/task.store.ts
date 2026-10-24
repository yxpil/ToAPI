// @author yxpil
import { create } from 'zustand'
import type {
  NewScheduleTask,
  ScheduleSpec,
  ScheduleTaskView,
  TaskPreviewResult,
  UpdateScheduleTask,
} from '@shared/channels'
import { invoke } from '../lib/ipc'

/** 定时任务面板状态（12 号文档 §1）：列表 + 编辑表单开关，表单本身留在组件里 */

interface TaskState {
  tasks: ScheduleTaskView[]
  editorOpen: boolean
  editing: ScheduleTaskView | null
  preview: TaskPreviewResult | null

  load(): Promise<void>
  setEditor(open: boolean, task?: ScheduleTaskView): void
  create(input: NewScheduleTask): Promise<ScheduleTaskView | null>
  update(input: UpdateScheduleTask): Promise<ScheduleTaskView | null>
  toggle(id: string, enabled: boolean): Promise<void>
  remove(id: string): Promise<void>
  runNow(id: string): Promise<void>
  previewSpec(spec: ScheduleSpec): Promise<void>
  applyState(payload: {
    taskId: string
    running: boolean
    nextRunAt: number | null
    lastRunAt: number | null
    lastRunId: string | null
    lastFailed: number | null
  }): void
}

export const useTasks = create<TaskState>((set, get) => ({
  tasks: [],
  editorOpen: false,
  editing: null,
  preview: null,

  async load() {
    try {
      set({ tasks: await invoke('task:list', {}) })
    } catch {
      /* 主进程未就绪时静默 */
    }
  },

  setEditor(open, task) {
    set({ editorOpen: open, editing: task ?? null, preview: null })
  },

  async create(input) {
    try {
      const task = await invoke('task:create', input)
      set({ tasks: [...get().tasks, task], editorOpen: false, editing: null })
      return task
    } catch {
      return null
    }
  },

  async update(input) {
    try {
      const task = await invoke('task:update', input)
      set({
        tasks: get().tasks.map((t) => (t.id === task.id ? task : t)),
        editorOpen: false,
        editing: null,
      })
      return task
    } catch {
      return null
    }
  },

  async toggle(id, enabled) {
    const task = await invoke('task:toggle', { id, enabled }).catch(() => null)
    if (task) set({ tasks: get().tasks.map((t) => (t.id === id ? task : t)) })
  },

  async remove(id) {
    await invoke('task:delete', { id }).catch(() => undefined)
    set({ tasks: get().tasks.filter((t) => t.id !== id) })
  },

  async runNow(id) {
    await invoke('task:run-now', { id }).catch(() => undefined)
    await get().load()
  },

  async previewSpec(spec) {
    const preview = await invoke('task:preview', { spec }).catch(() => null)
    set({ preview })
  },

  applyState(payload) {
    set({
      tasks: get().tasks.map((t) => (t.id === payload.taskId ? { ...t, ...payload } : t)),
    })
  },
}))

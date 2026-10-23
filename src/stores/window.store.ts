import { create } from 'zustand'
import { invoke } from '../lib/ipc'

interface WindowState {
  maximized: boolean
  init(): Promise<void>
  setMaximized(maximized: boolean): void
  minimize(): void
  toggleMaximize(): Promise<void>
  close(): void
}

/** 标题栏窗口控制（06 号文档 §4）；状态真源在主进程，这里只做镜像 */
export const useWindow = create<WindowState>((set) => ({
  maximized: false,

  async init() {
    try {
      set({ maximized: (await invoke('window:get-state', {})).maximized })
    } catch {
      set({ maximized: false })
    }
  },

  setMaximized: (maximized) => set({ maximized }),

  minimize: () => {
    void invoke('window:minimize', {}).catch(() => undefined)
  },

  async toggleMaximize() {
    try {
      set({ maximized: (await invoke('window:toggle-maximize', {})).maximized })
    } catch {
      /* 窗口不可用时保持当前图标 */
    }
  },

  close: () => {
    void invoke('window:close', {}).catch(() => undefined)
  },
}))

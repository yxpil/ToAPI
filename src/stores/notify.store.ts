// @author yxpil
import { create } from 'zustand'
import type {
  NotificationView,
  NotifyEventType,
  NotifySettingsView,
  SetNotifySettingsInput,
  TestWebhookResult,
} from '@shared/channels'
import { invoke } from '../lib/ipc'

/** 通知中心与订阅规则状态（15 号文档 §3/§5） */

export interface FeedToast {
  id: string
  level: NotificationView['level']
  title: string
  body: string
}

interface NotifyState {
  items: NotificationView[]
  unread: number
  nextCursor: string | null
  typeFilter: NotifyEventType | null
  drawerOpen: boolean
  settingsOpen: boolean
  settings: NotifySettingsView | null
  /** 应用内 Toast：error 级需手动关，其余 2s 自动消失（§3） */
  toast: FeedToast | null
  webhookResult: TestWebhookResult | null

  load(): Promise<void>
  more(): Promise<void>
  open(): Promise<void>
  close(): void
  setFilter(type: NotifyEventType | null): Promise<void>
  receive(view: NotificationView): void
  markRead(id: string): Promise<void>
  markAllRead(): Promise<void>
  dismissToast(): void
  loadSettings(): Promise<void>
  setSettingsOpen(open: boolean): Promise<void>
  saveSettings(patch: SetNotifySettingsInput): Promise<void>
  testWebhook(url: string, template: string): Promise<void>
}

export const useNotify = create<NotifyState>((set, get) => ({
  items: [],
  unread: 0,
  nextCursor: null,
  typeFilter: null,
  drawerOpen: false,
  settingsOpen: false,
  settings: null,
  toast: null,
  webhookResult: null,

  async load() {
    try {
      const page = await invoke('notify:list', {
        limit: 50,
        type: get().typeFilter,
      })
      set({ items: page.items, nextCursor: page.nextCursor, unread: page.unread })
    } catch {
      /* 主进程未就绪时静默，下一次打开抽屉再拉 */
    }
  },

  async more() {
    const cursor = get().nextCursor
    if (!cursor) return
    const page = await invoke('notify:list', { cursor, limit: 50, type: get().typeFilter })
    set({
      items: [...get().items, ...page.items],
      nextCursor: page.nextCursor,
      unread: page.unread,
    })
  },

  async open() {
    set({ drawerOpen: true })
    await get().load()
  },

  close() {
    set({ drawerOpen: false })
  },

  async setFilter(type) {
    set({ typeFilter: type })
    await get().load()
  },

  receive(view) {
    const state = get()
    const rest = state.items.filter((n) => n.id !== view.id)
    const allowToast = state.settings?.rules[view.type]?.toast ?? true
    set({
      items: [view, ...rest].slice(0, 200),
      unread: state.unread + (view.read ? 0 : 1),
      // 抽屉已打开时列表就地更新，不再弹 Toast
      toast:
        state.drawerOpen || !allowToast
          ? state.toast
          : { id: view.id, level: view.level, title: view.title, body: view.body },
    })
  },

  async markRead(id) {
    await invoke('notify:mark-read', { ids: [id] }).catch(() => undefined)
    set({
      items: get().items.map((n) => (n.id === id ? { ...n, read: true } : n)),
      unread: Math.max(0, get().unread - 1),
    })
  },

  async markAllRead() {
    const { unread } = await invoke('notify:mark-all-read', {})
    set({ items: get().items.map((n) => ({ ...n, read: true })), unread })
  },

  dismissToast() {
    set({ toast: null })
  },

  async loadSettings() {
    const settings = await invoke('notify:get-settings', {}).catch(() => null)
    if (settings) set({ settings })
  },

  async setSettingsOpen(open) {
    set({ settingsOpen: open, webhookResult: null })
    if (!open) return
    const settings = await invoke('notify:get-settings', {}).catch(() => null)
    set({ settings })
  },

  async saveSettings(patch) {
    const settings = await invoke('notify:set-settings', patch)
    set({ settings })
  },

  async testWebhook(url, template) {
    const result = await invoke('notify:test-webhook', {
      url,
      template: template as 'raw' | 'wecom' | 'dingtalk' | 'feishu',
    })
    set({ webhookResult: result })
  },
}))

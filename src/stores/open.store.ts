// @author yxpil
import { create } from 'zustand'
import type {
  OpenCallLogView,
  OpenClientView,
  OpenConfigView,
  OpenSetConfigInput,
} from '@shared/channels'
import { invoke } from '../lib/ipc'

export interface OpenApproval {
  clientId: string
  name: string
  kind: 'http' | 'mcp'
  detail: string
  skillPreview: string
  createdAt: number
}

interface OpenState {
  config: OpenConfigView | null
  clients: OpenClientView[]
  log: OpenCallLogView[]
  /** 待用户确认的外部连接（客户端授权或 host 越界确认） */
  approvals: OpenApproval[]
  settingsOpen: boolean
  /** 新生成的调用密码，只在界面上显示一次 */
  revealed: string | null

  load(): Promise<void>
  apply(pending: OpenApproval): void
  decide(clientId: string, approve: boolean): Promise<void>
  save(input: OpenSetConfigInput): Promise<void>
  rotate(): Promise<void>
  revoke(clientId: string): Promise<void>
  clearRevealed(): void
  setSettingsOpen(open: boolean): void
}

export const useOpen = create<OpenState>((set, get) => ({
  config: null,
  clients: [],
  log: [],
  approvals: [],
  settingsOpen: false,
  revealed: null,

  async load() {
    try {
      const [config, clients, log] = await Promise.all([
        invoke('open:get-config', {}),
        invoke('open:list-clients', {}),
        invoke('open:call-log', { limit: 30 }),
      ])
      set({ config, clients, log })
    } catch {
      /* 主进程未就绪时静默，下一次打开面板再拉 */
    }
  },

  apply(pending) {
    if (get().approvals.some((a) => a.clientId === pending.clientId)) return
    set({ approvals: [...get().approvals, pending] })
  },

  async decide(clientId, approve) {
    set({ approvals: get().approvals.filter((a) => a.clientId !== clientId) })
    await invoke('open:approval-result', { clientId, approve }).catch(() => undefined)
    await get().load()
  },

  async save(input) {
    const config = await invoke('open:set-config', input)
    set({ config })
    await get().load()
  },

  async rotate() {
    const { password } = await invoke('open:rotate-token', {})
    set({ revealed: password })
    await get().load()
  },

  async revoke(clientId) {
    await invoke('open:revoke-client', { id: clientId })
    await get().load()
  },

  clearRevealed() {
    set({ revealed: null })
  },

  setSettingsOpen(open) {
    set({ settingsOpen: open })
    if (open) void get().load()
    else set({ revealed: null })
  },
}))

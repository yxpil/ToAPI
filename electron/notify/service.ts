// @author yxpil
import type {
  NotificationView,
  NotifyEventType,
  NotifyLevel,
  NotifyRuleMap,
  NotifySettingsView,
  SetNotifySettingsInput,
  WebhookTemplate,
} from '@shared/channels'
import { NOTIFY_EVENT_TYPES } from '@shared/channels'
import type { EventName, EventPayload } from '@shared/channels'
import type { Repos } from '../db/repo'
import { SecretMask } from '../open/redact'
import { createLogger } from '../infra/logger'
import { postWebhook, type WebhookPayloadSource } from './webhook'

/**
 * 通知体系（15 号文档）：事件源 → 合并窗口 → 按订阅规则多通道投递 → 通知中心留痕。
 * 合并与限流都按惰性时间判定，不挂定时器，无头场景与测试行为一致。
 */

export interface NotifyEvent {
  type: NotifyEventType
  level: NotifyLevel
  title: string
  body?: string
  sourceType?: string | null
  sourceId?: string | null
  /** 状态变化抑制：同一 stateKey 且 state 未翻转时只留痕不投递（§3.2） */
  stateKey?: string
  state?: string
  /** 强制投递，用于 misfire、error 等必须打断人的场景 */
  force?: boolean
}

export interface DesktopHooks {
  /** OS 原生通知；silent=false 时带提示音 */
  show: (title: string, body: string, silent: boolean) => void
  /** 窗口在前台且聚焦时不发 OS 通知 */
  isFront: () => boolean
}

export interface NotifyDeps {
  repos: Repos
  emit: <K extends EventName>(channel: K, payload: EventPayload<K>) => void
  desktop?: DesktopHooks
  /** 每条入库后的回调，托盘用来刷新红点与菜单（15 号文档 §4） */
  onPosted?: (view: NotificationView) => void
  /** 「关窗最小化到托盘」的默认值，由主进程按平台给出 */
  closeToTrayByDefault?: boolean
  now?: () => number
  fetchImpl?: typeof fetch
}

const RULES_KEY = 'notify.rules'
const CHANNELS_KEY = 'notify.channels'
const log = createLogger('notify')
/** 相同事件 60s 内合并为一条（15 号文档 §3.2） */
const MERGE_WINDOW_MS = 60_000
/** 每个 Webhook URL 每分钟最多 6 条 */
const WEBHOOK_PER_MIN = 6

const DEFAULT_RULES: NotifyRuleMap = {
  'runner.finished': { toast: true, os: true, sound: false, webhook: false },
  'runner.failed': { toast: true, os: true, sound: true, webhook: false },
  'task.finished': { toast: true, os: true, sound: false, webhook: false },
  'task.misfire': { toast: true, os: true, sound: false, webhook: false },
  'node.finished': { toast: true, os: true, sound: false, webhook: false },
  'open.denied': { toast: true, os: true, sound: true, webhook: false },
  'db.failed': { toast: true, os: true, sound: true, webhook: false },
}

interface ChannelSettings {
  closeToTray: boolean
  stateChangeOnly: boolean
  webhookUrl: string
  webhookTemplate: WebhookTemplate
}

/**
 * Linux 桌面环境（GNOME 等）常常没有可用的状态栏托盘：关窗隐藏就等于把应用藏没了，
 * 所以托盘驻留只在 Windows/macOS 默认开，其他平台默认关但用户仍可手动打开。
 */
export const closeToTraySupported = (platform: string): boolean =>
  platform === 'win32' || platform === 'darwin'

const defaultChannels = (closeToTray: boolean): ChannelSettings => ({
  closeToTray,
  stateChangeOnly: true,
  webhookUrl: '',
  webhookTemplate: 'raw',
})

const LEVEL_ORDER: Record<NotifyLevel, number> = { info: 0, warn: 1, error: 2 }

const maxLevel = (a: NotifyLevel, b: NotifyLevel): NotifyLevel =>
  LEVEL_ORDER[a] >= LEVEL_ORDER[b] ? a : b

/** 合并窗口内的累积状态，只影响投递文案，不影响数据库留痕条数 */
interface MergeWindow {
  id: string
  expiresAt: number
  level: NotifyLevel
  subject: string
  lines: string[]
  count: number
}

export class NotifyService {
  private rules: NotifyRuleMap | null = null
  private channels: ChannelSettings | null = null
  private readonly windows = new Map<string, MergeWindow>()
  private readonly lastState = new Map<string, string>()
  private readonly webhookSent = new Map<string, number[]>()

  constructor(private readonly deps: NotifyDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private loadRules(): NotifyRuleMap {
    if (this.rules) return this.rules
    const stored = this.deps.repos.settings.get<Partial<NotifyRuleMap>>(RULES_KEY, {})
    const merged: NotifyRuleMap = { ...DEFAULT_RULES }
    for (const type of NOTIFY_EVENT_TYPES) {
      const entry = stored[type]
      if (entry) merged[type] = { ...DEFAULT_RULES[type], ...entry }
    }
    this.rules = merged
    return merged
  }

  private loadChannels(): ChannelSettings {
    if (this.channels) return this.channels
    this.channels = {
      ...defaultChannels(this.deps.closeToTrayByDefault ?? true),
      ...this.deps.repos.settings.get<Partial<ChannelSettings>>(CHANNELS_KEY, {}),
    }
    return this.channels
  }

  settings(): NotifySettingsView {
    return {
      rules: this.loadRules(),
      ...this.loadChannels(),
      unread: this.deps.repos.notification.unread(),
    }
  }

  setSettings(patch: SetNotifySettingsInput): NotifySettingsView {
    if (patch.rules) {
      const rules = this.loadRules()
      for (const type of NOTIFY_EVENT_TYPES) {
        const entry = patch.rules[type]
        if (entry) rules[type] = { ...rules[type], ...entry }
      }
      this.rules = rules
      this.deps.repos.settings.set(RULES_KEY, rules)
    }
    const channels = { ...this.loadChannels() }
    if (typeof patch.closeToTray === 'boolean') channels.closeToTray = patch.closeToTray
    if (typeof patch.stateChangeOnly === 'boolean') {
      channels.stateChangeOnly = patch.stateChangeOnly
      this.lastState.clear()
    }
    if (typeof patch.webhookUrl === 'string') channels.webhookUrl = patch.webhookUrl.trim()
    if (patch.webhookTemplate) channels.webhookTemplate = patch.webhookTemplate
    this.channels = channels
    this.deps.repos.settings.set(CHANNELS_KEY, channels)
    return this.settings()
  }

  /** 记一条通知并按订阅规则投递；返回入库后的视图 */
  publish(event: NotifyEvent): NotificationView {
    const mask = SecretMask.forProject(this.deps.repos)
    const title = mask.text(event.title)
    const body = mask.text(event.body ?? '')
    const key = `${event.type}|${event.sourceId ?? ''}`
    const open = this.windows.get(key)
    const live = open && open.expiresAt > this.now() ? open : null

    let view: NotificationView
    if (live) {
      const lines = [...live.lines, body].filter((l) => l !== '').slice(-3)
      const level = maxLevel(live.level, event.level)
      const count = live.count + 1
      view = this.deps.repos.notification.merge(live.id, {
        level,
        title: count > 1 ? `${live.subject} 等 ${count} 条` : live.subject,
        body: lines.join('；'),
      })
      this.windows.set(key, { ...live, level, count, lines })
    } else {
      view = this.deps.repos.notification.add({
        type: event.type,
        level: event.level,
        title,
        body,
        sourceType: event.sourceType,
        sourceId: event.sourceId,
      })
      this.windows.set(key, {
        id: view.id,
        expiresAt: this.now() + MERGE_WINDOW_MS,
        level: event.level,
        subject: title,
        lines: body ? [body] : [],
        count: 1,
      })
    }

    // 通知中心不可关：先留痕，再按规则决定打扰方式（15 号文档 §3）
    this.deps.emit('event:notify', view)
    this.deps.onPosted?.(view)

    const stateChanged =
      !event.stateKey || !event.state || this.lastState.get(event.stateKey) !== event.state
    if (event.stateKey && event.state) this.lastState.set(event.stateKey, event.state)
    const quiet = !event.force && this.loadChannels().stateChangeOnly && !stateChanged
    if (quiet) return view

    this.deliver(view, event.type, live === null)
    return view
  }

  /**
   * OS 通知与 Webhook 只在合并窗口的首条触发，窗口内的重复事件只更新同一条记录，
   * 避免高频定时任务把系统通知刷成噪音（15 号文档 §3.2）。
   */
  private deliver(view: NotificationView, type: NotifyEventType, first: boolean): void {
    if (!first) return
    const rule = this.loadRules()[type] ?? DEFAULT_RULES['runner.finished']
    const channels = this.loadChannels()
    if (rule.os && this.deps.desktop && !this.deps.desktop.isFront()) {
      this.deps.desktop.show(view.title, view.body, !rule.sound)
    }
    if (rule.webhook && channels.webhookUrl) void this.pushWebhook(channels, view)
  }

  private allowWebhook(url: string): boolean {
    const now = this.now()
    const recent = (this.webhookSent.get(url) ?? []).filter((t) => now - t < 60_000)
    if (recent.length >= WEBHOOK_PER_MIN) return false
    recent.push(now)
    this.webhookSent.set(url, recent)
    return true
  }

  private async pushWebhook(channels: ChannelSettings, view: NotificationView): Promise<void> {
    if (!this.allowWebhook(channels.webhookUrl)) return
    const source: WebhookPayloadSource = {
      type: view.type,
      level: view.level,
      title: view.title,
      body: view.body,
      sourceType: view.sourceType,
      sourceId: view.sourceId,
      count: view.count,
      ts: view.createdAt,
    }
    const result = await postWebhook(
      channels.webhookUrl,
      channels.webhookTemplate,
      source,
      this.deps.fetchImpl,
    )
    // Webhook 失败不再触发通知，否则失败通知会放大成失败风暴
    if (!result.ok) log.error(`Webhook 投递失败：${result.status} ${result.error ?? ''}`)
  }

  async testWebhook(input: { url: string; template: WebhookTemplate }): Promise<{
    ok: boolean
    status: number
    error: string | null
  }> {
    return postWebhook(
      input.url,
      input.template,
      {
        type: 'runner.finished',
        level: 'info',
        title: 'ToAPI 通知连通性测试',
        body: '这是一条来自 ToAPI 的测试消息，收到即表示 Webhook 可用。',
        sourceType: null,
        sourceId: null,
        count: 1,
        ts: this.now(),
      },
      this.deps.fetchImpl,
    )
  }

  /** 只读游标分页 + 未读过滤；未读数一并返回给角标 */
  list(input: {
    cursor?: string | null
    unreadOnly?: boolean
    type?: NotifyEventType | null
    limit?: number
  }): { items: NotificationView[]; nextCursor: string | null; unread: number } {
    const page = this.deps.repos.notification.list(input)
    return { ...page, unread: this.deps.repos.notification.unread() }
  }

  markRead(ids: string[]): number {
    return this.deps.repos.notification.markRead(ids)
  }

  markAllRead(): number {
    return this.deps.repos.notification.markAllRead()
  }

  unread(): number {
    return this.deps.repos.notification.unread()
  }

  /** 托盘菜单摘要（15 号文档 §4） */
  recent(limit = 3): NotificationView[] {
    return this.deps.repos.notification.latest(limit)
  }

  unreadError(): boolean {
    return this.deps.repos.notification.hasUnreadError()
  }

  reset(): void {
    this.rules = null
    this.channels = null
    this.windows.clear()
    this.lastState.clear()
    this.webhookSent.clear()
  }
}

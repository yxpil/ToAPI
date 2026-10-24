// @author yxpil
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createKernel, type Kernel } from '@main/kernel'
import { makeSyncCall } from '../../fixtures/sync'
import type { NotifyEventType } from '@shared/channels'

/**
 * 通知投递矩阵（15 号文档 §3/§7）：合并窗口、前台不打扰、状态变化抑制、
 * Webhook 限流与模板、secret 脱敏、通知中心容量与已读语义。
 */

interface Shown {
  title: string
  body: string
  silent: boolean
}

let dir = ''
let kernel: Kernel

/** 同步 handler 的直接调用：绕过 invokeGuard 但要保留 handler 层的校验语义 */
const call = makeSyncCall(() => kernel.handlers)
let shown: Shown[] = []
let front = false
let posted: { url: string; body: Record<string, unknown> }[] = []

const events: [NotifyEventType, string][] = [
  ['runner.finished', '运行完成'],
  ['runner.failed', '运行失败'],
  ['task.finished', '任务完成'],
  ['task.misfire', '补跑'],
  ['open.denied', '外部调用'],
  ['db.failed', '数据库'],
]

const reset = (): void => {
  kernel.db.prepare('DELETE FROM notification').run()
  kernel.repos.settings.remove('notify.rules')
  kernel.repos.settings.remove('notify.channels')
  kernel.notify.reset()
  shown = []
  posted = []
  front = false
}

const stubFetch = (async (url: string, init?: RequestInit) => {
  posted.push({
    url: String(url),
    body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
  })
  return new Response('ok', { status: 200 })
}) as typeof fetch

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'toapi-notify-'))
  kernel = createKernel({
    dbPath: ':memory:',
    filesDir: dir,
    appVersion: 'test',
    desktop: {
      show: (title, body, silent) => shown.push({ title, body, silent }),
      isFront: () => front,
    },
    fetchImpl: stubFetch,
  })
})

afterAll(() => {
  kernel?.dispose()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(reset)

const publish = (over: Partial<Parameters<Kernel['notify']['publish']>[0]> = {}): void => {
  kernel.notify.publish({
    type: 'task.finished',
    level: 'info',
    title: '订单回归：48/50 通过',
    body: '失败：创建订单(500)',
    sourceType: 'runner_run',
    sourceId: 'run-1',
    ...over,
  })
}

describe('通道矩阵与前台判定', () => {
  it('窗口在前台时只留痕，不发 OS 通知', () => {
    front = true
    publish()
    expect(shown).toHaveLength(0)
    expect(kernel.repos.notification.list({ limit: 10 }).items).toHaveLength(1)
  })

  it('失焦时发 OS 通知，error 级默认带声音', () => {
    publish()
    expect(shown).toHaveLength(1)
    expect(shown[0]?.silent).toBe(true)
    publish({ type: 'runner.failed', sourceId: 'run-2', level: 'error', force: true })
    expect(shown[1]?.silent).toBe(false)
  })

  it('按事件类型关闭通道后不再投递，通知中心仍收', () => {
    call('notify:set-settings', {
      rules: { 'task.finished': { os: false, toast: false } },
    })
    publish()
    expect(shown).toHaveLength(0)
    expect(kernel.notify.unread()).toBe(1)
  })

  it('notify:list 支持未读过滤与游标分页', () => {
    for (let i = 0; i < 12; i += 1)
      publish({ sourceId: `run-${String(i)}`, title: `第 ${String(i)} 条` })
    const first = call('notify:list', { limit: 5 })
    expect(first.items).toHaveLength(5)
    expect(first.unread).toBe(12)
    const second = call('notify:list', { limit: 5, cursor: first.nextCursor })
    expect(second.items.map((n) => n.id)).not.toContain(first.items[0]?.id)
    second.items.forEach((n) => call('notify:mark-read', { ids: [n.id] }))
    const unreadOnly = call('notify:list', { limit: 50, unreadOnly: true })
    expect(unreadOnly.items.length + second.items.length).toBeGreaterThanOrEqual(10)
  })

  it('全部已读后角标归零', () => {
    publish({ sourceId: 'a' })
    publish({ sourceId: 'b' })
    expect(call('notify:mark-all-read', {}).unread).toBe(0)
    expect(kernel.notify.unreadError()).toBe(false)
  })

  it('error 未读时红点判定为真', () => {
    publish({ level: 'error', sourceId: 'e', force: true })
    expect(kernel.notify.unreadError()).toBe(true)
    call('notify:mark-all-read', {})
    expect(kernel.notify.unreadError()).toBe(false)
  })
})

describe('合并与防轰炸（15 号文档 §3.2）', () => {
  it('相同类型同源 60s 内合并为一条并累计计数', () => {
    publish()
    publish({ title: '订单回归：47/50 通过', body: '失败：支付回调(超时)' })
    publish({ level: 'warn', title: '订单回归：46/50 通过' })
    const items = kernel.repos.notification.list({ limit: 10 }).items
    expect(items).toHaveLength(1)
    expect(items[0]?.count).toBe(3)
    expect(items[0]?.title).toContain('等 3 条')
    expect(items[0]?.level).toBe('warn')
    // OS 通知只在首条投递，后续合并不再打扰
    expect(shown).toHaveLength(1)
  })

  it('不同来源不合并', () => {
    publish({ sourceId: 'a' })
    publish({ sourceId: 'b' })
    expect(kernel.repos.notification.list({ limit: 10 }).items).toHaveLength(2)
  })

  it('状态未翻转时定时任务只留痕不投递', () => {
    kernel.notify.publish({
      type: 'task.finished',
      level: 'info',
      title: '心跳：1/1 通过',
      sourceId: 't1',
      stateKey: 'task:t1',
      state: 'ok',
    })
    kernel.notify.publish({
      type: 'task.finished',
      level: 'info',
      title: '心跳2：1/1 通过',
      sourceId: 't2',
      stateKey: 'task:t1',
      state: 'ok',
    })
    expect(shown).toHaveLength(1)
    expect(kernel.repos.notification.list({ limit: 10 }).items).toHaveLength(2)

    // 失败是状态翻转，必须再次打扰
    kernel.notify.publish({
      type: 'task.finished',
      level: 'warn',
      title: '心跳3：0/1 通过',
      sourceId: 't3',
      stateKey: 'task:t1',
      state: 'fail',
    })
    expect(shown).toHaveLength(2)
  })

  it('关掉「只在变化时通知」后每次都发', () => {
    call('notify:set-settings', { stateChangeOnly: false })
    for (const id of ['s1', 's2', 's3']) {
      kernel.notify.publish({
        type: 'task.finished',
        level: 'info',
        title: `探测 ${id}`,
        sourceId: id,
        stateKey: 'task:probe',
        state: 'ok',
      })
    }
    expect(shown).toHaveLength(3)
  })
})

describe('Webhook（15 号文档 §3.3）', () => {
  const enable = (template: 'raw' | 'wecom' | 'dingtalk' | 'feishu' = 'raw'): void => {
    call('notify:set-settings', {
      webhookUrl: 'https://hook.example/robot',
      webhookTemplate: template,
    })
    call('notify:set-settings', {
      rules: { 'task.finished': { webhook: true }, 'runner.finished': { webhook: true } },
    })
  }

  it('载荷字段与 15 号文档一致', async () => {
    enable('raw')
    publish({ sourceId: 'r1', type: 'task.finished' })
    await new Promise((r) => setTimeout(r, 30))
    expect(posted).toHaveLength(1)
    expect(posted[0]?.url).toBe('https://hook.example/robot')
    const body = posted[0]?.body as Record<string, unknown>
    expect(body['app']).toBe('ToAPI')
    expect(body['type']).toBe('task.finished')
    expect(body['title']).toBe('订单回归：48/50 通过')
    expect(body['run_id']).toBe('r1')

    // 来源不是运行记录时 run_id 为空，避免 CI 端把任务 id 当 run id 用
    publish({ sourceId: 'task-9', sourceType: 'schedule_task' })
    await new Promise((r) => setTimeout(r, 30))
    expect((posted[1]?.body as Record<string, unknown>)['run_id']).toBeNull()
  })

  it('三种 IM 模板各自的载荷结构', async () => {
    for (const template of ['wecom', 'dingtalk', 'feishu'] as const) {
      reset()
      enable(template)
      publish({ sourceId: `t-${template}` })
      await new Promise((r) => setTimeout(r, 30))
      const body = posted[0]?.body as Record<string, unknown>
      if (template === 'wecom') expect(body['msgtype']).toBe('markdown')
      if (template === 'dingtalk')
        expect((body['text'] as { content: string }).content).toContain('ToAPI')
      if (template === 'feishu') expect(Object.keys(body)).toEqual(['msg_type', 'content'])
    }
  })

  it('每地址每分钟最多 6 条，其余丢弃', async () => {
    enable('raw')
    for (let i = 0; i < 10; i += 1)
      publish({ sourceId: `run-${String(i)}`, title: `第 ${String(i)} 条` })
    await new Promise((r) => setTimeout(r, 60))
    expect(posted).toHaveLength(6)
    expect(kernel.repos.notification.list({ limit: 50 }).items).toHaveLength(10)
  })

  it('test-webhook 走同一模板并回传状态', async () => {
    const res = kernel.invoke('notify:test-webhook', {
      url: 'https://hook.example/probe',
      template: 'dingtalk',
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(await res).toMatchObject({ ok: true, status: 200 })
    expect(posted[0]?.url).toBe('https://hook.example/probe')
  })

  it('非法地址与协议拒绝', () => {
    expect(() => call('notify:set-settings', { webhookUrl: 'not-a-url' })).toThrow(/合法 URL/)
    expect(() => call('notify:set-settings', { webhookUrl: 'file:///C:/windows' })).toThrow(/http/)
  })
})

describe('脱敏与容量（15 号文档 §7）', () => {
  it('secret 值在标题、正文与 Webhook 载荷里都只出现 ***', async () => {
    const project = call('project:create', { name: '脱敏项目' })
    const env = call('env:create', { projectId: project.id, name: 'prod' })
    call('var:set', {
      scope: 'environment',
      environmentId: env.id,
      key: 'password',
      value: 'TOPSEKRIT-9527',
      secret: true,
    })
    enableForWebhook()
    kernel.notify.publish({
      type: 'runner.failed',
      level: 'error',
      title: '登录失败：TOPSEKRIT-9527',
      body: '请求头 Authorization: Bearer TOPSEKRIT-9527',
      sourceId: 'sec-1',
      force: true,
    })
    await new Promise((r) => setTimeout(r, 40))
    const items = kernel.repos.notification.list({ limit: 10 }).items
    expect(items[0]?.title).toContain('***')
    expect(JSON.stringify(items)).not.toContain('TOPSEKRIT-9527')
    expect(shown).toHaveLength(1)
    expect(shown[0]?.title).not.toContain('TOPSEKRIT-9527')
    expect(JSON.stringify(posted)).not.toContain('TOPSEKRIT-9527')
  })

  it('通知中心保留最近 1000 条，超出环形清理', () => {
    for (let i = 0; i < 1005; i += 1) {
      kernel.repos.notification.add({
        type: 'db.failed',
        level: 'error',
        title: `第 ${String(i)} 条`,
        body: '',
      })
    }
    expect(kernel.repos.notification.list({ limit: 200 }).items).toHaveLength(200)
    const total = kernel.db.prepare('SELECT COUNT(*) AS c FROM notification').get() as { c: number }
    expect(total.c).toBe(1000)
  })

  it('六种事件类型都能读写订阅矩阵', () => {
    const view = call('notify:get-settings', {})
    for (const [type] of events) expect(Object.keys(view.rules)).toContain(type)
    const next = call('notify:set-settings', {
      rules: Object.fromEntries(events.map(([type], i) => [type, { toast: i % 2 === 0 }])),
    })
    for (let i = 0; i < events.length; i += 1) {
      const [type] = events[i]!
      expect(next.rules[type].toast).toBe(i % 2 === 0)
    }
  })
})

function enableForWebhook(): void {
  call('notify:set-settings', { webhookUrl: 'https://hook.example/robot' })
  call('notify:set-settings', {
    rules: { 'runner.failed': { webhook: true } },
  })
}

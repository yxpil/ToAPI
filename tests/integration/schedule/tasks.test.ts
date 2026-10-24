// @author yxpil
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createKernel, type Kernel } from '@main/kernel'
import { makeSyncCall } from '../../fixtures/sync'
import { startRange, type Range } from '../../fixtures/range'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const WORKER = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../dist-electron/script-worker.cjs',
)

/**
 * 定时任务真实链路（12/15 号文档）：调度触发 → 靶场流量 → 通过率汇报 + 报告落盘 → 通知中心。
 * 这里用真实 RunnerFlow 与真实 HTTP 服务，桩只在调度策略测试里用。
 */

let kernel: Kernel

/** 同步 handler 的直接调用：绕过 invokeGuard 但要保留 handler 层的校验语义 */
const call = makeSyncCall(() => kernel.handlers)
let range: Range
let dir = ''
let projectId = ''
let collectionId = ''
let envId = ''
let passApiId = ''

const notifications = (type?: string) =>
  kernel.repos.notification
    .list({ limit: 50, ...(type ? { type: type as never } : {}) })
    .items.filter((n) => (type ? n.type === type : true))

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'toapi-tasks-'))
  range = await startRange()
  kernel = createKernel({
    dbPath: ':memory:',
    filesDir: dir,
    appVersion: 'test',
    scriptWorkerPath: WORKER,
  })

  projectId = (await kernel.invoke('project:create', { name: '定时项目' })).id
  collectionId = (await kernel.invoke('collection:create', { projectId, name: '冒烟' })).id
  envId = (await kernel.invoke('env:create', { projectId, name: 'staging' })).id
  await kernel.invoke('var:set', {
    scope: 'environment',
    environmentId: envId,
    key: 'baseUrl',
    value: range.origin,
  })
  passApiId = (await kernel.invoke('api:create', { collectionId, name: '取令牌', method: 'GET' }))
    .id
  await kernel.invoke('api:update', {
    id: passApiId,
    url: '{{baseUrl}}/token?user=scheduler',
    postScript: 'toapi.expect(toapi.response.status).to.equal(201)',
  })
})

afterAll(() => {
  kernel?.dispose()
  range?.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('task:run-now 走真实 Runner', () => {
  it('触发一次集合回归：靶场收到请求、通过率进通知、报告落盘', async () => {
    const view = call('task:create', {
      name: '冒烟回归',
      targetType: 'collection',
      targetId: collectionId,
      spec: { kind: 'interval', everyMs: 60_000 },
      envId,
      notify: { onSuccess: true, onFail: true, report: 'json' },
    })
    const before = range.requests.length

    const { runId } = await kernel.invoke('task:run-now', { id: view.id })
    await kernel.runner.whenDone(runId)

    expect(range.requests.length).toBeGreaterThan(before)
    const run = kernel.repos.runner.get(runId)
    expect(run?.passed).toBe(1)

    const finished = notifications('task.finished')
    expect(finished).toHaveLength(1)
    expect(finished[0]?.title).toBe('冒烟回归：1/1 通过')
    expect(finished[0]?.level).toBe('info')
    expect(finished[0]?.sourceId).toBe(view.id)

    // 报告路径来自通知正文，验证文件真的写出来了
    const path = (finished[0]?.body ?? '').match(/报告：(.+)$/)?.[1] ?? ''
    expect(path).not.toBe('')
    expect(existsSync(path)).toBe(true)
    const text = readFileSync(path, 'utf8')
    expect(JSON.parse(text).run.scope.name).toBe('冒烟')

    // 任务触发的运行不再另发 runner.* 通知，避免一次运行两条（15 号文档 §1）
    expect(notifications('runner.finished')).toHaveLength(0)

    const task = kernel.repos.schedule.get(view.id)
    expect(task?.lastRunId).toBe(runId)
    expect(task?.lastFailed).toBe(0)
    expect(task?.nextRunAt ?? 0).toBeGreaterThan(Date.now() - 1000)
  })

  it('界面手动跑集合时发 runner.finished 通知', async () => {
    const { runId } = await kernel.invoke('runner:start', {
      scopeType: 'collection',
      scopeId: collectionId,
      envId,
      cancelId: 'manual-1',
    })
    await kernel.runner.whenDone(runId)
    const finished = notifications('runner.finished')
    expect(finished.some((n) => n.title === '冒烟：1/1 通过')).toBe(true)
  })

  it('断言失败时通知级别升到 warn 并带上失败接口名', async () => {
    const badApi = (
      await kernel.invoke('api:create', { collectionId, name: '必失败', method: 'GET' })
    ).id
    await kernel.invoke('api:update', {
      id: badApi,
      url: '{{baseUrl}}/status/500',
      postScript: 'toapi.expect(toapi.response.status).to.equal(200)',
    })
    const view = call('task:create', {
      name: '破坏性回归',
      targetType: 'api',
      targetId: badApi,
      spec: { kind: 'interval', everyMs: 60_000 },
      envId,
      notify: { onSuccess: true, onFail: true, report: 'none' },
    })
    const { runId } = await kernel.invoke('task:run-now', { id: view.id })
    await kernel.runner.whenDone(runId)

    const finished = notifications('task.finished').filter((n) => n.sourceId === view.id)
    expect(finished).toHaveLength(1)
    expect(finished[0]?.level).toBe('warn')
    expect(finished[0]?.title).toBe('破坏性回归：0/1 通过')
    expect(finished[0]?.body).toContain('必失败')
    expect(finished[0]?.body).not.toContain('报告：')
  })

  it('任务只关心失败时成功不通知，但仍写运行记录', async () => {
    const view = call('task:create', {
      name: '只要失败声',
      targetType: 'api',
      targetId: passApiId,
      spec: { kind: 'interval', everyMs: 60_000 },
      envId,
      notify: { onSuccess: false, onFail: true, report: 'none' },
    })
    const before = notifications('task.finished').length
    const { runId } = await kernel.invoke('task:run-now', { id: view.id })
    await kernel.runner.whenDone(runId)
    expect(kernel.repos.runner.get(runId)?.passed).toBe(1)
    expect(notifications('task.finished')).toHaveLength(before)
    // 不打扰不等于不留痕：任务缓存仍记录这次运行
    expect(kernel.repos.schedule.get(view.id)?.lastRunId).toBe(runId)
  })
})

describe('runner:report 报告导出（07/23 号文档）', () => {
  it('默认写到 reports 目录，格式决定后缀', async () => {
    const { runId } = await kernel.invoke('runner:start', {
      scopeType: 'collection',
      scopeId: collectionId,
      envId,
      cancelId: 'report-1',
    })
    await kernel.runner.whenDone(runId)
    const { filePath } = await kernel.invoke('runner:report', { runId, format: 'html' })
    expect(filePath.startsWith(join(dir, 'reports'))).toBe(true)
    expect(filePath.endsWith('.html')).toBe(true)
    expect(readFileSync(filePath, 'utf8')).toContain('ToAPI 运行报告')
  })

  it('自定义路径后缀不符时补齐正确后缀', async () => {
    const { runId } = await kernel.invoke('runner:start', {
      scopeType: 'collection',
      scopeId: collectionId,
      envId,
      cancelId: 'report-2',
    })
    await kernel.runner.whenDone(runId)
    const target = join(dir, 'named-report')
    const { filePath } = await kernel.invoke('runner:report', {
      runId,
      format: 'junit',
      filePath: target,
    })
    expect(filePath).toBe(`${target}.xml`)
    expect(readFileSync(filePath, 'utf8')).toContain('<testsuite')
  })

  it('运行记录不存在时报 NOT_FOUND', async () => {
    await expect(
      kernel.invoke('runner:report', { runId: '01NOPE', format: 'json' }),
    ).rejects.toThrow(/运行记录不存在/)
  })
})

describe('task CRUD 与视图（12 号文档 §4）', () => {
  it('列表视图带目标名、环境名与运行态', () => {
    const list = call('task:list', {})
    expect(list.length).toBeGreaterThan(0)
    const withEnv = list.find((t) => t.envName === 'staging')
    expect(withEnv?.targetName).toBe('冒烟')
    expect(withEnv?.running).toBe(false)
  })

  it('更新表达式会重排下次触发时间，禁用后不再排期', () => {
    const view = call('task:create', {
      name: '待改期',
      targetType: 'collection',
      targetId: collectionId,
      spec: { kind: 'interval', everyMs: 60_000 },
      envId,
    })
    const updated = call('task:update', {
      id: view.id,
      spec: { kind: 'cron', expr: '0 9 * * *' },
    })
    expect(updated.spec.kind).toBe('cron')
    expect(updated.nextRunAt ?? 0).toBeGreaterThan(Date.now())
    const off = call('task:toggle', { id: view.id, enabled: false })
    expect(off.enabled).toBe(false)
    expect(off.nextRunAt).toBeNull()
    call('task:delete', { id: view.id })
    expect(call('task:list', {}).some((t) => t.id === view.id)).toBe(false)
  })

  it('删除不存在的任务报 NOT_FOUND', () => {
    expect(() => call('task:delete', { id: '01NOPE' })).toThrow(/不存在/)
  })
})

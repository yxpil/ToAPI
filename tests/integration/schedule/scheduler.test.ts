// @author yxpil
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createKernel, type Kernel } from '@main/kernel'
import { makeSyncCall } from '../../fixtures/sync'
import type { RunnerFlow } from '@main/flow/runner'
import { ScheduleService } from '@main/schedule/service'
import type { NewScheduleTask } from '@shared/channels'

/**
 * 调度策略（12 号文档 §1/§5）：misfire 补跑、overlap skip/queue 上限、时钟跳变不重复触发。
 * 用桩 RunnerFlow 精确控制运行时长；真实靶场链路在 tasks.test.ts 里验。
 */

let dir = ''
let kernel: Kernel

/** 同步 handler 的直接调用：绕过 invokeGuard 但要保留 handler 层的校验语义 */
const call = makeSyncCall(() => kernel.handlers)
let projectId = ''
let collectionId = ''
let envId = ''

interface Stub {
  started: number
  /** 释放 N 个挂起的 whenDone，让对应运行结束 */
  release: (count?: number) => void
  runner: RunnerFlow
}

/**
 * hold=false 时 whenDone 立即完成；hold=true 时挂起直到 release。
 * 运行记录仍写进 runner_run，任务侧的通过率汇报才能走真实链路。
 */
function stubRunner(hold: boolean): Stub {
  const pending: (() => void)[] = []
  const stub: Stub = {
    started: 0,
    release: (count = 1) => {
      for (let i = 0; i < count; i += 1) pending.shift()?.()
    },
    runner: null as unknown as RunnerFlow,
  }
  stub.runner = {
    start: async () => {
      stub.started += 1
      const { id } = kernel.repos.runner.startRun({
        scopeType: 'collection',
        scopeId: collectionId,
        scopeName: '桩集合',
        envId,
        total: 1,
        iterationCount: 1,
      })
      kernel.repos.runner.finishRun({ runId: id, passed: 1, failed: 0, skipped: 0, report: {} })
      return { runId: id, total: 1 }
    },
    whenDone: () =>
      hold
        ? new Promise<void>((resolve) => {
            pending.push(resolve)
          })
        : Promise.resolve(),
    cancel: () => stub.release(),
  } as unknown as RunnerFlow
  return stub
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 把下次触发拨到过去；tick 发现库里的排期与内存不一致会重新对齐并在下一轮触发 */
const rewind = (taskId: string): void => {
  kernel.repos.schedule.setNextRun(taskId, Date.now() - 5_000)
}

/** 等两个 tick：第一个用来重新对齐排期，第二个才真正触发 */
const settle = (): Promise<void> => wait(180)

/** 轮询到条件成立，避免"固定 sleep"在慢机器上误判 */
async function until(label: string, predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  for (let waited = 0; waited < timeoutMs; waited += 50) {
    if (predicate()) return
    await wait(50)
  }
  throw new Error(`等待超时：${label}`)
}

const services: ScheduleService[] = []

/**
 * 间隔默认取 1 小时：这些用例靠"把 next_run_at 拨回过去"手工驱动触发，
 * 用短间隔会让 epoch 对齐的自然触发混进来，排队数与并发数就不再确定。
 */
const mkTask = (over: Partial<NewScheduleTask> = {}): NewScheduleTask => ({
  name: '策略任务',
  targetType: 'collection',
  targetId: collectionId,
  spec: { kind: 'interval', everyMs: 3_600_000 },
  envId,
  ...over,
})

const build = (runner: RunnerFlow): ScheduleService => {
  const service = new ScheduleService({
    repos: kernel.repos,
    runner,
    files: kernel.files,
    notify: kernel.notify,
    emit: () => undefined,
    tickMs: 30,
  })
  services.push(service)
  return service
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'toapi-sched-'))
  kernel = createKernel({ dbPath: ':memory:', filesDir: dir, appVersion: 'test' })
  projectId = call('project:create', { name: '调度项目' }).id
  collectionId = call('collection:create', { projectId, name: '主集合' }).id
  envId = call('env:create', { projectId, name: 'staging' }).id
})

afterAll(() => {
  kernel?.dispose()
  rmSync(dir, { recursive: true, force: true })
})

afterEach(() => {
  for (const service of services.splice(0)) service.stop()
  for (const task of kernel.repos.schedule.list()) kernel.repos.schedule.remove(task.id)
  kernel.db.prepare('DELETE FROM notification').run()
  kernel.repos.settings.remove('notify.rules')
  kernel.repos.settings.remove('notify.channels')
  kernel.notify.reset()
})

describe('misfire 补跑（12 号文档 §1）', () => {
  it('错过多次触发只补最近一次，并发出 warn 通知', async () => {
    const stub = stubRunner(false)
    const service = build(stub.runner)
    // 间隔取 1 小时：除了补跑这一次，短时间内不会有自然触发，计数才唯一
    const view = call(
      'task:create',
      mkTask({ name: '夜间回归', spec: { kind: 'interval', everyMs: 3_600_000 } }),
    )
    kernel.repos.schedule.setNextRun(view.id, Date.now() - 2 * 3_600_000)

    service.start()
    await settle()

    expect(stub.started).toBe(1)
    const misfire = kernel.repos.notification.list({ type: 'task.misfire', limit: 10 }).items
    expect(misfire).toHaveLength(1)
    expect(misfire[0]?.level).toBe('warn')
    expect(misfire[0]?.title).toContain('夜间回归')
    const task = kernel.repos.schedule.get(view.id)
    expect(task?.lastRunId).not.toBeNull()
    expect(task?.nextRunAt ?? 0).toBeGreaterThan(Date.now() - 1000)
    service.stop()
  })

  it('misfire=skip 时不补跑', async () => {
    const stub = stubRunner(false)
    const service = build(stub.runner)
    const view = call(
      'task:create',
      mkTask({ name: '跳过补跑', misfire: 'skip', spec: { kind: 'interval', everyMs: 3_600_000 } }),
    )
    kernel.repos.schedule.setNextRun(view.id, Date.now() - 60_000)
    service.start()
    await settle()
    expect(stub.started).toBe(0)
    expect(kernel.repos.notification.list({ type: 'task.misfire', limit: 10 }).items).toHaveLength(
      0,
    )
    // 跳过补跑也要把排期推回未来，否则每秒都在"错过"
    expect(kernel.repos.schedule.get(view.id)?.nextRunAt ?? 0).toBeGreaterThanOrEqual(Date.now())
    service.stop()
  })

  it('单次任务跑完自动停用', async () => {
    const stub = stubRunner(false)
    const service = build(stub.runner)
    const view = call(
      'task:create',
      mkTask({ name: '一次性', spec: { kind: 'once', at: Date.now() + 20 } }),
    )
    service.start()
    await wait(150)
    expect(stub.started).toBe(1)
    const task = kernel.repos.schedule.get(view.id)
    expect(task?.enabled).toBe(false)
    expect(task?.nextRunAt).toBeNull()
    service.stop()
  })
})

describe('overlap 策略（12 号文档 §1/§5）', () => {
  it('skip：上次仍在运行时不并发，结束后按新周期继续', async () => {
    const stub = stubRunner(true)
    const service = build(stub.runner)
    const view = call('task:create', mkTask({ name: '串行任务', overlap: 'skip' }))
    service.start()
    rewind(view.id)
    await settle()
    expect(stub.started).toBe(1)

    for (let i = 0; i < 3; i += 1) {
      rewind(view.id)
      await settle()
    }
    expect(stub.started).toBe(1)

    stub.release()
    await settle()
    rewind(view.id)
    await until('放行后按新周期继续触发', () => stub.started === 2)
    stub.release()
    service.stop()
  })

  it('queue：排队上限 3，多出的到期按跳过丢弃', async () => {
    const stub = stubRunner(true)
    const service = build(stub.runner)
    const view = call('task:create', mkTask({ name: '排队任务', overlap: 'queue' }))
    service.start()
    rewind(view.id)
    await settle()
    expect(stub.started).toBe(1)

    for (let i = 0; i < 6; i += 1) {
      rewind(view.id)
      await settle()
    }
    // 逐个放行：1 个在执行 + 3 个排队，多出的到期被丢弃，所以总执行数停在 4
    for (let i = 0; i < 4; i += 1) {
      stub.release()
      await wait(60)
    }
    await until('排队中的 3 次全部放行', () => stub.started === 4)
    expect(stub.started).toBe(4)
    service.stop()
  })

  it('parallel：同一任务可并发执行', async () => {
    const stub = stubRunner(true)
    const service = build(stub.runner)
    const view = call('task:create', mkTask({ name: '并发任务', overlap: 'parallel' }))
    service.start()
    for (let i = 0; i < 3; i += 1) {
      rewind(view.id)
      await settle()
    }
    expect(stub.started).toBeGreaterThanOrEqual(3)
    stub.release(3)
    service.stop()
  })
})

describe('时钟与目标失效', () => {
  it('墙钟被拨快不会提前触发（到期判定用单调时钟）', async () => {
    const stub = stubRunner(false)
    const service = build(stub.runner)
    call('task:create', mkTask({ name: '单调时钟', spec: { kind: 'interval', everyMs: 60_000 } }))
    service.start()
    const originalNow = Date.now
    // 系统时间前进 10 分钟，单调时钟仍在同一轮里
    Date.now = () => originalNow() + 10 * 60_000
    try {
      await wait(200)
    } finally {
      Date.now = originalNow
    }
    expect(stub.started).toBe(0)
    service.stop()
  })

  it('目标集合被删除后任务自动停用，而不是每次都失败', async () => {
    const orphan = call('task:create', mkTask({ name: '孤儿任务' }))
    const gone = call('collection:create', { projectId, name: '待删集合' })
    const task = call('task:create', mkTask({ name: '真删集合', targetId: gone.id }))
    kernel.repos.collection.remove(gone.id)
    const service = build(kernel.runner)
    service.start()
    rewind(task.id)
    await until('任务因目标失效被停用', () => kernel.repos.schedule.get(task.id)?.enabled === false)
    // 启动失败也要留痕，通知中心里能看到是任务出错而不是静默消失
    const failed = kernel.repos.notification.list({ type: 'task.finished', limit: 10 }).items
    expect(failed.some((n) => n.level === 'error')).toBe(true)
    expect(kernel.repos.schedule.get(orphan.id)?.enabled).toBe(true)
    service.stop()
  })
})

describe('校验闸门（12 号文档 §1）', () => {
  it('未锁环境直接拒绝', () => {
    expect(() => call('task:create', mkTask({ envId: null }))).toThrow(/必须锁定环境/)
  })

  it('环境不属于目标项目时拒绝', () => {
    const other = call('project:create', { name: '别的项目' })
    const otherEnv = call('env:create', { projectId: other.id, name: 'prod' })
    expect(() => call('task:create', mkTask({ envId: otherEnv.id }))).toThrow(
      /不属于该目标所在项目/,
    )
  })

  it('非法 cron 与不存在的目标都拒绝', () => {
    expect(() => call('task:create', mkTask({ spec: { kind: 'cron', expr: '* *' } }))).toThrow(
      /5 或 6 段/,
    )
    expect(() => call('task:create', mkTask({ targetId: '01NOPE' }))).toThrow(/目标不存在/)
  })

  it('cron 预览给出未来 5 次，非法表达式返回原因而不是抛错', () => {
    const ok = call('task:preview', { spec: { kind: 'cron', expr: '0 * * * *' } })
    expect(ok.times).toHaveLength(5)
    expect(ok.error).toBeNull()
    const bad = call('task:preview', { spec: { kind: 'cron', expr: '* *' } })
    expect(bad.times).toEqual([])
    expect(bad.error).toContain('5 或 6 段')
  })
})

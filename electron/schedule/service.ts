// @author yxpil
import type {
  EventName,
  EventPayload,
  NewScheduleTask,
  ScheduleTaskView,
  ScheduleTargetType,
  TaskPreviewResult,
  UpdateScheduleTask,
} from '@shared/channels'
import { IpcErrorRaised } from '@shared/types'
import type { Repos } from '../db/repo'
import type { RunnerRun } from '../db/repo/runner.repo'
import type { ScheduleTask } from '../db/repo/schedule.repo'
import type { RunnerFlow } from '../flow/runner'
import type { FileStore } from '../infra/filestore'
import { writeReport } from '../report/export'
import { createLogger } from '../infra/logger'
import type { NotifyService } from '../notify/service'
import { nextAt, nextAfter, validateSpec } from './cron'

/**
 * 定时任务与调度器（12 号文档 §1）：CRUD、下次触发计算、overlap/misfire 策略与完成汇报。
 * 到期判定走单调时钟，用户改系统时间不会造成重复触发（§5「时钟」用例）。
 */

export interface ScheduleDeps {
  repos: Repos
  runner: RunnerFlow
  files: FileStore
  notify: NotifyService
  emit: <K extends EventName>(channel: K, payload: EventPayload<K>) => void
  /** 轮询间隔，默认 1s；测试注入更短以驱动到期逻辑 */
  tickMs?: number
}

const log = createLogger('schedule')
const TICK_MS = 1000
/** queue 策略的排队上限，超出按 skip 处理（12 号文档 §5） */
const MAX_QUEUE = 3
/** misfire 统计最多回溯 1000 个触发点 */
const MAX_MISFIRED = 1000

const mono = (): number => Number(process.hrtime.bigint() / 1000000n)

interface Target {
  projectId: string
  name: string
}

export class ScheduleService {
  private timer: NodeJS.Timeout | null = null
  /** 任务 id → 到期时的单调毫秒 */
  private readonly due = new Map<string, number>()
  /** 排期时读到的墙钟时间：与库里不一致（被编辑或被别的实例改过）就重新对齐 */
  private readonly planned = new Map<string, number | null>()
  /** 任务 id → 正在运行的 cancelId，parallel 策略下可能多个 */
  private readonly active = new Map<string, Set<string>>()
  private readonly queued = new Map<string, number>()

  constructor(private readonly deps: ScheduleDeps) {}

  // ── 对账与视图 ──

  list(): ScheduleTaskView[] {
    return this.deps.repos.schedule.list().map((task) => this.toView(task))
  }

  private toView(task: ScheduleTask): ScheduleTaskView {
    const target = this.targetSafe(task.targetType, task.targetId)
    const env = task.envId ? this.deps.repos.environment.get(task.envId) : null
    return {
      id: task.id,
      name: task.name,
      enabled: task.enabled,
      targetType: task.targetType,
      targetId: task.targetId,
      targetName: target?.name ?? '目标已删除',
      spec: task.spec,
      envId: task.envId,
      envName: env?.name ?? '未锁定',
      overlap: task.overlap,
      misfire: task.misfire,
      notify: task.notify,
      lastRunAt: task.lastRunAt,
      lastRunId: task.lastRunId,
      lastFailed: task.lastFailed,
      nextRunAt: task.nextRunAt,
      running: this.active.has(task.id),
    }
  }

  private targetSafe(type: ScheduleTargetType, id: string): Target | null {
    if (type === 'collection') {
      const c = this.deps.repos.collection.get(id)
      return c ? { projectId: c.projectId, name: c.name } : null
    }
    if (type === 'api') {
      const api = this.deps.repos.api.get(id)
      if (!api) return null
      const collection = this.deps.repos.collection.get(api.collectionId)
      return { projectId: collection?.projectId ?? '', name: api.name }
    }
    const p = this.deps.repos.project.get(id)
    return p ? { projectId: p.id, name: p.name } : null
  }

  private requireTarget(type: ScheduleTargetType, id: string): Target {
    const target = this.targetSafe(type, id)
    if (!target) {
      throw new IpcErrorRaised({ code: 'NOT_FOUND', message: '定时任务的目标不存在或已删除' })
    }
    return target
  }

  /** 定时回归必须锁环境，禁止跟随当前激活（12 号文档 §1） */
  private requireEnv(envId: string | null, projectId: string): void {
    if (!envId) {
      throw new IpcErrorRaised({
        code: 'VALIDATION',
        message: '定时任务必须锁定环境，避免跟着界面切换跑错目标',
      })
    }
    const env = this.deps.repos.environment.get(envId)
    if (!env || env.projectId !== projectId) {
      throw new IpcErrorRaised({ code: 'VALIDATION', message: '环境不属于该目标所在项目' })
    }
  }

  private assertSpec(spec: NewScheduleTask['spec']): void {
    const error = validateSpec(spec)
    if (error) throw new IpcErrorRaised({ code: 'VALIDATION', message: error })
    if (spec.kind === 'once' && spec.at <= Date.now()) {
      throw new IpcErrorRaised({ code: 'VALIDATION', message: '单次触发时间已经过去' })
    }
  }

  private nextOrThrow(spec: NewScheduleTask['spec'], from: number): number {
    const next = nextAt(spec, from)
    if (next === null) {
      throw new IpcErrorRaised({ code: 'VALIDATION', message: '该表达式在未来 4 年内不会触发' })
    }
    return next
  }

  // ── CRUD ──

  create(input: NewScheduleTask): ScheduleTaskView {
    const target = this.requireTarget(input.targetType, input.targetId)
    this.assertSpec(input.spec)
    this.requireEnv(input.envId ?? null, target.projectId)
    const task = this.deps.repos.schedule.create({
      ...input,
      envId: input.envId ?? null,
      nextRunAt: this.nextOrThrow(input.spec, Date.now()),
    })
    this.syncDue(task)
    this.emitState(task.id)
    return this.toView(task)
  }

  update(req: UpdateScheduleTask): ScheduleTaskView {
    const { id, ...patch } = req
    const current = this.get(id)
    const targetType = patch.targetType ?? current.targetType
    const targetId = patch.targetId ?? current.targetId
    const spec = patch.spec ?? current.spec
    const envId = patch.envId === undefined ? current.envId : patch.envId
    const target = this.requireTarget(targetType, targetId)
    if (patch.spec) this.assertSpec(patch.spec)
    this.requireEnv(envId, target.projectId)
    const enabled = patch.enabled ?? current.enabled
    const task = this.deps.repos.schedule.update(id, {
      name: patch.name ?? current.name,
      targetType,
      targetId,
      spec,
      envId,
      overlap: patch.overlap ?? current.overlap,
      misfire: patch.misfire ?? current.misfire,
      notify: patch.notify ?? current.notify,
      enabled,
      nextRunAt: enabled ? this.nextOrThrow(spec, Date.now()) : null,
    })
    this.syncDue(task)
    this.emitState(task.id)
    return this.toView(task)
  }

  get(id: string): ScheduleTask {
    const task = this.deps.repos.schedule.get(id)
    if (!task) throw new IpcErrorRaised({ code: 'NOT_FOUND', message: '定时任务不存在' })
    return task
  }

  toggle(id: string, enabled: boolean): ScheduleTaskView {
    const current = this.get(id)
    const nextRunAt = enabled ? this.nextOrThrow(current.spec, Date.now()) : null
    const task = this.deps.repos.schedule.setEnabled(id, enabled, nextRunAt)
    this.syncDue(task)
    this.emitState(task.id)
    return this.toView(task)
  }

  remove(id: string): void {
    this.get(id)
    this.deps.repos.schedule.remove(id)
    this.due.delete(id)
    this.planned.delete(id)
    this.queued.delete(id)
  }

  preview(spec: NewScheduleTask['spec'], from?: number): TaskPreviewResult {
    const error = validateSpec(spec)
    if (error) return { times: [], error }
    try {
      return { times: nextAfter(spec, from ?? Date.now(), 5), error: null }
    } catch (e) {
      return { times: [], error: (e as Error).message }
    }
  }

  /** 立即触发一次：不受 overlap 排队限制，也不推进下次时间（12 号文档 §4） */
  async runNow(id: string): Promise<{ runId: string }> {
    const task = this.get(id)
    const runId = await this.fire(task, { manual: true })
    if (runId === null) {
      throw new IpcErrorRaised({
        code: 'VALIDATION',
        message: '该范围没有可运行的接口或目标已删除',
      })
    }
    return { runId }
  }

  // ── 调度循环 ──

  /** 启动：先按 misfire 策略补跑错过的触发点，再挂上 tick（12 号文档 §1/§5） */
  start(): void {
    this.recover()
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), this.deps.tickMs ?? TICK_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.due.clear()
    this.planned.clear()
    this.queued.clear()
  }

  private syncDue(task: ScheduleTask): void {
    if (!task.enabled || task.nextRunAt === null) {
      this.due.delete(task.id)
      this.planned.delete(task.id)
      return
    }
    this.due.set(task.id, mono() + Math.max(0, task.nextRunAt - Date.now()))
    this.planned.set(task.id, task.nextRunAt)
  }

  private recover(): void {
    const now = Date.now()
    for (const task of this.deps.repos.schedule.listEnabled()) {
      if (task.nextRunAt === null) {
        // 单次任务时间已过或从未排上：重新排一次，避免永久静默
        const next = nextAt(task.spec, now)
        this.deps.repos.schedule.setNextRun(task.id, next)
        this.syncDue({ ...task, nextRunAt: next })
        continue
      }
      if (task.nextRunAt > now) {
        this.syncDue(task)
        continue
      }
      const missed = this.countMissed(task.spec, task.nextRunAt, now)
      const next = nextAt(task.spec, now)
      this.deps.repos.schedule.setNextRun(task.id, next)
      this.syncDue({ ...task, nextRunAt: next })
      if (task.misfire === 'skip' || missed === 0) continue
      this.deps.notify.publish({
        type: 'task.misfire',
        level: 'warn',
        title: `任务「${task.name}」错过 ${missed} 次触发`,
        body: `应用未运行期间错过 ${missed} 次，已补跑最近一次`,
        sourceType: 'schedule_task',
        sourceId: task.id,
        force: true,
      })
      void this.fire({ ...task, nextRunAt: next }, { misfire: missed })
    }
  }

  private countMissed(spec: ScheduleTask['spec'], from: number, to: number): number {
    let count = 0
    let cursor = from - 1
    while (count < MAX_MISFIRED) {
      const next = nextAt(spec, cursor)
      if (next === null || next > to) break
      cursor = next
      count += 1
    }
    return count
  }

  private tick(): void {
    const now = mono()
    for (const task of this.deps.repos.schedule.listEnabled()) {
      const dueAt = this.due.get(task.id)
      if (dueAt === undefined || this.planned.get(task.id) !== task.nextRunAt) {
        this.syncDue(task)
        continue
      }
      if (now < dueAt) continue
      // 先推进下次时间再触发：长跑任务与慢请求都不会被重复排上
      const next = task.spec.kind === 'once' ? null : nextAt(task.spec, Date.now())
      this.deps.repos.schedule.setNextRun(task.id, next)
      this.syncDue({ ...task, nextRunAt: next })
      void this.fire(task, {})
    }
  }

  private async fire(
    task: ScheduleTask,
    opts: { manual?: boolean; misfire?: number },
  ): Promise<string | null> {
    if (!opts.manual && this.active.has(task.id)) {
      if (task.overlap === 'parallel') return this.execute(task, opts)
      if (task.overlap === 'queue') {
        const q = this.queued.get(task.id) ?? 0
        if (q >= MAX_QUEUE) {
          log.warn(`任务「${task.name}」排队已满，本次跳过`)
          return null
        }
        this.queued.set(task.id, q + 1)
        return null
      }
      log.warn(`任务「${task.name}」上次仍在运行，本次按 skip 跳过`)
      return null
    }
    return this.execute(task, opts)
  }

  private async execute(
    task: ScheduleTask,
    opts: { manual?: boolean; misfire?: number },
  ): Promise<string | null> {
    const cancelId = `task:${task.id}:${Date.now().toString(36)}`
    const ranAt = Date.now()
    this.beginRun(task.id, cancelId)
    let runId: string | null = null
    try {
      const started = await this.deps.runner.start({
        scopeType: task.targetType,
        scopeId: task.targetId,
        envId: task.envId,
        cancelId,
      })
      runId = started.runId
      await this.deps.runner.whenDone(runId)
      const run = this.deps.repos.runner.get(runId)
      if (!run) throw new Error('运行记录未落库')
      // 单次任务跑完自动停用，避免下次启动又被 misfire 补跑
      const finished = this.deps.repos.schedule.markRun({
        id: task.id,
        runId,
        failed: run.failed,
        ranAt,
        enabled: task.spec.kind === 'once' ? false : task.enabled,
      })
      this.syncDue(finished)
      this.reportAndNotify(task, run, opts)
      return runId
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.deps.notify.publish({
        type: 'task.finished',
        level: 'error',
        title: `任务「${task.name}」启动失败`,
        body: message,
        sourceType: 'schedule_task',
        sourceId: task.id,
        force: true,
      })
      // 目标被删除或范围为空时停用它，否则每秒都会失败一次
      const finished = this.deps.repos.schedule.markRun({
        id: task.id,
        runId: null,
        failed: null,
        ranAt,
        enabled: false,
      })
      this.syncDue(finished)
      return runId
    } finally {
      this.endRun(task.id, cancelId)
      this.drain(task.id)
    }
  }

  /** 完成汇报：通过率进标题，失败明细与报告路径进正文（15 号文档 §1） */
  private reportAndNotify(task: ScheduleTask, run: RunnerRun, opts: { misfire?: number }): void {
    const failed = run.failed
    const reportPath =
      task.notify.report === 'none' ? null : writeReport(this.deps.files, run, task.notify.report)
    const broken = run.items
      .filter((i) => i.status === 'failed' || i.status === 'error')
      .slice(0, 3)
    const seconds = run.finishedAt
      ? `${((run.finishedAt - run.startedAt) / 1000).toFixed(1)}s`
      : '—'
    const body = [
      opts.misfire ? `补跑错过的 ${opts.misfire} 次触发中的最近一次` : '',
      broken.length > 0
        ? `失败：${broken.map((i) => `${i.apiName}(${i.error ?? i.status})`).join('、')}`
        : `全部通过 · 耗时 ${seconds}`,
      reportPath ? `报告：${reportPath}` : '',
    ]
      .filter((line) => line !== '')
      .join('；')

    const wanted = failed === 0 ? task.notify.onSuccess : task.notify.onFail
    if (wanted) {
      this.deps.notify.publish({
        type: 'task.finished',
        level: failed > 0 ? 'warn' : 'info',
        title: `${task.name}：${run.passed}/${run.total} 通过`,
        body,
        sourceType: 'schedule_task',
        sourceId: task.id,
        stateKey: `task:${task.id}`,
        state: failed > 0 ? 'fail' : 'ok',
      })
    }
  }

  private beginRun(taskId: string, cancelId: string): void {
    const set = this.active.get(taskId) ?? new Set<string>()
    set.add(cancelId)
    this.active.set(taskId, set)
    this.emitState(taskId)
  }

  private endRun(taskId: string, cancelId: string): void {
    const set = this.active.get(taskId)
    if (!set) return
    set.delete(cancelId)
    if (set.size === 0) this.active.delete(taskId)
    this.emitState(taskId)
  }

  private drain(taskId: string): void {
    const waiting = this.queued.get(taskId) ?? 0
    if (waiting <= 0) return
    this.queued.set(taskId, waiting - 1)
    const task = this.deps.repos.schedule.get(taskId)
    if (task && task.enabled) void this.fire(task, {})
  }

  private emitState(taskId: string): void {
    const task = this.deps.repos.schedule.get(taskId)
    if (!task) return
    this.deps.emit('event:task-state', {
      taskId,
      running: this.active.has(taskId),
      nextRunAt: task.nextRunAt,
      lastRunAt: task.lastRunAt,
      lastRunId: task.lastRunId,
      lastFailed: task.lastFailed,
    })
  }
}

// @author yxpil
import type { AssertionResult, LogEntry } from '@shared/types'
import { IpcErrorRaised } from '@shared/types'
import type { EventName, EventPayload } from '@shared/channels'
import type { Repos } from '../db/repo'
import type { RunnerItem, RunnerItemStatus } from '../db/repo/runner.repo'
import type { RequestFlow } from './request'
import type { CancelRegistry } from '../infra/cancel-registry'

export interface RunnerStartInput {
  scopeType: 'collection' | 'api' | 'project'
  scopeId: string
  envId?: string | null
  cancelId: string
  stopOnFail?: boolean
  delayMs?: number
  /** 数据行；未给 iterationCount 时迭代次数等于行数（23 号文档 §5.1） */
  iterationData?: Record<string, string>[]
  iterationCount?: number
  timeoutMs?: number
}

export interface RunnerDeps {
  repos: Repos
  flow: RequestFlow
  cancel: CancelRegistry
  emit: <K extends EventName>(channel: K, payload: EventPayload<K>) => void
}

interface ProgressEvent {
  runId: string
  item: RunnerItem
  finished: boolean
}

interface Target {
  id: string
  name: string
}

/** 集合内接口的执行顺序：集合自身接口 → 子集合递归（05 号文档 §5 模式 B） */
const collectApiIds = (deps: RunnerDeps, rootId: string): Target[] => {
  const collections = deps.repos.collection.listByProject(
    deps.repos.collection.get(rootId)?.projectId ?? '',
  )
  const childrenOf = new Map<string, string[]>()
  for (const c of collections) {
    const key = c.parentId ?? ''
    const bucket = childrenOf.get(key)
    if (bucket) bucket.push(c.id)
    else childrenOf.set(key, [c.id])
  }

  const out: Target[] = []
  const visit = (collectionId: string): void => {
    for (const api of deps.repos.api.listByCollection(collectionId))
      out.push({ id: api.id, name: api.name })
    for (const child of childrenOf.get(collectionId) ?? []) visit(child)
  }
  visit(rootId)
  return out
}

/** 项目范围：按根集合顺序逐个递归（CLI `toapi run --project`） */
const collectProject = (deps: RunnerDeps, projectId: string): Target[] =>
  deps.repos.collection
    .listByProject(projectId)
    .filter((c) => (c.parentId ?? '') === '')
    .flatMap((root) => collectApiIds(deps, root.id))

const verdict = (
  assertions: AssertionResult[],
  status: number,
  skipped: boolean,
): { status: RunnerItemStatus; error: string | null } => {
  if (skipped) return { status: 'skipped', error: null }
  const failed = assertions.filter((a) => !a.pass)
  if (failed.length > 0)
    return { status: 'failed', error: failed.map((f) => `${f.name}: ${f.error}`).join('; ') }
  if (status >= 400) return { status: 'failed', error: `HTTP ${status}` }
  return { status: 'passed', error: null }
}

export class RunnerFlow {
  private readonly active = new Map<string, { stop: boolean }>()
  private readonly pending = new Map<string, Promise<void>>()

  constructor(private readonly deps: RunnerDeps) {}

  async start(input: RunnerStartInput): Promise<{ runId: string; total: number }> {
    const { repos } = this.deps

    let targets: Target[]
    let scopeName: string
    let envProjectId: string

    if (input.scopeType === 'api') {
      const api = repos.api.get(input.scopeId)
      if (!api) throw new IpcErrorRaised({ code: 'NOT_FOUND', message: '接口不存在' })
      const collection = repos.collection.get(api.collectionId)
      targets = [{ id: api.id, name: api.name }]
      scopeName = api.name
      envProjectId = collection?.projectId ?? ''
    } else if (input.scopeType === 'project') {
      const project = repos.project.get(input.scopeId)
      if (!project) throw new IpcErrorRaised({ code: 'NOT_FOUND', message: '项目不存在' })
      targets = collectProject(this.deps, project.id)
      scopeName = project.name
      envProjectId = project.id
    } else {
      const collection = repos.collection.get(input.scopeId)
      if (!collection) throw new IpcErrorRaised({ code: 'NOT_FOUND', message: '集合不存在' })
      targets = collectApiIds(this.deps, collection.id)
      scopeName = collection.name
      envProjectId = collection.projectId
    }

    if (targets.length === 0) {
      throw new IpcErrorRaised({ code: 'VALIDATION', message: '该范围内没有接口' })
    }

    const rows = input.iterationData ?? []
    const iterationCount = input.iterationCount ?? (rows.length > 0 ? rows.length : 1)
    const total = targets.length * iterationCount

    const envId =
      input.envId !== undefined
        ? input.envId
        : (repos.environment.activeFor(envProjectId)?.id ?? null)
    const { id: runId } = repos.runner.startRun({
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      scopeName,
      envId,
      total,
      iterationCount,
    })

    const state = { stop: false }
    this.active.set(runId, state)

    const loop = this.loop({ runId, targets, rows, iterationCount, input, state, envProjectId })
    this.pending.set(runId, loop)
    void loop.catch(() => undefined)
    return { runId, total }
  }

  cancel(runId: string): void {
    const state = this.active.get(runId)
    if (state) state.stop = true
    this.deps.cancel.abort(`runner:${runId}`)
  }

  /** CLI 等待一次运行结束；UI 路径靠进度事件，不需要它 */
  whenDone(runId: string): Promise<void> | undefined {
    return this.pending.get(runId)
  }

  private async loop(args: {
    runId: string
    targets: Target[]
    rows: Record<string, string>[]
    iterationCount: number
    input: RunnerStartInput
    state: { stop: boolean }
    envProjectId: string
  }): Promise<void> {
    const { repos } = this.deps
    const { runId, targets, rows, iterationCount, input, state, envProjectId } = args
    let passed = 0
    let failed = 0
    let skipped = 0
    let lastSeq = 0

    const tally = (item: RunnerItem): RunnerItem => {
      const saved = repos.runner.addItem(item)
      if (saved.status === 'passed') passed += 1
      else if (saved.status === 'skipped') skipped += 1
      else failed += 1
      this.deps.emit('event:runner-progress', { runId, item: saved, finished: false })
      return saved
    }

    // 每次运行前清运行时变量，避免上次结果泄漏（07 号文档 §2.4）
    this.deps.flow.clearSession(envProjectId)

    for (let iteration = 1; iteration <= iterationCount; iteration += 1) {
      if (state.stop) break
      const row = rows.length > 0 ? rows[(iteration - 1) % rows.length] : undefined
      // setNextRequest 可反复跳回同一接口，用步数上限兜底
      const maxSteps = targets.length * 20 + 20
      let seq = 0
      let steps = 0
      let index = 0

      while (index < targets.length && !state.stop) {
        if (steps > maxSteps) {
          const target = targets[index]!
          tally({
            id: '',
            runId,
            apiId: target.id,
            apiName: target.name,
            status: 'error',
            historyId: null,
            timeMs: 0,
            assertions: [],
            logs: [],
            error: 'pm.execution.setNextRequest 跳转次数超过上限，已终止本轮迭代',
            sortOrder: seq,
            iteration,
          })
          break
        }

        const target = targets[index]!
        const startedAt = Date.now()
        let item: RunnerItem
        let jumpTo: number | null = null
        let endIteration = false

        try {
          const result = await this.deps.flow.send({
            apiId: target.id,
            // 未显式指定环境时不能传 null，否则会把项目激活环境顶掉
            ...(input.envId !== undefined ? { envId: input.envId } : {}),
            cancelId: `runner:${runId}`,
            ...(row ? { iterationData: row } : {}),
            iteration,
            iterationCount,
            runner: true,
            ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
          })
          const call = verdict(result.script.assertions, result.response.status, result.skipped)
          item = {
            id: '',
            runId,
            apiId: target.id,
            apiName: target.name,
            status: call.status,
            historyId: result.historyId || null,
            timeMs: result.response.timeMs,
            assertions: result.script.assertions,
            logs: [...result.script.preLogs, ...result.script.postLogs],
            error: call.error,
            sortOrder: seq,
            iteration,
          }

          // setNextRequest：字符串按名称/ID 跳转，null 结束本轮，未知名同样结束（Postman 语义）
          if (result.nextRequest === null) endIteration = true
          else if (typeof result.nextRequest === 'string') {
            const jump = targets.findIndex(
              (t) => t.name === result.nextRequest || t.id === result.nextRequest,
            )
            if (jump === -1) endIteration = true
            else jumpTo = jump
          }
        } catch (e) {
          const message = e instanceof IpcErrorRaised ? e.payload.message : (e as Error).message
          item = {
            id: '',
            runId,
            apiId: target.id,
            apiName: target.name,
            status: 'error',
            historyId: null,
            timeMs: Date.now() - startedAt,
            assertions: [],
            logs: [],
            error: message,
            sortOrder: seq,
            iteration,
          }
        }

        const saved = tally(item)
        seq += 1
        steps += 1
        lastSeq = seq

        if (input.stopOnFail && saved.status !== 'passed' && saved.status !== 'skipped') {
          state.stop = true
        }
        if (endIteration) break
        if (input.delayMs && input.delayMs > 0 && !state.stop) {
          await new Promise((r) => setTimeout(r, input.delayMs))
        }
        index = jumpTo ?? index + 1
      }
    }

    repos.runner.finishRun({ runId, passed, failed, skipped, report: { passed, failed, skipped } })
    this.active.delete(runId)
    this.pending.delete(runId)
    this.deps.emit('event:runner-progress', {
      runId,
      item: {
        id: `${runId}:summary`,
        runId,
        apiId: null,
        apiName: `完成：${passed} 通过 / ${failed} 失败 / ${skipped} 跳过`,
        status: failed === 0 ? 'passed' : 'failed',
        historyId: null,
        timeMs: 0,
        assertions: [] as AssertionResult[],
        logs: [] as LogEntry[],
        error: null,
        sortOrder: lastSeq,
        iteration: iterationCount,
      },
      finished: true,
    } satisfies ProgressEvent)
  }
}

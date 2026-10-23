import type { AssertionResult, LogEntry } from '@shared/types'
import { IpcErrorRaised } from '@shared/types'
import type { EventName, EventPayload } from '@shared/channels'
import type { Repos } from '../db/repo'
import type { RunnerItem, RunnerItemStatus } from '../db/repo/runner.repo'
import type { RequestFlow } from './request'
import type { CancelRegistry } from '../infra/cancel-registry'

export interface RunnerStartInput {
  scopeType: 'collection' | 'api'
  scopeId: string
  envId?: string | null
  cancelId: string
  stopOnFail?: boolean
  delayMs?: number
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

/** 集合内接口的执行顺序：集合自身接口 → 子集合递归（05 号文档 §5 模式 B） */
const collectApiIds = (deps: RunnerDeps, rootId: string): { id: string; name: string }[] => {
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

  const out: { id: string; name: string }[] = []
  const visit = (collectionId: string): void => {
    for (const api of deps.repos.api.listByCollection(collectionId))
      out.push({ id: api.id, name: api.name })
    for (const child of childrenOf.get(collectionId) ?? []) visit(child)
  }
  visit(rootId)
  return out
}

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

  constructor(private readonly deps: RunnerDeps) {}

  async start(input: RunnerStartInput): Promise<{ runId: string; total: number }> {
    const { repos } = this.deps

    let targets: { id: string; name: string }[]
    let scopeName: string
    let envProjectId: string

    if (input.scopeType === 'api') {
      const api = repos.api.get(input.scopeId)
      if (!api) throw new IpcErrorRaised({ code: 'NOT_FOUND', message: '接口不存在' })
      const collection = repos.collection.get(api.collectionId)
      targets = [{ id: api.id, name: api.name }]
      scopeName = api.name
      envProjectId = collection?.projectId ?? ''
    } else {
      const collection = repos.collection.get(input.scopeId)
      if (!collection) throw new IpcErrorRaised({ code: 'NOT_FOUND', message: '集合不存在' })
      targets = collectApiIds(this.deps, collection.id)
      scopeName = collection.name
      envProjectId = collection.projectId
    }

    if (targets.length === 0) {
      throw new IpcErrorRaised({ code: 'VALIDATION', message: '该集合下没有接口' })
    }

    const envId =
      input.envId !== undefined
        ? input.envId
        : (repos.environment.activeFor(envProjectId)?.id ?? null)
    const { id: runId } = repos.runner.startRun({
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      scopeName,
      envId,
      total: targets.length,
    })

    const state = { stop: false }
    this.active.set(runId, state)

    void this.loop({ runId, targets, input, state, envProjectId })
    return { runId, total: targets.length }
  }

  cancel(runId: string): void {
    const state = this.active.get(runId)
    if (state) state.stop = true
    this.deps.cancel.abort(`runner:${runId}`)
  }

  private async loop(args: {
    runId: string
    targets: { id: string; name: string }[]
    input: RunnerStartInput
    state: { stop: boolean }
    envProjectId: string
  }): Promise<void> {
    const { repos } = this.deps
    const { runId, targets, input, state, envProjectId } = args
    let passed = 0
    let failed = 0
    let skipped = 0

    // 每次运行前清运行时变量，避免上次结果泄漏（07 号文档 §2.4）
    this.deps.flow.clearSession(envProjectId)

    for (const [index, target] of targets.entries()) {
      if (state.stop) break
      const startedAt = Date.now()
      let item: RunnerItem

      try {
        const result = await this.deps.flow.send({
          apiId: target.id,
          // 未显式指定环境时不能传 null，否则会把项目激活环境顶掉
          ...(input.envId !== undefined ? { envId: input.envId } : {}),
          cancelId: `runner:${runId}`,
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
          sortOrder: index,
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
          sortOrder: index,
        }
      }

      const saved = repos.runner.addItem(item)
      if (saved.status === 'passed') passed += 1
      else if (saved.status === 'skipped') skipped += 1
      else failed += 1

      this.deps.emit('event:runner-progress', {
        runId,
        item: saved,
        finished: false,
      } satisfies ProgressEvent)

      if (input.stopOnFail && saved.status !== 'passed' && saved.status !== 'skipped') {
        state.stop = true
      }
      if (input.delayMs && input.delayMs > 0 && !state.stop) {
        await new Promise((r) => setTimeout(r, input.delayMs))
      }
    }

    repos.runner.finishRun({ runId, passed, failed, skipped, report: { passed, failed, skipped } })
    this.active.delete(runId)
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
        sortOrder: targets.length,
      },
      finished: true,
    } satisfies ProgressEvent)
  }
}

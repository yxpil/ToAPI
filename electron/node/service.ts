// @author yxpil
import { createHash } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import type {
  AddNodeInput,
  NodeCallLogView,
  NodeListItem,
  NodeProbe,
  NodePullInput,
  NodePushInput,
  NodeRunInput,
  NodeRunStatus,
  NodeSelfView,
  NodeTree,
  TapiImportResult,
  UpdateNodeInput,
} from '@shared/channels'
import { IpcErrorRaised } from '@shared/types'
import type { Repos } from '../db/repo'
import { toView, type NodeRow } from '../db/repo/node.repo'
import type { RunnerFlow } from '../flow/runner'
import type { NotifyService } from '../notify/service'
import type { OpenConfig } from '../open/config'
import type { TapiService } from '../tapi/service'
import { buildTapi } from '../tapi/export'
import { ulid } from '../infra/id'
import { createLogger } from '../infra/logger'
import { NodeClient, pair } from './client'
import { NodeServer } from './server'
import { fingerprintOf } from './channel'
import type { EventName, EventPayload } from '@shared/channels'

/**
 * 局域网节点（24 号文档）：本机保存配对结果与信道密钥，
 * 对外提供探活/互传/代为测试；同时作为被连一方的协议处理者。
 */

const log = createLogger('node')
const DEFAULT_PORT = 4730
const SELF_KEY = 'node.self'
/** 代为测试的轮询上限：超过就按"节点无响应"收尾，不无限等 */
const RUN_WAIT_MS = 10 * 60_000
const RUN_POLL_START_MS = 1000
const RUN_POLL_MAX_MS = 5000

export interface NodeServiceDeps {
  repos: Repos
  runner: RunnerFlow
  notify: NotifyService
  config: OpenConfig
  /** 监听是否真的起来了：配置开了但端口被占时不算"可被配对" */
  isOpenRunning: () => boolean
  /** 互传复用 TapiService，走同一套 checksum 与版本闸门（08 号文档 §5） */
  tapi: TapiService
  appVersion: string
  emit: <K extends EventName>(channel: K, payload: EventPayload<K>) => void
  fetchImpl?: typeof fetch
}

const bad = (message: string): never => {
  throw new IpcErrorRaised({ code: 'VALIDATION', message })
}

const denied = (message: string): never => {
  throw new IpcErrorRaised({ code: 'FORBIDDEN', message })
}

const normalizeHost = (input: string): string => {
  const raw = input
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
  if (raw === '') bad('请填写目标主机 IP 或主机名')
  return raw
}

/** 项目"看起来是否一致"的摘要：只用于互传前的差异提示，不作冲突判定依据（§3） */
const projectHash = (repos: Repos, projectId: string): string => {
  const parts: string[] = []
  for (const c of repos.collection.listByProject(projectId)) parts.push(`c:${c.id}:${c.updatedAt}`)
  for (const a of repos.collection
    .listByProject(projectId)
    .flatMap((c) => repos.api.listByCollection(c.id)))
    parts.push(`a:${a.id}:${a.updatedAt}`)
  return createHash('sha256').update(parts.sort().join('|'), 'utf8').digest('hex').slice(0, 12)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 本机局域网 IPv4：配对信息要给用户念出来，回环与 IPv6 不算 */
function lanAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address)
    }
  }
  return [...new Set(out)].sort()
}

export class NodeService {
  private readonly runOps = new Map<string, string>()
  private server: NodeServer | null = null

  constructor(private readonly deps: NodeServiceDeps) {}

  // ── 本机身份 ──

  selfDeviceId(): string {
    const stored = this.deps.repos.settings.get<{ deviceId?: string }>(SELF_KEY, {})
    if (typeof stored.deviceId === 'string' && stored.deviceId !== '') return stored.deviceId
    const deviceId = ulid()
    this.deps.repos.settings.set(SELF_KEY, { deviceId })
    return deviceId
  }

  /** 本机作为被配对一方的对外信息：界面把它念给对方核对（§2.1 第 1 步） */
  selfView(): NodeSelfView {
    const key = this.deps.config.nodeKey()
    const view = this.deps.config.view()
    return {
      deviceId: this.selfDeviceId(),
      fingerprint: key === null ? null : fingerprintOf(key),
      pairable: view.enabled && key !== null && this.deps.isOpenRunning(),
      running: this.deps.isOpenRunning(),
      access: view.access,
      port: view.port,
      addresses: lanAddresses(),
    }
  }

  /** 节点调用留痕：出站按本机记录的节点名，入站显示对端 deviceId（§9） */
  callLog(limit = 30): NodeCallLogView[] {
    const names = new Map(this.deps.repos.node.list().map((n) => [n.id, n.name]))
    return this.deps.repos.node.recentLog(limit).map((row): NodeCallLogView => ({
      id: row.id,
      nodeId: row.nodeId,
      nodeName: names.get(row.nodeId) ?? (row.nodeId === '' ? '入站' : '（已解除配对）'),
      peer: row.peer,
      direction: row.nodeId === '' ? 'in' : 'out',
      action: row.action,
      ok: row.ok,
      errorCode: row.errorCode,
      timeMs: row.timeMs,
      items: row.items,
      createdAt: row.createdAt,
    }))
  }

  /** 本机作为被连一方的探活信息：项目摘要 + 是否忙 */
  localProbe(): NodeProbe {
    const busy = this.deps.runner.isBusy()
    return {
      deviceId: this.selfDeviceId(),
      version: this.deps.appVersion,
      platform: process.platform,
      protocol: 1,
      busy,
      projects: this.deps.repos.project.list().map((p) => ({
        id: p.id,
        name: p.name,
        hash: projectHash(this.deps.repos, p.id),
        apis: this.deps.repos.collection
          .listByProject(p.id)
          .reduce((sum, c) => sum + this.deps.repos.api.listByCollection(c.id).length, 0),
      })),
    }
  }

  localPull(projectId: string): { content: string; apis: number; collections: number } {
    const { file, stats } = buildTapi(this.deps.repos, {
      projectId,
      secrets: 'strip',
      appVersion: this.deps.appVersion,
    })
    return {
      content: JSON.stringify(file, null, 2),
      apis: stats.apis,
      collections: stats.collections,
    }
  }

  localPush(input: {
    content: string
    mode: 'new' | 'into'
    targetProjectId?: string
    apiConflict?: 'skip' | 'overwrite' | 'duplicate'
  }): { projectId: string; projectName: string; imported: unknown } {
    const result = this.deps.tapi.import({
      content: input.content,
      mode: input.mode,
      ...(input.targetProjectId ? { targetProjectId: input.targetProjectId } : {}),
      ...(input.apiConflict ? { apiConflict: input.apiConflict } : {}),
    })
    log.info(
      `收到节点推送项目「${result.projectName}」，导入 ${String(result.imported.apis)} 个接口`,
    )
    return {
      projectId: result.projectId,
      projectName: result.projectName,
      imported: result.imported,
    }
  }

  /** 远端可跑的东西：集合与环境都按对端真实数据回，避免本机凭猜测下发 */
  localTree(projectId: string): NodeTree {
    if (this.deps.repos.project.get(projectId) === null) {
      throw new IpcErrorRaised({ code: 'NOT_FOUND', message: '该项目不在本机' })
    }
    return {
      collections: this.deps.repos.collection.listByProject(projectId).map((c) => ({
        id: c.id,
        name: c.name,
        apis: this.deps.repos.api.listByCollection(c.id).length,
      })),
      envs: this.deps.repos.environment
        .listByProject(projectId)
        .map((e) => ({ id: e.id, name: e.name })),
    }
  }

  async localRun(input: {
    scopeType: 'collection' | 'project' | 'api'
    scopeId: string
    envId?: string | null
    opId: string
  }): Promise<{ runId: string; total: number }> {
    const existing = this.runOps.get(input.opId)
    if (existing) return { runId: existing, total: 0 }
    const started = await this.deps.runner.start({
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      ...(input.envId === undefined ? {} : { envId: input.envId }),
      cancelId: `node:${input.opId}`,
    })
    this.runOps.set(input.opId, started.runId)
    return started
  }

  localRunGet(runId: string): NodeRunStatus {
    const run = this.deps.repos.runner.get(runId)
    if (!run) throw new IpcErrorRaised({ code: 'NOT_FOUND', message: '运行记录不存在' })
    return {
      runId: run.id,
      finished: run.finishedAt !== null,
      total: run.total,
      passed: run.passed,
      failed: run.failed,
      skipped: run.skipped,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      items: run.items.map((i) => ({
        apiName: i.apiName,
        status: i.status,
        timeMs: i.timeMs,
        iteration: i.iteration,
        error: i.error,
      })),
    }
  }

  /** 被连一方的协议处理者 */
  nodeServer(): NodeServer {
    if (this.server) return this.server
    this.server = new NodeServer({
      config: this.deps.config,
      deviceId: () => this.selfDeviceId(),
      platform: () => process.platform,
      appVersion: () => this.deps.appVersion,
      probe: () => this.localProbe(),
      pull: (projectId) => this.localPull(projectId),
      push: (input) => this.localPush(input),
      run: (input) => this.localRun(input),
      runGet: (runId) => this.localRunGet(runId),
      tree: (projectId) => this.localTree(projectId),
      runCancel: (runId) => this.deps.runner.cancel(runId),
      audit: (entry) => {
        this.deps.repos.node.log({
          nodeId: '',
          peer: entry.peer === '' ? entry.ip : entry.peer,
          action: entry.action,
          ok: entry.ok,
          ...(entry.errorCode === undefined ? {} : { errorCode: entry.errorCode }),
          timeMs: entry.timeMs,
        })
        log.info(
          `入站节点调用 ${entry.action} → ${entry.ok ? 'ok' : (entry.errorCode ?? 'fail')}（${entry.peer || entry.ip}）`,
        )
      },
    })
    return this.server
  }

  // ── 节点 CRUD 与调用 ──

  private require(id: string): NodeRow {
    const node = this.deps.repos.node.get(id)
    if (!node) throw new IpcErrorRaised({ code: 'NOT_FOUND', message: '节点不存在' })
    return node
  }

  private client(node: NodeRow): NodeClient {
    if (node.channelKey === '') denied('节点尚未完成配对')
    return new NodeClient(
      {
        base: `http://${node.host}:${node.port}`,
        deviceId: node.deviceId,
        key: Buffer.from(node.channelKey, 'hex'),
        epoch: node.epoch,
        nextSeq: () => this.deps.repos.node.nextSeq(node.id),
      },
      this.selfDeviceId(),
      { fetchImpl: this.deps.fetchImpl },
    )
  }

  /** 写操作（push/run）要求指纹已锁定且未变化（§2.1 第 4 步） */
  private requireTrusted(node: NodeRow): void {
    if (!node.enabled) denied(`节点「${node.name}」已停用`)
    if (node.fingerprint === '' || node.fingerprint !== node.confirmedFingerprint) {
      denied(
        `节点「${node.name}」的指纹未确认或与上次不一致：请先在界面上核对指纹，口令变更需重新配对`,
      )
    }
  }

  async list(): Promise<NodeListItem[]> {
    const nodes = this.deps.repos.node.list()
    return Promise.all(
      nodes.map(async (node) => ({
        ...toView(node),
        probe: node.enabled ? await this.probeQuiet(node) : null,
      })),
    )
  }

  private async probeQuiet(node: NodeRow): Promise<NodeProbe | null> {
    if (node.channelKey === '') return null
    try {
      const probe = await this.client(node).state()
      this.deps.repos.node.markSeen(node.id)
      return probe
    } catch (e) {
      this.deps.repos.node.markFailed(node.id, (e as Error).message)
      return null
    }
  }

  async add(input: AddNodeInput): Promise<NodeListItem> {
    const host = normalizeHost(input.host)
    const port = input.port ?? DEFAULT_PORT
    const paired = await pair({
      base: `http://${host}:${port}`,
      password: input.password,
      selfDeviceId: this.selfDeviceId(),
      ...(this.deps.fetchImpl ? { deps: { fetchImpl: this.deps.fetchImpl } } : {}),
    })
    const created = this.deps.repos.node.create({
      name: input.name.trim() === '' ? paired.probe.deviceId : input.name.trim(),
      host,
      port,
      labels: input.labels ?? [],
      channelKey: paired.key.toString('hex'),
      fingerprint: paired.fingerprint,
      deviceId: paired.hello.deviceId,
      epoch: paired.epoch,
      seq: paired.seq,
    })
    this.deps.emit('event:node-state', {
      nodeId: created.id,
      state: 'paired',
      detail: `已配对 ${host}:${port}，请核对指纹`,
      runId: null,
    })
    return { ...toView(created), probe: paired.probe }
  }

  async update(input: UpdateNodeInput): Promise<NodeListItem> {
    const current = this.require(input.id)
    const host = input.host === undefined ? current.host : normalizeHost(input.host)
    const port = input.port ?? current.port
    let next = this.deps.repos.node.update(input.id, {
      ...(input.name === undefined ? {} : { name: input.name }),
      host,
      port,
      ...(input.labels === undefined ? {} : { labels: input.labels }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    })
    if (input.password !== undefined && input.password.trim() !== '') {
      const paired = await pair({
        base: `http://${host}:${port}`,
        password: input.password,
        selfDeviceId: this.selfDeviceId(),
        ...(this.deps.fetchImpl ? { deps: { fetchImpl: this.deps.fetchImpl } } : {}),
      })
      next = this.deps.repos.node.setChannel(
        input.id,
        paired.key.toString('hex'),
        paired.fingerprint,
        paired.hello.deviceId,
        paired.epoch,
        paired.seq,
      )
      return { ...toView(next), probe: paired.probe }
    }
    return { ...toView(next), probe: await this.probeQuiet(next) }
  }

  remove(id: string): void {
    this.require(id)
    this.deps.repos.node.remove(id)
  }

  async probe(id: string): Promise<NodeProbe> {
    const node = this.require(id)
    const probe = await this.probeQuiet(node)
    if (!probe) throw new IpcErrorRaised({ code: 'NETWORK', message: `节点「${node.name}」不可达` })
    return probe
  }

  confirm(id: string): NodeListItem {
    const node = this.require(id)
    if (node.fingerprint === '') denied('节点还没有学到指纹，请先探活')
    return { ...toView(this.deps.repos.node.confirm(id)), probe: null }
  }

  async pull(input: NodePullInput): Promise<TapiImportResult> {
    const node = this.require(input.nodeId)
    this.requireTrusted(node)
    const started = Date.now()
    try {
      const packed = await this.client(node).pull(input.projectId)
      const result = this.deps.tapi.import({
        content: packed.content,
        mode: input.mode,
        ...(input.targetProjectId ? { targetProjectId: input.targetProjectId } : {}),
        ...(input.apiConflict ? { apiConflict: input.apiConflict } : {}),
      })
      this.deps.repos.node.log({
        nodeId: node.id,
        action: 'pull',
        ok: true,
        timeMs: Date.now() - started,
        items: result.imported.apis,
      })
      return result
    } catch (e) {
      this.deps.repos.node.log({
        nodeId: node.id,
        action: 'pull',
        ok: false,
        errorCode: e instanceof IpcErrorRaised ? e.payload.code : 'INTERNAL',
        timeMs: Date.now() - started,
      })
      throw e
    }
  }

  async push(input: NodePushInput): Promise<{ imported: number; message: string }> {
    const node = this.require(input.nodeId)
    this.requireTrusted(node)
    const started = Date.now()
    const packed = buildTapi(this.deps.repos, {
      projectId: input.projectId,
      secrets: 'strip',
      appVersion: this.deps.appVersion,
    })
    try {
      const result = await this.client(node).push(JSON.stringify(packed.file, null, 2), {
        mode: 'new',
        ...(input.apiConflict ? { apiConflict: input.apiConflict } : {}),
      })
      this.deps.repos.node.log({
        nodeId: node.id,
        action: 'push',
        ok: true,
        timeMs: Date.now() - started,
        items: packed.stats.apis,
      })
      return {
        imported: packed.stats.apis,
        message: `已推送到「${node.name}」，导入为项目「${result.projectName}」；密钥未跨机`,
      }
    } catch (e) {
      this.deps.repos.node.log({
        nodeId: node.id,
        action: 'push',
        ok: false,
        errorCode: e instanceof IpcErrorRaised ? e.payload.code : 'INTERNAL',
        timeMs: Date.now() - started,
      })
      throw e
    }
  }

  /** 代为测试：远端跑，本地轮询并把结果落成一份本机运行记录 + 通知（§4） */
  async run(input: NodeRunInput): Promise<{ runId: string }> {
    const node = this.require(input.nodeId)
    this.requireTrusted(node)
    const opId = ulid()
    const started = await this.client(node).run({
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      envId: input.envId ?? null,
      opId,
    })
    void this.watchRun(node, started.runId).catch((e: Error) => {
      log.error(`跟踪远端运行失败：${e.message}`)
      this.deps.repos.node.markFailed(node.id, e.message)
    })
    return { runId: started.runId }
  }

  private async watchRun(node: NodeRow, runId: string): Promise<void> {
    const client = this.client(node)
    const deadline = Date.now() + RUN_WAIT_MS
    let backoff = RUN_POLL_START_MS
    let status: NodeRunStatus | null = null
    this.deps.emit('event:node-state', {
      nodeId: node.id,
      state: 'busy',
      detail: '远端运行中',
      runId,
    })
    while (Date.now() < deadline) {
      await sleep(backoff)
      backoff = Math.min(backoff * 2, RUN_POLL_MAX_MS)
      status = await client.runGet(runId)
      if (status.finished) break
    }
    if (!status || !status.finished) {
      this.deps.repos.node.markFailed(node.id, '远端运行超时')
      this.deps.notify.publish({
        type: 'node.finished',
        level: 'error',
        title: `节点「${node.name}」运行超时`,
        body: '超过 10 分钟仍未回传结果，已停止等待；远端可能仍在继续运行',
        sourceType: 'node',
        sourceId: node.id,
        force: true,
      })
      this.deps.emit('event:node-state', {
        nodeId: node.id,
        state: 'error',
        detail: '运行超时',
        runId,
      })
      return
    }
    this.landRemoteRun(node, runId, status)
    this.deps.emit('event:node-state', {
      nodeId: node.id,
      state: 'idle',
      detail: `远端运行完成：${status.passed}/${status.total} 通过`,
      runId,
    })
  }

  /** 远端结果落成本机 runner_run（scope_type=remote），报告与通知都按本机口径走 */
  private landRemoteRun(node: NodeRow, runId: string, status: NodeRunStatus): void {
    const { repos } = this.deps
    const local = repos.runner.startRun({
      scopeType: 'remote',
      scopeId: `${node.id}:${runId}`,
      scopeName: `${node.name} · 代为测试`,
      envId: null,
      total: status.total,
      iterationCount: 1,
    })
    status.items.forEach((item, index) => {
      repos.runner.addItem({
        runId: local.id,
        apiId: null,
        apiName: item.apiName,
        status: item.status,
        historyId: null,
        timeMs: item.timeMs,
        assertions: [],
        logs: [],
        error: item.error,
        sortOrder: index,
        iteration: item.iteration || 1,
      })
    })
    repos.runner.finishRun({
      runId: local.id,
      passed: status.passed,
      failed: status.failed,
      skipped: status.skipped,
      report: {
        remote: { nodeId: node.id, nodeName: node.name, runId, host: `${node.host}:${node.port}` },
      },
    })
    repos.node.log({
      nodeId: node.id,
      action: 'run',
      ok: status.failed === 0,
      timeMs: (status.finishedAt ?? Date.now()) - status.startedAt,
      items: status.total,
    })
    this.deps.notify.publish({
      type: 'node.finished',
      level: status.failed > 0 ? 'warn' : 'info',
      title: `${node.name}：${status.passed}/${status.total} 通过`,
      body:
        status.failed > 0
          ? `失败：${status.items
              .filter((i) => i.status !== 'passed')
              .slice(0, 3)
              .map((i) => i.apiName)
              .join('、')}`
          : `远端 ${node.host}:${node.port} 全部通过`,
      sourceType: 'runner_run',
      sourceId: local.id,
      stateKey: `node:${node.id}`,
      state: status.failed > 0 ? 'fail' : 'ok',
    })
  }

  async tree(input: { nodeId: string; projectId: string }): Promise<NodeTree> {
    const node = this.require(input.nodeId)
    return this.client(node).tree(input.projectId)
  }

  async runCancel(input: { nodeId: string; runId: string }): Promise<void> {
    const node = this.require(input.nodeId)
    this.requireTrusted(node)
    await this.client(node).runCancel(input.runId)
  }

  async runGet(input: { nodeId: string; runId: string }): Promise<NodeRunStatus> {
    const node = this.require(input.nodeId)
    return this.client(node).runGet(input.runId)
  }
}

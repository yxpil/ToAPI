// @author yxpil
import { createHash, randomBytes } from 'node:crypto'
import type { IpcErrorCode } from '@shared/types'
import { IpcErrorRaised } from '@shared/types'
import type { OpenApprovalInput, OpenCallLogView, OpenConfigView } from '@shared/channels'
import type { Repos } from '../db/repo'
import type { RequestFlow } from '../flow/request'
import type { RunnerFlow } from '../flow/runner'
import { OpenConfig, type AuthorizedClient } from './config'
import { SecretMask } from './redact'
import { buildSkillFiles } from './skill'
import {
  OPEN_TOOLS,
  ToolInputError,
  declaredHosts,
  toolByName,
  validateParams,
  type ToolHosts,
} from './tools'

/** 开放通道统一入口：密码 → 客户端授权 → host 确认 → 执行 → 脱敏 → 审计（11 号文档 §0/§2.3） */

const APPROVAL_TIMEOUT_MS = 60_000
const HOST_SCOPE = 'host:'
const SKILL_PREVIEW_CHARS = 400

export interface CallMeta {
  channel: 'http' | 'mcp'
  /** 客户端标识：HTTP 取 X-Client-Name（缺省用对端地址哈希），MCP 取 initialize 上报名 */
  client: string
  clientName?: string
  /** 本会话内已被用户确认过的越界 host 由调用方带回，避免反复打扰 */
  allowedHosts?: string[]
}

export interface CallResult {
  ok: boolean
  data?: unknown
  error?: { code: IpcErrorCode; message: string }
  timeMs: number
}

export interface PendingApproval {
  clientId: string
  name: string
  kind: 'http' | 'mcp'
  detail: string
  skillPreview: string
  createdAt: number
}

export interface OpenServiceDeps {
  repos: Repos
  flow: RequestFlow
  runner: RunnerFlow
  appVersion: string
  newCancelId: () => string
  emit?: (channel: 'event:open-approval', payload: PendingApproval) => void
  /**
   * 无 GUI 模式（`toapi mcp` / CLI）没有授权条可弹：调用密码即用户授权，
   * 客户端首次连接直接记账放行；host 越界确认仍然必须拒绝（没人可问）。
   */
  headless?: boolean
}

class RateLimiter {
  private hits: number[] = []

  allow(limit: number): boolean {
    const now = Date.now()
    this.hits = this.hits.filter((t) => now - t < 60_000)
    if (this.hits.length >= limit) return false
    this.hits.push(now)
    return true
  }
}

interface Waiting {
  approval: PendingApproval
  settle: (ok: boolean) => void
}

const projectIdOf = (repos: Repos, input: Record<string, unknown>): string | null => {
  if (typeof input['projectId'] === 'string' && repos.project.get(input['projectId']))
    return input['projectId']
  if (typeof input['apiId'] === 'string') {
    const api = repos.api.get(input['apiId'])
    const collection = api ? repos.collection.get(api.collectionId) : null
    if (collection) return collection.projectId
  }
  if (typeof input['environmentId'] === 'string')
    return repos.environment.projectIdOf(input['environmentId'])
  if (typeof input['envId'] === 'string') return repos.environment.projectIdOf(input['envId'])
  if (
    typeof input['scopeId'] === 'string' &&
    (input['scopeType'] === 'project' || repos.project.get(input['scopeId']))
  )
    return input['scopeId']
  if (typeof input['scopeId'] === 'string') {
    const collection = repos.collection.get(input['scopeId'])
    if (collection) return collection.projectId
  }
  return null
}

export class OpenService {
  readonly config: OpenConfig
  private readonly hosts: ToolHosts
  private readonly limiter = new RateLimiter()
  private readonly waiting = new Map<string, Waiting>()
  private readonly waiters = new Map<string, ((ok: boolean) => void)[]>()
  /** 会话内已确认的 (client, host)，避免每次请求都弹条 */
  private readonly rememberedHosts = new Set<string>()
  private running = false
  private boundPort = 0

  constructor(private readonly deps: OpenServiceDeps) {
    this.config = new OpenConfig(deps.repos.settings)
    this.hosts = {
      repos: deps.repos,
      flow: deps.flow,
      runner: deps.runner,
      appVersion: deps.appVersion,
      newCancelId: deps.newCancelId,
    }
  }

  tools() {
    return OPEN_TOOLS.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      kind: t.kind,
      params: t.params,
    }))
  }

  setRunning(running: boolean, port = 0): void {
    this.running = running
    this.boundPort = port
  }

  view(): OpenConfigView {
    const v = this.config.view()
    return {
      ...v,
      running: this.running && this.config.isEnabled(),
      port: this.boundPort || v.port,
    }
  }

  clients(): ReturnType<OpenConfig['clients']> {
    return this.config.clients()
  }

  callLog(limit = 100): OpenCallLogView[] {
    return this.deps.repos.openLog.list(limit)
  }

  pendingApprovals(): PendingApproval[] {
    return [...this.waiting.values()].map((w) => w.approval)
  }

  static clientIdOf(name: string): string {
    return `c-${createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 16)}`
  }

  static randomSecret(): string {
    return randomBytes(32).toString('hex')
  }

  /** 首次授权时随附的 Skill 摘要，让用户知道会交出什么内容 */
  private skillPreview(): string {
    const first = this.deps.repos.project.list()[0]
    if (!first) return ''
    try {
      return (
        buildSkillFiles(this.deps.repos, first.id)[0]?.content.slice(0, SKILL_PREVIEW_CHARS) ?? ''
      )
    } catch {
      return ''
    }
  }

  private ask(approval: PendingApproval): Promise<boolean> {
    const key = approval.clientId
    const existing = this.waiting.get(key)
    if (existing) {
      return new Promise<boolean>((resolve) => {
        const list = this.waiters.get(key) ?? []
        list.push(resolve)
        this.waiters.set(key, list)
      })
    }
    this.deps.emit?.('event:open-approval', approval)
    return new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (ok: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.waiting.delete(key)
        resolve(ok)
        for (const waiter of this.waiters.get(key) ?? []) waiter(ok)
        this.waiters.delete(key)
      }
      const timer = setTimeout(() => finish(false), APPROVAL_TIMEOUT_MS)
      this.waiting.set(key, { approval, settle: finish })
    })
  }

  /** 用户在 GUI 点「允许 / 拒绝」；客户端授权与 host 确认共用此入口 */
  approvalResult(input: OpenApprovalInput): void {
    const found = this.waiting.get(input.clientId)
    if (!found) return
    if (input.approve && !input.clientId.startsWith(HOST_SCOPE)) {
      this.config.authorizeClient({
        id: input.clientId,
        name: found.approval.name,
        kind: found.approval.kind,
      })
    }
    found.settle(input.approve)
  }

  /** 闸门一：客户端授权。已授权直接过，首次连接挂起等待用户确认；无 GUI 时密码即授权 */
  private async gateClient(meta: CallMeta, toolTitle: string): Promise<AuthorizedClient> {
    const clientId = OpenService.clientIdOf(meta.client)
    const known = this.config.findClient(clientId)
    if (known) return known
    if (this.deps.headless) {
      return this.config.authorizeClient({
        id: clientId,
        name: meta.clientName || meta.client,
        kind: meta.channel,
      })
    }
    const approved = await this.ask({
      clientId,
      name: meta.clientName || meta.client,
      kind: meta.channel,
      detail: `客户端「${meta.clientName || meta.client}」（${meta.channel}）请求调用 ${toolTitle}`,
      skillPreview: this.skillPreview(),
      createdAt: Date.now(),
    })
    if (!approved)
      throw new IpcErrorRaised({ code: 'FORBIDDEN', message: '用户未授权该客户端，调用被拒绝' })
    return this.config.authorizeClient({
      id: clientId,
      name: meta.clientName || meta.client,
      kind: meta.channel,
    })
  }

  /** 闸门二：目标 host 必须在项目环境声明的清单内，否则逐次确认（会话内记住） */
  private async gateHost(meta: CallMeta, toolTitle: string, host: string): Promise<void> {
    if (meta.allowedHosts?.includes(host)) return
    const rememberKey = `${meta.client}\u0000${host}`
    if (this.rememberedHosts.has(rememberKey)) return
    if (this.deps.headless)
      throw new IpcErrorRaised({
        code: 'FORBIDDEN',
        message: `目标地址 ${host} 不在项目环境声明的 host 清单内；无界面模式下无法请求确认`,
      })
    const approved = await this.ask({
      clientId: `${HOST_SCOPE}${host}`,
      name: meta.clientName || meta.client,
      kind: meta.channel,
      detail: `${toolTitle} 想访问清单外的地址 ${host}`,
      skillPreview: '',
      createdAt: Date.now(),
    })
    if (!approved)
      throw new IpcErrorRaised({
        code: 'FORBIDDEN',
        message: `目标地址 ${host} 不在项目环境声明的 host 清单内，且用户未确认`,
      })
    this.rememberedHosts.add(rememberKey)
  }

  async invoke(
    toolName: string,
    params: unknown,
    meta: CallMeta,
    secret: string | null | undefined,
  ): Promise<CallResult> {
    const startedAt = Date.now()
    let mask = SecretMask.forProject(this.deps.repos)
    try {
      const tool = toolByName(toolName)
      if (!tool) throw new IpcErrorRaised({ code: 'VALIDATION', message: `未知工具 ${toolName}` })
      if (!this.config.isEnabled())
        throw new IpcErrorRaised({
          code: 'FORBIDDEN',
          message: '开放通道未启用或未设置调用密码（设置 → 开放调用）',
        })
      if (!this.config.verify(secret))
        throw new IpcErrorRaised({ code: 'FORBIDDEN', message: '调用密码缺失或不正确' })
      if (!this.limiter.allow(this.config.ratePerMin()))
        throw new IpcErrorRaised({
          code: 'RATE_LIMIT',
          message: `超出限流（${this.config.ratePerMin()} 次/分钟）`,
        })

      const validated = validateParams(tool.params, params)
      const client = await this.gateClient(meta, tool.title)
      this.config.touchClient(client.id)

      if (tool.targetUrl) {
        const host = await tool.targetUrl(validated, this.hosts)
        if (host) {
          const projectId = projectIdOf(this.deps.repos, validated)
          const declared = projectId ? declaredHosts(this.deps.repos, projectId) : []
          if (!declared.includes(host)) await this.gateHost(meta, tool.title, host)
        }
      }

      const projectId = projectIdOf(this.deps.repos, validated)
      if (projectId) mask = SecretMask.forProject(this.deps.repos, projectId)
      const data = mask.value(await tool.run(validated, this.hosts))
      this.audit(meta, toolName, validated, true, null, Date.now() - startedAt, mask)
      return { ok: true, data, timeMs: Date.now() - startedAt }
    } catch (e) {
      const raised =
        e instanceof IpcErrorRaised
          ? e.payload
          : e instanceof ToolInputError
            ? { code: 'VALIDATION' as IpcErrorCode, message: e.message }
            : { code: 'INTERNAL' as IpcErrorCode, message: (e as Error).message }
      this.audit(meta, toolName, params, false, raised.code, Date.now() - startedAt, mask)
      return { ok: false, error: raised, timeMs: Date.now() - startedAt }
    }
  }

  private audit(
    meta: CallMeta,
    tool: string,
    params: unknown,
    ok: boolean,
    errorCode: string | null,
    timeMs: number,
    mask: SecretMask,
  ): void {
    this.deps.repos.openLog.add({
      channel: meta.channel,
      tool,
      client: mask.text(meta.clientName || meta.client).slice(0, 120),
      paramsSummary: mask.summary(params),
      ok,
      errorCode,
      timeMs,
    })
  }
}

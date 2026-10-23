import type {
  Api,
  AssertionResult,
  Auth,
  ExtractedValue,
  Extractor,
  FakeConfig,
  FinalRequest,
  KvRow,
  LogEntry,
  Project,
  ResponseView,
  SendResult,
} from '@shared/types'
import { IpcErrorRaised } from '@shared/types'
import type { EventName, EventPayload, SendInput } from '@shared/channels'
import type { Repos } from '../db/repo'
import {
  HttpCancelError,
  HttpTimeoutError,
  type EngineRequest,
  type EngineResponse,
  type HttpEngine,
  type TransportOptions,
} from '../http/engine'
import { CookieJar } from '../http/cookie-jar'
import { resolveUa } from '../http/ua-presets'
import { mapLookup, resolveVars, type VarLookup } from '../vars/resolver'
import { preview, runAll } from '../vars/extractor'
import type { CancelRegistry } from '../infra/cancel-registry'
import type { FileStore } from '../infra/filestore'
import type { ScriptVM } from '../script/vm'
import type { ScriptRequest, SubRequestCall, SubRequestResult } from '../script/protocol'

/** 超过该字节数的响应体落文件，DB 只存路径（03 号文档 §5） */
export const INLINE_BODY_LIMIT = 256 * 1024
/** 脚本沙箱限制（05 号文档 §6） */
export const MAX_SUB_REQUEST_DEPTH = 8
export const MAX_SUB_REQUESTS = 50
export const SCRIPT_TIMEOUT_MS = 5_000

export interface FlowDeps {
  engine: HttpEngine
  files: FileStore
  cancel: CancelRegistry
  repos: Repos
  emit: <K extends EventName>(channel: K, payload: EventPayload<K>) => void
  script?: ScriptVM
}

interface ResolvedTarget {
  apiId: string | null
  projectId: string
  project: Project | null
  environmentId: string | null
  method: Api['method']
  url: string
  params: KvRow[]
  headers: KvRow[]
  bodyType: Api['bodyType']
  body: string
  auth: Auth
  fake: FakeConfig
  preScript: string
  postScript: string
  extractors: Extractor[]
  isSubRequest: boolean
}

interface RunCtx {
  depth: number
  subCount: number
  cancelId: string
  projectId: string
}

const rowsToRecord = (rows: KvRow[]): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const r of rows) if (r.enabled && r.key) out[r.key] = r.value
  return out
}

/** 沙箱返回的 header 记录回写为 KvRow：保留原顺序，删除未出现的键，追加新键 */
const recordToRows = (prev: KvRow[], next: Record<string, string>): KvRow[] => {
  const kept: KvRow[] = []
  const used = new Set<string>()
  for (const row of prev) {
    const hit = Object.keys(next).find((k) => k.toLowerCase() === row.key.toLowerCase())
    if (hit === undefined) continue
    used.add(hit.toLowerCase())
    kept.push({ ...row, key: hit, value: next[hit] ?? '', enabled: true })
  }
  for (const [key, value] of Object.entries(next)) {
    if (!used.has(key.toLowerCase())) kept.push({ key, value, enabled: true, desc: '' })
  }
  return kept
}

export class RequestFlow {
  private readonly runtimeVars = new Map<string, Map<string, string>>()
  private readonly jars = new Map<string, CookieJar>()

  constructor(private readonly deps: FlowDeps) {}

  runtimeFor(projectId: string): Map<string, string> {
    const existing = this.runtimeVars.get(projectId)
    if (existing) return existing
    const created = new Map<string, string>()
    this.runtimeVars.set(projectId, created)
    return created
  }

  jarFor(projectId: string): CookieJar {
    const existing = this.jars.get(projectId)
    if (existing) return existing
    const created = new CookieJar()
    this.jars.set(projectId, created)
    return created
  }

  /** 运行时变量与 Cookie 只在内存，退出即弃（03 号文档 §3.5） */
  clearSession(projectId?: string): void {
    if (projectId) {
      this.runtimeVars.delete(projectId)
      this.jars.delete(projectId)
      return
    }
    this.runtimeVars.clear()
    this.jars.clear()
  }

  /** 合并顺序即优先级：全局 → 环境 → runtime 后者覆盖（05 号文档 §2） */
  private mergedVars(target: ResolvedTarget): Map<string, string> {
    const { repos } = this.deps
    const merged = new Map<string, string>()
    for (const v of repos.variable.listGlobals()) merged.set(v.key, v.value)
    if (target.environmentId) {
      for (const v of repos.variable.listForEnv(target.environmentId)) merged.set(v.key, v.value)
    }
    for (const [k, v] of this.runtimeFor(target.projectId)) merged.set(k, v)
    return merged
  }

  private varLookup(target: ResolvedTarget): VarLookup {
    return mapLookup(this.mergedVars(target))
  }

  /** 项目默认伪装 ← 接口覆盖（03 号文档 §3.8） */
  static mergeFake(project: Project | null, apiFake: FakeConfig): FakeConfig {
    return { ...(project?.settings.fake ?? {}), ...apiFake }
  }

  private resolveTarget(input: SendInput): ResolvedTarget {
    const { repos } = this.deps
    const pickEnv = (projectId: string): string | null => {
      if (input.envId !== undefined) return input.envId
      return projectId ? (repos.environment.activeFor(projectId)?.id ?? null) : null
    }

    if (input.apiId) {
      const api = repos.api.get(input.apiId)
      if (!api) throw new IpcErrorRaised({ code: 'NOT_FOUND', message: '接口不存在' })
      const collection = repos.collection.get(api.collectionId)
      const projectId = collection?.projectId ?? ''
      return {
        apiId: api.id,
        projectId,
        project: projectId ? repos.project.get(projectId) : null,
        environmentId: pickEnv(projectId),
        method: api.method,
        url: api.url,
        params: api.params,
        headers: api.headers,
        bodyType: api.bodyType,
        body: api.body,
        auth: api.auth,
        fake: api.fake,
        preScript: api.preScript,
        postScript: api.postScript,
        extractors: api.extractors,
        isSubRequest: false,
      }
    }

    const draft = input.draft
    if (!draft)
      throw new IpcErrorRaised({ code: 'VALIDATION', message: 'apiId 与 draft 必须二选一' })
    const projectId = draft.projectId ?? ''
    return {
      apiId: null,
      projectId,
      project: projectId ? repos.project.get(projectId) : null,
      environmentId: pickEnv(projectId),
      method: draft.method,
      url: draft.url,
      params: draft.params ?? [],
      headers: draft.headers ?? [],
      bodyType: draft.bodyType ?? 'none',
      body: draft.body ?? '',
      auth: draft.auth ?? { type: 'none' },
      fake: draft.fake ?? {},
      preScript: '',
      postScript: '',
      extractors: [],
      isSubRequest: false,
    }
  }

  private buildHeaders(
    target: ResolvedTarget,
    lookup: VarLookup,
    fake: FakeConfig,
  ): [string, string][] {
    const enabledRows = (rows: KvRow[]): [string, string][] =>
      rows
        .filter((r) => r.enabled && r.key)
        .map((r) => [r.key, resolveVars(r.value, lookup).text] as [string, string])

    const upsert = (pairs: [string, string][], next: [string, string]): void => {
      const at = pairs.findIndex(([k]) => k.toLowerCase() === next[0].toLowerCase())
      if (at >= 0) pairs[at] = next
      else pairs.push(next)
    }

    const pairs: [string, string][] = enabledRows(target.headers)

    const auth = target.auth
    if (auth.type === 'bearer') {
      upsert(pairs, ['Authorization', `Bearer ${resolveVars(auth.token, lookup).text}`])
    } else if (auth.type === 'basic') {
      const user = resolveVars(auth.username, lookup).text
      const pass = resolveVars(auth.password, lookup).text
      upsert(pairs, [
        'Authorization',
        `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`,
      ])
    } else if (auth.type === 'apikey' && auth.addTo === 'header') {
      upsert(pairs, [resolveVars(auth.key, lookup).text, resolveVars(auth.value, lookup).text])
    }

    for (const row of enabledRows(fake.headers ?? [])) upsert(pairs, row)

    const ua = resolveUa(fake.ua)
    if (ua) upsert(pairs, ['User-Agent', ua])

    if (target.bodyType === 'json' && !pairs.some(([k]) => k.toLowerCase() === 'content-type')) {
      pairs.push(['Content-Type', 'application/json'])
    }
    return pairs
  }

  private buildUrl(target: ResolvedTarget, lookup: VarLookup): string {
    const resolved = resolveVars(target.url, lookup)
    if (resolved.status === 'cycle') {
      throw new IpcErrorRaised({
        code: 'VALIDATION',
        message: `变量循环引用: ${resolved.cycle?.join(' -> ') ?? ''}`,
      })
    }
    let url = resolved.text
    if (!/^https?:\/\//i.test(url)) {
      throw new IpcErrorRaised({
        code: 'VALIDATION',
        message: 'URL 必须以 http:// 或 https:// 开头',
      })
    }

    const query: [string, string][] = target.params
      .filter((p) => p.enabled && p.key)
      .map((p) => [p.key, resolveVars(p.value, lookup).text])

    const auth = target.auth
    if (auth.type === 'apikey' && auth.addTo === 'query') {
      query.push([resolveVars(auth.key, lookup).text, resolveVars(auth.value, lookup).text])
    }

    if (query.length > 0) {
      const marker = url.includes('?') ? '&' : '?'
      url = `${url}${marker}${new URLSearchParams(query).toString()}`
    }
    return url
  }

  static transportOf(fake: FakeConfig): TransportOptions {
    return {
      proxyUrl: fake.proxy?.enabled ? fake.proxy.url : undefined,
      followRedirects: fake.followRedirects ?? true,
      maxRedirects: fake.maxRedirects ?? 5,
      timeoutMs: fake.timeoutMs ?? 30000,
      ignoreTlsErrors: fake.ignoreTlsErrors ?? false,
    }
  }

  async send(input: SendInput): Promise<SendResult> {
    const target = this.resolveTarget(input)
    return this.runTarget(target, {
      depth: 0,
      subCount: 0,
      cancelId: input.cancelId,
      projectId: target.projectId,
    })
  }

  /** 脚本子请求：复用同一伪装/代理/CookieJar 管道，计入历史并受深度限制 */
  async sendSub(call: SubRequestCall, ctx: RunCtx): Promise<SubRequestResult> {
    if (ctx.depth >= MAX_SUB_REQUEST_DEPTH) {
      throw new Error(`子请求层级超过 ${MAX_SUB_REQUEST_DEPTH} 层，疑似递归`)
    }
    if (ctx.subCount >= MAX_SUB_REQUESTS) {
      throw new Error(`单个主请求的子请求数超过 ${MAX_SUB_REQUESTS} 个上限`)
    }
    ctx.subCount += 1

    const projectId = ctx.projectId
    const target: ResolvedTarget = {
      apiId: null,
      projectId,
      project: projectId ? this.deps.repos.project.get(projectId) : null,
      environmentId: projectId
        ? (this.deps.repos.environment.activeFor(projectId)?.id ?? null)
        : null,
      method: (call.method ?? 'GET') as Api['method'],
      url: call.url,
      params: [],
      headers: Object.entries(call.headers ?? {}).map(([key, value]) => ({
        key,
        value,
        enabled: true,
        desc: '',
      })),
      bodyType: call.body ? 'raw' : 'none',
      body: call.body ?? '',
      auth: { type: 'none' },
      fake: call.fake ?? {},
      preScript: '',
      postScript: '',
      extractors: [],
      isSubRequest: true,
    }

    const result = await this.runTarget(target, { ...ctx, depth: ctx.depth + 1 })
    return {
      status: result.response.status,
      statusText: result.response.statusText,
      headers: result.response.headers,
      body: result.response.bodyText ?? '',
      timeMs: result.response.timeMs,
    }
  }

  private async runTarget(target: ResolvedTarget, ctx: RunCtx): Promise<SendResult> {
    const lookup = this.varLookup(target)
    let fake = RequestFlow.mergeFake(target.project, target.fake)
    let url = this.buildUrl(target, lookup)
    let bodyText = resolveVars(target.body, lookup).text
    let method = target.method
    let bodyType = target.bodyType
    let workingRows = target.headers
    let workingAuth = target.auth
    const preLogs: LogEntry[] = []
    let preAssertions: AssertionResult[] = []

    if (this.deps.script && target.preScript.trim()) {
      const jobRequest: ScriptRequest = {
        method,
        url,
        headers: rowsToRecord(target.headers),
        body: bodyText,
        bodyType,
      }
      const outcome = await this.deps.script.run(
        {
          kind: 'pre',
          code: target.preScript,
          timeoutMs: SCRIPT_TIMEOUT_MS,
          request: jobRequest,
          vars: Object.fromEntries(this.mergedVars(target)),
          projectId: target.projectId,
          auth: target.auth,
        },
        {
          subRequest: (call) => this.sendSub(call, ctx),
          varWrite: (scope, key, value) => this.writeVar(scope, key, value, target),
        },
      )
      preLogs.push(...outcome.logs)
      preAssertions = outcome.assertions
      for (const [k, v] of Object.entries(outcome.runtimeWrites)) {
        this.runtimeFor(target.projectId).set(k, v)
      }
      if (outcome.error) {
        throw new IpcErrorRaised({
          code: outcome.error.code,
          message: `前置脚本：${outcome.error.message}`,
        })
      }
      if (outcome.skip !== undefined) {
        return {
          finalRequest: { method, url, headers: [] },
          response: {
            status: 0,
            statusText: '',
            headers: [],
            redirects: [],
            timeMs: 0,
            bodySizeBytes: 0,
          },
          script: { preLogs, postLogs: [], assertions: preAssertions },
          extracted: [],
          historyId: '',
          skipped: true,
          skipReason: outcome.skip,
        }
      }
      if (outcome.request) {
        method = outcome.request.method
        url = outcome.request.url
        bodyText = outcome.request.body
        bodyType = (outcome.request.bodyType ?? bodyType) as Api['bodyType']
        workingRows = recordToRows(target.headers, outcome.request.headers)
        // 脚本自己写了 Authorization 时不再叠加 Auth 配置，避免覆盖脚本意图
        const touchedAuth = Object.keys(outcome.request.headers).some(
          (k) => k.toLowerCase() === 'authorization',
        )
        workingAuth = touchedAuth ? { type: 'none' } : target.auth
      }
      fake = { ...fake, ...outcome.fakePatch }
    }

    // Header 在伪装补丁合并后再算一次，保证 toapi.fake.ua/header 真实落线
    const headers = this.buildHeaders(
      { ...target, headers: workingRows, auth: workingAuth },
      lookup,
      fake,
    )

    const hasBody = bodyType !== 'none' && bodyText !== ''
    const bodyBase64 = hasBody ? Buffer.from(bodyText, 'utf8').toString('base64') : undefined

    if (target.projectId) {
      const jar = this.jarFor(target.projectId)
      const cookie = jar.headerFor(url)
      if (cookie && !headers.some(([k]) => k.toLowerCase() === 'cookie'))
        headers.push(['Cookie', cookie])
    }

    const finalRequest: FinalRequest = {
      method,
      url,
      headers,
      ...(bodyBase64 ? { bodyBase64 } : {}),
    }

    const transport = RequestFlow.transportOf(fake)
    const engineRequest: EngineRequest = { ...finalRequest, transport }
    const controller = this.deps.cancel.create(ctx.cancelId)
    this.deps.emit('event:send-progress', { cancelId: ctx.cancelId, phase: 'sending' })

    let res: EngineResponse
    try {
      res = await this.deps.engine.execute(engineRequest, controller.signal)
    } catch (e) {
      if (e instanceof HttpCancelError)
        throw new IpcErrorRaised({ code: 'CANCELLED', message: '请求已取消' })
      if (e instanceof HttpTimeoutError)
        throw new IpcErrorRaised({
          code: 'TIMEOUT',
          message: `请求超时（${transport.timeoutMs}ms）`,
        })
      throw new IpcErrorRaised({ code: 'NETWORK', message: (e as Error).message })
    } finally {
      this.deps.cancel.release(ctx.cancelId)
    }

    if (target.projectId)
      this.jarFor(target.projectId).ingest(
        res.setCookies.map((v) => ['set-cookie', v] as [string, string]),
        res.finalUrl,
      )

    const bodySize = res.body.byteLength
    const inline = bodySize <= INLINE_BODY_LIMIT
    const responseBody = Buffer.from(res.body).toString('utf8')

    const historyRow = this.deps.repos.history.add({
      apiId: target.apiId,
      projectId: target.projectId,
      request: finalRequest,
      response: {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
        redirects: res.redirects,
        bodySizeBytes: bodySize,
        timeMs: res.timeMs,
      },
      isSubRequest: target.isSubRequest,
    })
    const bodyPath = inline ? undefined : this.deps.files.writeBody(historyRow.id, res.body)

    const response: ResponseView = {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
      redirects: res.redirects,
      timeMs: res.timeMs,
      bodySizeBytes: bodySize,
      ...(inline ? { bodyText: responseBody } : { bodyPath }),
    }

    const extracted = this.applyExtractors(target.extractors, res, target.projectId)
    const postLogs: LogEntry[] = []
    let assertions: AssertionResult[] = []

    if (this.deps.script && target.postScript.trim()) {
      const outcome = await this.deps.script.run(
        {
          kind: 'post',
          code: target.postScript,
          timeoutMs: SCRIPT_TIMEOUT_MS,
          request: { method, url, headers: Object.fromEntries(headers), body: bodyText, bodyType },
          response: {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
            body: inline ? responseBody : responseBody.slice(0, INLINE_BODY_LIMIT),
            timeMs: res.timeMs,
          },
          vars: Object.fromEntries(this.mergedVars(target)),
          projectId: target.projectId,
          auth: target.auth,
        },
        {
          subRequest: (call) => this.sendSub(call, ctx),
          varWrite: (scope, key, value) => this.writeVar(scope, key, value, target),
        },
      )
      postLogs.push(...outcome.logs)
      assertions = outcome.assertions
      for (const [k, v] of Object.entries(outcome.runtimeWrites)) {
        this.runtimeFor(target.projectId).set(k, v)
      }
      // post 脚本自身出错不推翻已收到的响应，以失败断言呈现（05 号文档 §6）
      if (outcome.error)
        assertions = [
          ...assertions,
          { name: '后置脚本执行', pass: false, error: outcome.error.message },
        ]
    }

    return {
      finalRequest,
      response,
      script: { preLogs, postLogs, assertions: [...preAssertions, ...assertions] },
      extracted,
      historyId: historyRow.id,
      skipped: false,
    }
  }

  private writeVar(
    scope: 'env' | 'global',
    key: string,
    value: string,
    target: ResolvedTarget,
  ): void {
    if (scope === 'global') {
      this.deps.repos.variable.upsert({ scope: 'global', key, value })
      return
    }
    if (!target.environmentId) throw new Error('当前没有激活环境，无法写入环境变量')
    this.deps.repos.variable.upsert({
      scope: 'environment',
      environmentId: target.environmentId,
      key,
      value,
    })
  }

  private applyExtractors(
    extractors: Extractor[],
    res: EngineResponse,
    projectId: string,
  ): ExtractedValue[] {
    if (extractors.length === 0) return []
    const outcomes = runAll(extractors, {
      status: res.status,
      headers: res.headers,
      bodyText: Buffer.from(res.body).toString('utf8'),
    })
    const envId = projectId ? (this.deps.repos.environment.activeFor(projectId)?.id ?? null) : null
    const values: ExtractedValue[] = []
    for (const o of outcomes) {
      if (!o.hit) continue
      if (o.scope === 'runtime') {
        this.runtimeFor(projectId).set(o.name, o.value)
      } else if (o.scope === 'env' && envId) {
        this.deps.repos.variable.upsert({
          scope: 'environment',
          environmentId: envId,
          key: o.name,
          value: o.value,
        })
      } else if (o.scope === 'global') {
        this.deps.repos.variable.upsert({ scope: 'global', key: o.name, value: o.value })
      }
      values.push({ name: o.name, scope: o.scope, valuePreview: preview(o.value) })
    }
    return values
  }
}

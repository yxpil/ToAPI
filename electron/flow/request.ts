// @author yxpil
import type {
  Api,
  AssertionResult,
  Auth,
  Collection,
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
import { dynamicVar } from '../postman/dynamic-vars'
import { resolveVars, type VarLookup } from '../vars/resolver'
import { preview, runAll } from '../vars/extractor'
import type { CancelRegistry } from '../infra/cancel-registry'
import type { FileStore } from '../infra/filestore'
import type { ScriptVM } from '../script/vm'
import type {
  ScriptScopes,
  ScriptVarScope,
  SubRequestCall,
  SubRequestResult,
} from '../script/protocol'

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
  requestName: string
  projectId: string
  project: Project | null
  /** 集合链由外到内，用于认证/变量/脚本继承（23 号文档 §3.1） */
  collectionChain: Collection[]
  /** 叶子集合，pm.collectionVariables 写回此处 */
  collectionId: string | null
  environmentId: string | null
  method: Api['method']
  url: string
  params: KvRow[]
  headers: KvRow[]
  bodyType: Api['bodyType']
  body: string
  auth: Auth
  fake: FakeConfig
  preScripts: string[]
  postScripts: string[]
  extractors: Extractor[]
  isSubRequest: boolean
}

interface RunCtx {
  depth: number
  subCount: number
  cancelId: string
  projectId: string
  /** 数据驱动：当前迭代的数据行，优先级高于 environment、低于 local（23 号文档 §5.1） */
  iterationData?: Record<string, string>
  iteration: number
  iterationCount: number
  /** 仅 Runner/CLI 内 pm.execution.setNextRequest 生效 */
  runner?: boolean
  /** CLI --timeout 覆盖接口自身的超时设置 */
  timeoutMs?: number
}

const rowsToRecord = (rows: KvRow[]): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const r of rows) if (r.enabled && r.key) out[r.key] = r.value
  return out
}

/** 从叶子集合向上收集到根，返回由外到内的链；断层或环则截断 */
const collectionChain = (repos: Repos, leafId: string | null): Collection[] => {
  if (!leafId) return []
  const chain: Collection[] = []
  const seen = new Set<string>()
  let current = repos.collection.get(leafId)
  while (current && !seen.has(current.id) && chain.length < 64) {
    seen.add(current.id)
    chain.push(current)
    current = current.parentId ? repos.collection.get(current.parentId) : null
  }
  return chain.reverse()
}

/** api → 集合链 → project：取第一个非 inherit/none 的认证（23 号文档 §3.1） */
const inheritAuth = (apiAuth: Auth, chain: Collection[], project: Project | null): Auth => {
  if (apiAuth.type !== 'inherit' && apiAuth.type !== 'none') return apiAuth
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const auth = chain[i]?.auth
    if (auth && auth.type !== 'inherit' && auth.type !== 'none') return auth
  }
  const root = project?.auth
  if (root && root.type !== 'inherit' && root.type !== 'none') return root
  return { type: 'none' }
}

const collectScripts = (
  project: Project | null,
  chain: Collection[],
  apiPre: string,
  apiPost: string,
): { preScripts: string[]; postScripts: string[] } => {
  const keep = (code: string): boolean => code.trim() !== ''
  return {
    preScripts: [project?.preScript ?? '', ...chain.map((c) => c.preScript), apiPre].filter(keep),
    postScripts: [
      apiPost,
      ...[...chain].reverse().map((c) => c.postScript),
      project?.postScript ?? '',
    ].filter(keep),
  }
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

  /** 各作用域快照；pm.* 按作用域读写（23 号文档 §4.2） */
  private scopeSnapshot(target: ResolvedTarget, local: Map<string, string>): ScriptScopes {
    const { repos } = this.deps
    const globals: Record<string, string> = {}
    for (const v of repos.variable.listGlobals()) if (v.enabled) globals[v.key] = v.value
    const project: Record<string, string> = {}
    for (const v of target.project?.variables ?? []) if (v.enabled) project[v.key] = v.value
    const collection: Record<string, string> = {}
    for (const c of target.collectionChain) {
      // 前置脚本可能刚改写集合变量，读 DB 最新值而不是解析请求时的快照
      const current = repos.collection.get(c.id) ?? c
      for (const v of current.variables) if (v.enabled) collection[v.key] = v.value
    }
    const environment: Record<string, string> = {}
    if (target.environmentId) {
      for (const v of repos.variable.listForEnv(target.environmentId))
        if (v.enabled) environment[v.key] = v.value
    }
    return { globals, project, collection, environment, local: Object.fromEntries(local) }
  }

  /** 合并顺序即优先级：全局 → 项目根 → 集合链由外到内 → 环境 → 数据行 → local → runtime（23 号文档 §3.1 / §5.1） */
  private mergedVars(
    target: ResolvedTarget,
    local?: Map<string, string>,
    iterationData?: Record<string, string>,
  ): Map<string, string> {
    const merged = new Map<string, string>()
    const scopes = this.scopeSnapshot(target, local ?? new Map())
    for (const group of [
      scopes.globals,
      scopes.project,
      scopes.collection,
      scopes.environment,
      iterationData ?? {},
      scopes.local,
    ]) {
      for (const [k, v] of Object.entries(group)) merged.set(k, v)
    }
    for (const [k, v] of this.runtimeFor(target.projectId)) merged.set(k, v)
    return merged
  }

  /** local 优先级最高；静态变量未命中时再取动态变量（23 号文档 §4.5） */
  private varLookup(
    target: ResolvedTarget,
    local?: Map<string, string>,
    iterationData?: Record<string, string>,
  ): VarLookup {
    const merged = this.mergedVars(target, undefined, iterationData)
    return { get: (name) => local?.get(name) ?? merged.get(name) ?? dynamicVar(name) }
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
      const chain = collectionChain(repos, api.collectionId)
      const projectId = chain[0]?.projectId ?? ''
      const project = projectId ? repos.project.get(projectId) : null
      return {
        apiId: api.id,
        requestName: api.name,
        projectId,
        project,
        collectionChain: chain,
        collectionId: api.collectionId,
        environmentId: pickEnv(projectId),
        method: api.method,
        url: api.url,
        params: api.params,
        headers: api.headers,
        bodyType: api.bodyType,
        body: api.body,
        auth: inheritAuth(api.auth, chain, project),
        fake: api.fake,
        ...collectScripts(project, chain, api.preScript, api.postScript),
        extractors: api.extractors,
        isSubRequest: false,
      }
    }

    const draft = input.draft
    if (!draft)
      throw new IpcErrorRaised({ code: 'VALIDATION', message: 'apiId 与 draft 必须二选一' })
    const chain = collectionChain(repos, draft.collectionId ?? null)
    const projectId = draft.projectId ?? chain[0]?.projectId ?? ''
    const project = projectId ? repos.project.get(projectId) : null
    return {
      apiId: null,
      requestName: '临时请求',
      projectId,
      project,
      collectionChain: chain,
      collectionId: draft.collectionId ?? null,
      environmentId: pickEnv(projectId),
      method: draft.method,
      url: draft.url,
      params: draft.params ?? [],
      headers: draft.headers ?? [],
      bodyType: draft.bodyType ?? 'none',
      body: draft.body ?? '',
      auth: inheritAuth(draft.auth ?? { type: 'none' }, chain, project),
      fake: draft.fake ?? {},
      ...collectScripts(project, chain, '', ''),
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
      iteration: input.iteration ?? 1,
      iterationCount: input.iterationCount ?? 1,
      ...(input.iterationData ? { iterationData: input.iterationData } : {}),
      ...(input.runner ? { runner: true } : {}),
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
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
      requestName: 'pm.sendRequest',
      projectId,
      project: projectId ? this.deps.repos.project.get(projectId) : null,
      collectionChain: [],
      collectionId: null,
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
      preScripts: [],
      postScripts: [],
      extractors: [],
      isSubRequest: true,
    }

    // 子请求各自使用独立取消句柄：pm.test 里的多个异步子请求会并发执行
    const result = await this.runTarget(target, {
      ...ctx,
      depth: ctx.depth + 1,
      cancelId: `${ctx.cancelId}#${ctx.subCount}`,
    })
    return {
      status: result.response.status,
      statusText: result.response.statusText,
      headers: result.response.headers,
      body: result.response.bodyText ?? '',
      timeMs: result.response.timeMs,
    }
  }

  private async runTarget(target: ResolvedTarget, ctx: RunCtx): Promise<SendResult> {
    let lookup = this.varLookup(target, undefined, ctx.iterationData)
    let fake = RequestFlow.mergeFake(target.project, target.fake)
    let url = this.buildUrl(target, lookup)
    let bodyText = resolveVars(target.body, lookup).text
    let method = target.method
    let bodyType = target.bodyType
    let workingRows = target.headers
    let workingAuth = target.auth
    const localVars = new Map<string, string>()
    const preLogs: LogEntry[] = []
    const preAssertions: AssertionResult[] = []
    let nextRequest: string | null | undefined
    const iterationData = ctx.iterationData ?? {}

    if (this.deps.script) {
      for (const code of target.preScripts) {
        const outcome = await this.deps.script.run(
          {
            kind: 'pre',
            code,
            timeoutMs: SCRIPT_TIMEOUT_MS,
            request: {
              method,
              url,
              headers: rowsToRecord(workingRows),
              body: bodyText,
              bodyType,
            },
            vars: Object.fromEntries(this.mergedVars(target, localVars, iterationData)),
            scopes: this.scopeSnapshot(target, localVars),
            cookies: target.projectId ? this.jarFor(target.projectId).list(url) : [],
            requestName: target.requestName,
            requestId: target.apiId,
            iteration: ctx.iteration,
            iterationCount: ctx.iterationCount,
            iterationData,
            runner: ctx.runner === true,
            collectionId: target.collectionId,
            projectId: target.projectId,
            auth: workingAuth,
          },
          {
            subRequest: (call) => this.sendSub(call, ctx),
            varWrite: (scope, key, value, collectionId) =>
              this.writeVar(scope, key, value, target, collectionId),
            varUnset: (scope, key, collectionId) => this.unsetVar(scope, key, target, collectionId),
            cookieWrite: (op, name, value) => this.writeCookie(op, name, value, target, url),
          },
        )
        preLogs.push(...outcome.logs)
        preAssertions.push(...outcome.assertions)
        if (outcome.nextRequest !== undefined) nextRequest = outcome.nextRequest
        for (const [k, v] of Object.entries(outcome.runtimeWrites)) {
          this.runtimeFor(target.projectId).set(k, v)
        }
        for (const [k, v] of Object.entries(outcome.localWrites)) localVars.set(k, v)
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
          workingRows = recordToRows(workingRows, outcome.request.headers)
          // 脚本自己写了 Authorization 时不再叠加 Auth 配置，避免覆盖脚本意图
          const touchedAuth = Object.keys(outcome.request.headers).some(
            (k) => k.toLowerCase() === 'authorization',
          )
          workingAuth = touchedAuth ? { type: 'none' } : workingAuth
        }
        fake = { ...fake, ...outcome.fakePatch }
      }
    }

    // Header 在伪装补丁与前置脚本之后重算，保证 local 变量与 toapi.fake 真实落线
    lookup = this.varLookup(target, localVars, iterationData)
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
    // Runner/CLI 的 --timeout 覆盖接口自身设置（23 号文档 §5.3）
    if (ctx.timeoutMs) transport.timeoutMs = ctx.timeoutMs
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

    const extraction = this.applyExtractors(target.extractors, res, target.projectId)
    const postLogs: LogEntry[] = []
    const assertions: AssertionResult[] = []
    // Runner/CLI 场景下提取器未命中即链路断裂，按失败断言呈现（23 号文档 §5.2）
    if (ctx.runner)
      for (const name of extraction.misses)
        assertions.push({ name: `提取器 ${name}`, pass: false, error: '未命中' })

    const cookieUrl = res.finalUrl || url
    if (this.deps.script) {
      for (const code of target.postScripts) {
        const outcome = await this.deps.script.run(
          {
            kind: 'post',
            code,
            timeoutMs: SCRIPT_TIMEOUT_MS,
            request: {
              method,
              url,
              headers: Object.fromEntries(headers),
              body: bodyText,
              bodyType,
            },
            response: {
              status: res.status,
              statusText: res.statusText,
              headers: res.headers,
              body: inline ? responseBody : responseBody.slice(0, INLINE_BODY_LIMIT),
              timeMs: res.timeMs,
            },
            vars: Object.fromEntries(this.mergedVars(target, localVars, iterationData)),
            scopes: this.scopeSnapshot(target, localVars),
            cookies: target.projectId ? this.jarFor(target.projectId).list(cookieUrl) : [],
            requestName: target.requestName,
            requestId: target.apiId,
            iteration: ctx.iteration,
            iterationCount: ctx.iterationCount,
            iterationData,
            runner: ctx.runner === true,
            collectionId: target.collectionId,
            projectId: target.projectId,
            auth: workingAuth,
          },
          {
            subRequest: (call) => this.sendSub(call, ctx),
            varWrite: (scope, key, value, collectionId) =>
              this.writeVar(scope, key, value, target, collectionId),
            varUnset: (scope, key, collectionId) => this.unsetVar(scope, key, target, collectionId),
            cookieWrite: (op, name, value) => this.writeCookie(op, name, value, target, cookieUrl),
          },
        )
        postLogs.push(...outcome.logs)
        assertions.push(...outcome.assertions)
        if (outcome.nextRequest !== undefined) nextRequest = outcome.nextRequest
        for (const [k, v] of Object.entries(outcome.runtimeWrites)) {
          this.runtimeFor(target.projectId).set(k, v)
        }
        for (const [k, v] of Object.entries(outcome.localWrites)) localVars.set(k, v)
        // 后置脚本自身出错不推翻已收到的响应，以失败断言呈现；后续脚本继续执行（05 号文档 §6）
        if (outcome.error)
          assertions.push({ name: '后置脚本执行', pass: false, error: outcome.error.message })
      }
    }

    return {
      finalRequest,
      response,
      script: { preLogs, postLogs, assertions: [...preAssertions, ...assertions] },
      extracted: extraction.values,
      historyId: historyRow.id,
      skipped: false,
      ...(ctx.runner && nextRequest !== undefined ? { nextRequest } : {}),
    }
  }

  private writeVar(
    scope: ScriptVarScope,
    key: string,
    value: string,
    target: ResolvedTarget,
    collectionId?: string,
  ): void {
    if (scope === 'global') {
      this.deps.repos.variable.upsert({ scope: 'global', key, value })
      return
    }
    if (scope === 'env') {
      if (!target.environmentId) throw new Error('当前没有激活环境，无法写入环境变量')
      this.deps.repos.variable.upsert({
        scope: 'environment',
        environmentId: target.environmentId,
        key,
        value,
      })
      return
    }

    const id = collectionId ?? target.collectionId
    if (!id) throw new Error('当前请求不在集合内，无法写入集合变量')
    const current = this.deps.repos.collection.get(id)
    if (!current) throw new Error('集合不存在，无法写入集合变量')
    const variables = current.variables.slice()
    const at = variables.findIndex((v) => v.key === key)
    if (at >= 0) variables[at] = { ...(variables[at] as (typeof variables)[number]), value }
    else variables.push({ key, value, enabled: true, secret: false, desc: '' })
    this.deps.repos.collection.update(id, { variables })
  }

  private unsetVar(
    scope: ScriptVarScope,
    key: string,
    target: ResolvedTarget,
    collectionId?: string,
  ): void {
    if (scope === 'global' || scope === 'env') {
      const environmentId = scope === 'env' ? target.environmentId : null
      if (scope === 'env' && !environmentId) throw new Error('当前没有激活环境，无法删除环境变量')
      const row = this.deps.repos.variable.find(
        scope === 'env' ? 'environment' : 'global',
        environmentId,
        key,
      )
      if (row) this.deps.repos.variable.remove(row.id)
      return
    }

    const id = collectionId ?? target.collectionId
    if (!id) throw new Error('当前请求不在集合内，无法写入集合变量')
    const current = this.deps.repos.collection.get(id)
    if (!current) return
    const variables = current.variables.filter((v) => v.key !== key)
    if (variables.length !== current.variables.length)
      this.deps.repos.collection.update(id, { variables })
  }

  private writeCookie(
    op: 'set' | 'unset',
    name: string,
    value: string | undefined,
    target: ResolvedTarget,
    url: string,
  ): void {
    if (!target.projectId || !/^https?:\/\//i.test(url)) return
    const jar = this.jarFor(target.projectId)
    if (op === 'set') jar.set(name, value ?? '', url)
    else jar.unset(name, url)
  }

  private applyExtractors(
    extractors: Extractor[],
    res: EngineResponse,
    projectId: string,
  ): { values: ExtractedValue[]; misses: string[] } {
    if (extractors.length === 0) return { values: [], misses: [] }
    const outcomes = runAll(extractors, {
      status: res.status,
      headers: res.headers,
      bodyText: Buffer.from(res.body).toString('utf8'),
    })
    const envId = projectId ? (this.deps.repos.environment.activeFor(projectId)?.id ?? null) : null
    const values: ExtractedValue[] = []
    const misses: string[] = []
    for (const o of outcomes) {
      if (!o.hit) {
        misses.push(o.name)
        continue
      }
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
    return { values, misses }
  }
}

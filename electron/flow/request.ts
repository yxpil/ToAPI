import type {
  Api,
  Auth,
  ExtractedValue,
  Extractor,
  FakeConfig,
  FinalRequest,
  KvRow,
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

/** 超过该字节数的响应体落文件，DB 只存路径（03 号文档 §5） */
export const INLINE_BODY_LIMIT = 256 * 1024

export interface FlowDeps {
  engine: HttpEngine
  files: FileStore
  cancel: CancelRegistry
  repos: Repos
  emit: <K extends EventName>(channel: K, payload: EventPayload<K>) => void
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
  extractors: Extractor[]
  isSubRequest: boolean
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

  private varLookup(target: ResolvedTarget): VarLookup {
    const { repos } = this.deps
    const globals = new Map(
      repos.variable.listGlobals().map((v) => [v.key, v.value] as [string, string]),
    )
    const envVars = new Map<string, string>()
    if (target.environmentId) {
      for (const v of repos.variable.listForEnv(target.environmentId)) envVars.set(v.key, v.value)
    }
    // 优先级：runtime > 环境 > 全局（05 号文档 §2）
    return mapLookup(globals, envVars, this.runtimeFor(target.projectId))
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
    const lookup = this.varLookup(target)
    const fake = RequestFlow.mergeFake(target.project, target.fake)
    const transport = RequestFlow.transportOf(fake)

    const url = this.buildUrl(target, lookup)
    const headers = this.buildHeaders(target, lookup, fake)
    const bodyText = resolveVars(target.body, lookup).text
    const bodyBase64 =
      target.bodyType === 'none' ? undefined : Buffer.from(bodyText, 'utf8').toString('base64')

    if (target.projectId) {
      const jar = this.jarFor(target.projectId)
      const cookie = jar.headerFor(url)
      if (cookie && !headers.some(([k]) => k.toLowerCase() === 'cookie'))
        headers.push(['Cookie', cookie])
    }

    const finalRequest: FinalRequest = {
      method: target.method,
      url,
      headers,
      ...(bodyBase64 ? { bodyBase64 } : {}),
    }

    const engineRequest: EngineRequest = { ...finalRequest, transport }
    const controller = this.deps.cancel.create(input.cancelId)
    this.deps.emit('event:send-progress', { cancelId: input.cancelId, phase: 'sending' })

    let res: EngineResponse
    try {
      res = await this.deps.engine.execute(engineRequest, controller.signal)
    } catch (e) {
      if (e instanceof HttpCancelError) {
        throw new IpcErrorRaised({ code: 'CANCELLED', message: '请求已取消' })
      }
      if (e instanceof HttpTimeoutError) {
        throw new IpcErrorRaised({
          code: 'TIMEOUT',
          message: `请求超时（${transport.timeoutMs}ms）`,
        })
      }
      throw new IpcErrorRaised({ code: 'NETWORK', message: (e as Error).message })
    } finally {
      this.deps.cancel.release(input.cancelId)
    }

    if (target.projectId)
      this.jarFor(target.projectId).ingest(
        res.setCookies.map((v) => ['set-cookie', v] as [string, string]),
        res.finalUrl,
      )

    const bodySize = res.body.byteLength
    const inline = bodySize <= INLINE_BODY_LIMIT
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
      ...(inline ? { bodyText: Buffer.from(res.body).toString('utf8') } : { bodyPath }),
    }

    return {
      finalRequest,
      response,
      script: { preLogs: [], postLogs: [], assertions: [] },
      extracted: this.applyExtractors(target.extractors, res, target.projectId),
      historyId: historyRow.id,
      skipped: false,
    }
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

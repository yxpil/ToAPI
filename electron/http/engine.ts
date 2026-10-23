import { Agent, ProxyAgent, request, type Dispatcher } from 'undici'
import { performance } from 'node:perf_hooks'
import type { HttpMethod } from '@shared/types'

export interface TransportOptions {
  proxyUrl?: string
  followRedirects: boolean
  maxRedirects: number
  timeoutMs: number
  ignoreTlsErrors: boolean
}

export interface EngineRequest {
  method: HttpMethod
  url: string
  /** 有序头，保持发送顺序（伪装语义，07 号文档 §2.2） */
  headers: [string, string][]
  bodyBase64?: string
  transport: TransportOptions
}

export interface EngineResponse {
  status: number
  statusText: string
  headers: [string, string][]
  setCookies: string[]
  body: Uint8Array
  timeMs: number
  redirects: { status: number; location: string }[]
  finalUrl: string
}

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
}

export class HttpTimeoutError extends Error {
  constructor(message = '请求超时') {
    super(message)
    this.name = 'HttpTimeoutError'
  }
}

export class HttpCancelError extends Error {
  constructor() {
    super('请求已取消')
    this.name = 'HttpCancelError'
  }
}

const isRedirect = (status: number): boolean => [301, 302, 303, 307, 308].includes(status)

/** undici v8 的 response.headers 是 Record<string, string | string[]>，set-cookie 为数组 */
type RawHeaders = Record<string, string | string[] | undefined>

const toPairs = (headers: RawHeaders): [string, string][] => {
  const pairs: [string, string][] = []
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const v of value) pairs.push([key, v])
    else pairs.push([key, value])
  }
  return pairs
}

export class HttpEngine {
  private readonly dispatchers = new Map<string, Dispatcher>()

  private dispatcherFor(t: TransportOptions): Dispatcher | undefined {
    const key = `${t.proxyUrl ?? ''}|${t.ignoreTlsErrors ? 1 : 0}`
    const cached = this.dispatchers.get(key)
    if (cached) return cached
    const connect = { rejectUnauthorized: !t.ignoreTlsErrors }
    const created: Dispatcher = t.proxyUrl
      ? new ProxyAgent({ uri: t.proxyUrl, connect })
      : new Agent({ connections: 64, keepAliveTimeout: 30_000, connect })
    this.dispatchers.set(key, created)
    return created
  }

  async execute(req: EngineRequest, external: AbortSignal): Promise<EngineResponse> {
    const started = performance.now()
    const redirects: { status: number; location: string }[] = []
    let currentUrl = req.url
    let method = req.method
    let body = req.bodyBase64 ? Buffer.from(req.bodyBase64, 'base64') : undefined
    const headers = [...req.headers]

    for (let hop = 0; ; hop++) {
      const timeout = AbortSignal.timeout(req.transport.timeoutMs)
      const signal = AbortSignal.any([external, timeout])
      let response: Dispatcher.ResponseData
      try {
        response = await request(currentUrl, {
          method: method as Dispatcher.HttpMethod,
          // 扁平数组形式保留发送顺序与重复头
          headers: headers.flatMap(([k, v]) => [k, v]) as string[],
          body,
          signal,
          dispatcher: this.dispatcherFor(req.transport),
        })
      } catch (e) {
        if (external.aborted) throw new HttpCancelError()
        if (timeout.aborted) throw new HttpTimeoutError()
        throw new Error(`${(e as Error).name}: ${(e as Error).message}`, { cause: e })
      }

      const pairs = toPairs(response.headers as unknown as RawHeaders)
      const setCookies = pairs.filter(([k]) => k.toLowerCase() === 'set-cookie').map(([, v]) => v)
      const chunks: Buffer[] = []
      try {
        for await (const chunk of response.body) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
        }
      } catch (e) {
        if (external.aborted) throw new HttpCancelError()
        if (timeout.aborted) throw new HttpTimeoutError()
        throw e
      }

      const bodyBuffer = Buffer.concat(chunks)
      const status = response.statusCode

      const location = pairs.find(([k]) => k.toLowerCase() === 'location')?.[1]
      if (
        req.transport.followRedirects &&
        location &&
        isRedirect(status) &&
        hop < req.transport.maxRedirects
      ) {
        redirects.push({ status, location })
        currentUrl = new URL(location, currentUrl).toString()
        // 303 与 301/302 的 POST 按浏览器语义转 GET 并丢弃请求体
        if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
          method = 'GET'
          body = undefined
          headers.splice(
            0,
            headers.length,
            ...headers.filter(([k]) => !/^content-(length|type)$/i.test(k)),
          )
        }
        continue
      }

      return {
        status,
        statusText: STATUS_TEXT[status] ?? '',
        headers: pairs,
        setCookies,
        body: new Uint8Array(bodyBuffer),
        timeMs: performance.now() - started,
        redirects,
        finalUrl: currentUrl,
      }
    }
  }

  close(): void {
    for (const d of this.dispatchers.values()) void d.close()
    this.dispatchers.clear()
  }
}

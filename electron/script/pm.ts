// @author yxpil
import type { ScriptJob, ScriptVarScope, SubRequestCall, SubRequestResult } from './protocol'
import { AssertionError, deepEqual, expect } from './expect'
import { dynamicVar } from '../postman/dynamic-vars'
import { resolveVars } from '../vars/resolver'
import type { Auth } from '@shared/types'

/** Postman 脚本 API（23 号文档 §4.2）：只暴露文档承诺的成员，不泄露宿主能力 */

export interface PmRequestState {
  method: string
  url: string
  headers: Record<string, string>
  body: string
  bodyType: string
}

export interface PmTestResult {
  name: string
  pass: boolean
  skipped?: boolean
  error?: string
}

export interface PmHost {
  job: ScriptJob
  request: PmRequestState
  local: Map<string, string>
  assertions: PmTestResult[]
  pending: Promise<void>[]
  writes: Promise<void>[]
  errors: string[]
  /** pm.execution.setNextRequest 的结果，worker 收尾时回传宿主 */
  nextRequest: string | null | undefined
  skip: (reason?: string) => void
  subRequest: (call: SubRequestCall) => Promise<SubRequestResult>
  varWrite: (
    scope: ScriptVarScope,
    key: string,
    value: string,
    collectionId?: string,
  ) => Promise<void>
  varUnset: (scope: ScriptVarScope, key: string, collectionId?: string) => Promise<void>
  cookieWrite: (op: 'set' | 'unset', name: string, value?: string) => Promise<void>
  log: (level: 'log' | 'warn' | 'error', text: string) => void
}

type Dict = Record<string, unknown>

const isObject = (value: unknown): value is Dict =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const show = (value: unknown): string => {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const queryOf = (
  raw: string,
): { base: string; hash: string; rows: { key: string; value: string }[] } => {
  const hashAt = raw.indexOf('#')
  const hash = hashAt >= 0 ? raw.slice(hashAt) : ''
  const withoutHash = hashAt >= 0 ? raw.slice(0, hashAt) : raw
  const at = withoutHash.indexOf('?')
  const base = at >= 0 ? withoutHash.slice(0, at) : withoutHash
  const query = at >= 0 ? withoutHash.slice(at + 1) : ''
  const rows = query
    .split('&')
    .filter((part) => part !== '')
    .map((part) => {
      const eq = part.indexOf('=')
      const key = eq >= 0 ? part.slice(0, eq) : part
      const value = eq >= 0 ? part.slice(eq + 1) : ''
      const decode = (s: string): string => {
        try {
          return decodeURIComponent(s.replace(/\+/g, ' '))
        } catch {
          return s
        }
      }
      return { key: decode(key), value: decode(value) }
    })
  return { base, hash, rows }
}

const parseHeaders = (input: unknown): [string, string][] => {
  if (Array.isArray(input)) {
    const out: [string, string][] = []
    for (const entry of input) {
      if (typeof entry === 'string') {
        const at = entry.indexOf(':')
        if (at > 0) out.push([entry.slice(0, at).trim(), entry.slice(at + 1).trim()])
      } else if (isObject(entry) && typeof entry['key'] === 'string') {
        out.push([entry['key'], String(entry['value'] ?? '')])
      }
    }
    return out
  }
  if (isObject(input))
    return Object.entries(input).map(([key, value]) => [key, String(value)] as [string, string])
  return []
}

const basicAuth = (user: string, pass: string): string =>
  `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`

export const buildPm = (host: PmHost): Dict => {
  const { job } = host
  const readOnly = job.kind === 'post'
  const denyWrite = (what: string): boolean => {
    if (!readOnly) return false
    host.log('warn', `后置脚本中 ${what} 为只读，写入已忽略`)
    return true
  }

  const layers: Record<ScriptVarScope, Map<string, string>> = {
    global: new Map(Object.entries(job.scopes.globals)),
    env: new Map(Object.entries(job.scopes.environment)),
    collection: new Map(Object.entries(job.scopes.collection)),
  }
  const projectLayer = new Map(Object.entries(job.scopes.project))
  const iterationLayer = new Map(Object.entries(job.iterationData))
  const lower = new Map<string, string>()
  const rebuild = (): void => {
    lower.clear()
    // 优先级由低到高：global → project → collection → environment → iterationData（23 号文档 §5.1）
    for (const layer of [
      layers.global,
      projectLayer,
      layers.collection,
      layers.env,
      iterationLayer,
    ])
      for (const [key, value] of layer) lower.set(key, value)
  }
  rebuild()

  const lookup = (name: string): string | undefined =>
    host.local.get(name) ?? lower.get(name) ?? dynamicVar(name)

  const mergedVars = (): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const [key, value] of lower) out[key] = value
    for (const [key, value] of host.local) out[key] = value
    return out
  }

  const trackWrite = (promise: Promise<void>): void => {
    host.writes.push(
      promise.catch((e: unknown) => {
        host.errors.push(errorText(e))
      }),
    )
  }

  const scopeApi = (scope: ScriptVarScope, extra?: { collectionId?: string }) => {
    const cache = layers[scope]
    return {
      get: (key: string): string | undefined => cache.get(key),
      has: (key: string): boolean => cache.has(key),
      set: (key: string, value: unknown): void => {
        const text = String(value)
        cache.set(key, text)
        rebuild()
        trackWrite(host.varWrite(scope, key, text, extra?.collectionId))
      },
      unset: (key: string): void => {
        cache.delete(key)
        rebuild()
        trackWrite(host.varUnset(scope, key, extra?.collectionId))
      },
      toObject: (): Record<string, string> => Object.fromEntries(cache),
      clear: (): void => {
        for (const key of [...cache.keys()]) {
          cache.delete(key)
          trackWrite(host.varUnset(scope, key, extra?.collectionId))
        }
        rebuild()
      },
    }
  }

  const variables = {
    get: (key: string): string | undefined => lookup(key),
    has: (key: string): boolean => lookup(key) !== undefined,
    set: (key: string, value: unknown): void => {
      host.local.set(key, String(value))
    },
    unset: (key: string): void => {
      host.local.delete(key)
    },
    toObject: mergedVars,
    replaceIn: (template: string): string => resolveVars(String(template), { get: lookup }).text,
  }

  const HeaderList = (
    read: () => Record<string, string>,
    write: (next: Record<string, string>) => void,
    label: string,
  ) => {
    const keyIn = (record: Record<string, string>, name: string): string | undefined =>
      Object.keys(record).find((key) => key.toLowerCase() === name.toLowerCase())

    const api: Dict = {
      get: (name: string): string | undefined => {
        const record = read()
        const key = keyIn(record, name)
        return key === undefined ? undefined : record[key]
      },
      has: (name: string): boolean => keyIn(read(), name) !== undefined,
      toObject: (): Record<string, string> => ({ ...read() }),
      all: (): { key: string; value: string; type: 'text' }[] =>
        Object.entries(read()).map(([key, value]) => ({ key, value, type: 'text' })),
      count: (): number => Object.keys(read()).length,
      each: (fn: (entry: { key: string; value: string }) => void): void => {
        for (const [key, value] of Object.entries(read())) fn({ key, value })
      },
      add: (entry: unknown): void => {
        if (denyWrite(`${label}.add`)) return
        const record = { ...read() }
        for (const [key, value] of parseHeaders(Array.isArray(entry) ? entry : [entry])) {
          const existing = keyIn(record, key)
          if (existing && existing !== key) delete record[existing]
          record[key] = value
        }
        write(record)
      },
      upsert: (entry: unknown): void => {
        if (denyWrite(`${label}.upsert`)) return
        const record = { ...read() }
        for (const [key, value] of parseHeaders(Array.isArray(entry) ? entry : [entry])) {
          const existing = keyIn(record, key)
          if (existing) record[existing] = value
          else record[key] = value
        }
        write(record)
      },
      remove: (name: string): void => {
        if (denyWrite(`${label}.remove`)) return
        const record = { ...read() }
        const key = keyIn(record, name)
        if (key !== undefined) delete record[key]
        write(record)
      },
      toString: (): string =>
        Object.entries(read())
          .map(([key, value]) => `${key}: ${value}`)
          .join('\n'),
    }
    return api
  }

  const headers = HeaderList(
    () => ({ ...host.request.headers }),
    (next) => {
      host.request.headers = next
    },
    'pm.request.headers',
  )

  const queryList = () => {
    const read = () => queryOf(host.request.url)
    const commit = (rows: { key: string; value: string }[]): void => {
      if (denyWrite('pm.request.url')) return
      const { base, hash } = read()
      const query = rows
        .map(({ key, value }) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join('&')
      host.request.url = `${base}${query ? `?${query}` : ''}${hash}`
    }
    const api: Dict = {
      all: () => read().rows.map((row) => ({ ...row, disabled: false })),
      toObject: (): Record<string, string> =>
        Object.fromEntries(read().rows.map((r) => [r.key, r.value])),
      get: (key: string): string | undefined => read().rows.find((r) => r.key === key)?.value,
      has: (key: string): boolean => read().rows.some((r) => r.key === key),
      count: (): number => read().rows.length,
      each: (fn: (row: { key: string; value: string }) => void): void => {
        for (const row of read().rows) fn(row)
      },
      map: (fn: (row: { key: string; value: string }) => unknown): unknown[] => read().rows.map(fn),
      filter: (fn: (row: { key: string; value: string }) => boolean): Dict[] =>
        read().rows.filter(fn),
      add: (value: unknown): void => {
        const rows = read().rows
        for (const row of toRows(value)) rows.push(row)
        commit(rows)
      },
      upsert: (value: unknown): void => {
        const rows = read().rows
        for (const row of toRows(value)) {
          const at = rows.findIndex((r) => r.key === row.key)
          if (at >= 0) rows[at] = row
          else rows.push(row)
        }
        commit(rows)
      },
      remove: (key: string): void => {
        commit(read().rows.filter((r) => r.key !== key))
      },
      clear: (): void => commit([]),
    }
    return api
  }

  const toRows = (value: unknown): { key: string; value: string }[] => {
    if (typeof value === 'string') {
      return value
        .split('&')
        .filter(Boolean)
        .map((part) => {
          const eq = part.indexOf('=')
          return eq >= 0
            ? { key: part.slice(0, eq), value: part.slice(eq + 1) }
            : { key: part, value: '' }
        })
    }
    if (Array.isArray(value))
      return value.flatMap((entry) =>
        isObject(entry) && typeof entry['key'] === 'string'
          ? [{ key: entry['key'], value: String(entry['value'] ?? '') }]
          : [],
      )
    if (isObject(value)) return Object.entries(value).map(([key, v]) => ({ key, value: String(v) }))
    return []
  }

  const urlApi = (): Dict => {
    const api: Dict = {
      toString: (): string => host.request.url,
      get host(): string {
        return (
          queryOf(host.request.url)
            .base.replace(/^[a-z]+:\/\//i, '')
            .split('/')[0] ?? ''
        )
      },
      get path(): string {
        const base = queryOf(host.request.url).base.replace(/^[a-z]+:\/\//i, '')
        const parts = base.split('/')
        return parts.slice(1).join('/')
      },
      get protocol(): string {
        return /^([a-z]+):\/\//i.exec(host.request.url)?.[1] ?? ''
      },
      get query(): Dict {
        return queryList()
      },
      getQueryString: (): string => {
        const query = queryList()
        const toObject = query['toObject'] as () => Record<string, string>
        return Object.entries(toObject())
          .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
          .join('&')
      },
      addQueryParams: (params: unknown): void => {
        const query = queryList()
        ;(query['add'] as (value: unknown) => void)(params)
      },
      update: (value: string): void => {
        if (denyWrite('pm.request.url.update')) return
        host.request.url = String(value)
      },
    }
    return api
  }

  const bodyApi = (): Dict => {
    const mode = host.request.bodyType === 'json' ? 'raw' : host.request.bodyType
    return {
      mode: mode === 'none' ? undefined : mode,
      raw: host.request.body,
      toString: (): string => host.request.body,
      update: (value: unknown): void => {
        if (denyWrite('pm.request.body.update')) return
        host.request.body = String(value)
      },
    }
  }

  const request: Dict = {
    get method(): string {
      return host.request.method
    },
    set method(value: string) {
      if (denyWrite('pm.request.method')) return
      host.request.method = String(value)
    },
    get url(): Dict {
      return urlApi()
    },
    set url(value: unknown) {
      if (denyWrite('pm.request.url')) return
      const toString = isObject(value) ? value['toString'] : undefined
      host.request.url =
        typeof value === 'string'
          ? value
          : typeof toString === 'function'
            ? String((toString as () => string).call(value))
            : String(value)
    },
    get headers(): Dict {
      return headers
    },
    get body(): Dict {
      return bodyApi()
    },
    get auth(): Auth {
      return JSON.parse(JSON.stringify(job.auth)) as Auth
    },
    skipRequest: (reason?: string): void => {
      host.skip(reason ?? 'skipped by script')
    },
  }

  const recordAssertion = (name: string, fn: () => void): void => {
    try {
      fn()
      host.assertions.push({ name, pass: true })
    } catch (e) {
      host.assertions.push({ name, pass: false, error: errorText(e) })
    }
  }

  const parseCookies = (pairs: [string, string][]): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const [name, value] of pairs) {
      if (name.toLowerCase() !== 'set-cookie') continue
      const first = value.split(';')[0] ?? ''
      const eq = first.indexOf('=')
      if (eq > 0) out[first.slice(0, eq).trim()] = first.slice(eq + 1).trim()
    }
    return out
  }

  const responseApi = (
    status: number,
    statusText: string,
    pairs: [string, string][],
    body: string,
    timeMs: number,
  ): Dict => {
    const responseHeaders = HeaderList(
      () => Object.fromEntries(pairs),
      () => undefined,
      'pm.response.headers',
    )
    const cookieMap = parseCookies(pairs)
    const to: Dict = {
      have: {
        status(code: number): void {
          recordAssertion(`响应状态码 ${code}`, () => {
            if (status !== code) throw new AssertionError(`期望 ${code}，实际 ${status}`)
          })
        },
        header(name: string, value?: unknown): void {
          recordAssertion(`响应头 ${name}`, () => {
            const read = responseHeaders['get'] as (key: string) => string | undefined
            const hit = read(name)
            if (hit === undefined) throw new AssertionError(`缺少响应头 ${name}`)
            if (value !== undefined && String(hit) !== String(value))
              throw new AssertionError(`响应头 ${name} 期望 ${String(value)}，实际 ${hit}`)
          })
        },
        body(text: string): void {
          recordAssertion('响应体包含文本', () => {
            if (!body.includes(String(text)))
              throw new AssertionError(`响应体不包含 ${String(text).slice(0, 80)}`)
          })
        },
        jsonBody(expected: unknown): void {
          recordAssertion('响应体 JSON 匹配', () => {
            const parsed = JSON.parse(body) as unknown
            if (!deepEqual(parsed, expected))
              throw new AssertionError(`JSON 体不匹配：期望 ${show(expected)}`)
          })
        },
      },
    }
    ;(to as Dict)['be'] = to
    const flag = (name: string, ok: boolean): void => {
      Object.defineProperty(to, name, {
        get: () =>
          recordAssertion(`响应状态 ${name}`, () => {
            if (!ok) throw new AssertionError(`实际状态 ${status}`)
          }),
        enumerable: false,
      })
    }
    flag('ok', status >= 200 && status < 300)
    flag('success', status >= 200 && status < 300)
    flag('clientError', status >= 400 && status < 500)
    flag('serverError', status >= 500 && status < 600)
    flag('error', status >= 400)

    return {
      code: status,
      status: statusText,
      statusText,
      responseTime: timeMs,
      headers: responseHeaders,
      cookies: {
        get: (name: string): string | undefined => cookieMap[name],
        has: (name: string): boolean => name in cookieMap,
        toObject: (): Record<string, string> => ({ ...cookieMap }),
      },
      text: (): string => body,
      json: (): unknown => JSON.parse(body) as unknown,
      size: (): number => Buffer.byteLength(body, 'utf8'),
      to,
    }
  }

  const pm: Dict = {
    info: {
      eventName: job.kind === 'pre' ? 'prerequest' : 'test',
      requestName: job.requestName,
      requestId: job.requestId,
      iteration: job.iteration,
      iterationCount: job.iterationCount,
    },
    request,
    variables,
    collectionVariables: scopeApi('collection', {
      collectionId: job.collectionId ?? undefined,
    }),
    environment: scopeApi('env'),
    globals: scopeApi('global'),
    iterationData: {
      get: (key: string): string | undefined => iterationLayer.get(key),
      has: (key: string): boolean => iterationLayer.has(key),
      toObject: (): Record<string, string> => Object.fromEntries(iterationLayer),
    },
    expect,
  }

  if (job.response) {
    const response = job.response
    pm['response'] = responseApi(
      response.status,
      response.statusText,
      response.headers,
      response.body,
      response.timeMs,
    )
  }

  const cookies = new Map((job.cookies ?? []).map((c) => [c.name, c.value] as [string, string]))
  pm['cookies'] = {
    get: (name: string): string | undefined => cookies.get(name),
    has: (name: string): boolean => cookies.has(name),
    set: (name: string, value: unknown): void => {
      cookies.set(name, String(value))
      trackWrite(host.cookieWrite('set', name, String(value)))
    },
    unset: (name: string): void => {
      cookies.delete(name)
      trackWrite(host.cookieWrite('unset', name))
    },
    toObject: (): Record<string, string> => Object.fromEntries(cookies),
    jar: (): never => {
      throw new Error('pm.cookies.jar() 的异步域接口未提供，请改用 pm.cookies.get / set / unset')
    },
  }

  let testIndex = 0
  const pmTest = (name: string, fn?: (done: (err?: unknown) => void) => unknown): void => {
    testIndex += 1
    if (typeof fn !== 'function') {
      host.assertions.push({ name, pass: true, skipped: true })
      return
    }
    try {
      if (fn.length >= 1) {
        const entry: PmTestResult = { name, pass: true }
        host.assertions.push(entry)
        host.pending.push(
          new Promise<void>((resolve) => {
            let settled = false
            const done = (err?: unknown): void => {
              if (settled) return
              settled = true
              if (err !== undefined && err !== null) {
                entry.pass = false
                entry.error = errorText(err)
              }
              resolve()
            }
            try {
              const out = fn(done)
              if (out && typeof (out as Promise<unknown>).then === 'function') {
                Promise.resolve(out).then(
                  () => done(),
                  (e: unknown) => done(e),
                )
              }
            } catch (e) {
              done(e)
            }
          }),
        )
        return
      }
      const out = fn(() => undefined)
      if (out && typeof (out as Promise<unknown>).then === 'function') {
        const entry: PmTestResult = { name, pass: true }
        host.assertions.push(entry)
        host.pending.push(
          Promise.resolve(out).then(
            () => undefined,
            (e: unknown) => {
              entry.pass = false
              entry.error = errorText(e)
            },
          ),
        )
      } else {
        host.assertions.push({ name, pass: true })
      }
    } catch (e) {
      host.assertions.push({ name, pass: false, error: errorText(e) })
    }
  }
  Object.defineProperty(pmTest, 'skip', {
    value: (name: string): void => {
      testIndex += 1
      host.assertions.push({ name, pass: true, skipped: true })
    },
  })
  Object.defineProperty(pmTest, 'index', {
    get: () => testIndex,
  })
  pm['test'] = pmTest

  const sendRequest = (
    input: unknown,
    callback?: (err: Error | null, res?: Dict) => void,
  ): Promise<Dict> => {
    const options = typeof input === 'string' ? { url: input } : isObject(input) ? input : {}
    let url =
      typeof options['url'] === 'string'
        ? options['url']
        : String((options['url'] as Dict)?.['raw'] ?? '')
    const method = String(options['method'] ?? 'GET').toUpperCase()
    const headersRecord: Record<string, string> = {}
    for (const [key, value] of parseHeaders(options['header'])) headersRecord[key] = value
    const bodyValue = options['body']
    let body = ''
    if (typeof bodyValue === 'string') body = bodyValue
    else if (isObject(bodyValue)) body = String(bodyValue['raw'] ?? '')

    const auth = options['auth']
    if (isObject(auth)) {
      const type = String(auth['type'] ?? '')
      if (type === 'basic') {
        headersRecord['Authorization'] = basicAuth(
          String(auth['username'] ?? ''),
          String(auth['password'] ?? ''),
        )
      } else if (type === 'bearer') {
        headersRecord['Authorization'] = `Bearer ${String(auth['token'] ?? '')}`
      } else if (type === 'apikey') {
        const key = String(auth['key'] ?? '')
        const value = String(auth['value'] ?? '')
        if (auth['in'] === 'query' || auth['addTo'] === 'query')
          url += `${url.includes('?') ? '&' : '?'}${encodeURIComponent(key)}=${encodeURIComponent(value)}`
        else headersRecord[key] = value
      }
    }

    const promise = host
      .subRequest({
        method: method as SubRequestCall['method'],
        url,
        headers: headersRecord,
        body: body || undefined,
      })
      .then((result) => {
        const response = responseApi(
          result.status,
          result.statusText,
          result.headers,
          result.body,
          result.timeMs,
        )
        callback?.(null, response)
        return response
      })
      .catch((e: unknown) => {
        const error = e instanceof Error ? e : new Error(String(e))
        callback?.(error)
        throw error
      })
    // 回调风格调用方通常忽略返回值；挂一个空 catch 防止 worker 因未处理拒绝而崩溃
    promise.catch(() => undefined)
    return promise
  }
  pm['sendRequest'] = sendRequest

  pm['execution'] = {
    setNextRequest: (target?: string | null): void => {
      if (!job.runner) {
        host.log('warn', 'pm.execution.setNextRequest 只在集合 Runner / CLI 内生效，本次调用已忽略')
        return
      }
      // 未传参等同 null：结束本轮迭代（Postman 语义）
      host.nextRequest = target === undefined || target === null ? null : String(target)
    },
    skipRequest: (reason?: string): void => host.skip(reason ?? 'skipped by script'),
  }
  pm['visualizer'] = {
    set: (): void => {
      host.log('warn', 'pm.visualizer 将在 B4 提供，本次调用已忽略')
    },
  }
  pm['require'] = (): never => {
    throw new Error('沙箱不允许 require；请使用内置 _ / CryptoJS / uuid / moment')
  }

  return pm
}

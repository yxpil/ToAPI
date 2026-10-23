import { parentPort } from 'node:worker_threads'
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import vm from 'node:vm'
import type { HostToWorker, SubRequestCall, SubRequestResult, WorkerToHost } from './protocol'

const port = parentPort
if (!port) throw new Error('script worker 必须由 worker_threads 启动')

const post = (msg: WorkerToHost): void => port.postMessage(msg)

class AssertionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AssertionError'
  }
}

const stringify = (value: unknown): string => {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

const deepEqual = (a: unknown, b: unknown): boolean => {
  const sa = stringify(a)
  const sb = stringify(b)
  if (sa === sb) return true
  const bufA = Buffer.from(sa)
  const bufB = Buffer.from(sb)
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
}

const makeExpect = (actual: unknown) => ({
  toBe: (expected: unknown): void => {
    if (actual !== expected)
      throw new AssertionError(`期望 ${stringify(expected)}，实际 ${stringify(actual)}`)
  },
  toEqual: (expected: unknown): void => {
    if (!deepEqual(actual, expected)) {
      throw new AssertionError(`值不相等：期望 ${stringify(expected)}，实际 ${stringify(actual)}`)
    }
  },
  toContain: (needle: string): void => {
    const text = typeof actual === 'string' ? actual : stringify(actual)
    if (!text.includes(needle)) throw new AssertionError(`${text.slice(0, 120)} 不包含 ${needle}`)
  },
  toMatch: (pattern: string): void => {
    const text = typeof actual === 'string' ? actual : stringify(actual)
    if (!new RegExp(pattern).test(text))
      throw new AssertionError(`${text.slice(0, 120)} 不匹配 /${pattern}/`)
  },
  toBeLessThan: (limit: number): void => {
    if (!(typeof actual === 'number' && actual < limit)) {
      throw new AssertionError(`${stringify(actual)} 不小于 ${limit}`)
    }
  },
  toBeGreaterThan: (limit: number): void => {
    if (!(typeof actual === 'number' && actual > limit)) {
      throw new AssertionError(`${stringify(actual)} 不大于 ${limit}`)
    }
  },
  toBeDefined: (): void => {
    if (actual === undefined) throw new AssertionError('值未定义')
  },
  toBeNull: (): void => {
    if (actual !== null) throw new AssertionError(`期望 null，实际 ${stringify(actual)}`)
  },
})

let seq = 0
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

const ask = <T>(build: (id: number) => WorkerToHost): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const id = ++seq
    waiting.set(id, { resolve: resolve as (v: unknown) => void, reject })
    port.postMessage(build(id))
  })

const subRequest = (call: SubRequestCall): Promise<SubRequestResult> =>
  ask<SubRequestResult>((id) => ({ type: 'subRequest', id, call }))

const varWrite = (scope: 'env' | 'global', key: string, value: string): Promise<void> =>
  ask<void>((id) => ({ type: 'varWrite', id, scope, key, value }))

port.on('message', (msg: HostToWorker) => {
  if (msg.type === 'subResponse') {
    const w = waiting.get(msg.id)
    if (!w) return
    waiting.delete(msg.id)
    if (msg.ok) w.resolve(msg.result)
    else w.reject(new Error(msg.error ?? '子请求失败'))
    return
  }
  if (msg.type === 'varWriteAck') {
    const w = waiting.get(msg.id)
    if (!w) return
    waiting.delete(msg.id)
    w.resolve(undefined)
  }
})

const buildToapi = (
  job: Extract<HostToWorker, { type: 'job' }>['job'],
  state: {
    request: {
      method: string
      url: string
      headers: Record<string, string>
      body: string
      bodyType: string
    }
    runtime: Map<string, string>
    fake: Record<string, unknown>
    assertions: { name: string; pass: boolean; error?: string }[]
    skip?: string
  },
): Record<string, unknown> => {
  const toapi: Record<string, unknown> = {}

  const request = Object.create(null) as Record<string, unknown>
  Object.defineProperty(request, 'method', {
    get: () => state.request.method,
    set: (v: string) => {
      state.request.method = v
    },
  })
  Object.defineProperty(request, 'url', {
    get: () => state.request.url,
    set: (v: string) => {
      state.request.url = v
    },
  })
  Object.defineProperty(request, 'body', {
    get: () => state.request.body,
    set: (v: string) => {
      state.request.body = String(v)
    },
  })
  request.headers = state.request.headers
  request.setHeader = (key: string, value: string): void => {
    state.request.headers[key] = String(value)
  }
  request.setBody = (value: string): void => {
    state.request.body = String(value)
  }
  request.skip = (reason?: string): void => {
    state.skip = reason ?? 'skipped by script'
  }
  request.send = (call: SubRequestCall): Promise<SubRequestResult & { json: () => unknown }> =>
    subRequest(call).then((r) => ({ ...r, json: () => JSON.parse(r.body) as unknown }))
  toapi.request = request

  if (job.response) {
    const res = Object.create(null) as Record<string, unknown>
    res.status = job.response.status
    res.statusText = job.response.statusText
    res.headers = Object.fromEntries(job.response.headers)
    res.body = job.response.body
    res.timeMs = job.response.timeMs
    res.json = () => JSON.parse(job.response?.body ?? 'null') as unknown
    toapi.response = res
  }

  toapi.vars = {
    get: (key: string): string | undefined => state.runtime.get(key) ?? job.vars[key],
    set: (key: string, value: string): void => {
      state.runtime.set(key, String(value))
    },
  }
  const write =
    (scope: 'env' | 'global') =>
    (key: string, value: string): Promise<void> =>
      varWrite(scope, key, String(value))
  toapi.env = { set: write('env'), get: (key: string) => state.runtime.get(key) ?? job.vars[key] }
  toapi.globals = {
    set: write('global'),
    get: (key: string) => state.runtime.get(key) ?? job.vars[key],
  }

  toapi.fake = {
    ua: (value: string): void => {
      state.fake.ua = value
    },
    header: (key: string, value: string): void => {
      const list = (state.fake.headers ??= []) as { key: string; value: string }[]
      const at = list.findIndex((h) => h.key.toLowerCase() === key.toLowerCase())
      if (at >= 0) list[at] = { key, value }
      else list.push({ key, value })
    },
    proxy: (url: string): void => {
      state.fake.proxy = { enabled: true, url }
    },
    timeout: (ms: number): void => {
      state.fake.timeoutMs = ms
    },
    noRedirects: (): void => {
      state.fake.followRedirects = false
    },
  }

  toapi.test = (name: string, fn: () => unknown): void => {
    try {
      const out = fn()
      if (out && typeof (out as Promise<unknown>).then === 'function') {
        throw new AssertionError('toapi.test 不支持异步断言，请改用 toapi.asyncTest')
      }
      state.assertions.push({ name, pass: true })
    } catch (e) {
      state.assertions.push({ name, pass: false, error: (e as Error).message })
    }
  }
  toapi.expect = makeExpect

  toapi.log = (...args: unknown[]): void =>
    post({ type: 'log', level: 'log', text: args.map(stringify).join(' ') })
  toapi.warn = (...args: unknown[]): void =>
    post({ type: 'log', level: 'warn', text: args.map(stringify).join(' ') })
  toapi.error = (...args: unknown[]): void =>
    post({ type: 'log', level: 'error', text: args.map(stringify).join(' ') })

  toapi.uuid = (): string => randomUUID()
  toapi.timestamp = (): number => Date.now()
  toapi.randomInt = (min: number, max: number): number =>
    min + Math.floor(Math.random() * (max - min + 1))
  toapi.base64Encode = (s: string): string => Buffer.from(s, 'utf8').toString('base64')
  toapi.base64Decode = (s: string): string => Buffer.from(s, 'base64').toString('utf8')
  toapi.md5 = (s: string): string => createHash('md5').update(s).digest('hex')
  toapi.sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
  toapi.hmacSha256 = (key: string, s: string): string =>
    createHmac('sha256', key).update(s).digest('hex')
  toapi.sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(Number(ms) || 0, 0), 30_000)))

  return toapi
}

const WARMUP = `(async () => {\n`
const CLOSING = `\n})()`

async function run(job: Extract<HostToWorker, { type: 'job' }>['job']): Promise<void> {
  const state = {
    request: { ...job.request, headers: { ...job.request.headers } },
    runtime: new Map<string, string>(),
    fake: {} as Record<string, unknown>,
    assertions: [] as { name: string; pass: boolean; error?: string }[],
    skip: undefined as string | undefined,
  }

  const sandbox = { toapi: buildToapi(job, state) }
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } })

  let script: vm.Script
  try {
    script = new vm.Script(WARMUP + job.code + CLOSING, { filename: `toapi-${job.kind}-script.js` })
  } catch (e) {
    post({ type: 'fail', message: `脚本语法错误: ${(e as Error).message}` })
    return
  }

  try {
    // timeout 只覆盖同步阶段；异步阶段的失控由宿主 terminate 兜底（05 号文档 §6）
    await script.runInContext(context, { timeout: Math.min(job.timeoutMs, 5_000) })
  } catch (e) {
    post({ type: 'fail', message: (e as Error).message })
    return
  }

  post({
    type: 'done',
    request: state.request as never,
    fake: state.fake,
    skip: state.skip,
    runtimeWrites: Object.fromEntries(state.runtime),
    assertions: state.assertions,
  })
}

port.on('message', (msg: HostToWorker) => {
  if (msg.type === 'job') void run(msg.job)
})

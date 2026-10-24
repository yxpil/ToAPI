import { parentPort } from 'node:worker_threads'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import vm from 'node:vm'
import lodash from 'lodash'
import CryptoJS from 'crypto-js'
import moment from 'moment'
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid'
import type { FakeConfig } from '@shared/types'
import { dynamicVar } from '../postman/dynamic-vars'
import { expect } from './expect'
import { buildPm, type PmHost, type PmTestResult } from './pm'
import type {
  HostToWorker,
  ScriptJob,
  ScriptRequest,
  ScriptVarScope,
  SubRequestCall,
  SubRequestResult,
  WorkerToHost,
} from './protocol'

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

const varWrite = (
  scope: ScriptVarScope,
  key: string,
  value: string,
  collectionId?: string,
): Promise<void> => ask<void>((id) => ({ type: 'varWrite', id, scope, key, value, collectionId }))

const varUnset = (scope: ScriptVarScope, key: string, collectionId?: string): Promise<void> =>
  ask<void>((id) => ({ type: 'varUnset', id, scope, key, collectionId }))

const cookieWrite = (op: 'set' | 'unset', name: string, value?: string): Promise<void> =>
  ask<void>((id) => ({ type: 'cookieWrite', id, op, name, value }))

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
    if (msg.ok === false) w.reject(new Error(msg.error ?? '变量写入失败'))
    else w.resolve(undefined)
  }
})

interface WorkerState {
  request: ScriptRequest
  runtime: Map<string, string>
  local: Map<string, string>
  fake: Record<string, unknown>
  assertions: PmTestResult[]
  pending: Promise<void>[]
  writes: Promise<void>[]
  errors: string[]
  skip?: string
}

const buildToapi = (job: ScriptJob, state: WorkerState): Record<string, unknown> => {
  const toapi: Record<string, unknown> = {}

  const request = Object.create(null) as Record<string, unknown>
  Object.defineProperty(request, 'method', {
    get: () => state.request.method,
    set: (v: string) => {
      state.request.method = v as ScriptRequest['method']
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

  const getVar = (key: string): string | undefined =>
    state.local.get(key) ?? state.runtime.get(key) ?? job.vars[key] ?? dynamicVar(key)

  toapi.vars = {
    get: getVar,
    set: (key: string, value: string): void => {
      state.runtime.set(key, String(value))
    },
  }
  const writeScope =
    (scope: ScriptVarScope) =>
    (key: string, value: string): Promise<void> =>
      varWrite(scope, key, String(value)).catch((e: unknown) => {
        state.errors.push((e as Error).message)
      })
  toapi.env = { set: writeScope('env'), get: getVar }
  toapi.globals = { set: writeScope('global'), get: getVar }

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
        throw new AssertionError('toapi.test 不支持异步断言，请改用 pm.test')
      }
      state.assertions.push({ name, pass: true })
    } catch (e) {
      state.assertions.push({ name, pass: false, error: (e as Error).message })
    }
  }
  toapi.expect = expect

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

const settle = async (state: WorkerState): Promise<void> => {
  while (state.pending.length > 0 || state.writes.length > 0) {
    const pending = state.pending.splice(0)
    const writes = state.writes.splice(0)
    await Promise.all([...pending, ...writes])
  }
}

const WARMUP = `(async () => {\n`
const CLOSING = `\n})()`

async function run(job: ScriptJob): Promise<void> {
  const state: WorkerState = {
    request: { ...job.request, headers: { ...job.request.headers } },
    runtime: new Map<string, string>(),
    local: new Map<string, string>(Object.entries(job.scopes.local)),
    fake: {},
    assertions: [],
    pending: [],
    writes: [],
    errors: [],
    skip: undefined,
  }

  const host: PmHost = {
    job,
    request: state.request,
    local: state.local,
    assertions: state.assertions,
    pending: state.pending,
    writes: state.writes,
    errors: state.errors,
    nextRequest: undefined,
    skip: (reason?: string) => {
      state.skip = reason ?? 'skipped by script'
    },
    subRequest,
    varWrite,
    varUnset,
    cookieWrite,
    log: (level, text) => post({ type: 'log', level, text }),
  }
  const pm = buildPm(host)

  // 沙箱库在启动时注入（23 号文档 §4.4），不暴露 require / process / 文件系统
  const sandbox = {
    toapi: buildToapi(job, state),
    pm,
    _: lodash,
    CryptoJS,
    uuid: { v4: uuidv4, v7: uuidv7 },
    moment,
    atob: (input: string): string => Buffer.from(String(input), 'base64').toString('latin1'),
    btoa: (input: string): string => Buffer.from(String(input), 'latin1').toString('base64'),
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console: {
      log: (...args: unknown[]) =>
        post({ type: 'log', level: 'log', text: args.map(stringify).join(' ') }),
      info: (...args: unknown[]) =>
        post({ type: 'log', level: 'log', text: args.map(stringify).join(' ') }),
      debug: (...args: unknown[]) =>
        post({ type: 'log', level: 'log', text: args.map(stringify).join(' ') }),
      warn: (...args: unknown[]) =>
        post({ type: 'log', level: 'warn', text: args.map(stringify).join(' ') }),
      error: (...args: unknown[]) =>
        post({ type: 'log', level: 'error', text: args.map(stringify).join(' ') }),
    },
  }
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
    await settle(state)
  } catch (e) {
    post({ type: 'fail', message: (e as Error).message })
    return
  }

  for (const error of state.errors) {
    state.assertions.push({ name: '脚本变量写入', pass: false, error })
  }

  post({
    type: 'done',
    request: state.request,
    fake: state.fake as FakeConfig,
    skip: state.skip,
    runtimeWrites: Object.fromEntries(state.runtime),
    localWrites: Object.fromEntries(state.local),
    ...(host.nextRequest === undefined ? {} : { nextRequest: host.nextRequest }),
    assertions: state.assertions,
  })
}

port.on('message', (msg: HostToWorker) => {
  if (msg.type === 'job') void run(msg.job)
})

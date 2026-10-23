import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createKernel, type Kernel } from '@main/kernel'
import { startRange, type Range } from '../../fixtures/range'

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..')
const WORKER = join(repoRoot, 'dist-electron/script-worker.cjs')

let kernel: Kernel
let range: Range
let dir: string
let projectId: string
let collectionId: string
let envId: string
let seq = 0

const cancelId = (): string => `C${String(seq++).padStart(25, '0')}`
const rawHeaderLine = (): string => (range.last()?.rawHeaders ?? []).join('|')

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'toapi-script-'))
  range = await startRange()
  kernel = createKernel({
    dbPath: ':memory:',
    filesDir: dir,
    appVersion: 'test',
    scriptWorkerPath: WORKER,
  })
  expect(kernel.script).not.toBeNull()

  const project = await kernel.invoke('project:create', { name: '脚本项目' })
  projectId = project.id
  const collection = await kernel.invoke('collection:create', { projectId, name: '集合' })
  collectionId = collection.id
  const env = await kernel.invoke('env:create', { projectId, name: 'dev' })
  envId = env.id
  await kernel.invoke('env:activate', { projectId, environmentId: env.id })
  await kernel.invoke('var:set', {
    scope: 'environment',
    environmentId: env.id,
    key: 'baseUrl',
    value: range.origin,
  })
})

afterAll(() => {
  kernel.dispose()
  void range.close()
  rmSync(dir, { recursive: true, force: true })
})

const makeApi = async (name: string, patch: Record<string, unknown>): Promise<string> => {
  const api = await kernel.invoke('api:create', {
    collectionId,
    name,
    url: '{{baseUrl}}/echo',
    method: 'GET',
  })
  await kernel.invoke('api:update', { id: api.id, ...patch })
  return api.id
}

describe('前置脚本', () => {
  it('可改写 Header 并参与签名计算', async () => {
    const id = await makeApi('签名', {
      preScript: `
        const ts = toapi.timestamp()
        toapi.request.setHeader('X-Sign', toapi.md5('secret' + ts))
        toapi.request.setHeader('X-Ts', String(ts))
      `,
    })
    const result = await kernel.invoke('api:send', { apiId: id, cancelId: cancelId() })

    expect(result.response.status).toBe(200)
    expect(rawHeaderLine()).toContain('X-Sign')
    const sign = result.finalRequest.headers.find(([k]) => k === 'X-Sign')?.[1] ?? ''
    expect(sign).toMatch(/^[0-9a-f]{32}$/)
  })

  it('可改写 URL 与方法', async () => {
    const id = await makeApi('改写', {
      preScript: `toapi.request.url = toapi.vars.get('baseUrl') + '/token?user=scripted'; toapi.request.method = 'GET'`,
    })
    const result = await kernel.invoke('api:send', { apiId: id, cancelId: cancelId() })
    expect(result.finalRequest.url).toContain('/token?user=scripted')
    expect(result.response.status).toBe(201)
  })

  it('skip() 后不发请求并标记 SKIPPED', async () => {
    const before = range.requests.length
    const id = await makeApi('跳过', { preScript: `toapi.request.skip('条件不满足')` })
    const result = await kernel.invoke('api:send', { apiId: id, cancelId: cancelId() })

    expect(result.skipped).toBe(true)
    expect(result.skipReason).toBe('条件不满足')
    expect(range.requests.length).toBe(before)
  })

  it('toapi.request.send 子请求可取 token 再注入主请求（05 号文档 §7）', async () => {
    const id = await makeApi('链式', {
      preScript: `
        const login = await toapi.request.send({
          method: 'GET',
          url: toapi.vars.get('baseUrl') + '/token?user=qa',
        })
        toapi.test('登录成功', () => toapi.expect(login.status).toBe(201))
        const token = login.json().data.token
        toapi.vars.set('token', token)
        toapi.request.setHeader('Authorization', 'Bearer ' + token)
      `,
    })
    const result = await kernel.invoke('api:send', { apiId: id, cancelId: cancelId() })

    expect(result.script.assertions).toEqual([{ name: '登录成功', pass: true }])
    expect(result.finalRequest.headers).toContainEqual(['Authorization', 'Bearer TOK-qa'])
    expect(kernel.flow.runtimeFor(projectId).get('token')).toBe('TOK-qa')
  })

  it('fake API 改写 UA 与超时', async () => {
    const id = await makeApi('伪装脚本', {
      preScript: `toapi.fake.ua('@preset:okhttp'); toapi.fake.timeout(8000)`,
    })
    await kernel.invoke('api:send', { apiId: id, cancelId: cancelId() })
    expect(rawHeaderLine()).toContain('okhttp/4.12.0')
  })

  it('env.set 写入当前环境并可被后续请求插值', async () => {
    const id = await makeApi('写环境', {
      preScript: `toapi.env.set('traceId', 'T-777')`,
    })
    await kernel.invoke('api:send', { apiId: id, cancelId: cancelId() })

    const listed = await kernel.invoke('env:list', { projectId })
    expect(listed.vars.find((v) => v.key === 'traceId' && v.environmentId === envId)?.value).toBe(
      'T-777',
    )

    const downstream = await makeApi('读环境', {
      headers: [{ key: 'X-Trace', value: '{{traceId}}', enabled: true, desc: '' }],
    })
    const r2 = await kernel.invoke('api:send', { apiId: downstream, cancelId: cancelId() })
    expect(r2.finalRequest.headers).toContainEqual(['X-Trace', 'T-777'])
  })
})

describe('后置脚本与断言', () => {
  it('断言全部通过时 pass 记录完整', async () => {
    const id = await makeApi('断言通过', {
      postScript: `
        toapi.test('状态 200', () => toapi.expect(toapi.response.status).toBe(200))
        toapi.test('回显 method', () => toapi.expect(toapi.response.json().method).toBe('GET'))
        toapi.test('耗时存在', () => toapi.expect(toapi.response.timeMs).toBeGreaterThan(-1))
      `,
    })
    const result = await kernel.invoke('api:send', { apiId: id, cancelId: cancelId() })

    expect(result.script.assertions.every((a) => a.pass)).toBe(true)
    expect(result.script.assertions.map((a) => a.name)).toEqual([
      '状态 200',
      '回显 method',
      '耗时存在',
    ])
  })

  it('断言失败不推翻响应，以失败项呈现', async () => {
    const id = await makeApi('断言失败', {
      postScript: `toapi.test('期望 500', () => toapi.expect(toapi.response.status).toBe(500))`,
    })
    const result = await kernel.invoke('api:send', { apiId: id, cancelId: cancelId() })

    expect(result.response.status).toBe(200)
    expect(result.script.assertions[0]).toMatchObject({ name: '期望 500', pass: false })
    expect(result.script.assertions[0]?.error).toContain('期望 500，实际 200')
  })

  it('脚本 console 走 toapi.log 并回传', async () => {
    const id = await makeApi('日志', { postScript: `toapi.log('调试值', 42); toapi.warn('注意')` })
    const result = await kernel.invoke('api:send', { apiId: id, cancelId: cancelId() })

    expect(result.script.postLogs.map((l) => l.text)).toEqual(['调试值 42', '注意'])
    expect(result.script.postLogs[1]?.level).toBe('warn')
  })
})

describe('沙箱边界（07 号文档 §2.3）', () => {
  it('require 不可达', async () => {
    const id = await makeApi('逃逸 require', {
      preScript: `const fs = require('node:fs'); toapi.request.setHeader('X', fs.readFileSync('/etc/passwd','utf8'))`,
    })
    await expect(kernel.invoke('api:send', { apiId: id, cancelId: cancelId() })).rejects.toThrow(
      /require|前置脚本/,
    )
  })

  it('fetch / process 等宿主能力在沙箱内不存在', async () => {
    const id = await makeApi('逃逸 fetch', {
      preScript: `await fetch('http://127.0.0.1:1/anything')`,
    })
    await expect(kernel.invoke('api:send', { apiId: id, cancelId: cancelId() })).rejects.toThrow(
      'fetch is not defined',
    )

    const id2 = await makeApi('逃逸 process', { preScript: `process.exit(0)` })
    await expect(kernel.invoke('api:send', { apiId: id2, cancelId: cancelId() })).rejects.toThrow(
      'process is not defined',
    )
  })

  it('同步死循环被熔断，且熔断后引擎仍可用', async () => {
    const id = await makeApi('死循环', { preScript: `while (true) {}` })
    const startedAt = Date.now()
    await expect(kernel.invoke('api:send', { apiId: id, cancelId: cancelId() })).rejects.toThrow(
      '熔断',
    )
    expect(Date.now() - startedAt).toBeLessThan(9000)

    const ok = await makeApi('熔断后恢复', {})
    const result = await kernel.invoke('api:send', { apiId: ok, cancelId: cancelId() })
    expect(result.response.status).toBe(200)
  }, 20000)

  it('异步悬挂（永不 resolve）同样被强杀', async () => {
    const id = await makeApi('异步悬挂', { preScript: `await new Promise(() => {})` })
    await expect(kernel.invoke('api:send', { apiId: id, cancelId: cancelId() })).rejects.toThrow(
      '熔断',
    )
  }, 20000)

  it('语法错误返回 SCRIPT_ERROR 而非崩溃', async () => {
    const id = await makeApi('语法错误', { preScript: `const = ;(` })
    await expect(kernel.invoke('api:send', { apiId: id, cancelId: cancelId() })).rejects.toThrow(
      '语法错误',
    )
  })

  it('子请求递归超过深度上限被拒绝', async () => {
    const id = await makeApi('递归', {
      preScript: `
        const recurse = async (n) => {
          const r = await toapi.request.send({ method: 'GET', url: toapi.vars.get('baseUrl') + '/echo?n=' + n })
          if (n > 0) await recurse(n - 1)
          return r.status
        }
        await recurse(0)
        toapi.request.setHeader('X-R', '1')
      `,
    })
    const result = await kernel.invoke('api:send', { apiId: id, cancelId: cancelId() })
    expect(result.response.status).toBe(200)

    const deep = await makeApi('超深递归', {
      preScript: `
        const recurse = async () => {
          await toapi.request.send({ method: 'GET', url: toapi.vars.get('baseUrl') + '/echo' })
          await recurse()
        }
        await recurse()
      `,
    })
    await expect(kernel.invoke('api:send', { apiId: deep, cancelId: cancelId() })).rejects.toThrow(
      /层级|子请求/,
    )
  }, 30000)
})

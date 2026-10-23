import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createKernel, type Kernel } from '@main/kernel'
import { startRange, type Range } from '../../fixtures/range'

let kernel: Kernel
let range: Range
let dir: string
let projectId: string
let collectionId: string

const cancelSeq = ((): (() => string) => {
  let n = 0
  return () => `CANCEL${String(n++).padStart(22, '0')}`
})()

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'toapi-flow-'))
  range = await startRange()
  kernel = createKernel({ dbPath: ':memory:', filesDir: dir, appVersion: 'test' })

  const project = await kernel.invoke('project:create', { name: '链路项目' })
  projectId = project.id
  const collection = await kernel.invoke('collection:create', { projectId, name: '认证' })
  collectionId = collection.id

  const env = await kernel.invoke('env:create', { projectId, name: 'dev' })
  await kernel.invoke('env:activate', { projectId, environmentId: env.id })
  await kernel.invoke('var:set', {
    scope: 'environment',
    environmentId: env.id,
    key: 'baseUrl',
    value: range.origin,
  })
  await kernel.invoke('var:set', {
    scope: 'environment',
    environmentId: env.id,
    key: 'username',
    value: 'qa-user',
  })
})

afterAll(() => {
  kernel.dispose()
  void range.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('M1 验收链路：登录取 token → 带 token 请求', () => {
  it('登录接口提取 token 到运行时变量', async () => {
    const login = await kernel.invoke('api:create', {
      collectionId,
      name: '登录',
      method: 'GET',
      url: '{{baseUrl}}/token?user={{username}}',
    })
    await kernel.invoke('api:update', {
      id: login.id,
      extractors: [
        { name: 'token', source: 'body', type: 'jsonpath', expr: '$.data.token', scope: 'runtime' },
      ],
    })

    const result = await kernel.invoke('api:send', { apiId: login.id, cancelId: cancelSeq() })

    expect(result.response.status).toBe(201)
    expect(result.extracted).toEqual([
      { name: 'token', scope: 'runtime', valuePreview: 'TOK-qa-user' },
    ])
    expect(kernel.flow.runtimeFor(projectId).get('token')).toBe('TOK-qa-user')
  })

  it('下游接口用 {{token}} 自动携带（联调链式）', async () => {
    const downstream = await kernel.invoke('api:create', {
      collectionId,
      name: '查订单',
      method: 'GET',
      url: '{{baseUrl}}/echo',
    })
    await kernel.invoke('api:update', {
      id: downstream.id,
      headers: [{ key: 'Authorization', value: 'Bearer {{token}}', enabled: true, desc: '' }],
    })

    const result = await kernel.invoke('api:send', { apiId: downstream.id, cancelId: cancelSeq() })

    expect(result.finalRequest.headers).toContainEqual(['Authorization', 'Bearer TOK-qa-user'])
    const raw = range.last()?.rawHeaders ?? []
    expect(raw.join('|')).toContain('Bearer TOK-qa-user')
  })

  it('query 参数与 URL 变量插值一起生效', async () => {
    const api = await kernel.invoke('api:create', {
      collectionId,
      name: '带参',
      url: '{{baseUrl}}/echo',
    })
    await kernel.invoke('api:update', {
      id: api.id,
      params: [
        { key: 'page', value: '2', enabled: true, desc: '' },
        { key: 'off', value: '1', enabled: false, desc: '' },
      ],
    })
    const result = await kernel.invoke('api:send', { apiId: api.id, cancelId: cancelSeq() })
    expect(result.finalRequest.url).toContain('page=2')
    expect(result.finalRequest.url).not.toContain('off=1')
  })

  it('未命中的变量保留原文（不静默丢参数）', async () => {
    const api = await kernel.invoke('api:create', {
      collectionId,
      name: '缺变量',
      url: '{{baseUrl}}/echo',
    })
    await kernel.invoke('api:update', {
      id: api.id,
      headers: [{ key: 'X-Trace', value: '{{notDefined}}', enabled: true, desc: '' }],
    })
    const result = await kernel.invoke('api:send', { apiId: api.id, cancelId: cancelSeq() })
    expect(result.finalRequest.headers).toContainEqual(['X-Trace', '{{notDefined}}'])
  })

  it('Cookie Jar：上一个响应种的 cookie 自动带到下一个请求', async () => {
    const plant = await kernel.invoke('api:create', {
      collectionId,
      name: '种 cookie',
      url: '{{baseUrl}}/cookie',
    })
    await kernel.invoke('api:send', { apiId: plant.id, cancelId: cancelSeq() })

    const echo = await kernel.invoke('api:create', {
      collectionId,
      name: '读 cookie',
      url: '{{baseUrl}}/echo',
    })
    await kernel.invoke('api:send', { apiId: echo.id, cancelId: cancelSeq() })

    const raw = range.last()?.rawHeaders.join('|') ?? ''
    expect(raw).toContain('sid=abc123')
    expect(raw).toContain('theme=dark')
  })

  it('伪装 UA 在接口级生效', async () => {
    const api = await kernel.invoke('api:create', {
      collectionId,
      name: '伪装',
      url: '{{baseUrl}}/echo',
    })
    await kernel.invoke('api:update', { id: api.id, fake: { ua: '@preset:okhttp' } })
    await kernel.invoke('api:send', { apiId: api.id, cancelId: cancelSeq() })
    expect(range.last()?.rawHeaders.join('|')).toContain('okhttp/4.12.0')
  })

  it('POST JSON 自动补 Content-Type 并送达请求体', async () => {
    const api = await kernel.invoke('api:create', {
      collectionId,
      name: '下单',
      method: 'POST',
      url: '{{baseUrl}}/echo',
    })
    await kernel.invoke('api:update', { id: api.id, bodyType: 'json', body: '{"sku":"A-001"}' })
    const result = await kernel.invoke('api:send', { apiId: api.id, cancelId: cancelSeq() })

    expect(result.finalRequest.headers).toContainEqual(['Content-Type', 'application/json'])
    expect(range.last()?.body).toBe('{"sku":"A-001"}')
  })

  it('超时映射为 TIMEOUT 错误码', async () => {
    const api = await kernel.invoke('api:create', {
      collectionId,
      name: '慢接口',
      url: '{{baseUrl}}/slow?ms=1500',
    })
    await kernel.invoke('api:update', { id: api.id, fake: { timeoutMs: 200 } })
    await expect(
      kernel.invoke('api:send', { apiId: api.id, cancelId: cancelSeq() }),
    ).rejects.toThrow('请求超时')
  })
})

describe('历史与大响应体', () => {
  it('每次发送都写入历史并可按接口过滤', async () => {
    const page = await kernel.invoke('history:list', { projectId, limit: 100 })
    expect(page.items.length).toBeGreaterThan(3)
    expect(page.items.every((h) => h.status > 0)).toBe(true)
    expect(page.items[0]!.createdAt).toBeGreaterThanOrEqual(page.items.at(-1)!.createdAt)

    const onlyOne = await kernel.invoke('history:list', {
      apiId: page.items[0]!.apiId ?? undefined,
      limit: 5,
    })
    expect(onlyOne.items.every((h) => h.apiId === page.items[0]!.apiId)).toBe(true)
  })

  it('游标分页不重不漏', async () => {
    const first = await kernel.invoke('history:list', { projectId, limit: 2 })
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).toBeTruthy()

    const second = await kernel.invoke('history:list', {
      projectId,
      limit: 2,
      cursor: first.nextCursor,
    })
    const overlap = second.items.filter((h) => first.items.some((f) => f.id === h.id))
    expect(overlap).toHaveLength(0)
  })

  it('超过 256KB 的响应体落文件，列表不带正文', async () => {
    const api = await kernel.invoke('api:create', {
      collectionId,
      name: '大响应',
      url: '{{baseUrl}}/big?kb=600',
    })
    const result = await kernel.invoke('api:send', { apiId: api.id, cancelId: cancelSeq() })

    expect(result.response.bodyText).toBeUndefined()
    expect(result.response.bodyPath).toBeTruthy()
    expect(existsSync(result.response.bodyPath!)).toBe(true)
    expect(readFileSync(result.response.bodyPath!).byteLength).toBe(600 * 1024)
  })
})

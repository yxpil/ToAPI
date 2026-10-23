import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createKernel, type Kernel } from '@main/kernel'
import { startRange, type Range } from '../../fixtures/range'

const WORKER = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../dist-electron/script-worker.cjs',
)

let kernel: Kernel
let range: Range
let dir: string
let projectId: string
let collectionId: string
let seq = 0
let firstRunId = ''

const cancelId = (): string => `R${String(seq++).padStart(25, '0')}`

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const getRun = (runId: string) => kernel.invoke('runner:get', { id: runId })

const waitFinished = async (
  runId: string,
  timeoutMs = 25000,
): Promise<Awaited<ReturnType<typeof getRun>>> => {
  for (let waited = 0; waited < timeoutMs; waited += 100) {
    const run = await getRun(runId)
    if (run.finishedAt !== null) return run
    await sleep(100)
  }
  throw new Error(`Runner 未在 ${timeoutMs}ms 内结束`)
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'toapi-runner-'))
  range = await startRange()
  kernel = createKernel({
    dbPath: ':memory:',
    filesDir: dir,
    appVersion: 'test',
    scriptWorkerPath: WORKER,
  })

  const project = await kernel.invoke('project:create', { name: '回归项目' })
  projectId = project.id
  const collection = await kernel.invoke('collection:create', { projectId, name: '冒烟集合' })
  collectionId = collection.id
  const env = await kernel.invoke('env:create', { projectId, name: 'test' })
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

const addApi = async (
  name: string,
  patch: { url?: string; postScript?: string; headers?: { key: string; value: string }[] } = {},
): Promise<string> => {
  const api = await kernel.invoke('api:create', {
    collectionId,
    name,
    method: 'GET',
    url: patch.url ?? '{{baseUrl}}/echo',
  })
  await kernel.invoke('api:update', {
    id: api.id,
    postScript: patch.postScript ?? '',
    headers: (patch.headers ?? []).map((h) => ({ ...h, enabled: true, desc: '' })),
  })
  return api.id
}

describe('集合 Runner', () => {
  it('按顺序执行集合内接口并统计通过率', async () => {
    await addApi('A 取 token', {
      url: '{{baseUrl}}/token?user=runner',
      postScript: `
        toapi.test('状态 201', () => toapi.expect(toapi.response.status).toBe(201))
        toapi.vars.set('tk', toapi.response.json().data.token)
      `,
    })
    await addApi('B 断言失败', {
      postScript: `toapi.test('期望 404', () => toapi.expect(toapi.response.status).toBe(404))`,
    })
    await addApi('C 使用上游变量', {
      headers: [{ key: 'Authorization', value: 'Bearer {{tk}}' }],
      postScript: `toapi.test('状态 200', () => toapi.expect(toapi.response.status).toBe(200))`,
    })

    const { runId, total } = await kernel.invoke('runner:start', {
      scopeType: 'collection',
      scopeId: collectionId,
      cancelId: cancelId(),
    })
    expect(total).toBe(3)
    firstRunId = runId

    const run = await waitFinished(runId)
    expect(run.items.map((i) => i.apiName)).toEqual(['A 取 token', 'B 断言失败', 'C 使用上游变量'])
    expect(run.passed).toBe(2)
    expect(run.failed).toBe(1)
    expect(run.items[1]?.status).toBe('failed')
    expect(run.items[1]?.error ?? '').toContain('期望 404，实际 200')
    expect(run.items[2]?.assertions[0]?.pass).toBe(true)
  })

  it('运行时变量跨接口传递（登录 → 带 token）', async () => {
    const run = await getRun(firstRunId)
    const itemC = run.items.find((i) => i.apiName === 'C 使用上游变量')
    expect(itemC?.status).toBe('passed')

    // A 的 post 脚本写入 runtime 变量 tk，C 的 Header 用 {{tk}} 插值后真实落线
    expect(range.requests.some((r) => r.rawHeaders.join('|').includes('Bearer TOK-runner'))).toBe(
      true,
    )
    const detail = itemC?.historyId ? await kernel.invoke('history:list', { limit: 5 }) : null
    expect(detail?.items.some((h) => h.id === itemC?.historyId)).toBe(true)
  })

  it('stopOnFail 在首个失败处停止', async () => {
    const other = await kernel.invoke('collection:create', { projectId, name: '早停集合' })
    const a = await kernel.invoke('api:create', {
      collectionId: other.id,
      name: '会失败',
      method: 'GET',
      url: '{{baseUrl}}/echo',
    })
    await kernel.invoke('api:update', {
      id: a.id,
      postScript: `toapi.test('必然失败', () => toapi.expect(toapi.response.status).toBe(500))`,
    })
    await kernel.invoke('api:create', {
      collectionId: other.id,
      name: '不该执行',
      method: 'GET',
      url: '{{baseUrl}}/echo',
    })

    const before = range.requests.length
    const { runId } = await kernel.invoke('runner:start', {
      scopeType: 'collection',
      scopeId: other.id,
      cancelId: cancelId(),
      stopOnFail: true,
    })
    const run = await waitFinished(runId)

    expect(run.items).toHaveLength(1)
    expect(run.failed).toBe(1)
    expect(range.requests.length).toBe(before + 1)
  })

  it('空集合直接拒绝而不是产出空报告', async () => {
    const empty = await kernel.invoke('collection:create', { projectId, name: '空集合' })
    await expect(
      kernel.invoke('runner:start', {
        scopeType: 'collection',
        scopeId: empty.id,
        cancelId: cancelId(),
      }),
    ).rejects.toThrow('没有接口')
  })

  it('请求失败的接口记为 error 而不中断整轮', async () => {
    const c2 = await kernel.invoke('collection:create', { projectId, name: '含失败集合' })
    await kernel.invoke('api:create', {
      collectionId: c2.id,
      name: '不可达',
      method: 'GET',
      url: 'http://127.0.0.1:1/nope',
    })
    await kernel.invoke('api:create', {
      collectionId: c2.id,
      name: '正常',
      method: 'GET',
      url: '{{baseUrl}}/echo',
    })

    const { runId } = await kernel.invoke('runner:start', {
      scopeType: 'collection',
      scopeId: c2.id,
      cancelId: cancelId(),
    })
    const run = await waitFinished(runId)

    expect(run.items[0]?.status).toBe('error')
    expect(run.items[1]?.status).toBe('passed')
    expect(run.failed).toBe(1)
    expect(run.passed).toBe(1)
  })
})

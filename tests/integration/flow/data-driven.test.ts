// @author yxpil
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
let envId = ''
let seq = 0

const cancelId = (): string => `D${String(seq++).padStart(25, '0')}`
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const getRun = (runId: string) => kernel.invoke('runner:get', { id: runId })

const waitFinished = async (runId: string, timeoutMs = 25000) => {
  for (let waited = 0; waited < timeoutMs; waited += 100) {
    const run = await getRun(runId)
    if (run.finishedAt !== null) return run
    await sleep(100)
  }
  throw new Error(`Runner 未在 ${timeoutMs}ms 内结束`)
}

const newCollection = async (name: string): Promise<string> =>
  (await kernel.invoke('collection:create', { projectId, name })).id

const newApi = async (
  collectionId: string,
  name: string,
  patch: { url?: string; postScript?: string } = {},
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
  })
  return api.id
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'toapi-data-'))
  range = await startRange()
  kernel = createKernel({
    dbPath: ':memory:',
    filesDir: dir,
    appVersion: 'test',
    scriptWorkerPath: WORKER,
  })
  projectId = (await kernel.invoke('project:create', { name: '数据驱动项目' })).id
  const env = await kernel.invoke('env:create', { projectId, name: 'main' })
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

describe('数据驱动 Runner（23 号文档 §5.1 / §5.2）', () => {
  it('每行一次迭代：{{列名}} 真实落线，pm.iterationData 与回显一致', async () => {
    const collectionId = await newCollection('数据集合')
    await newApi(collectionId, '按行请求', {
      url: '{{baseUrl}}/echo?u={{user}}',
      postScript: `
          pm.test('回显与数据行一致', () => {
            pm.expect(pm.response.json().query.u).to.eql(pm.iterationData.get('user'))
          })
          pm.test('迭代信息可读', () => {
            pm.expect(pm.info.iterationCount).to.eql(3)
            pm.expect(pm.iterationData.has('user')).to.be.true
          })
        `,
    })

    const { runId, total } = await kernel.invoke('runner:start', {
      scopeType: 'collection',
      scopeId: collectionId,
      cancelId: cancelId(),
      iterationData: [{ user: 'alice' }, { user: 'bob' }, { user: 'carol' }],
    })
    expect(total).toBe(3)
    const run = await waitFinished(runId)

    expect(run.iterationCount).toBe(3)
    expect(run.items.map((i) => i.iteration)).toEqual([1, 2, 3])
    expect(run.items.every((i) => i.status === 'passed')).toBe(true)
    expect(run.failed).toBe(0)
    const paths = range.requests.slice(-3).map((r) => `${r.path}${r.search}`)
    expect(paths).toEqual(['/echo?u=alice', '/echo?u=bob', '/echo?u=carol'])
  })

  it('iterationCount 大于行数时循环取行', async () => {
    const collectionId = await newCollection('循环取行')
    await newApi(collectionId, 'Echo', { url: '{{baseUrl}}/echo?u={{user}}' })

    const before = range.requests.length
    const { runId } = await kernel.invoke('runner:start', {
      scopeType: 'collection',
      scopeId: collectionId,
      cancelId: cancelId(),
      iterationData: [{ user: 'x' }, { user: 'y' }],
      iterationCount: 5,
    })
    const run = await waitFinished(runId)

    expect(run.items).toHaveLength(5)
    expect(range.requests.slice(before).map((r) => `${r.path}${r.search}`)).toEqual([
      '/echo?u=x',
      '/echo?u=y',
      '/echo?u=x',
      '/echo?u=y',
      '/echo?u=x',
    ])
  })

  it('数据行优先级高于环境、低于 local', async () => {
    const collectionId = await newCollection('优先级')
    await newApi(collectionId, 'Echo', { url: '{{baseUrl}}/echo?p={{p}}' })
    await kernel.invoke('var:set', {
      scope: 'environment',
      environmentId: envId,
      key: 'p',
      value: 'env',
    })

    const { runId } = await kernel.invoke('runner:start', {
      scopeType: 'collection',
      scopeId: collectionId,
      cancelId: cancelId(),
      iterationData: [{ p: 'row' }],
    })
    const run = await waitFinished(runId)
    expect(run.items[0]?.status).toBe('passed')
    expect(range.last()?.search).toBe('?p=row')
  })

  it('setNextRequest 按名称跳转并跳过中间接口', async () => {
    const collectionId = await newCollection('跳转')
    await newApi(collectionId, 'A', {
      postScript: `pm.execution.setNextRequest('C')`,
    })
    await newApi(collectionId, 'B')
    await newApi(collectionId, 'C')

    const { runId } = await kernel.invoke('runner:start', {
      scopeType: 'collection',
      scopeId: collectionId,
      cancelId: cancelId(),
    })
    const run = await waitFinished(runId)
    expect(run.items.map((i) => i.apiName)).toEqual(['A', 'C'])
  })

  it('setNextRequest(null) 结束本轮迭代，多轮时下一轮重新开始', async () => {
    const collectionId = await newCollection('提前结束')
    await newApi(collectionId, 'A', { postScript: `pm.execution.setNextRequest(null)` })
    await newApi(collectionId, 'B')

    const { runId } = await kernel.invoke('runner:start', {
      scopeType: 'collection',
      scopeId: collectionId,
      cancelId: cancelId(),
      iterationCount: 2,
    })
    const run = await waitFinished(runId)
    expect(run.items.map((i) => `${String(i.iteration)}:${i.apiName}`)).toEqual(['1:A', '2:A'])
    expect(run.total).toBe(4)
  })

  it('未知跳转名不报错，只结束本轮', async () => {
    const collectionId = await newCollection('未知跳转')
    await newApi(collectionId, 'A', { postScript: `pm.execution.setNextRequest('不存在的接口')` })
    await newApi(collectionId, 'B')

    const { runId } = await kernel.invoke('runner:start', {
      scopeType: 'collection',
      scopeId: collectionId,
      cancelId: cancelId(),
    })
    const run = await waitFinished(runId)
    expect(run.items.map((i) => i.apiName)).toEqual(['A'])
  })

  it('单次发送里 setNextRequest 被忽略并给出提示', async () => {
    const collectionId = await newCollection('非 Runner')
    const apiId = await newApi(collectionId, 'A', {
      postScript: `pm.execution.setNextRequest('B')`,
    })

    const result = await kernel.invoke('api:send', { apiId, cancelId: cancelId() })
    expect(result.nextRequest).toBeUndefined()
    expect(result.script.postLogs.some((l) => l.text.includes('只在集合 Runner'))).toBe(true)
  })

  it('Runner 内提取器未命中记为失败断言', async () => {
    const collectionId = await newCollection('提取器未命中')
    const apiId = await newApi(collectionId, 'A')
    await kernel.invoke('api:update', {
      id: apiId,
      extractors: [
        {
          name: 'missing',
          source: 'body',
          type: 'jsonpath',
          expr: '$.nope',
          scope: 'runtime',
        },
      ],
    })

    const { runId } = await kernel.invoke('runner:start', {
      scopeType: 'collection',
      scopeId: collectionId,
      cancelId: cancelId(),
    })
    const run = await waitFinished(runId)
    expect(run.items[0]?.status).toBe('failed')
    expect(run.items[0]?.error ?? '').toContain('未命中')
  })

  it('--timeout 覆盖接口设置：慢接口按覆盖值判超时', async () => {
    const collectionId = await newCollection('超时覆盖')
    const apiId = await newApi(collectionId, '慢', { url: '{{baseUrl}}/slow?ms=1200' })
    await kernel.invoke('api:update', { id: apiId, fake: { timeoutMs: 20000 } })

    const { runId } = await kernel.invoke('runner:start', {
      scopeType: 'collection',
      scopeId: collectionId,
      cancelId: cancelId(),
      timeoutMs: 200,
    })
    const run = await waitFinished(runId)
    expect(run.items[0]?.status).toBe('error')
    expect(run.items[0]?.error ?? '').toContain('请求超时（200ms）')
  })

  it('project 范围一次跑完项目内全部集合', async () => {
    // 独立项目：本文件其它集合里有 setNextRequest 脚本，会截断整轮
    const scoped = (await kernel.invoke('project:create', { name: '项目范围' })).id
    const scopedEnv = await kernel.invoke('env:create', { projectId: scoped, name: 'main' })
    await kernel.invoke('env:activate', { projectId: scoped, environmentId: scopedEnv.id })
    await kernel.invoke('var:set', {
      scope: 'environment',
      environmentId: scopedEnv.id,
      key: 'baseUrl',
      value: range.origin,
    })
    const a = (await kernel.invoke('collection:create', { projectId: scoped, name: '项目甲' })).id
    const b = (await kernel.invoke('collection:create', { projectId: scoped, name: '项目乙' })).id
    await newApi(a, 'A1')
    await newApi(b, 'B1')

    const { runId, total } = await kernel.invoke('runner:start', {
      scopeType: 'project',
      scopeId: scoped,
      cancelId: cancelId(),
    })
    expect(total).toBe(2)
    const run = await waitFinished(runId)
    const names = run.items.map((i) => i.apiName)
    expect(names).toEqual(['A1', 'B1'])
    expect(run.scopeType).toBe('project')
  })
})

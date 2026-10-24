// @author yxpil
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
let outerId: string
let innerId: string
let envId: string
let seq = 0

const cancelId = (): string => `I${String(seq++).padStart(25, '0')}`

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'toapi-inherit-'))
  range = await startRange()
  kernel = createKernel({
    dbPath: ':memory:',
    filesDir: dir,
    appVersion: 'test',
    scriptWorkerPath: WORKER,
  })
  expect(kernel.script).not.toBeNull()

  const project = await kernel.invoke('project:create', { name: '继承项目' })
  projectId = project.id
  await kernel.invoke('project:update', {
    id: projectId,
    auth: { type: 'bearer', token: 'ROOT-{{rootToken}}' },
    variables: [
      { key: 'rootToken', value: 'root-secret', enabled: true, secret: true, desc: '' },
      { key: 'rootOnly', value: 'root-value', enabled: true, secret: false, desc: '' },
    ],
    preScript: "toapi.log('pre:project')\ntoapi.vars.set('rootPre', '1')",
    postScript: "toapi.log('post:project')\ntoapi.test('project post', () => {})",
  })

  const outer = await kernel.invoke('collection:create', { projectId, name: '外层' })
  outerId = outer.id
  await kernel.invoke('collection:update', {
    id: outerId,
    auth: { type: 'bearer', token: 'OUTER-{{outerToken}}' },
    variables: [
      { key: 'outerToken', value: 'outer-secret', enabled: true, secret: true, desc: '' },
      { key: 'shadow', value: 'outer', enabled: true, secret: false, desc: '' },
      { key: 'disabled', value: 'off', enabled: false, secret: false, desc: '' },
    ],
    preScript: "toapi.log('pre:outer')",
    postScript: "toapi.log('post:outer')\ntoapi.test('outer post', () => {})",
  })

  const inner = await kernel.invoke('collection:create', {
    projectId,
    parentId: outerId,
    name: '内层',
  })
  innerId = inner.id
  await kernel.invoke('collection:update', {
    id: innerId,
    variables: [
      { key: 'shadow', value: 'inner', enabled: true, secret: false, desc: '' },
      { key: 'innerOnly', value: 'inner-value', enabled: true, secret: false, desc: '' },
    ],
    preScript: "toapi.log('pre:inner')",
    postScript: "toapi.log('post:inner')\ntoapi.test('inner post', () => {})",
  })

  const env = await kernel.invoke('env:create', { projectId, name: 'dev' })
  envId = env.id
  await kernel.invoke('env:activate', { projectId, environmentId: env.id })
  await kernel.invoke('var:set', {
    scope: 'environment',
    environmentId: envId,
    key: 'baseUrl',
    value: range.origin,
  })
  await kernel.invoke('var:set', {
    scope: 'environment',
    environmentId: envId,
    key: 'shadow',
    value: 'env',
  })
})

afterAll(() => {
  kernel.dispose()
  void range.close()
  rmSync(dir, { recursive: true, force: true })
})

const makeLeaf = async (): Promise<string> => {
  const api = await kernel.invoke('api:create', {
    collectionId: innerId,
    name: '叶子',
    url: '{{baseUrl}}/echo',
    method: 'GET',
  })
  await kernel.invoke('api:update', {
    id: api.id,
    preScript: "toapi.log('pre:api')",
    postScript: "toapi.log('post:api')\ntoapi.test('api post', () => {})",
    headers: [
      { key: 'X-Shadow', value: '{{shadow}}', enabled: true, desc: '' },
      { key: 'X-Root', value: '{{rootOnly}}', enabled: true, desc: '' },
      { key: 'X-Inner', value: '{{innerOnly}}', enabled: true, desc: '' },
      { key: 'X-Disabled', value: '{{disabled}}', enabled: true, desc: '' },
    ],
  })
  return api.id
}

describe('Postman 作用域继承', () => {
  it('auth 沿集合链向上取第一个非 inherit/none', async () => {
    const apiId = await makeLeaf()
    const result = await kernel.invoke('api:send', { apiId, cancelId: cancelId() })
    expect(result.finalRequest.headers).toContainEqual([
      'Authorization',
      'Bearer OUTER-outer-secret',
    ])
  })

  it('内层集合 auth 覆盖外层', async () => {
    await kernel.invoke('collection:update', {
      id: innerId,
      auth: { type: 'basic', username: 'inner-user', password: 'inner-pass' },
    })
    const apiId = await makeLeaf()
    const result = await kernel.invoke('api:send', { apiId, cancelId: cancelId() })
    const auth = result.finalRequest.headers.find(([k]) => k.toLowerCase() === 'authorization')
    expect(auth?.[1]).toBe(
      `Basic ${Buffer.from('inner-user:inner-pass', 'utf8').toString('base64')}`,
    )
    await kernel.invoke('collection:update', { id: innerId, auth: { type: 'inherit' } })
  })

  it('变量优先级：环境 > 集合链 > 项目根，runtime 最高', async () => {
    const apiId = await makeLeaf()
    const first = await kernel.invoke('api:send', { apiId, cancelId: cancelId() })
    expect(first.finalRequest.headers).toContainEqual(['X-Shadow', 'env'])
    expect(first.finalRequest.headers).toContainEqual(['X-Root', 'root-value'])
    expect(first.finalRequest.headers).toContainEqual(['X-Inner', 'inner-value'])
    expect(first.finalRequest.headers).toContainEqual(['X-Disabled', '{{disabled}}'])

    kernel.flow.runtimeFor(projectId).set('shadow', 'runtime')
    const second = await kernel.invoke('api:send', { apiId, cancelId: cancelId() })
    expect(second.finalRequest.headers).toContainEqual(['X-Shadow', 'runtime'])
    kernel.flow.runtimeFor(projectId).delete('shadow')
  })

  it('脚本顺序：项目 → 外层 → 内层 → 接口；后置反向', async () => {
    const apiId = await makeLeaf()
    const result = await kernel.invoke('api:send', { apiId, cancelId: cancelId() })

    const pre = result.script.preLogs.map((l) => l.text)
    expect(pre).toEqual(['pre:project', 'pre:outer', 'pre:inner', 'pre:api'])

    const post = result.script.postLogs.map((l) => l.text)
    expect(post).toEqual(['post:api', 'post:inner', 'post:outer', 'post:project'])

    const names = result.script.assertions.map((a) => a.name)
    expect(names).toEqual(['api post', 'inner post', 'outer post', 'project post'])
    expect(result.script.assertions.every((a) => a.pass)).toBe(true)
  })

  it('根集合脚本写入的 runtime 变量可供后续请求使用', async () => {
    const apiId = await makeLeaf()
    await kernel.invoke('api:send', { apiId, cancelId: cancelId() })
    expect(kernel.flow.runtimeFor(projectId).get('rootPre')).toBe('1')
  })

  it('禁用变量不参与插值', async () => {
    await kernel.invoke('collection:update', {
      id: outerId,
      variables: [
        { key: 'outerToken', value: 'outer-secret', enabled: true, secret: true, desc: '' },
        { key: 'shadow', value: 'outer', enabled: false, secret: false, desc: '' },
        { key: 'disabled', value: 'off', enabled: false, secret: false, desc: '' },
      ],
    })
    const apiId = await makeLeaf()
    const result = await kernel.invoke('api:send', { apiId, cancelId: cancelId() })
    // 环境变量仍然生效，集合层禁用变量不会回退到被禁用的值
    expect(result.finalRequest.headers).toContainEqual(['X-Shadow', 'env'])
    expect(result.finalRequest.headers).toContainEqual(['X-Disabled', '{{disabled}}'])
  })
})

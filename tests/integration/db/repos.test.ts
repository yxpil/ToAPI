import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createKernel, type Kernel } from '@main/kernel'

let kernel: Kernel
let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'toapi-db-'))
  kernel = createKernel({ dbPath: ':memory:', filesDir: dir, appVersion: 'test' })
})

afterAll(() => {
  kernel.dispose()
  rmSync(dir, { recursive: true, force: true })
})

const treeApis = (projectId: string): string[] => {
  const node = kernel.repos.project.listTree().find((p) => p.project.id === projectId)
  return (node?.collections ?? []).flatMap((c) => c.apis.map((a) => `${c.name}/${a.name}`))
}

describe('迁移与约束', () => {
  it('内存库自动升到最新版本', () => {
    expect(kernel.hello.schemaVersion).toBeGreaterThan(0)
  })

  it('级联删除：删项目清集合与接口，历史保留但 api_id 置空', async () => {
    const project = await kernel.invoke('project:create', { name: '待删项目' })
    const collection = await kernel.invoke('collection:create', {
      projectId: project.id,
      name: '集合A',
    })
    const api = await kernel.invoke('api:create', {
      collectionId: collection.id,
      name: '接口1',
      url: 'http://x/',
    })

    await kernel.invoke('api:update', { id: api.id, name: '接口1' })
    // 造一条历史（不走网络，直接写库）
    kernel.repos.history.add({
      apiId: api.id,
      projectId: project.id,
      request: { method: 'GET', url: 'http://x/', headers: [] },
      response: {
        status: 200,
        statusText: 'OK',
        headers: [],
        redirects: [],
        bodySizeBytes: 2,
        timeMs: 1,
      },
    })

    await kernel.invoke('project:delete', { id: project.id })

    expect(kernel.repos.collection.get(collection.id)).toBeNull()
    expect(kernel.repos.api.get(api.id)).toBeNull()

    const page = kernel.repos.history.list({ projectId: project.id })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.apiId).toBeNull()
  })

  it('变量唯一约束：(scope, env, key) 重复写入为更新', async () => {
    const project = await kernel.invoke('project:create', { name: '变量项目' })
    const env = await kernel.invoke('env:create', { projectId: project.id, name: 'dev' })

    await kernel.invoke('var:set', {
      scope: 'environment',
      environmentId: env.id,
      key: 'baseUrl',
      value: 'https://a',
    })
    const second = await kernel.invoke('var:set', {
      scope: 'environment',
      environmentId: env.id,
      key: 'baseUrl',
      value: 'https://b',
    })

    expect(second.value).toBe('https://b')
    const listed = await kernel.invoke('env:list', { projectId: project.id })
    expect(
      listed.vars.filter((v) => v.key === 'baseUrl' && v.environmentId === env.id),
    ).toHaveLength(1)
  })

  it('每个项目最多一个激活环境', async () => {
    const project = await kernel.invoke('project:create', { name: '环境项目' })
    const a = await kernel.invoke('env:create', { projectId: project.id, name: 'a' })
    const b = await kernel.invoke('env:create', { projectId: project.id, name: 'b' })

    await kernel.invoke('env:activate', { projectId: project.id, environmentId: b.id })
    const listed = await kernel.invoke('env:list', { projectId: project.id })
    expect(listed.envs.filter((e) => e.isActive).map((e) => e.id)).toEqual([b.id])
    expect(listed.envs.find((e) => e.id === a.id)?.isActive).toBe(false)

    await kernel.invoke('env:activate', { projectId: project.id, environmentId: null })
    const cleared = await kernel.invoke('env:list', { projectId: project.id })
    expect(cleared.envs.some((e) => e.isActive)).toBe(false)
  })
})

describe('项目树与排序', () => {
  it('嵌套集合出现在树的正确层级', async () => {
    const project = await kernel.invoke('project:create', { name: '树项目' })
    const root = await kernel.invoke('collection:create', { projectId: project.id, name: '根集合' })
    const child = await kernel.invoke('collection:create', {
      projectId: project.id,
      parentId: root.id,
      name: '子集合',
    })
    await kernel.invoke('api:create', { collectionId: root.id, name: '根接口' })
    await kernel.invoke('api:create', { collectionId: child.id, name: '子接口' })

    const paths = treeApis(project.id)
    expect(paths).toContain('根集合/根接口')
    const node = kernel.repos.project.listTree().find((p) => p.project.id === project.id)
    const rootCollection = node?.collections.find((c) => c.name === '根集合')
    expect(rootCollection?.children[0]?.apis[0]?.name).toBe('子接口')
  })

  it('tree:move 用相邻中值插入排序', async () => {
    const project = await kernel.invoke('project:create', { name: '排序项目' })
    const collection = await kernel.invoke('collection:create', {
      projectId: project.id,
      name: '集合',
    })
    const first = await kernel.invoke('api:create', { collectionId: collection.id, name: 'A' })
    const second = await kernel.invoke('api:create', { collectionId: collection.id, name: 'B' })

    const moved = await kernel.invoke('tree:move', {
      nodeType: 'api',
      id: second.id,
      targetParentId: collection.id,
      beforeSortOrder: null,
      afterSortOrder: first.sortOrder,
    })
    expect(moved.sortOrder).toBeLessThan(first.sortOrder)

    const apis = kernel.repos.api.listByCollection(collection.id)
    expect(apis.map((a) => a.name)).toEqual(['B', 'A'])
  })

  it('移动到自身之下被拒绝', async () => {
    const project = await kernel.invoke('project:create', { name: '自环项目' })
    const collection = await kernel.invoke('collection:create', {
      projectId: project.id,
      name: 'C',
    })
    await expect(
      kernel.invoke('tree:move', {
        nodeType: 'collection',
        id: collection.id,
        targetParentId: collection.id,
      }),
    ).rejects.toThrow('自身')
  })
})

describe('IPC 入参校验', () => {
  it('非法载荷返回 VALIDATION 而不是崩溃', async () => {
    const { invokeGuard } = await import('@main/ipc/router')
    const bad = await invokeGuard('api:create', kernel.handlers, { collectionId: '', name: '' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.code).toBe('VALIDATION')
  })

  it('不存在的 id 抛 NOT_FOUND（guard 层再包装为 IpcResult）', async () => {
    const { invokeGuard } = await import('@main/ipc/router')
    const r = await invokeGuard('api:get', kernel.handlers, { id: 'A'.repeat(26) })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('NOT_FOUND')
  })
})

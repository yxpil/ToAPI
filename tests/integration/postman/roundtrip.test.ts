import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createKernel, type Kernel } from '@main/kernel'
import { invokeGuard } from '@main/ipc/router'
import type { IpcResult } from '@shared/types'

let kernel: Kernel
let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'toapi-postman-'))
  kernel = createKernel({ dbPath: ':memory:', filesDir: dir, appVersion: 'test' })
})

afterAll(() => {
  kernel.dispose()
  rmSync(dir, { recursive: true, force: true })
})

const call = <T>(channel: Parameters<typeof invokeGuard>[0], payload: unknown) =>
  invokeGuard(channel, kernel.handlers, payload) as Promise<IpcResult<T>>

const expectOk = <T>(result: IpcResult<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.data
}

const collectionFixture = (): Record<string, unknown> => ({
  info: {
    name: '示例集合',
    description: '集成测试用',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{tk}}', type: 'string' }] },
  variable: [
    { key: 'baseUrl', value: 'https://api.example.com' },
    { key: 'off', value: 'x', disabled: true },
  ],
  event: [
    {
      listen: 'prerequest',
      script: { type: 'text/javascript', exec: ["console.log('root pre')"] },
    },
  ],
  item: [
    {
      name: '根请求',
      request: {
        method: 'GET',
        header: [{ key: 'X-Trace', value: '1' }],
        url: 'https://api.example.com/ping?a=1',
      },
    },
    {
      name: '用户',
      item: [
        {
          name: '创建用户',
          request: {
            method: 'POST',
            url: {
              raw: 'https://api.example.com/users/{{id}}?debug=true',
              query: [{ key: 'debug', value: '1', disabled: true }],
              variable: [{ key: 'id', value: '7' }],
            },
            header: 'A: 1\nB: 2',
            body: {
              mode: 'raw',
              raw: '{"a":1}',
              options: { raw: { language: 'json' } },
            },
            auth: {
              type: 'apikey',
              apikey: [
                { key: 'key', value: 'X-Key' },
                { key: 'value', value: 'secret' },
                { key: 'in', value: 'header' },
              ],
            },
          },
          event: [
            {
              listen: 'test',
              script: { type: 'text/javascript', exec: ["pm.test('ok', () => {})"] },
            },
          ],
        },
      ],
    },
  ],
})

const importCollection = async (content: unknown, mode?: 'new' | 'into', target?: string) =>
  expectOk(
    await call<{
      projectId: string
      counts: Record<string, number>
      warnings: unknown[]
      preserved: number
    }>('postman:import', { content: JSON.stringify(content), mode, targetProjectId: target }),
  )

describe('Collection v2.1 导入', () => {
  it('还原层级、根请求占位、集合级 auth/variables/scripts', async () => {
    const report = await importCollection(collectionFixture())
    expect(report.counts).toMatchObject({ collections: 2, apis: 2, variables: 2, scripts: 2 })
    expect(report.preserved).toBeGreaterThanOrEqual(3)

    const project = kernel.repos.project.get(report.projectId)
    expect(project?.name).toBe('示例集合')
    expect(project?.description).toBe('集成测试用')
    expect(project?.auth).toEqual({ type: 'bearer', token: '{{tk}}' })
    expect(project?.variables).toHaveLength(2)
    expect(project?.variables[1]).toMatchObject({ key: 'off', enabled: false })
    expect(project?.preScript).toContain('root pre')

    const tree = kernel.repos.project.listTree().find((p) => p.project.id === report.projectId)
    expect(tree?.collections.map((c) => c.name)).toEqual(['根集合', '用户'])
    expect(tree?.collections[0]?.apis.map((a) => a.name)).toEqual(['根请求'])

    const folder = kernel.repos.collection.get(tree?.collections[1]?.id ?? '')
    expect(folder?.name).toBe('用户')
    const apiId = tree?.collections[1]?.apis[0]?.id ?? ''
    const api = kernel.repos.api.get(apiId)
    expect(api?.method).toBe('POST')
    expect(api?.url).toBe('https://api.example.com/users/{{id}}')
    expect(api?.params).toEqual([{ key: 'debug', value: '1', enabled: false, desc: '' }])
    expect(api?.headers).toEqual([
      { key: 'A', value: '1', enabled: true, desc: '' },
      { key: 'B', value: '2', enabled: true, desc: '' },
    ])
    expect(api?.bodyType).toBe('json')
    expect(api?.body).toBe('{"a":1}')
    expect(api?.auth).toEqual({ type: 'apikey', key: 'X-Key', value: 'secret', addTo: 'header' })
    expect(api?.postScript).toContain('pm.test')
  })

  it('同名项目追加序号并给出 warning', async () => {
    const second = await importCollection(collectionFixture())
    const project = kernel.repos.project.get(second.projectId)
    expect(project?.name).toBe('示例集合 (2)')
    expect(second.warnings.some((w) => (w as { code: string }).code === 'PROJECT_RENAMED')).toBe(
      true,
    )
  })

  it('mode=into 合并根变量与脚本，不新建项目', async () => {
    const base = expectOk(await call<{ id: string }>('project:create', { name: '既有项目' }))
    const project = kernel.repos.project.get(base.id)
    const before = kernel.repos.project.list().length
    const report = await importCollection(collectionFixture(), 'into', project?.id)
    expect(report.projectId).toBe(project?.id)
    expect(kernel.repos.project.list()).toHaveLength(before)
    const merged = kernel.repos.project.get(base.id)
    expect(merged?.variables.map((v) => v.key)).toEqual(['baseUrl', 'off'])
    expect(merged?.preScript).toContain('root pre')
    expect(
      kernel.repos.project.listTree().find((p) => p.project.id === base.id)?.collections,
    ).toHaveLength(2)
  })

  it('导出把占位集合还原为顶层 item，并写回根级配置', async () => {
    const report = await importCollection({
      ...collectionFixture(),
      info: { ...(collectionFixture()['info'] as Record<string, unknown>), name: '导出集合' },
    })
    const filePath = join(dir, 'exported.postman_collection.json')
    const exported = expectOk(
      await call<{ filePath: string; counts: Record<string, number> }>(
        'postman:export-collection',
        { projectId: report.projectId, filePath },
      ),
    )
    expect(exported.filePath).toBe(filePath)
    const json = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>
    const info = json['info'] as Record<string, unknown>
    expect(info['name']).toBe('导出集合')
    expect(info['schema']).toBe(
      'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    )
    const items = json['item'] as Record<string, unknown>[]
    expect(items.map((i) => i['name'])).toEqual(['根请求', '用户'])
    expect(json['auth']).toEqual({
      type: 'bearer',
      bearer: [{ key: 'token', value: '{{tk}}', type: 'string' }],
    })
    expect((json['variable'] as unknown[]).length).toBe(2)
    const events = json['event'] as { listen: string }[]
    expect(events[0]?.listen).toBe('prerequest')

    const nested = items[1]?.['item'] as Record<string, unknown>[]
    const request = nested[0]?.['request'] as Record<string, unknown>
    expect(request['method']).toBe('POST')
    expect(request['header']).toEqual([
      { key: 'A', value: '1', type: 'text' },
      { key: 'B', value: '2', type: 'text' },
    ])
    expect(request['body']).toEqual({
      mode: 'raw',
      raw: '{"a":1}',
      options: { raw: { language: 'json' } },
    })
  })

  it('导入导出的文件可再次导入，计数一致', async () => {
    const first = await importCollection(collectionFixture())
    const filePath = join(dir, 'roundtrip.json')
    expectOk(await call('postman:export-collection', { projectId: first.projectId, filePath }))
    const second = await importCollection(JSON.parse(readFileSync(filePath, 'utf8')))
    expect(second.counts).toMatchObject({ collections: 2, apis: 2, variables: 2 })
  })

  it('可从 filePath 导入并支持 inspect 自动识别', async () => {
    const filePath = join(dir, 'from-file.json')
    writeFileSync(filePath, JSON.stringify(collectionFixture()), 'utf8')
    const inspected = expectOk(
      await call<{ kind: string; name: string; counts: Record<string, number> }>(
        'postman:inspect',
        { filePath },
      ),
    )
    expect(inspected.kind).toBe('collection')
    expect(inspected.name).toBe('示例集合')
    expect(inspected.counts).toMatchObject({ collections: 1, apis: 2, scripts: 2 })
    const report = expectOk(
      await call<{ projectId: string }>('postman:import', { filePath, mode: 'new' }),
    )
    expect(kernel.repos.project.get(report.projectId)).not.toBeNull()
  })

  it('非法 JSON 与不支持 schema 返回 VALIDATION', async () => {
    const broken = await call('postman:inspect', { content: '{bad' })
    expect(broken.ok).toBe(false)
    if (!broken.ok) expect(broken.error.code).toBe('VALIDATION')

    const v1 = await call('postman:import', {
      content: JSON.stringify({
        info: { schema: 'https://schema.getpostman.com/json/collection/v1.0.0/collection.json' },
        item: [],
      }),
    })
    expect(v1.ok).toBe(false)
    if (!v1.ok) expect(v1.error.code).toBe('VALIDATION')

    const both = await call('postman:inspect', { content: '{}', filePath: join(dir, 'x.json') })
    expect(both.ok).toBe(false)
  })
})

describe('Environment v2.1 导入导出', () => {
  const envFixture = () => ({
    id: 'env-1',
    name: 'staging',
    values: [
      { key: 'baseUrl', value: 'https://staging.example.com', type: 'default', enabled: true },
      { key: 'token', value: 'abc', type: 'secret', enabled: true },
      { key: 'legacy', value: 'x', type: 'default', enabled: false },
    ],
    _postman_variable_scope: 'environment',
    _postman_exported_using: 'Postman/11',
  })

  it('导入 secret / 禁用标记', async () => {
    const project = expectOk(await call<{ id: string }>('project:create', { name: 'Env 项目' }))
    const report = expectOk(
      await call<{ environmentId?: string; counts: Record<string, number> }>(
        'postman:import-environment',
        { content: JSON.stringify(envFixture()), projectId: project.id },
      ),
    )
    const vars = kernel.repos.variable.listForEnv(report.environmentId ?? '')
    expect(vars).toHaveLength(3)
    expect(vars.find((v) => v.key === 'token')).toMatchObject({ secret: true, enabled: true })
    expect(vars.find((v) => v.key === 'legacy')).toMatchObject({ secret: false, enabled: false })
    expect(report.counts['variables']).toBe(3)
  })

  it('同名默认新建 (2)，overwrite 覆盖原环境变量', async () => {
    const project = expectOk(await call<{ id: string }>('project:create', { name: 'Env 覆盖项目' }))
    const first = expectOk(
      await call<{ environmentId?: string }>('postman:import-environment', {
        content: JSON.stringify(envFixture()),
        projectId: project.id,
      }),
    )
    const envId = first.environmentId ?? ''
    kernel.repos.variable.upsert({
      scope: 'environment',
      environmentId: envId,
      key: 'baseUrl',
      value: 'https://changed.example.com',
    })

    const second = expectOk(
      await call<{ environmentId?: string }>('postman:import-environment', {
        content: JSON.stringify(envFixture()),
        projectId: project.id,
      }),
    )
    expect(second.environmentId).not.toBe(envId)
    expect(kernel.repos.environment.get(second.environmentId ?? '')?.name).toBe('staging (2)')

    const overwritten = expectOk(
      await call<{ environmentId?: string }>('postman:import-environment', {
        content: JSON.stringify(envFixture()),
        projectId: project.id,
        mode: 'overwrite',
      }),
    )
    expect(overwritten.environmentId).toBe(envId)
    const vars = kernel.repos.variable.listForEnv(envId)
    expect(vars.find((v) => v.key === 'baseUrl')?.value).toBe('https://staging.example.com')
  })

  it('导出文件包含 scope 与 secret 标记', async () => {
    const project = expectOk(await call<{ id: string }>('project:create', { name: 'Env 导出项目' }))
    const report = expectOk(
      await call<{ environmentId?: string }>('postman:import-environment', {
        content: JSON.stringify(envFixture()),
        projectId: project.id,
      }),
    )
    const filePath = join(dir, 'staging.postman_environment.json')
    const exported = expectOk(
      await call<{ filePath: string; counts: Record<string, number> }>(
        'postman:export-environment',
        { environmentId: report.environmentId, filePath },
      ),
    )
    expect(exported.counts['variables']).toBe(3)
    const json = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>
    expect(json['_postman_variable_scope']).toBe('environment')
    expect(json['name']).toBe('staging')
    const values = json['values'] as Record<string, unknown>[]
    expect(values.find((v) => v['key'] === 'token')).toMatchObject({
      type: 'secret',
      enabled: true,
    })
    expect(values.find((v) => v['key'] === 'legacy')).toMatchObject({ enabled: false })
  })

  it('inspect 识别环境文件', async () => {
    const inspected = expectOk(
      await call<{ kind: string; name: string; counts: Record<string, number> }>(
        'postman:inspect',
        { content: JSON.stringify(envFixture()) },
      ),
    )
    expect(inspected.kind).toBe('environment')
    expect(inspected.name).toBe('staging')
    expect(inspected.counts['variables']).toBe(3)
  })
})

// @author yxpil
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createKernel, type Kernel } from '@main/kernel'
import { McpSession } from '@main/open/mcp'
import type { OpenConfigView } from '@shared/channels'
import { startRange, type Range } from '../../fixtures/range'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const WORKER = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../dist-electron/script-worker.cjs',
)

const PASSWORD = 'open-test-secret-1'
const PORT = 46130
const SECRET_TOKEN = 'SUPER-SECRET-TOKEN-9'

let kernel: Kernel
let range: Range
let dir: string
let projectId = ''
let apiId = ''

const call = async (
  path: string,
  init: { method?: string; body?: unknown; token?: string | null } = {},
): Promise<{ status: number; json: Record<string, unknown> }> => {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (init.token !== null) headers['authorization'] = `Bearer ${init.token ?? PASSWORD}`
  const res = await fetch(`${kernel.http.address ?? ''}${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

const errorOf = (json: Record<string, unknown>): string =>
  JSON.stringify((json as { error?: { code?: string; message?: string } }).error ?? {})

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'toapi-open-'))
  range = await startRange()
  kernel = createKernel({
    dbPath: ':memory:',
    filesDir: dir,
    appVersion: 'test',
    scriptWorkerPath: WORKER,
    headless: true,
  })

  projectId = (await kernel.invoke('project:create', { name: '开放通道项目' })).id
  const collection = await kernel.invoke('collection:create', {
    projectId,
    name: '主流程',
  })
  const env = await kernel.invoke('env:create', { projectId, name: 'test' })
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
    key: 'token',
    value: SECRET_TOKEN,
    secret: true,
  })
  const api = await kernel.invoke('api:create', {
    collectionId: collection.id,
    name: '带鉴权回显',
    method: 'GET',
    url: '{{baseUrl}}/echo',
  })
  apiId = api.id
  await kernel.invoke('api:update', {
    id: apiId,
    headers: [{ key: 'Authorization', value: 'Bearer {{token}}', enabled: true, desc: '' }],
    postScript: "toapi.test('状态 200', () => toapi.expect(toapi.response.status).toBe(200))",
  })
})

afterAll(async () => {
  await kernel.http.stop()
  kernel.dispose()
  await range.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('调用密码闸门（11 号文档 §0/§1.1）', () => {
  it('未设密码时启用无效，弱口令被拒', async () => {
    expect(kernel.open.view().hasPassword).toBe(false)
    kernel.open.config.setEnabled(true)
    expect(kernel.open.view().enabled).toBe(false)
    expect(() => kernel.open.config.setPassword('1234567')).toThrow('至少 8 位')
    const view = (await kernel.invoke('open:set-config', { password: PASSWORD })) as OpenConfigView
    expect(view.hasPassword).toBe(true)
    expect(view.enabled).toBe(false)
    expect(JSON.stringify(view)).not.toContain(PASSWORD)
  })

  it('密码校验走常量时间比较，错误密码一律拒', async () => {
    expect(kernel.open.config.verify(PASSWORD)).toBe(true)
    expect(kernel.open.config.verify(`${PASSWORD}x`)).toBe(false)
    expect(kernel.open.config.verify(null)).toBe(false)
    kernel.open.config.setEnabled(true)
    kernel.open.config.setPort(PORT)
    const state = await kernel.syncOpenEndpoint()
    expect(state).toEqual({ running: true, port: PORT })
    await kernel.http.stop()
    // 后续用例走随机端口，避免与真实开发者环境撞车
    await kernel.http.start('127.0.0.1', 0)
  })

  it('撤销密码会同时关闭通道', async () => {
    const before = kernel.open.view()
    expect(before.enabled).toBe(true)
    await kernel.invoke('open:set-config', { password: '' })
    expect(kernel.open.view().enabled).toBe(false)
    expect(kernel.open.view().hasPassword).toBe(false)
    await kernel.invoke('open:set-config', { password: PASSWORD, enabled: true })
    expect(kernel.open.view().enabled).toBe(true)
    // 关闭期间端口释放，重新随机起监听
    await kernel.http.stop()
    await kernel.http.start('127.0.0.1', 0)
  })
})

describe('Local HTTP API（11 号文档 §1）', () => {
  it('/v1/health 无需鉴权，其余端点缺密码 401', async () => {
    const health = await call('/v1/health', { token: null })
    expect(health.status).toBe(200)
    expect(JSON.stringify(health.json)).not.toContain(PASSWORD)
    const noToken = await call('/v1/projects', { token: null })
    expect(noToken.status).toBe(401)
    expect(errorOf(noToken.json)).toContain('FORBIDDEN')
    const wrong = await call('/v1/projects', { token: 'nope' })
    expect(wrong.status).toBe(401)
  })

  it('读端点返回项目与接口定义', async () => {
    const projects = await call('/v1/projects')
    const data = projects.json['data'] as { id: string; project: { name: string } }[]
    expect(data[0]?.project.name).toBe('开放通道项目')
    const api = await call(`/v1/api?apiId=${apiId}`)
    const detail = api.json['data'] as { url: string; postScript: string }
    expect(detail.url).toBe('{{baseUrl}}/echo')
    expect(detail.postScript).toContain('toapi.test')
  })

  it('环境变量与 .tapi 导出都不泄露 secret 明文', async () => {
    const env = await call(`/v1/env?projectId=${projectId}`)
    const text = JSON.stringify(env.json)
    expect(text).toContain('***')
    expect(text).not.toContain(SECRET_TOKEN)
    expect(text).toContain('baseUrl')

    const tapi = await call(`/v1/tapi?projectId=${projectId}`)
    const content = (tapi.json['data'] as { content: string }).content
    expect(content).not.toContain(SECRET_TOKEN)
    expect(content).toContain('"redacted": true')
  })

  it('/v1/send 真实发请求，并把响应里的 secret 遮成 ***', async () => {
    const before = range.requests.length
    const sent = await call('/v1/send', { method: 'POST', body: { apiId } })
    expect(sent.status).toBe(200)
    const data = sent.json['data'] as {
      response: { status: number; bodyText?: string }
      script: { assertions: { pass: boolean }[] }
    }
    expect(data.response.status).toBe(200)
    expect(data.script.assertions[0]?.pass).toBe(true)
    expect(range.requests.length).toBe(before + 1)
    // 靶场会回显请求头，若不脱敏就会把 secret 原样带回
    expect(JSON.stringify(sent.json)).not.toContain(SECRET_TOKEN)
    expect(JSON.stringify(sent.json)).toContain('***')
  })

  it('越界 host 在无界面模式下直接拒绝', async () => {
    const res = await call('/v1/send', {
      method: 'POST',
      body: { draft: { method: 'GET', url: 'http://example.invalid/x' } },
    })
    expect(res.status).toBe(403)
    expect(errorOf(res.json)).toContain('不在项目环境声明的 host 清单内')
  })

  it('/v1/run 同步跑完集合并返回逐项结果', async () => {
    const run = await call('/v1/run', {
      method: 'POST',
      body: { scopeType: 'project', scopeId: projectId },
    })
    const data = run.json['data'] as { passed: number; failed: number; items: unknown[] }
    expect(data.items).toHaveLength(1)
    expect(data.passed).toBe(1)
    const id = (run.json['data'] as { id: string }).id
    const again = await call(`/v1/run/${id}`)
    expect((again.json['data'] as { id: string }).id).toBe(id)
  })

  it('超限时返回 429 + RATE_LIMIT，恢复后继续可用', async () => {
    await kernel.invoke('open:set-config', { ratePerMin: 2 })
    try {
      const results = await Promise.all([
        call('/v1/projects'),
        call('/v1/projects'),
        call('/v1/projects'),
      ])
      const limited = results.filter((r) => r.status === 429)
      expect(limited.length).toBeGreaterThan(0)
      expect(errorOf(limited[0]?.json ?? {})).toContain('RATE_LIMIT')
    } finally {
      await kernel.invoke('open:set-config', { ratePerMin: 600 })
    }
    expect((await call('/v1/projects')).status).toBe(200)
  })

  it('工具清单与入参 JSON Schema 可读且不含额外属性', async () => {
    const tools = await call('/v1/tools')
    const list = tools.json['data'] as { name: string; kind: string }[]
    expect(list.length).toBeGreaterThanOrEqual(14)
    expect(list.some((t) => t.name === 'toapi_send_request' && t.kind === 'exec')).toBe(true)
    expect(list.some((t) => t.name === 'toapi_run_collection')).toBe(true)
    expect(list.some((t) => t.name === 'toapi_get_skill')).toBe(true)
  })

  it('SKILL.md 只列敏感变量名、不给值', async () => {
    const skill = await call(`/v1/skill?projectId=${projectId}`)
    const data = skill.json['data'] as { skill: string; files: string[]; examples: unknown[] }
    expect(data.skill).toContain('name: 开放通道项目-api')
    expect(data.skill).toContain('敏感变量只列名字、绝不带值：token')
    expect(data.skill).not.toContain(SECRET_TOKEN)
    expect(data.files.some((f) => f.startsWith('examples/'))).toBe(true)
    expect(data.examples.length).toBeGreaterThan(0)
  })

  it('每次外部调用都进审计，摘要不含 secret', async () => {
    const log = kernel.open.callLog(50)
    expect(log.length).toBeGreaterThan(5)
    expect(log.every((row) => row.channel === 'http')).toBe(true)
    expect(JSON.stringify(log)).not.toContain(SECRET_TOKEN)
    expect(JSON.stringify(log)).not.toContain(PASSWORD)
    expect(log.some((row) => row.ok === false && row.errorCode === 'FORBIDDEN')).toBe(true)
  })
})

describe('MCP 会话（11 号文档 §2）', () => {
  const session = (): McpSession =>
    new McpSession({
      service: kernel.open,
      appVersion: 'test',
      secret: PASSWORD,
      clientName: 'qoder-test',
    })

  it('initialize / tools/list 正常，协议版本与能力声明齐全', async () => {
    const init = await session().handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    expect(init).toMatchObject({ jsonrpc: '2.0', id: 1 })
    const result = (init as { result: Record<string, unknown> }).result
    expect(result['protocolVersion']).toBeTruthy()
    expect((result['serverInfo'] as { name: string }).name).toBe('ToAPI')

    const list = await session().handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    const tools = (list as { result: { tools: Record<string, unknown>[] } }).result.tools
    expect(tools.length).toBeGreaterThanOrEqual(14)
    const send = tools.find((t) => t['name'] === 'toapi_send_request')
    expect((send?.['inputSchema'] as { additionalProperties: boolean }).additionalProperties).toBe(
      false,
    )
    expect(
      (send?.['inputSchema'] as { properties: Record<string, unknown> }).properties['apiId'],
    ).toBeTruthy()
  })

  it('tools/call 走同一套闸门：错误密码返回 isError', async () => {
    const bad = await new McpSession({
      service: kernel.open,
      appVersion: 'test',
      secret: 'wrong',
      clientName: 'intruder',
    }).handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'toapi_list_projects', arguments: {} },
    })
    expect((bad as { result: { isError: boolean } }).result.isError).toBe(true)
    expect(JSON.stringify(bad)).toContain('FORBIDDEN')

    const good = await session().handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'toapi_list_projects', arguments: {} },
    })
    expect((good as { result: { isError: boolean } }).result.isError).toBe(false)
  })

  it('未知工具与非法参数都是工具级错误而不是协议崩溃', async () => {
    const unknown = await session().handle({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'toapi_drop_database', arguments: {} },
    })
    expect(JSON.stringify(unknown)).toContain('未知工具')
    const badArgs = await session().handle({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'toapi_get_project', arguments: {} },
    })
    expect(JSON.stringify(badArgs)).toContain('缺少参数 projectId')
    const noMethod = await session().handle({ jsonrpc: '2.0', id: 7, method: 'resources/list' })
    expect(JSON.stringify(noMethod)).toContain('不支持的方法')
    const notification = await session().handle({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    })
    expect(notification).toBeNull()
  })

  it('数据驱动与运行时变量也能从 MCP 侧走通', async () => {
    const setVar = await session().handle({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: {
        name: 'toapi_set_runtime_var',
        arguments: { projectId, key: 'page', value: '77' },
      },
    })
    expect(JSON.stringify(setVar)).toContain('"ok":true')
    const run = await session().handle({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: {
        name: 'toapi_run_collection',
        arguments: {
          scopeType: 'collection',
          scopeId: (await kernel.invoke('api:get', { id: apiId })).collectionId,
          iterationData: [{ page: '11' }, { page: '22' }],
        },
      },
    })
    const payload = JSON.stringify(run)
    expect(payload).toContain('"iterationCount":2')
    expect(payload).toContain('"passed":2')
  })

  it('MCP 调用也进审计并标注通道', async () => {
    const log = kernel.open.callLog(80).filter((row) => row.channel === 'mcp')
    expect(log.length).toBeGreaterThan(3)
    expect(log.some((row) => row.client.includes('qoder-test'))).toBe(true)
  })
})

// @author yxpil
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createKernel, type Kernel } from '@main/kernel'
import type { TapiFile } from '@main/tapi/format'

let kernel: Kernel
let dir: string
let projectId = ''
let childId = ''
let exportPath = ''
let exported = ''

const buildProject = async (): Promise<void> => {
  const project = await kernel.invoke('project:create', { name: '互传项目' })
  projectId = project.id
  await kernel.invoke('project:update', {
    id: projectId,
    description: '给测试部的联调用例集',
    preScript: 'toapi.vars.set("pk", "1")',
    variables: [{ key: 'projVar', value: 'p1', enabled: true, secret: false, desc: '' }],
  })

  const parent = await kernel.invoke('collection:create', { projectId, name: '订单' })
  await kernel.invoke('collection:update', {
    id: parent.id,
    description: '订单域',
    auth: { type: 'bearer', token: '{{token}}' },
    variables: [
      { key: 'colVar', value: 'c1', enabled: true, secret: false, desc: '' },
      { key: 'colSecret', value: 'C-SECRET', enabled: true, secret: true, desc: '' },
    ],
    postScript: "toapi.test('集合后置跑过', () => toapi.expect(1).toBe(1))",
  })
  const child = await kernel.invoke('collection:create', {
    projectId,
    parentId: parent.id,
    name: '退款',
  })
  childId = child.id

  const create = await kernel.invoke('api:create', {
    collectionId: parent.id,
    name: '创建订单',
    method: 'POST',
    url: '{{baseUrl}}/api/orders',
  })
  await kernel.invoke('api:update', {
    id: create.id,
    description: '下单主流程',
    headers: [{ key: 'Content-Type', value: 'application/json', enabled: true, desc: '' }],
    bodyType: 'json',
    body: '{"sku":"A1","qty":2}',
    auth: { type: 'basic', username: 'u', password: '{{token}}' },
    fake: { ua: '@preset:chrome-win' },
    preScript: "toapi.setHeader('X-Trace', '1')",
    postScript: "toapi.vars.set('orderId', toapi.response.json().id)",
    extractors: [
      { name: 'orderId', source: 'body', type: 'jsonpath', expr: '$.id', scope: 'runtime' },
    ],
  })
  const query = await kernel.invoke('api:create', {
    collectionId: child.id,
    name: '查订单',
    method: 'GET',
    url: '{{baseUrl}}/orders?page=2',
  })
  await kernel.invoke('api:update', {
    id: query.id,
    params: [{ key: 'page', value: '2', enabled: true, desc: '' }],
  })

  const env = await kernel.invoke('env:create', { projectId, name: 'staging' })
  await kernel.invoke('env:activate', { projectId, environmentId: env.id })
  await kernel.invoke('var:set', {
    scope: 'environment',
    environmentId: env.id,
    key: 'baseUrl',
    value: 'https://staging.example.com',
  })
  await kernel.invoke('var:set', {
    scope: 'environment',
    environmentId: env.id,
    key: 'token',
    value: 'E-SECRET',
    secret: true,
  })
  await kernel.invoke('var:set', { scope: 'global', key: 'region', value: 'cn' })
  await kernel.invoke('var:set', { scope: 'global', key: 'gKey', value: 'G-SECRET', secret: true })
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'toapi-tapi-'))
  kernel = createKernel({ dbPath: join(dir, 'toapi.db'), filesDir: dir, appVersion: '0.2.0' })
  await buildProject()
  exportPath = join(dir, 'export.tapi')
  const result = await kernel.invoke('tapi:export', { projectId, filePath: exportPath })
  exported = readFileSync(exportPath, 'utf8')
  expect(result.filePath).toBe(exportPath)
})

afterAll(() => {
  kernel.dispose()
  rmSync(dir, { recursive: true, force: true })
})

const json = (): TapiFile => JSON.parse(exported) as TapiFile

describe('.tapi 导出（08 号文档 §2-§4）', () => {
  it('文件是格式化 JSON，含 format/version/meta/payload', () => {
    const file = json()
    expect(file.format).toBe('tapi')
    expect(file.format_version).toBe('1.0')
    expect(file.meta.app_version).toBe('0.2.0')
    expect(file.meta.name).toBe('互传项目')
    expect(file.meta.checksum).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(exported).toContain('\n  "format"')
    expect(exported.split('\n').length).toBeGreaterThan(50)
  })

  it('结构与库内一一对应：集合树、接口字段、脚本、提取器', () => {
    const project = json().payload.project
    expect(project.name).toBe('互传项目')
    expect(project.description).toBe('给测试部的联调用例集')
    expect(project.pre_script).toContain('toapi.vars.set')
    expect(project.collections).toHaveLength(1)
    const orders = project.collections[0]
    expect(orders?.name).toBe('订单')
    expect(orders?.auth).toEqual({ type: 'bearer', token: '{{token}}' })
    expect(orders?.post_script).toContain('toapi.test')
    expect(orders?.apis).toHaveLength(1)
    const api = orders?.apis[0]
    expect(api).toMatchObject({
      name: '创建订单',
      method: 'POST',
      url: '{{baseUrl}}/api/orders',
      body_type: 'json',
      body: '{"sku":"A1","qty":2}',
      pre_script: "toapi.setHeader('X-Trace', '1')",
    })
    expect(api?.auth).toEqual({ type: 'basic', username: 'u', password: '{{token}}' })
    expect(api?.fake).toEqual({ ua: '@preset:chrome-win' })
    expect(api?.headers).toHaveLength(1)
    expect(api?.extractors).toHaveLength(1)
    expect(orders?.children[0]?.name).toBe('退款')
    expect(orders?.children[0]?.apis[0]?.name).toBe('查订单')
  })

  it('默认剔除敏感变量并打 redacted 标记，明文不落文件', () => {
    const text = exported
    expect(text).not.toContain('E-SECRET')
    expect(text).not.toContain('G-SECRET')
    expect(text).not.toContain('C-SECRET')
    const file = json()
    const envToken = file.payload.environments[0]?.variables.find((v) => v.key === 'token')
    expect(envToken).toMatchObject({ value: '', secret: true, redacted: true })
    const global = file.payload.globals.find((v) => v.key === 'gKey')
    expect(global?.redacted).toBe(true)
    const plain = file.payload.globals.find((v) => v.key === 'region')
    expect(plain?.value).toBe('cn')
    expect(plain?.redacted).toBeUndefined()
    expect(file.meta.contains_secrets).toBeUndefined()
  })

  it('secrets=plain 时写明文并带 contains_secrets', async () => {
    const plainPath = join(dir, 'plain.tapi')
    const result = await kernel.invoke('tapi:export', {
      projectId,
      filePath: plainPath,
      secrets: 'plain',
    })
    expect(result.containsSecrets).toBe(true)
    const text = readFileSync(plainPath, 'utf8')
    expect(text).toContain('E-SECRET')
    expect((JSON.parse(text) as TapiFile).meta.contains_secrets).toBe(true)
  })

  it('collectionIds 只导出指定子树', async () => {
    const subPath = join(dir, 'sub.tapi')
    const result = await kernel.invoke('tapi:export', {
      projectId,
      collectionIds: [childId],
      filePath: subPath,
    })
    expect(result.stats.collections).toBe(1)
    expect(result.stats.apis).toBe(1)
    const file = JSON.parse(readFileSync(subPath, 'utf8')) as TapiFile
    expect(file.payload.project.collections[0]?.name).toBe('退款')
  })

  it('历史与 Runner 记录不进文件', () => {
    const text = JSON.stringify(json())
    expect(text).not.toContain('history')
    expect(text).not.toContain('runner')
    expect(json().payload.cases).toEqual([])
  })
})

describe('.tapi 预览与导入（08 号文档 §5）', () => {
  it('inspect 给出计数、剔除数与同名项目提示，且不写库', async () => {
    const before = (await kernel.invoke('project:list', {})).length
    const inspected = await kernel.invoke('tapi:inspect', { filePath: exportPath })
    expect(inspected.stats).toEqual({
      collections: 2,
      apis: 2,
      environments: 1,
      globals: 2,
    })
    expect(inspected.checksumOk).toBe(true)
    expect(inspected.supported).toBe(true)
    expect(inspected.redactedCount).toBe(3)
    expect(inspected.sameNameProject).toBe('互传项目')
    expect((await kernel.invoke('project:list', {})).length).toBe(before)
  })

  it('导入为独立新项目：结构、变量、脚本、环境全部还原', async () => {
    const report = await kernel.invoke('tapi:import', { content: exported, mode: 'new' })
    expect(report.projectName).toBe('互传项目 (2)')
    // 全局变量同名不覆盖本地值（08 号文档 §5）
    expect(report.imported).toEqual({ collections: 2, apis: 2, environments: 1, globals: 0 })
    expect(report.skipped).toBe(2)
    const tree = await kernel.invoke('project:list', {})
    const node = tree.find((n) => n.project.id === report.projectId)
    expect(node?.project.description).toBe('给测试部的联调用例集')
    expect(node?.project.preScript).toContain('toapi.vars.set')
    const orders = node?.collections[0]
    expect(orders?.name).toBe('订单')
    // 树节点只带 id/name/apis，集合级字段直接读库确认是否还原
    const ordersRow = orders ? kernel.repos.collection.get(orders.id) : null
    expect(ordersRow?.auth).toEqual({ type: 'bearer', token: '{{token}}' })
    expect(ordersRow?.description).toBe('订单域')
    expect(ordersRow?.postScript).toContain('toapi.test')
    expect(ordersRow?.variables.map((v) => v.key)).toEqual(['colVar', 'colSecret'])
    expect(orders?.children[0]?.name).toBe('退款')
    expect(orders?.apis[0]?.name).toBe('创建订单')
    expect(orders?.apis[0]?.url).toBe('{{baseUrl}}/api/orders')
    const importedApi = orders?.apis[0]
    const detail = importedApi ? await kernel.invoke('api:get', { id: importedApi.id }) : null
    expect(detail?.extractors).toHaveLength(1)
    expect(detail?.bodyType).toBe('json')
    expect(detail?.fake).toEqual({ ua: '@preset:chrome-win' })

    const envs = await kernel.invoke('env:list', { projectId: report.projectId })
    const staging = envs.envs.find((e) => e.name === 'staging')
    expect(staging).toBeTruthy()
    const baseUrl = envs.vars.find((v) => v.key === 'baseUrl')
    expect(baseUrl?.value).toBe('https://staging.example.com')
    const token = envs.vars.find((v) => v.key === 'token')
    // 剔除的密钥不留值，只留占位与环境变量身份
    expect(token?.value).toBe('')
    expect(token?.secret).toBe(true)
    expect(report.warnings.some((w) => w.includes('token'))).toBe(true)
  })

  it('合并进现有项目：同名集合不重复，接口按方法+URL+名称判重', async () => {
    const tree = await kernel.invoke('project:list', {})
    const target = tree.find((n) => n.project.name === '互传项目 (2)')
    expect(target).toBeTruthy()
    const before = target?.collections[0]?.apis.length ?? 0

    const skipped = await kernel.invoke('tapi:import', {
      content: exported,
      mode: 'into',
      targetProjectId: target?.project.id,
      apiConflict: 'skip',
    })
    expect(skipped.projectId).toBe(target?.project.id)
    expect(skipped.skipped).toBeGreaterThanOrEqual(1)
    expect(skipped.imported.collections).toBe(0)

    const afterSkip = (await kernel.invoke('project:list', {})).find(
      (n) => n.project.id === target?.project.id,
    )
    expect(afterSkip?.collections[0]?.apis.length).toBe(before)

    const dup = await kernel.invoke('tapi:import', {
      content: exported,
      mode: 'into',
      targetProjectId: target?.project.id,
      apiConflict: 'duplicate',
    })
    expect(dup.imported.apis).toBe(2)
    const afterDup = (await kernel.invoke('project:list', {})).find(
      (n) => n.project.id === target?.project.id,
    )
    expect(afterDup?.collections[0]?.apis.map((a) => a.name)).toContain('创建订单 (2)')
    expect(afterDup?.collections.length).toBe(1)
  })

  it('改接口字段后重新导出，overwrite 策略把新内容覆盖到目标接口', async () => {
    const tree = await kernel.invoke('project:list', {})
    const fresh = tree.find((n) => n.project.name === '互传项目 (2)')
    expect(fresh).toBeTruthy()
    const targetApi = fresh?.collections[0]?.apis[0]
    expect(targetApi).toBeTruthy()
    if (!targetApi) return
    const apiDetail = await kernel.invoke('api:get', { id: targetApi.id })
    expect(apiDetail.body).toBe('{"sku":"A1","qty":2}')

    // 源项目改一处 body，重新导出，再 overwrite 导入到已导入的项目
    const sourceApis = (await kernel.invoke('project:list', {})).find(
      (n) => n.project.id === projectId,
    )?.collections[0]?.apis
    const sourceApi = sourceApis?.[0]
    expect(sourceApi).toBeTruthy()
    if (sourceApi) {
      await kernel.invoke('api:update', { id: sourceApi.id, body: '{"sku":"B9","qty":9}' })
    }
    const v2Path = join(dir, 'export-v2.tapi')
    await kernel.invoke('tapi:export', { projectId, filePath: v2Path })
    const report = await kernel.invoke('tapi:import', {
      content: readFileSync(v2Path, 'utf8'),
      mode: 'into',
      targetProjectId: fresh?.project.id,
      apiConflict: 'overwrite',
    })
    expect(report.imported.apis).toBe(2)
    const after = await kernel.invoke('api:get', { id: targetApi.id })
    expect(after.body).toBe('{"sku":"B9","qty":9}')

    // 还原源项目，避免影响后续用例
    if (sourceApi)
      await kernel.invoke('api:update', { id: sourceApi.id, body: '{"sku":"A1","qty":2}' })
  })

  it('篡改内容导致校验和不匹配 → 拒绝导入且不写库', async () => {
    const tampered = json()
    tampered.payload.globals.push({ key: 'evil', value: 'x', secret: false, enabled: true })
    const before = (await kernel.invoke('project:list', {})).length
    await expect(
      kernel.invoke('tapi:import', { content: JSON.stringify(tampered), mode: 'new' }),
    ).rejects.toThrow('校验和不匹配')
    expect((await kernel.invoke('project:list', {})).length).toBe(before)
  })

  it('更高 format_version 拒绝并提示升级', async () => {
    const future = json()
    future.format_version = '2.0'
    await expect(
      kernel.invoke('tapi:inspect', { content: JSON.stringify(future) }),
    ).rejects.toThrow('请升级 ToAPI')
  })

  it('非 .tapi 内容与非法 JSON 报明确错误', async () => {
    await expect(
      kernel.invoke('tapi:import', { content: '{"info":{"name":"x"}}', mode: 'new' }),
    ).rejects.toThrow('这不是 .tapi 文件')
    await expect(kernel.invoke('tapi:import', { content: '{', mode: 'new' })).rejects.toThrow(
      '不是合法 JSON',
    )
    const before = (await kernel.invoke('project:list', {})).length
    await expect(
      kernel.invoke('tapi:import', { content: exported, mode: 'into', targetProjectId: 'nope' }),
    ).rejects.toThrow('targetProjectId')
    expect((await kernel.invoke('project:list', {})).length).toBe(before)
  })

  it('本地没有同名全局变量时，globals 一并导入（剔除项留空占位）', async () => {
    // 先清掉当前库里的全局变量，才能看到「导入新建」这条路径
    for (const v of kernel.repos.variable.listGlobals()) kernel.repos.variable.remove(v.id)
    const report = await kernel.invoke('tapi:import', { content: exported, mode: 'new' })
    expect(report.imported.globals).toBe(2)
    const region = kernel.repos.variable.find('global', null, 'region')
    expect(region?.value).toBe('cn')
    // 被剔除的密钥以空值占位并保留 secret 标记，由 UI 提示补填（08 号文档 §4）
    const gKey = kernel.repos.variable.find('global', null, 'gKey')
    expect(gKey?.value).toBe('')
    expect(gKey?.secret).toBe(true)
    expect(report.warnings.some((w) => w.includes('gKey'))).toBe(true)
  })

  it('明文导出的文件可以还原密钥值', async () => {
    const plainPath = join(dir, 'plain2.tapi')
    await kernel.invoke('tapi:export', { projectId, filePath: plainPath, secrets: 'plain' })
    const content = readFileSync(plainPath, 'utf8')
    const report = await kernel.invoke('tapi:import', { content, mode: 'new' })
    const envs = await kernel.invoke('env:list', { projectId: report.projectId })
    expect(envs.vars.find((v) => v.key === 'token')?.value).toBe('E-SECRET')
    expect(report.warnings.filter((w) => w.includes('剔除'))).toHaveLength(0)
  })

  it('导出走保存对话框时未注入 dialogs 会明确报错', async () => {
    await expect(kernel.invoke('tapi:export', { projectId, secrets: 'strip' })).rejects.toThrow(
      '没有保存对话框',
    )
  })

  it('导出到不存在的目录时报错而不是留下半个文件', async () => {
    const bad = join(dir, '不存在目录', 'x.tapi')
    await expect(kernel.invoke('tapi:export', { projectId, filePath: bad })).rejects.toThrow()
    expect(existsSync(bad)).toBe(false)
  })
})

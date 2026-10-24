// @author yxpil
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createKernel, type Kernel } from '@main/kernel'
import { deriveChannelKey, seal } from '@main/node/channel'
import type { NodeListItem } from '@shared/channels'
import { startRange, type Range } from '../../fixtures/range'

const WORKER = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../dist-electron/script-worker.cjs',
)

/**
 * 双实例节点靶场（24 号文档 §10）：同一进程里起两个真实 ToAPI 内核，
 * 各占一个随机端口做真实 HTTP 握手与加密往返，不 mock 网络层。
 */

const PASSWORD_B = 'node-test-target-secret-1'
const PASSWORD_A = 'node-test-initiator-secret-1'
const TARGET_TOKEN = 'TARGET-ONLY-ON-B-9'

let a: Kernel
let b: Kernel
let range: Range
let dir: string
let node: NodeListItem
let bProjectId = ''
let bCollectionId = ''
let bEnvId = ''

/** 开放通道配置写入会顺带起监听，测试要随机端口就手工接管 */
const exposeNode = async (kernel: Kernel, password: string): Promise<number> => {
  await kernel.invoke('open:set-config', { password })
  await kernel.http.start('127.0.0.1', 0)
  kernel.open.config.setEnabled(true)
  const address = kernel.http.address ?? ''
  const port = Number(new URL(address).port)
  kernel.open.setRunning(true, port)
  return port
}

const seedProject = async (kernel: Kernel, name: string): Promise<void> => {
  const projectId = (await kernel.invoke('project:create', { name })).id
  const collection = await kernel.invoke('collection:create', { projectId, name: '主流程' })
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
    value: TARGET_TOKEN,
    secret: true,
  })
  const api = await kernel.invoke('api:create', {
    collectionId: collection.id,
    name: '回显',
    method: 'GET',
    url: '{{baseUrl}}/echo',
  })
  await kernel.invoke('api:update', {
    id: api.id,
    headers: [{ key: 'Authorization', value: 'Bearer {{token}}', enabled: true, desc: '' }],
    postScript: "toapi.test('状态 200', () => toapi.expect(toapi.response.status).toBe(200))",
  })
  if (kernel === b) {
    bProjectId = projectId
    bCollectionId = collection.id
    bEnvId = env.id
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'toapi-node-'))
  range = await startRange()
  const options = {
    dbPath: ':memory:',
    filesDir: dir,
    appVersion: 'test',
    scriptWorkerPath: WORKER,
    headless: true,
  }
  a = createKernel(options)
  b = createKernel(options)
  await seedProject(b, '远端靶项目')
  await seedProject(a, '本机项目')
  const portB = await exposeNode(b, PASSWORD_B)
  await exposeNode(a, PASSWORD_A)

  node = await a.invoke('node:add', {
    name: '靶机 B',
    host: '127.0.0.1',
    port: portB,
    password: PASSWORD_B,
  })
})

afterAll(async () => {
  await a?.http.stop()
  await b?.http.stop()
  a?.dispose()
  b?.dispose()
  await range?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('配对与信道（24 号文档 §2）', () => {
  it('配对即学到指纹，但未确认前不算可信', () => {
    expect(node.fingerprint).toMatch(/^([0-9a-f]{2}:){7}[0-9a-f]{2}$/)
    expect(node.confirmedFingerprint).toBe('')
    expect(node.trusted).toBe(false)
    expect(node.deviceId).toBe(b.node.selfDeviceId())
  })

  it('列表会并发探活，回包带对端项目摘要', async () => {
    const items = await a.invoke('node:list', {})
    const fresh = items.find((n) => n.id === node.id)
    expect(fresh?.probe).not.toBeNull()
    expect(fresh?.probe?.deviceId).toBe(b.node.selfDeviceId())
    expect(fresh?.probe?.projects.some((p) => p.id === bProjectId)).toBe(true)
    expect(JSON.stringify(fresh)).not.toContain(TARGET_TOKEN)
  })

  it('本机视图不含口令与信道密钥', async () => {
    const self = await a.invoke('node:self', {})
    expect(self.pairable).toBe(true)
    expect(self.access).toBe('loopback')
    expect(self.running).toBe(true)
    expect(Array.isArray(self.addresses)).toBe(true)
    expect(self.fingerprint).toMatch(/^([0-9a-f]{2}:){7}[0-9a-f]{2}$/)
    expect(JSON.stringify(self)).not.toContain(PASSWORD_A)
    const raw = a.repos.node.get(node.id)
    expect(raw?.channelKey.length).toBe(64)
  })

  it('口令错配不出可信节点，明文业务请求一律被拒', async () => {
    await expect(
      a.invoke('node:add', {
        name: '错口令',
        host: '127.0.0.1',
        port: Number(new URL(b.http.address ?? '').port),
        password: 'this-password-is-wrong-1',
      }),
    ).rejects.toThrow(/口令不正确/)
    const plain = await fetch(`${b.http.address}/v1/node/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: bProjectId }),
    })
    expect(plain.status).toBe(400)
    expect((await plain.text()).slice(0, 200)).toContain('只接受加密帧')
  })
})

describe('项目互传（24 号文档 §3）', () => {
  it('未确认指纹前拒绝推送与代跑', async () => {
    await expect(a.invoke('node:push', { nodeId: node.id, projectId: bProjectId })).rejects.toThrow(
      /指纹未确认/,
    )
    await expect(
      a.invoke('node:run', {
        nodeId: node.id,
        scopeType: 'collection',
        scopeId: bCollectionId,
        envId: bEnvId,
      }),
    ).rejects.toThrow(/指纹未确认/)
  })

  it('确认后拉取远端项目，密钥只到变量名', async () => {
    node = await a.invoke('node:confirm', { id: node.id })
    expect(node.trusted).toBe(true)

    const result = await a.invoke('node:pull', {
      nodeId: node.id,
      projectId: bProjectId,
      mode: 'new',
    })
    expect(result.imported.apis).toBeGreaterThan(0)
    expect(result.inspection.redactedCount).toBeGreaterThan(0)

    const envs = await a.invoke('env:list', { projectId: result.projectId })
    const token = envs.vars.find((v) => v.key === 'token')
    expect(token?.value ?? '').not.toContain(TARGET_TOKEN)
    expect(JSON.stringify(await a.invoke('project:list', {}))).not.toContain(TARGET_TOKEN)
  })

  it('推送本机项目到远端，对端按新项目的策略导入', async () => {
    const local = (await a.invoke('project:list', {}))[0]
    if (!local) throw new Error('本机项目未就绪')
    const pushed = await a.invoke('node:push', { nodeId: node.id, projectId: local.project.id })
    expect(pushed.imported).toBeGreaterThan(0)
    expect(pushed.message).toContain('密钥未跨机')
    const probe = b.node.localProbe()
    expect(probe.projects.some((p) => p.name === '本机项目')).toBe(true)
  })

  it('校验和被破坏的载荷整批回滚，不留半个项目', async () => {
    const packed = b.node.localPull(bProjectId)
    const file = JSON.parse(packed.content) as { meta: { checksum: string } }
    file.meta.checksum = '0'.repeat(64)
    const before = a.repos.project.list().length
    expect(() => a.tapi.import({ content: JSON.stringify(file) })).toThrow(/校验和不匹配/)
    expect(a.repos.project.list().length).toBe(before)
  })
})

describe('代为测试（24 号文档 §4）', () => {
  it('取远端结构只能拿到对端真实存在的集合与环境', async () => {
    const tree = await a.invoke('node:tree', { nodeId: node.id, projectId: bProjectId })
    expect(tree.collections.map((c) => c.id)).toContain(bCollectionId)
    expect(tree.envs.map((e) => e.id)).toContain(bEnvId)
  })

  it('远端真实执行，结果落成本机 remote 运行记录并汇报', async () => {
    const before = range.requests.length
    const started = await a.invoke('node:run', {
      nodeId: node.id,
      scopeType: 'collection',
      scopeId: bCollectionId,
      envId: bEnvId,
    })
    expect(started.runId).not.toBe('')

    let landed = a.repos.runner.list(5).find((r) => r.scopeType === 'remote')
    for (let i = 0; i < 40 && landed === undefined; i++) {
      await sleep(500)
      landed = a.repos.runner.list(5).find((r) => r.scopeType === 'remote')
    }
    expect(landed).toBeDefined()
    expect(landed?.total).toBe(1)
    expect(landed?.passed).toBe(1)
    expect(landed?.scopeName).toContain('靶机 B')
    expect(range.requests.length).toBeGreaterThan(before)

    const note = a.repos.notification.latest(10).find((n) => n.type === 'node.finished')
    expect(note?.title).toContain('1/1 通过')
  })

  it('取消能真的中断远端在跑的请求', async () => {
    const slow = await b.invoke('collection:create', { projectId: bProjectId, name: '慢集合' })
    await b.invoke('api:create', {
      collectionId: slow.id,
      name: '慢回显',
      method: 'GET',
      url: `${range.url('/slow')}?ms=6000`,
    })
    const started = await a.invoke('node:run', {
      nodeId: node.id,
      scopeType: 'collection',
      scopeId: slow.id,
      envId: bEnvId,
    })
    await a.invoke('node:run-cancel', { nodeId: node.id, runId: started.runId })

    let run = b.repos.runner.get(started.runId)
    for (let i = 0; i < 40 && (run === null || run.finishedAt === null); i++) {
      await sleep(250)
      run = b.repos.runner.get(started.runId)
    }
    expect(run?.finishedAt).not.toBeNull()
    expect(run?.passed).toBe(0)
    expect((run?.skipped ?? 0) + (run?.failed ?? 0)).toBe(1)
  })

  it('每次调用都进审计，摘要不含口令与密钥值', async () => {
    const log = await a.invoke('node:log', { limit: 50 })
    expect(log.length).toBeGreaterThan(0)
    expect(log.some((row) => row.direction === 'out' && row.action === 'run')).toBe(true)
    expect(log.some((row) => row.direction === 'out' && row.action === 'pull')).toBe(true)
    const text = JSON.stringify(log)
    expect(text).not.toContain(PASSWORD_A)
    expect(text).not.toContain(PASSWORD_B)
    expect(text).not.toContain(TARGET_TOKEN)

    const inbound = b.repos.node.recentLog(50)
    expect(inbound.some((row) => row.nodeId === '' && row.action === '/v1/node/run')).toBe(true)
  })
})

describe('信道降级与防重放（24 号文档 §2.2）', () => {
  it('对端换口令后本机拒绝写操作，只允许只读探测', async () => {
    const port = Number(new URL(b.http.address ?? '').port)
    await b.invoke('open:set-config', { password: 'rotated-target-secret-99' })
    b.open.config.setEnabled(true)
    b.open.setRunning(true, port)

    await expect(a.invoke('node:probe', { id: node.id })).rejects.toThrow(/不可达/)
    const items = await a.invoke('node:list', {})
    expect(items.find((n) => n.id === node.id)?.probe).toBeNull()
    expect(items.find((n) => n.id === node.id)?.lastError).toContain('口令不正确')
  })

  it('抓包重放旧序号会被拒', async () => {
    const address = b.http.address ?? ''
    const hello = await (await fetch(`${address}/v1/node/hello?deviceId=replay-kit`)).json()
    const salt = (hello as { data: { salt: string } }).data.salt
    const key = deriveChannelKey('rotated-target-secret-99', salt)
    const frame = seal(key, 'req', 1, '/v1/node/state', { from: 'replay-kit' })
    const post = (): Promise<Response> =>
      fetch(`${address}/v1/node/state`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-toapi-node': '1' },
        body: JSON.stringify(frame),
      })
    expect((await post()).status).toBe(200)
    const again = await post()
    expect(again.status).toBe(400)
    expect(await again.text()).toContain('序号回退')
  })
})

it('同一来源连续 3 次认证失败后锁 60 秒', async () => {
  const address = b.http.address ?? ''
  const junk = {
    iv: Buffer.alloc(12, 7).toString('base64'),
    ct: Buffer.from('junk-junk-junk-junk-junk', 'utf8').toString('base64'),
    seq: 1,
  }
  const post = async (): Promise<number> =>
    (
      await fetch(`${address}/v1/node/state`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-toapi-node': '1' },
        body: JSON.stringify(junk),
      })
    ).status
  expect(await post()).toBe(401)
  expect(await post()).toBe(401)
  expect(await post()).toBe(401)
  expect(await post()).toBe(429)
  const inbound = b.repos.node.recentLog(10)
  expect(inbound.some((row) => row.errorCode === 'LOCKED')).toBe(true)
})

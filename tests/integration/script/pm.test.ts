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
let collectionId: string
let envId: string
let seq = 0

const cancelId = (): string => `C${String(seq++).padStart(25, '0')}`
const rawHeaderLine = (): string => (range.last()?.rawHeaders ?? []).join('|')
const headerValue = (headers: [string, string][], name: string): string | undefined =>
  headers.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]

const makeCollection = async (name: string, variables: { key: string; value: string }[] = []) => {
  const collection = await kernel.invoke('collection:create', { projectId, name })
  if (variables.length > 0) {
    await kernel.invoke('collection:update', {
      id: collection.id,
      variables: variables.map((v) => ({ ...v, enabled: true, secret: false, desc: '' })),
    })
  }
  return collection.id
}

const makeApi = async (
  name: string,
  patch: Record<string, unknown>,
  targetCollectionId = collectionId,
): Promise<string> => {
  const api = await kernel.invoke('api:create', {
    collectionId: targetCollectionId,
    name,
    url: '{{baseUrl}}/echo',
    method: 'GET',
  })
  await kernel.invoke('api:update', { id: api.id, ...patch })
  return api.id
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'toapi-pm-'))
  range = await startRange()
  kernel = createKernel({
    dbPath: ':memory:',
    filesDir: dir,
    appVersion: 'test',
    scriptWorkerPath: WORKER,
  })
  expect(kernel.script).not.toBeNull()

  const project = await kernel.invoke('project:create', { name: 'pm 项目' })
  projectId = project.id
  const collection = await kernel.invoke('collection:create', { projectId, name: '主集合' })
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

describe('pm.test 与 pm.expect（23 号文档 §4.2/§4.3）', () => {
  it('同步/异步/回调/done/skip/失败都正确汇总', async () => {
    const id = await makeApi('pm 断言', {
      url: '{{baseUrl}}/status/201',
      postScript: `
        pm.test('状态与响应读取', function () {
          pm.response.to.have.status(201)
          pm.response.to.have.header('content-type')
          pm.response.to.have.body('statusOnly')
          pm.response.to.have.jsonBody({ statusOnly: true })
          pm.response.to.be.ok
          pm.response.to.be.success
          pm.expect(pm.response.code).to.equal(201)
          pm.expect(pm.response.status).to.be.a('string')
          pm.expect(pm.response.responseTime).to.be.at.least(0)
          pm.expect(pm.response.headers.get('content-type')).to.include('application/json')
          pm.expect(pm.response.json()).to.deep.equal({ statusOnly: true })
          pm.expect(pm.response.text()).to.include('statusOnly')
          pm.expect(pm.response.size()).to.be.above(0)
        })
        pm.test('chai 链式', function () {
          pm.expect({ a: 1, list: [1, 2] }).to.have.property('a', 1)
          pm.expect([1, 2, 3]).to.have.lengthOf(3)
          pm.expect('hello world').to.match(/wor/)
          pm.expect(5).to.be.above(4).and.below(6)
          pm.expect('abcdef').to.include('cde')
          pm.expect(null).to.be.null
          pm.expect(undefined).to.be.undefined
          pm.expect(true).to.be.true
          pm.expect({ x: 1 }).to.deep.equal({ x: 1 })
          pm.expect([]).to.be.empty
          pm.expect('abc').to.be.a('string')
          pm.expect(2).to.be.oneOf([1, 2, 3])
          pm.expect('abc').to.not.equal('abd')
          pm.expect({ n: 1 }).to.not.have.property('m')
          pm.expect([1, 2]).to.not.be.empty
        })
        pm.test.skip('本轮跳过')
        pm.test('故意失败', function () {
          pm.expect(1).to.equal(2)
        })
        pm.test('异步 resolve', function () {
          return new Promise(function (resolve) { setTimeout(resolve, 30) })
        })
        pm.test('回调 done', function (done) {
          setTimeout(done, 20)
        })
        pm.test('异步失败', function () {
          return Promise.reject(new Error('async boom'))
        })
      `,
    })
    const result = await kernel.invoke('api:send', { apiId: id, cancelId: cancelId() })
    const byName = new Map(result.script.assertions.map((a) => [a.name, a]))

    expect(byName.get('状态与响应读取')?.pass).toBe(true)
    expect(byName.get('chai 链式')?.pass).toBe(true)
    expect(byName.get('本轮跳过')?.skipped).toBe(true)
    expect(byName.get('本轮跳过')?.pass).toBe(true)
    expect(byName.get('故意失败')?.pass).toBe(false)
    expect(byName.get('故意失败')?.error).toContain('期望 2')
    expect(byName.get('异步 resolve')?.pass).toBe(true)
    expect(byName.get('回调 done')?.pass).toBe(true)
    expect(byName.get('异步失败')?.pass).toBe(false)
    expect(byName.get('异步失败')?.error).toContain('async boom')

    expect(byName.get('响应状态码 201')?.pass).toBe(true)
    expect(byName.get('响应头 content-type')?.pass).toBe(true)
    expect(byName.get('响应体包含文本')?.pass).toBe(true)
    expect(byName.get('响应体 JSON 匹配')?.pass).toBe(true)
    expect(byName.get('响应状态 ok')?.pass).toBe(true)
    expect(byName.get('响应状态 success')?.pass).toBe(true)
  })
})

describe('pm.request（23 号文档 §4.2）', () => {
  it('可改写方法/Header/URL/Body，local 变量参与插值', async () => {
    const id = await makeApi('pm 请求改写', {
      method: 'POST',
      url: '{{baseUrl}}/echo',
      headers: [{ key: 'X-Remove', value: '1', enabled: true, desc: '' }],
      bodyType: 'json',
      body: '{"seed":true}',
      preScript: `
        pm.request.method = 'POST'
        pm.request.headers.add({ key: 'X-Pm', value: 'yes' })
        pm.request.headers.upsert({ key: 'X-Trace', value: 'one' })
        pm.request.headers.upsert({ key: 'X-Trace', value: 'two' })
        pm.request.headers.remove('X-Remove')
        pm.request.url.addQueryParams({ q: 'pm' })
        pm.request.url.update(pm.request.url.toString())
        pm.request.body.update(JSON.stringify({ hi: 'there' }))
        pm.variables.set('localToken', 'LT')
        pm.request.headers.add({ key: 'X-Local-Template', value: '{{localToken}}' })
        pm.test('info', function () {
          pm.expect(pm.info.requestName).to.equal('pm 请求改写')
          pm.expect(pm.info.requestId).to.be.a('string')
          pm.expect(pm.info.eventName).to.equal('prerequest')
          pm.expect(pm.info.iteration).to.equal(1)
          pm.expect(pm.info.iterationCount).to.equal(1)
        })
        pm.test('请求视图', function () {
          pm.expect(pm.request.method).to.equal('POST')
          pm.expect(pm.request.headers.get('x-pm')).to.equal('yes')
          pm.expect(pm.request.headers.has('X-Trace')).to.equal(true)
          pm.expect(pm.request.headers.count()).to.equal(3)
          pm.expect(pm.request.url.query.get('q')).to.equal('pm')
          pm.expect(pm.request.body.toString()).to.include('there')
        })
      `,
    })
    const result = await kernel.invoke('api:send', { apiId: id, cancelId: cancelId() })

    expect(result.script.assertions.filter((a) => !a.pass)).toEqual([])
    expect(result.finalRequest.url).toContain('q=pm')
    expect(headerValue(result.finalRequest.headers, 'X-Pm')).toBe('yes')
    expect(result.finalRequest.headers.filter(([k]) => k === 'X-Trace')).toEqual([
      ['X-Trace', 'two'],
    ])
    expect(headerValue(result.finalRequest.headers, 'X-Remove')).toBeUndefined()
    expect(headerValue(result.finalRequest.headers, 'X-Local-Template')).toBe('LT')
    expect(Buffer.from(result.finalRequest.bodyBase64 ?? '', 'base64').toString('utf8')).toBe(
      '{"hi":"there"}',
    )
    expect(range.last()?.body).toBe('{"hi":"there"}')
  })

  it('skipRequest 中止发送', async () => {
    const before = range.requests.length
    const id = await makeApi('pm 跳过', {
      preScript: `pm.execution.skipRequest('条件不满足')`,
    })
    const result = await kernel.invoke('api:send', { apiId: id, cancelId: cancelId() })
    expect(result.skipped).toBe(true)
    expect(result.skipReason).toBe('条件不满足')
    expect(range.requests.length).toBe(before)
  })

  it('后置脚本对 pm.request 只读并记 warning', async () => {
    const id = await makeApi('后置只读', {
      postScript: `
        pm.test('后置请求视图', function () {
          pm.expect(pm.request.method).to.equal('GET')
        })
        pm.request.headers.add({ key: 'X-Post', value: 'no' })
        pm.request.method = 'DELETE'
        pm.request.url.addQueryParams({ late: '1' })
      `,
    })
    const result = await kernel.invoke('api:send', { apiId: id, cancelId: cancelId() })

    expect(result.finalRequest.method).toBe('GET')
    expect(headerValue(result.finalRequest.headers, 'X-Post')).toBeUndefined()
    expect(result.finalRequest.url).not.toContain('late=1')
    expect(result.script.postLogs.filter((l) => l.level === 'warn')).toHaveLength(3)
  })
})

describe('变量作用域与 Cookie（23 号文档 §4.2）', () => {
  it('collection/environment/globals/local 读写与 unset 持久化正确', async () => {
    const varsCollection = await makeCollection('变量集合', [
      { key: 'cVar', value: 'c1' },
      { key: 'cDelete', value: 'x' },
    ])
    await kernel.invoke('var:set', {
      scope: 'environment',
      environmentId: envId,
      key: 'eVar',
      value: 'e1',
    })
    await kernel.invoke('var:set', {
      scope: 'environment',
      environmentId: envId,
      key: 'eDelete',
      value: 'x',
    })
    await kernel.invoke('var:set', { scope: 'global', key: 'gVar', value: 'g1' })
    await kernel.invoke('var:set', { scope: 'global', key: 'gDelete', value: 'x' })

    const id = await makeApi(
      'pm 变量',
      {
        preScript: `
          pm.collectionVariables.set('cVar', 'c2')
          pm.collectionVariables.set('cNew', 'n1')
          pm.environment.set('eVar', 'e2')
          pm.globals.set('gVar', 'g2')
          pm.variables.set('localOnly', 'L')
          pm.test('前置作用域', function () {
            pm.expect(pm.collectionVariables.get('cVar')).to.equal('c2')
            pm.expect(pm.environment.get('eVar')).to.equal('e2')
            pm.expect(pm.globals.get('gVar')).to.equal('g2')
            pm.expect(pm.variables.get('localOnly')).to.equal('L')
            pm.expect(pm.collectionVariables.toObject()).to.have.property('cVar', 'c2')
            pm.expect(pm.variables.replaceIn('{{localOnly}}-{{cVar}}')).to.equal('L-c2')
          })
        `,
        postScript: `
          pm.test('前置写入在 post 可见', function () {
            pm.expect(pm.collectionVariables.get('cVar')).to.equal('c2')
            pm.expect(pm.environment.get('eVar')).to.equal('e2')
            pm.expect(pm.globals.get('gVar')).to.equal('g2')
            pm.expect(pm.variables.get('localOnly')).to.equal('L')
          })
          pm.collectionVariables.unset('cDelete')
          pm.environment.unset('eDelete')
          pm.globals.unset('gDelete')
        `,
      },
      varsCollection,
    )
    const result = await kernel.invoke('api:send', { apiId: id, cancelId: cancelId() })
    expect(result.script.assertions.filter((a) => !a.pass)).toEqual([])

    const collection = kernel.repos.collection.get(varsCollection)
    const collectionVars = new Map((collection?.variables ?? []).map((v) => [v.key, v.value]))
    expect(collectionVars.get('cVar')).toBe('c2')
    expect(collectionVars.get('cNew')).toBe('n1')
    expect(collectionVars.has('cDelete')).toBe(false)

    const envVars = new Map(kernel.repos.variable.listForEnv(envId).map((v) => [v.key, v.value]))
    expect(envVars.get('eVar')).toBe('e2')
    expect(envVars.has('eDelete')).toBe(false)

    const globalVars = new Map(kernel.repos.variable.listGlobals().map((v) => [v.key, v.value]))
    expect(globalVars.get('gVar')).toBe('g2')
    expect(globalVars.has('gDelete')).toBe(false)

    expect(kernel.flow.runtimeFor(projectId).has('localOnly')).toBe(false)
  })

  it('写环境变量但无激活环境时报错为失败断言', async () => {
    const standalone = await kernel.invoke('project:create', { name: '无环境项目' })
    const api = await kernel.invoke('api:create', {
      collectionId: (
        await kernel.invoke('collection:create', { projectId: standalone.id, name: '集合' })
      ).id,
      name: '无环境',
      url: `${range.origin}/echo`,
    })
    await kernel.invoke('api:update', {
      id: api.id,
      preScript: `pm.environment.set('x', '1')`,
    })
    const result = await kernel.invoke('api:send', {
      apiId: api.id,
      envId: null,
      cancelId: cancelId(),
    })
    const failure = result.script.assertions.find((a) => a.name === '脚本变量写入')
    expect(failure?.pass).toBe(false)
    expect(failure?.error).toContain('没有激活环境')
  })

  it('pm.response.cookies 解析 Set-Cookie，pm.cookies 读写项目 CookieJar', async () => {
    const planter = await makeApi('种 Cookie', {
      url: '{{baseUrl}}/cookie',
      postScript: `
        pm.test('响应 cookie', function () {
          pm.expect(pm.response.cookies.get('sid')).to.equal('abc123')
          pm.expect(pm.response.cookies.has('theme')).to.equal(true)
          pm.expect(pm.response.cookies.toObject()).to.have.property('sid', 'abc123')
        })
        pm.test('CookieJar 快照', function () {
          pm.expect(pm.cookies.get('sid')).to.equal('abc123')
          pm.expect(pm.cookies.has('theme')).to.equal(true)
          pm.expect(pm.cookies.toObject()).to.have.property('theme', 'dark')
        })
        pm.cookies.set('extra', 'x1')
        pm.cookies.unset('theme')
      `,
    })
    const planted = await kernel.invoke('api:send', { apiId: planter, cancelId: cancelId() })
    expect(planted.script.assertions.every((a) => a.pass)).toBe(true)

    const jar = kernel.flow.jarFor(projectId).list(range.url('/echo'))
    const jarMap = new Map(jar.map((c) => [c.name, c.value]))
    expect(jarMap.get('sid')).toBe('abc123')
    expect(jarMap.get('extra')).toBe('x1')
    expect(jarMap.has('theme')).toBe(false)

    const echo = await makeApi('带 Cookie', { url: '{{baseUrl}}/echo' })
    await kernel.invoke('api:send', { apiId: echo, cancelId: cancelId() })
    const cookieLine = rawHeaderLine()
    expect(cookieLine).toContain('sid=abc123')
    expect(cookieLine).toContain('extra=x1')
    expect(cookieLine).not.toContain('theme=dark')
  })
})

describe('pm.sendRequest 与沙箱库（23 号文档 §4.2/§4.4）', () => {
  it('Promise 与回调两种风格都能取到响应', async () => {
    const id = await makeApi('pm 子请求', {
      preScript: `
        pm.test('sendRequest Promise', async function () {
          const res = await pm.sendRequest({
            url: pm.variables.get('baseUrl') + '/token?user=pm',
            method: 'GET',
            header: [{ key: 'X-Sub', value: '1' }],
          })
          pm.expect(res.code).to.equal(201)
          pm.expect(res.json().data.token).to.equal('TOK-pm')
          pm.expect(res.headers.get('content-type')).to.include('json')
          pm.expect(res.responseTime).to.be.at.least(0)
          pm.expect(res.text()).to.include('TOK-pm')
          pm.request.headers.add({ key: 'Authorization', value: 'Bearer ' + res.json().data.token })
        })
        pm.test('sendRequest 回调', function () {
          return new Promise(function (resolve, reject) {
            pm.sendRequest(pm.variables.get('baseUrl') + '/token?user=cb', function (err, res) {
              if (err) return reject(err)
              try {
                pm.expect(res.json().data.token).to.equal('TOK-cb')
                resolve()
              } catch (e) {
                reject(e)
              }
            })
          })
        })
        pm.test('sendRequest auth basic', async function () {
          const res = await pm.sendRequest({
            url: pm.variables.get('baseUrl') + '/echo',
            auth: { type: 'basic', username: 'u', password: 'p' },
          })
          pm.expect(res.json().method).to.equal('GET')
        })
      `,
    })
    const result = await kernel.invoke('api:send', { apiId: id, cancelId: cancelId() })
    expect(result.script.assertions.filter((a) => !a.pass)).toEqual([])
    expect(headerValue(result.finalRequest.headers, 'Authorization')).toBe('Bearer TOK-pm')
  })

  it('lodash / CryptoJS / uuid / moment / atob / btoa 可用', async () => {
    const id = await makeApi('沙箱库', {
      preScript: `
        pm.test('lodash', function () {
          pm.expect(_.chunk([1, 2, 3, 4], 2)).to.deep.equal([[1, 2], [3, 4]])
          pm.expect(_.camelCase('foo bar')).to.equal('fooBar')
          pm.expect(_.get({ a: { b: 1 } }, 'a.b')).to.equal(1)
        })
        pm.test('CryptoJS', function () {
          pm.expect(CryptoJS.MD5('abc').toString()).to.equal('900150983cd24fb0d6963f7d28e17f72')
          pm.expect(CryptoJS.SHA256('abc').toString()).to.match(/^ba7816bf/)
          pm.expect(CryptoJS.HmacSHA256('hello', 'key').toString()).to.equal('9307b3b915efb5171ff14d8cb55fbcc798c6c0ef1456d66ded1a6aa723a58b7b')
          const encrypted = CryptoJS.AES.encrypt('hello', 'k').toString()
          pm.expect(CryptoJS.AES.decrypt(encrypted, 'k').toString(CryptoJS.enc.Utf8)).to.equal('hello')
          pm.expect(CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse('hi'))).to.equal('aGk=')
        })
        pm.test('uuid', function () {
          pm.expect(uuid.v4()).to.match(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
          pm.expect(uuid.v7()).to.match(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
        })
        pm.test('moment', function () {
          pm.expect(moment('2020-01-02T03:04:05Z').utc().format('YYYY-MM-DD HH:mm:ss')).to.equal('2020-01-02 03:04:05')
        })
        pm.test('atob/btoa', function () {
          pm.expect(btoa('hi')).to.equal('aGk=')
          pm.expect(atob('aGk=')).to.equal('hi')
          pm.expect(new URL(pm.variables.get('baseUrl')).pathname).to.equal('/')
        })
        console.log('sandbox log line')
      `,
    })
    const result = await kernel.invoke('api:send', { apiId: id, cancelId: cancelId() })
    expect(result.script.assertions.filter((a) => !a.pass)).toEqual([])
    expect(result.script.preLogs.map((l) => l.text)).toContain('sandbox log line')
  })
})

describe('动态变量（23 号文档 §4.5）', () => {
  it('URL/Header/Body 中每次独立求值，未知变量保留原文', async () => {
    const id = await makeApi('动态变量', {
      url: '{{baseUrl}}/echo?u={{$randomUUID}}&t={{$timestamp}}&i={{$randomInt}}&g1={{$guid}}&g2={{$guid}}',
      method: 'POST',
      bodyType: 'json',
      body: '{"id":"{{$randomUUID}}"}',
      headers: [
        { key: 'X-Dyn-Email', value: '{{$randomEmail}}', enabled: true, desc: '' },
        { key: 'X-Unknown', value: '{{$nope}}', enabled: true, desc: '' },
      ],
    })
    const result = await kernel.invoke('api:send', { apiId: id, cancelId: cancelId() })

    const url = new URL(result.finalRequest.url)
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    expect(url.searchParams.get('u')).toMatch(uuid)
    expect(url.searchParams.get('t')).toMatch(/^\d{10}$/)
    const randomInt = Number(url.searchParams.get('i'))
    expect(Number.isInteger(randomInt)).toBe(true)
    expect(randomInt).toBeGreaterThanOrEqual(0)
    expect(randomInt).toBeLessThanOrEqual(1000)
    expect(url.searchParams.get('g1')).toMatch(uuid)
    expect(url.searchParams.get('g2')).toMatch(uuid)
    expect(url.searchParams.get('g1')).not.toBe(url.searchParams.get('g2'))

    expect(headerValue(result.finalRequest.headers, 'X-Dyn-Email')).toMatch(/^[^@\s]+@[^@\s]+$/)
    expect(headerValue(result.finalRequest.headers, 'X-Unknown')).toBe('{{$nope}}')

    const body = Buffer.from(result.finalRequest.bodyBase64 ?? '', 'base64').toString('utf8')
    const parsed = JSON.parse(body) as { id: string }
    expect(parsed.id).toMatch(uuid)
    expect(body).not.toContain('{{')
  })
})

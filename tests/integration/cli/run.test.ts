import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createKernel } from '@main/kernel'
import { runCli } from '@main/cli/main'
import { startRange, type Range } from '../../fixtures/range'

const WORKER = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../dist-electron/script-worker.cjs',
)

let range: Range
let dir: string

interface ReportShape {
  run: {
    iterationCount: number
    stats: { total: number; passed: number; failed: number; skipped: number }
    executions: { name: string; status: string; iteration: number }[]
  }
}

const collection = (exec: string[]): string =>
  JSON.stringify({
    info: {
      name: 'CLI 回归',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: [
      {
        name: 'Echo',
        request: { method: 'GET', header: [], url: '{{baseUrl}}/echo?u={{user}}' },
        event: [{ listen: 'test', script: { type: 'text/javascript', exec } }],
      },
      {
        name: 'Token',
        request: { method: 'GET', header: [], url: '{{baseUrl}}/token?user={{user}}' },
      },
    ],
  })

const envFile = (): string =>
  JSON.stringify({
    name: 'cli',
    values: [{ key: 'baseUrl', value: range.origin, enabled: true, type: 'text' }],
  })

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'toapi-cli-'))
  range = await startRange()
})

afterAll(() => {
  void range.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('toapi run（23 号文档 §5.3）', () => {
  it('导入 Postman 集合 + 环境 + CSV 数据，退出码 0 并产出三种报告', async () => {
    const collectionPath = join(dir, 'collection.json')
    const envPath = join(dir, 'env.json')
    const dataPath = join(dir, 'rows.csv')
    writeFileSync(
      collectionPath,
      collection([
        "pm.test('数据行落到线上', () => {",
        "  pm.expect(pm.response.json().query.u).to.eql(pm.iterationData.get('user'))",
        '})',
      ]),
      'utf8',
    )
    writeFileSync(envPath, envFile(), 'utf8')
    writeFileSync(dataPath, 'user\nalice\nbob\n', 'utf8')

    const jsonPath = join(dir, 'out.json')
    const junitPath = join(dir, 'out.xml')
    const htmlPath = join(dir, 'out.html')
    const before = range.requests.length

    const code = await runCli([
      'run',
      collectionPath,
      '--env',
      envPath,
      '--data',
      dataPath,
      '--reporters',
      'json,junit,html',
      '--reporter-json-export',
      jsonPath,
      '--reporter-junit-export',
      junitPath,
      '--reporter-html-export',
      htmlPath,
    ])
    expect(code).toBe(0)

    const report = JSON.parse(readFileSync(jsonPath, 'utf8')) as ReportShape
    expect(report.run.iterationCount).toBe(2)
    expect(report.run.stats).toMatchObject({ total: 4, passed: 4, failed: 0 })
    expect(report.run.executions.map((e) => `${String(e.iteration)}:${e.name}`)).toEqual([
      '1:Echo',
      '1:Token',
      '2:Echo',
      '2:Token',
    ])
    const seen = range.requests.slice(before).map((r) => r.search)
    expect(seen).toEqual(['?u=alice', '?user=alice', '?u=bob', '?user=bob'])

    const xml = readFileSync(junitPath, 'utf8')
    expect(xml).toContain('tests="4" failures="0" errors="0" skipped="0"')
    expect(xml).toContain('name="[1/2] Echo"')
    expect(readFileSync(htmlPath, 'utf8')).toContain('ToAPI 运行报告')
  })

  it('断言失败时退出码 1，--bail 停在首个失败', async () => {
    const collectionPath = join(dir, 'fail.json')
    writeFileSync(
      collectionPath,
      collection(["pm.test('故意失败', () => { pm.expect(1).to.eql(2) })"]),
      'utf8',
    )
    const jsonPath = join(dir, 'fail.json.report.json')
    writeFileSync(join(dir, 'env2.json'), envFile(), 'utf8')

    const bailReport = join(dir, 'bail.json')
    const bailCode = await runCli([
      'run',
      collectionPath,
      '--env',
      join(dir, 'env2.json'),
      '--bail',
      '--quiet',
      '--reporters',
      'json',
      '--reporter-json-export',
      bailReport,
    ])
    expect(bailCode).toBe(1)
    const bail = JSON.parse(readFileSync(bailReport, 'utf8')) as ReportShape
    expect(bail.run.executions).toHaveLength(1)
    expect(bail.run.stats.failed).toBe(1)

    const fullCode = await runCli([
      'run',
      collectionPath,
      '--env',
      join(dir, 'env2.json'),
      '--quiet',
      '--reporters',
      'json',
      '--reporter-json-export',
      jsonPath,
    ])
    expect(fullCode).toBe(1)
    const full = JSON.parse(readFileSync(jsonPath, 'utf8')) as ReportShape
    expect(full.run.executions).toHaveLength(2)
    expect(full.run.stats.failed).toBe(1)
  })

  it('用法与文件错误一律退出码 2', async () => {
    expect(await runCli(['run'])).toBe(2)
    expect(await runCli(['run', join(dir, '不存在的集合.json')])).toBe(2)
    expect(await runCli(['run', '--db', join(dir, 'nope.db')])).toBe(2)
    const tapi = join(dir, 'project.tapi')
    writeFileSync(tapi, '{}', 'utf8')
    expect(await runCli(['run', tapi])).toBe(2)
  })

  it('--db 直接跑已有数据库，环境按名称激活', async () => {
    const dbPath = join(dir, 'toapi.db')
    const kernel = createKernel({
      dbPath,
      filesDir: dir,
      appVersion: 'test',
      scriptWorkerPath: WORKER,
    })
    const { repos } = kernel
    const project = repos.project.create({ name: '库内项目' })
    const collectionRow = repos.collection.create({ projectId: project.id, name: '库内集合' })
    const api = repos.api.create({
      collectionId: collectionRow.id,
      name: 'Echo',
      method: 'GET',
      url: '{{baseUrl}}/echo',
    })
    repos.api.update(api.id, {
      postScript: "toapi.test('状态 200', () => toapi.expect(toapi.response.status).toBe(200))",
    })
    const env = repos.environment.create({ projectId: project.id, name: 'prod' })
    repos.environment.activate(project.id, env.id)
    repos.variable.upsert({
      scope: 'environment',
      environmentId: env.id,
      key: 'baseUrl',
      value: range.origin,
    })
    kernel.dispose()

    const report = join(dir, 'db-run.json')
    const code = await runCli([
      'run',
      '--db',
      dbPath,
      '--project',
      '库内项目',
      '--env',
      'prod',
      '--quiet',
      '--reporters',
      'json',
      '--reporter-json-export',
      report,
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(readFileSync(report, 'utf8')) as ReportShape
    expect(parsed.run.executions.map((e) => e.status)).toEqual(['passed'])
  })

  it('--iteration-count 与 --globals：行数不足时循环复用，数据行优先于全局变量', async () => {
    const collectionPath = join(dir, 'iter.json')
    writeFileSync(
      collectionPath,
      collection([
        'pm.test("数据行优先于全局变量", () => {',
        '  pm.expect(pm.iterationData.get("user")).to.eql("alice")',
        '})',
      ]),
      'utf8',
    )
    const envPath = join(dir, 'env3.json')
    writeFileSync(envPath, envFile(), 'utf8')
    const globalsPath = join(dir, 'globals.json')
    writeFileSync(globalsPath, JSON.stringify({ values: [{ key: 'user', value: 'neo' }] }), 'utf8')
    const dataPath = join(dir, 'one.csv')
    writeFileSync(dataPath, 'user\nalice\n', 'utf8')
    const report = join(dir, 'iter.json.out')
    const before = range.requests.length

    const code = await runCli([
      'run',
      collectionPath,
      '--env',
      envPath,
      '--globals',
      globalsPath,
      '--data',
      dataPath,
      '--iteration-count',
      '3',
      '--quiet',
      '--reporters',
      'json',
      '--reporter-json-export',
      report,
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(readFileSync(report, 'utf8')) as ReportShape
    expect(parsed.run.iterationCount).toBe(3)
    expect(parsed.run.stats.total).toBe(6)
    // 数据行只有 1 行时循环复用，且优先级高于 --globals 里的同名变量
    expect(range.requests.slice(before).map((r) => r.search)).toEqual([
      '?u=alice',
      '?user=alice',
      '?u=alice',
      '?user=alice',
      '?u=alice',
      '?user=alice',
    ])
  })

  it('--help 返回 0', async () => {
    expect(await runCli(['--help'])).toBe(0)
    expect(await runCli(['--version'])).toBe(0)
  })
})

// @author yxpil
import { describe, expect, it } from 'vitest'
import type { RunnerItem, RunnerRun } from '@main/db/repo/runner.repo'
import { itemLine, renderHtml, renderJson, renderJunit, summaryLines } from '@main/cli/reporters'

const item = (patch: Partial<RunnerItem>): RunnerItem => ({
  id: 'i1',
  runId: 'r1',
  apiId: 'a1',
  apiName: '登录',
  status: 'passed',
  historyId: 'h1',
  timeMs: 12.4,
  assertions: [],
  logs: [],
  error: null,
  sortOrder: 0,
  iteration: 1,
  ...patch,
})

const run = (items: RunnerItem[]): RunnerRun => ({
  id: 'r1',
  scopeType: 'collection',
  scopeId: 'c1',
  scopeName: '冒烟 & 回归',
  envId: null,
  startedAt: 1_700_000_000_000,
  finishedAt: 1_700_000_003_456,
  total: items.length,
  passed: items.filter((i) => i.status === 'passed').length,
  failed: items.filter((i) => i.status === 'failed' || i.status === 'error').length,
  skipped: items.filter((i) => i.status === 'skipped').length,
  iterationCount: 1,
  items,
})

describe('CLI 行内输出', () => {
  it('单轮迭代不显示轮次前缀', () => {
    expect(itemLine(item({ timeMs: 12.4 }), 1)).toBe('通过 · 登录 · 12ms · 无断言')
  })

  it('多轮迭代带轮次，断言按通过数统计', () => {
    const line = itemLine(
      item({
        iteration: 2,
        status: 'failed',
        assertions: [
          { name: 'a', pass: true },
          { name: 'b', pass: false, error: '期望 1' },
        ],
      }),
      3,
    )
    expect(line).toBe('第 2/3 轮 · 失败 · 登录 · 12ms · 断言 1/2')
  })

  it('汇总含通过率与耗时', () => {
    const text = summaryLines(run([item({}), item({ status: 'failed', id: 'i2' })])).join('\n')
    expect(text).toContain('通过率 50.0%')
    expect(text).toContain('耗时：3.46s')
    expect(text).toContain('冒烟 & 回归（collection）')
  })
})

describe('JSON 报告', () => {
  it('机器可读：stats + executions', () => {
    const parsed = JSON.parse(renderJson(run([item({})]))) as {
      run: { stats: Record<string, unknown>; executions: Record<string, unknown>[] }
    }
    expect(parsed.run.stats).toMatchObject({ total: 1, passed: 1, failed: 0 })
    expect(parsed.run.executions[0]).toMatchObject({ name: '登录', status: 'passed', iteration: 1 })
  })
})

describe('JUnit 报告', () => {
  it('计数正确且文本做 XML 转义', () => {
    const xml = renderJunit(
      run([
        item({ status: 'failed', error: 'a<b & "c"' }),
        item({ status: 'error', id: 'i2', error: '连接被拒' }),
        item({ status: 'skipped', id: 'i3' }),
      ]),
    )
    expect(xml).toContain('<testsuites name="ToAPI" tests="3" failures="1" errors="1" skipped="1"')
    expect(xml).toContain('a&lt;b &amp; &quot;c&quot;')
    expect(xml).toContain('<error message="连接被拒">')
    expect(xml).toContain('<skipped/>')
    expect(xml).toContain('timestamp="2023-11-')
  })

  it('迭代名带轮次前缀', () => {
    const multi = run([item({ iteration: 1 }), item({ iteration: 2, id: 'i2' })])
    const xml = renderJunit({ ...multi, iterationCount: 2 })
    expect(xml).toContain('name="[1/2] 登录"')
    expect(xml).toContain('name="[2/2] 登录"')
  })
})

describe('HTML 报告', () => {
  it('自包含、无外部资源、状态行齐全', () => {
    const html = renderHtml(
      run([item({}), item({ status: 'failed', id: 'i2', error: '断言失败' })]),
    )
    expect(html).toContain('<!doctype html>')
    expect(html).not.toContain('<script')
    expect(html).not.toMatch(/https?:\/\//)
    expect(html).toContain('class="failed"')
    expect(html).toContain('断言失败')
  })
})

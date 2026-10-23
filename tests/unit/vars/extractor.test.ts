import { describe, expect, it } from 'vitest'
import { preview, runAll, runExtractor, type ExtractSource } from '@main/vars/extractor'
import type { Extractor } from '@shared/types'

const source: ExtractSource = {
  status: 201,
  headers: [
    ['content-type', 'application/json'],
    ['X-Trace-Id', 'trace-9'],
  ],
  bodyText: '{"data":{"token":"TOK-1","list":[{"id":7},{"id":8}]}}',
}

const ex = (patch: Partial<Extractor>): Extractor => ({
  name: 'v',
  source: 'body',
  type: 'jsonpath',
  expr: '$.data.token',
  scope: 'runtime',
  ...patch,
})

describe('runExtractor', () => {
  it('JSONPath 命中字符串值', () => {
    const r = runExtractor(ex({ name: 'token' }), source)
    expect(r).toMatchObject({ hit: true, value: 'TOK-1', scope: 'runtime' })
  })

  it('JSONPath 命中对象时序列化为 JSON 文本', () => {
    const r = runExtractor(ex({ expr: '$.data.list[0]' }), source)
    expect(r.hit).toBe(true)
    expect(r.value).toBe('{"id":7}')
  })

  it('JSONPath 未命中返回 hit=false', () => {
    expect(runExtractor(ex({ expr: '$.nope.deep' }), source).hit).toBe(false)
  })

  it('响应体不是 JSON 时 JSONPath 直接 miss', () => {
    const r = runExtractor(ex({}), { ...source, bodyText: 'not json' })
    expect(r.hit).toBe(false)
  })

  it('header 提取大小写不敏感，expr 即头名', () => {
    expect(runExtractor(ex({ source: 'header', expr: 'x-trace-id' }), source).value).toBe('trace-9')
    expect(runExtractor(ex({ source: 'header', expr: 'absent' }), source).hit).toBe(false)
  })

  it('status 来源配合正则取状态码', () => {
    const r = runExtractor(ex({ source: 'status', type: 'regex', expr: '(2\\d{2})' }), source)
    expect(r).toMatchObject({ hit: true, value: '201' })
  })

  it('正则取第一个捕获组', () => {
    const r = runExtractor(ex({ type: 'regex', expr: /token":"(TOK-\d+)/.source }), source)
    expect(r.value).toBe('TOK-1')
  })

  it('非法正则不抛异常，返回 miss', () => {
    expect(runExtractor(ex({ type: 'regex', expr: '([' }), source).hit).toBe(false)
  })

  it('runAll 保持声明顺序', () => {
    const all = runAll([ex({ name: 'a' }), ex({ name: 'b', expr: '$.data.list[1].id' })], source)
    expect(all.map((o) => [o.name, o.value])).toEqual([
      ['a', 'TOK-1'],
      ['b', '8'],
    ])
  })
})

describe('preview', () => {
  it('超长截断加省略号', () => {
    const long = 'x'.repeat(300)
    expect(preview(long).length).toBeLessThanOrEqual(201)
    expect(preview(long).endsWith('…')).toBe(true)
  })
})

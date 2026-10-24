// @author yxpil
import { describe, expect, it } from 'vitest'
import { canonicalJson, checksumOf, type TapiPayload } from '@main/tapi/format'

const payload = (extra: Record<string, unknown> = {}): TapiPayload => ({
  project: {
    name: '订单中心',
    description: '',
    settings: {},
    auth: { type: 'none' },
    variables: [],
    pre_script: '',
    post_script: '',
    collections: [],
  },
  environments: [],
  globals: [],
  cases: [],
  ...extra,
})

describe('规范化 JSON（08 号文档 §6）', () => {
  it('键按字典序排序，与写入顺序无关', () => {
    expect(canonicalJson({ b: 1, a: 2, c: { y: 1, x: 2 } })).toBe('{"a":2,"b":1,"c":{"x":2,"y":1}}')
    expect(canonicalJson({ a: 2, b: 1, c: { x: 2, y: 1 } })).toBe('{"a":2,"b":1,"c":{"x":2,"y":1}}')
  })

  it('数组保持原顺序（接口顺序是语义的一部分）', () => {
    expect(canonicalJson([2, 1])).toBe('[2,1]')
  })

  it('undefined 与函数值降级为 null，不会产生空洞', () => {
    expect(canonicalJson({ a: undefined })).toBe('{"a":null}')
  })

  it('中文与转义字符按 JSON 规则编码', () => {
    expect(canonicalJson({ 'a"b': '中文' })).toBe('{"a\\"b":"中文"}')
  })
})

describe('校验和', () => {
  it('同内容同哈希，改一个字段就变', () => {
    const a = checksumOf(payload())
    expect(a).toBe(checksumOf(payload()))
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/)
    const changed = payload()
    changed.project.name = '另一个项目'
    expect(checksumOf(changed)).not.toBe(a)
  })

  it('数组顺序参与哈希', () => {
    const one = payload({ globals: [{ key: 'a', value: '1', secret: false, enabled: true }] })
    const two = payload({
      globals: [
        { key: 'a', value: '1', secret: false, enabled: true },
        { key: 'b', value: '2', secret: false, enabled: true },
      ],
    })
    expect(checksumOf(one)).not.toBe(checksumOf(two))
  })
})

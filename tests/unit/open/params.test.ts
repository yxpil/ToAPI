// @author yxpil
import { describe, expect, it } from 'vitest'
import { ToolInputError, validateParams, type FieldSpec } from '@main/open/tools'

const spec: Record<string, FieldSpec> = {
  projectId: { type: 'string', required: true, max: 64 },
  limit: { type: 'number' },
  stopOnFail: { type: 'boolean' },
  scopeType: { type: 'string', required: true, enum: ['collection', 'project', 'api'] },
  collectionIds: { type: 'stringArray' },
  iterationData: { type: 'recordArray' },
  draft: { type: 'draft' },
}

describe('开放通道入参校验（11 号文档 §2.2）', () => {
  it('必填缺失时报字段名', () => {
    expect(() => validateParams(spec, { projectId: 'p' })).toThrow('缺少参数 scopeType')
  })

  it('未定义的参数直接拒绝，防止夹带', () => {
    expect(() => validateParams(spec, { projectId: 'p', scopeType: 'api', sneaky: 1 })).toThrow(
      '不支持的参数 sneaky',
    )
  })

  it('类型与枚举校验', () => {
    expect(() => validateParams(spec, { projectId: 1, scopeType: 'api' })).toThrow('需要字符串')
    expect(() => validateParams(spec, { projectId: 'p', scopeType: 'folder' })).toThrow('只能是')
    expect(() => validateParams(spec, { projectId: 'p', scopeType: 'api', limit: '20' })).toThrow(
      'limit 需要数字',
    )
  })

  it('长度与形状限制', () => {
    expect(() => validateParams(spec, { projectId: 'x'.repeat(80), scopeType: 'api' })).toThrow(
      '过长',
    )
    expect(() =>
      validateParams(spec, { projectId: 'p', scopeType: 'api', collectionIds: [1] }),
    ).toThrow('字符串数组')
    expect(() =>
      validateParams(spec, { projectId: 'p', scopeType: 'api', iterationData: [['a']] }),
    ).toThrow('需要对象')
  })

  it('draft 至少要有 method 与 url，且 URL 有上限', () => {
    expect(() =>
      validateParams(spec, { projectId: 'p', scopeType: 'api', draft: { method: 'GET' } }),
    ).toThrow('method 与 url')
    expect(() =>
      validateParams(spec, {
        projectId: 'p',
        scopeType: 'api',
        draft: { method: 'GET', url: 'x'.repeat(9000) },
      }),
    ).toThrow('过长')
    const ok = validateParams(spec, {
      projectId: 'p',
      scopeType: 'api',
      draft: { method: 'POST', url: 'http://x/y' },
    })
    expect(ok['draft']).toMatchObject({ method: 'POST' })
  })

  it('null 与 undefined 视为缺省，空对象合法时报必填错', () => {
    expect(() => validateParams(spec, null)).toThrow(ToolInputError)
    expect(() => validateParams(spec, [])).toThrow(ToolInputError)
    expect(() =>
      validateParams(spec, { projectId: 'p', scopeType: 'api', limit: undefined }),
    ).not.toThrow()
  })
})

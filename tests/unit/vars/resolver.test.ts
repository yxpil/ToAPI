import { describe, expect, it } from 'vitest'
import { findVarNames, mapLookup, resolveVars } from '@main/vars/resolver'

const lookupOf = (record: Record<string, string>) => mapLookup(new Map(Object.entries(record)))

describe('VarResolver.resolve', () => {
  it('替换命中的变量', () => {
    const r = resolveVars('{{baseUrl}}/users', lookupOf({ baseUrl: 'https://api.test' }))
    expect(r.text).toBe('https://api.test/users')
    expect(r.status).toBe('ok')
  })

  it('未命中时保留原文并记录 missing', () => {
    const r = resolveVars('{{missing}} 和 {{alsoMissing}}', lookupOf({}))
    expect(r.text).toBe('{{missing}} 和 {{alsoMissing}}')
    expect(r.missing).toEqual(['missing', 'alsoMissing'])
    expect(r.status).toBe('missing')
  })

  it('容忍花括号内空格', () => {
    expect(resolveVars('{{ token }}', lookupOf({ token: 'T1' })).text).toBe('T1')
  })

  it('值中嵌套引用继续展开', () => {
    const r = resolveVars('{{full}}', lookupOf({ full: '{{host}}/v1', host: 'example.com' }))
    expect(r.text).toBe('example.com/v1')
  })

  it('循环引用返回 cycle 而不是死循环', () => {
    const r = resolveVars('{{a}}', lookupOf({ a: '{{b}}', b: '{{a}}' }))
    expect(r.status).toBe('cycle')
    expect(r.cycle?.length).toBeGreaterThan(0)
  })

  it('优先级由 mapLookup 参数顺序决定（后者覆盖）', () => {
    const globals = new Map([['k', 'global']])
    const env = new Map([['k', 'env']])
    const runtime = new Map([['k', 'runtime']])
    expect(resolveVars('{{k}}', mapLookup(globals, env, runtime)).text).toBe('runtime')
    expect(resolveVars('{{k}}', mapLookup(globals, env)).text).toBe('env')
  })

  it('空文本与无变量文本原样返回', () => {
    expect(resolveVars('', lookupOf({}))).toMatchObject({ text: '', status: 'ok' })
    expect(resolveVars('plain', lookupOf({})).text).toBe('plain')
  })
})

describe('findVarNames', () => {
  it('去重列出所有引用', () => {
    expect(findVarNames('{{a}}-{{b}}-{{a}}')).toEqual(['a', 'b'])
  })
})

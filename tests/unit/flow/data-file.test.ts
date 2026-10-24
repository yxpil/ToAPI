import { describe, expect, it } from 'vitest'
import { parseCsvRows, parseData, parseJsonRows } from '@main/flow/data-file'

describe('CSV 数据文件（23 号文档 §5.1）', () => {
  it('首行表头 + 每行一条记录', () => {
    expect(parseCsvRows('user,age\nalice,30\nbob,25')).toEqual([
      { user: 'alice', age: '30' },
      { user: 'bob', age: '25' },
    ])
  })

  it('RFC 4180：引号内逗号、换行与 "" 转义', () => {
    const rows = parseCsvRows('a,b\n"x,1","line1\nline2"\n"say ""hi""",plain')
    expect(rows).toEqual([
      { a: 'x,1', b: 'line1\nline2' },
      { a: 'say "hi"', b: 'plain' },
    ])
  })

  it('BOM 与 CRLF 都能识别，末尾空行被丢弃', () => {
    expect(parseCsvRows('\uFEFFk,v\r\n1,2\r\n\r\n')).toEqual([{ k: '1', v: '2' }])
  })

  it('缺列补空串，空表头列被忽略', () => {
    expect(parseCsvRows('a,b,\n1')).toEqual([{ a: '1', b: '' }])
  })

  it('空文件报错', () => {
    expect(() => parseCsvRows('')).toThrow('CSV 数据文件为空')
  })
})

describe('JSON 数据文件', () => {
  it('对象数组每项一行，值统一转字符串', () => {
    expect(parseJsonRows('[{"id":1,"ok":true,"tags":["a"]}]')).toEqual([
      { id: '1', ok: 'true', tags: '["a"]' },
    ])
  })

  it('单个对象视为一行', () => {
    expect(parseJsonRows('{"a":"b"}')).toEqual([{ a: 'b' }])
  })

  it('null 转空串', () => {
    expect(parseJsonRows('[{"a":null}]')).toEqual([{ a: '' }])
  })

  it('非对象行报错并指明行号', () => {
    expect(() => parseJsonRows('[{"a":1},"x"]')).toThrow('第 2 行不是对象')
  })

  it('非法 JSON 报错', () => {
    expect(() => parseJsonRows('{')).toThrow('JSON 数据文件解析失败')
  })
})

describe('格式选择', () => {
  it('csv 走表头解析，json 走对象数组解析', () => {
    expect(parseData('a\n1', 'csv')).toEqual([{ a: '1' }])
    expect(parseData('[{"a":"1"}]', 'json')).toEqual([{ a: '1' }])
  })
})

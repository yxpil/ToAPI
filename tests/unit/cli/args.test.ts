import { describe, expect, it } from 'vitest'
import { CliUsageError, parseArgs } from '@main/cli/args'

describe('CLI 参数解析（23 号文档 §5.3）', () => {
  it('位置参数：run + 集合文件', () => {
    const opts = parseArgs(['run', 'collection.json'])
    expect(opts).toMatchObject({ command: 'run', file: 'collection.json', reporters: ['cli'] })
  })

  it('--db 模式与位置参数互斥', () => {
    expect(() => parseArgs(['run', 'a.json', '--db', 'x.db'])).toThrow(CliUsageError)
    expect(parseArgs(['run', '--db', 'x.db', '--project', '演示']).collection).toBeUndefined()
  })

  it('没有任何来源时报用法错误', () => {
    expect(() => parseArgs(['run'])).toThrow('需要一个 Postman Collection 文件')
  })

  it('未知选项与未知命令都拒绝', () => {
    expect(() => parseArgs(['run', 'a.json', '--bogus'])).toThrow('未知选项')
    expect(() => parseArgs(['fly', 'a.json'])).toThrow('未知命令')
  })

  it('--folder 是 --collection 的别名（照搬 Newman 命令）', () => {
    expect(parseArgs(['run', 'a.json', '--folder', '登录']).collection).toBe('登录')
  })

  it('数值选项解析并校验', () => {
    const opts = parseArgs([
      'run',
      'a.json',
      '--iteration-count',
      '5',
      '--delay',
      '200',
      '--timeout',
      '3000',
    ])
    expect(opts).toMatchObject({ iterationCount: 5, delayMs: 200, timeoutMs: 3000 })
    expect(() => parseArgs(['run', 'a.json', '--delay', 'abc'])).toThrow('--delay 需要非负整数')
    expect(() => parseArgs(['run', 'a.json', '--iteration-count', '0'])).toThrow(
      '--iteration-count 至少为 1',
    )
  })

  it('reporters 逗号分隔且校验取值', () => {
    expect(parseArgs(['run', 'a.json', '--reporters', 'json,junit']).reporters).toEqual([
      'json',
      'junit',
    ])
    expect(() => parseArgs(['run', 'a.json', '--reporters', 'csv'])).toThrow('未知 reporter')
  })

  it('缺参数值时报错而不是吞掉下一个选项', () => {
    expect(() => parseArgs(['run', 'a.json', '--env', '--bail'])).toThrow('--env 需要一个参数值')
  })

  it('--bail / --quiet / 帮助与版本', () => {
    expect(parseArgs(['run', 'a.json', '--bail', '--quiet'])).toMatchObject({
      bail: true,
      quiet: true,
    })
    expect(parseArgs(['--help']).command).toBe('help')
    expect(parseArgs(['-v']).command).toBe('version')
  })
})

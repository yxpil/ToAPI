// @author yxpil
import { describe, expect, it } from 'vitest'
import { nextAfter, parseCron, validateSpec } from '@main/schedule/cron'

/** 定时任务触发时刻（12 号文档 §1/§5）：本机时区，断言都用本地时间构造，避免 CI 时区影响 */
const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number =>
  new Date(y, mo - 1, d, h, mi, s, 0).getTime()

const fmt = (ms: number): string => {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`
}

describe('cron 解析（12 号文档 §1）', () => {
  it('6 段表达式按秒起算，5 段补 0 秒', () => {
    const six = parseCron('0 */30 * * * *')
    expect([...six.second]).toEqual([0])
    expect([...six.minute].sort((a, b) => a - b)).toEqual([0, 30])
    const five = parseCron('*/30 * * * *')
    expect([...five.second]).toEqual([0])
    expect([...five.minute].sort((a, b) => a - b)).toEqual([0, 30])
  })

  it('列表、区间与步长', () => {
    const f = parseCron('0 0,15,30 9-11 * * *')
    expect([...f.minute].sort((a, b) => a - b)).toEqual([0, 15, 30])
    expect([...f.hour].sort((a, b) => a - b)).toEqual([9, 10, 11])
    expect([...parseCron('0 5/20 * * * *').minute].sort((a, b) => a - b)).toEqual([5, 25, 45])
  })

  it('周日允许写 7，归一为 0', () => {
    expect([...parseCron('0 0 0 * * 7').dow]).toEqual([0])
  })

  it('非法表达式给出可读中文错误', () => {
    expect(() => parseCron('* * *')).toThrow('需要 5 或 6 段')
    expect(() => parseCron('0 60 * * * *')).toThrow('超出')
    expect(() => parseCron('0 5-1 * * * *')).toThrow('起点大于终点')
    expect(() => parseCron('0 abc * * * *')).toThrow('不是数字')
    expect(() => parseCron('0 */0 * * * *')).toThrow('步长')
  })
})

describe('触发时刻计算', () => {
  it('每 15 分钟：从整点后 30 秒排到下一刻', () => {
    const times = nextAfter({ kind: 'cron', expr: '*/15 * * * *' }, at(2026, 10, 24, 10, 0, 30), 3)
    expect(times.map(fmt)).toEqual([
      '2026-10-24 10:15:00',
      '2026-10-24 10:30:00',
      '2026-10-24 10:45:00',
    ])
  })

  it('每天 09:00：当天已过则排到次日', () => {
    const times = nextAfter({ kind: 'cron', expr: '0 9 * * *' }, at(2026, 10, 24, 10, 0), 2)
    expect(times.map(fmt)).toEqual(['2026-10-25 09:00:00', '2026-10-26 09:00:00'])
  })

  it('工作日 09:00：周五晚排到下周一（跨周末）', () => {
    // 2026-10-23 是周五
    const times = nextAfter({ kind: 'cron', expr: '0 9 * * 1-5' }, at(2026, 10, 23, 12, 0), 1)
    expect(times.map(fmt)).toEqual(['2026-10-26 09:00:00'])
  })

  it('日与周同时受限时取并集（Vixie cron 语义）', () => {
    // 2026-10-09 是周五；08:00 之后先命中 13 日（按日），再命中下个周五 16 日（按周）
    const times = nextAfter({ kind: 'cron', expr: '0 0 13 * 5' }, at(2026, 10, 9, 8, 0), 2)
    expect(times.map(fmt)).toEqual(['2026-10-13 00:00:00', '2026-10-16 00:00:00'])
  })

  it('日字段受限、周为 * 时只按日匹配', () => {
    const times = nextAfter({ kind: 'cron', expr: '0 0 1 1 *' }, at(2026, 3, 1, 0, 0), 2)
    expect(times.map(fmt)).toEqual(['2027-01-01 00:00:00', '2028-01-01 00:00:00'])
  })

  it('2 月 30 日永不触发，返回空而不是死循环', () => {
    expect(nextAfter({ kind: 'cron', expr: '0 0 30 2 *' }, at(2026, 1, 1, 0, 0), 3)).toEqual([])
  })

  it('间隔以整分对齐，不随触发时刻累加漂移', () => {
    const times = nextAfter({ kind: 'interval', everyMs: 60_000 }, at(2026, 10, 24, 10, 0, 30), 2)
    expect(times.map(fmt)).toEqual(['2026-10-24 10:01:00', '2026-10-24 10:02:00'])
  })

  it('单次任务：未来时刻排一次，已过则不排', () => {
    const future = at(2026, 10, 25, 9, 0)
    expect(nextAfter({ kind: 'once', at: future }, at(2026, 10, 24, 10, 0), 5)).toEqual([future])
    expect(nextAfter({ kind: 'once', at: future }, future, 5)).toEqual([])
  })
})

describe('表达式校验（task:create 前置闸门）', () => {
  it('合法返回 null，非法返回中文原因', () => {
    expect(validateSpec({ kind: 'cron', expr: '0 * * * *' })).toBeNull()
    expect(validateSpec({ kind: 'interval', everyMs: 60_000 })).toBeNull()
    expect(validateSpec({ kind: 'interval', everyMs: 500 })).toBe('间隔至少 1000 毫秒')
    expect(validateSpec({ kind: 'cron', expr: '99 * * * *' })).toContain('超出')
  })
})

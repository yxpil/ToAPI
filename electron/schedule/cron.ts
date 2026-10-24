// @author yxpil
/**
 * cron / interval / once 触发时刻计算（12 号文档 §1）：自实现解析，不引第三方依赖。
 * 表达式为本机时区，5 段（分 时 日 月 周）或 6 段（秒 分 时 日 月 周）。
 */
import type { ScheduleSpec } from '@shared/channels'

export interface CronFields {
  second: Set<number>
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
  /** dom / dow 同时受限时按「或」语义，任一为 * 时按受限那个（Vixie cron 规则） */
  domAll: boolean
  dowAll: boolean
}

const RANGES: [min: number, max: number][] = [
  [0, 59],
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  // 周允许 7 表示周日，解析后归一到 0
  [0, 7],
]

const FIELD_NAMES = ['秒', '分', '时', '日', '月', '周']

const bad = (message: string): never => {
  throw new Error(message)
}

const toInt = (text: string, field: string): number => {
  if (!/^\d+$/.test(text)) bad(`${field}「${text}」不是数字`)
  return Number.parseInt(text, 10)
}

const parsePart = (
  part: string,
  range: [number, number],
  field: string,
  out: Set<number>,
): void => {
  if (part === '') bad(`${field}含有空项`)
  const slash = part.indexOf('/')
  const body = slash < 0 ? part : part.slice(0, slash)
  const step = slash < 0 ? 1 : toInt(part.slice(slash + 1), `${field} 步长`)
  if (step < 1) bad(`${field} 步长必须 ≥ 1`)
  let lo: number
  let hi: number
  if (body === '*') {
    lo = range[0]
    hi = range[1]
  } else if (body.includes('-')) {
    const [a, b] = body.split('-')
    lo = toInt(a ?? '', field)
    hi = toInt(b ?? '', field)
    if (lo > hi) bad(`${field}区间「${body}」起点大于终点`)
  } else {
    lo = toInt(body, field)
    // 「5/10」= 从 5 起按步长到上界；单独「5」= 只命中 5
    hi = slash < 0 ? lo : range[1]
  }
  if (lo < range[0] || hi > range[1]) bad(`${field}「${body}」超出 ${range[0]}-${range[1]}`)
  for (let v = lo; v <= hi; v += step) out.add(v)
}

const parseField = (text: string, index: number): Set<number> => {
  const range = RANGES[index]!
  const out = new Set<number>()
  for (const part of text.split(',')) parsePart(part, range, FIELD_NAMES[index]!, out)
  if (index === 5 && out.has(7)) {
    out.delete(7)
    out.add(0)
  }
  if (out.size === 0) bad(`${FIELD_NAMES[index]}字段「${text}」无有效取值`)
  return out
}

const fullSet = ([min, max]: [number, number]): Set<number> =>
  new Set(Array.from({ length: max - min + 1 }, (_, i) => min + i))

const isStar = (text: string | undefined): boolean => (text ?? '*').trim() === '*'

export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5 && parts.length !== 6) {
    bad(`cron 表达式需要 5 或 6 段（分 时 日 月 周，可加秒），当前 ${parts.length} 段：${expr}`)
  }
  // 5 段表达式补 0 秒，统一成 6 段处理
  const f = parts.length === 6 ? parts : ['0', ...parts]
  const sets = f.map((text, index) => parseField(text, index))
  return {
    second: sets[0] ?? fullSet([0, 59]),
    minute: sets[1] ?? fullSet([0, 59]),
    hour: sets[2] ?? fullSet([0, 23]),
    dom: sets[3] ?? fullSet([1, 31]),
    month: sets[4] ?? fullSet([1, 12]),
    dow: sets[5] ?? fullSet([0, 6]),
    domAll: isStar(f[3]),
    dowAll: isStar(f[5]),
  }
}

const dayMatches = (date: Date, f: CronFields): boolean => {
  const domOk = f.dom.has(date.getDate())
  const dowOk = f.dow.has(date.getDay())
  if (f.domAll && f.dowAll) return true
  if (f.domAll) return dowOk
  if (f.dowAll) return domOk
  return domOk || dowOk
}

/** 最多向后探 4 年，超出即认为该表达式永不触发（如 2 月 30 日） */
const HORIZON_MS = 4 * 366 * 24 * 3600 * 1000

export function nextCronAt(fields: CronFields, fromMs: number, count: number): number[] {
  const out: number[] = []
  const cursor = new Date(fromMs)
  cursor.setMilliseconds(0)
  cursor.setTime(cursor.getTime() + 1000)
  const limit = fromMs + HORIZON_MS
  while (out.length < count && cursor.getTime() <= limit) {
    if (!fields.month.has(cursor.getMonth() + 1)) {
      cursor.setMonth(cursor.getMonth() + 1, 1)
      cursor.setHours(0, 0, 0, 0)
      continue
    }
    if (!dayMatches(cursor, fields)) {
      cursor.setDate(cursor.getDate() + 1)
      cursor.setHours(0, 0, 0, 0)
      continue
    }
    if (!fields.hour.has(cursor.getHours())) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0)
      continue
    }
    if (!fields.minute.has(cursor.getMinutes())) {
      cursor.setMinutes(cursor.getMinutes() + 1, 0, 0)
      continue
    }
    if (!fields.second.has(cursor.getSeconds())) {
      cursor.setSeconds(cursor.getSeconds() + 1, 0)
      continue
    }
    out.push(cursor.getTime())
    cursor.setSeconds(cursor.getSeconds() + 1, 0)
  }
  return out
}

/** interval 以 epoch 为锚对齐，避免每次触发累加漂移 */
const nextIntervalAt = (everyMs: number, fromMs: number, count: number): number[] => {
  const first = Math.floor(fromMs / everyMs) * everyMs + everyMs
  return Array.from({ length: count }, (_, i) => first + i * everyMs)
}

export const validateSpec = (spec: ScheduleSpec): string | null => {
  try {
    if (spec.kind === 'cron') parseCron(spec.expr)
    else if (spec.kind === 'interval') {
      if (!Number.isInteger(spec.everyMs) || spec.everyMs < 1000) return '间隔至少 1000 毫秒'
      if (spec.everyMs > 31_536_000_000) return '间隔超过一年没有意义'
    } else if (!Number.isInteger(spec.at) || spec.at <= 0) return '单次触发时刻不合法'
    return null
  } catch (e) {
    return (e as Error).message
  }
}

/** 未来 count 次触发时刻；表达式非法时抛错，由调用方转成 VALIDATION */
export function nextAfter(spec: ScheduleSpec, fromMs: number, count = 5): number[] {
  if (spec.kind === 'cron') return nextCronAt(parseCron(spec.expr), fromMs, count)
  if (spec.kind === 'interval') return nextIntervalAt(spec.everyMs, fromMs, count)
  return spec.at > fromMs ? [spec.at] : []
}

/** 下次触发时间，单次任务跑完即无下次 */
export const nextAt = (spec: ScheduleSpec, fromMs: number): number | null =>
  nextAfter(spec, fromMs, 1)[0] ?? null

import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { IpcErrorRaised } from '@shared/types'

/** Runner 数据文件解析（23 号文档 §5.1）：CSV 首行表头 / JSON 对象数组 */

export type DataFormat = 'csv' | 'json'

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const toText = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** RFC 4180：引号内逗号与换行、"" 转义；\r\n 与 \n 均识别 */
const splitCsv = (text: string): string[][] => {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i] as string
    if (quoted) {
      if (ch !== '"') {
        field += ch
        continue
      }
      if (src[i + 1] === '"') {
        field += '"'
        i += 1
      } else quoted = false
      continue
    }
    if (ch === '"') {
      quoted = true
      continue
    }
    if (ch === ',') {
      row.push(field)
      field = ''
      continue
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      continue
    }
    field += ch
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => !(r.length === 1 && (r[0] ?? '') === ''))
}

export const parseCsvRows = (text: string): Record<string, string>[] => {
  const table = splitCsv(text)
  const header = table[0]
  if (!header) throw new IpcErrorRaised({ code: 'VALIDATION', message: 'CSV 数据文件为空' })
  return table.slice(1).map((cells) => {
    const out: Record<string, string> = {}
    header.forEach((name, index) => {
      if (name !== '') out[name] = cells[index] ?? ''
    })
    return out
  })
}

export const parseJsonRows = (text: string): Record<string, string>[] => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch (e) {
    throw new IpcErrorRaised({
      code: 'VALIDATION',
      message: `JSON 数据文件解析失败：${(e as Error).message}`,
    })
  }
  const list = Array.isArray(parsed) ? parsed : [parsed]
  return list.map((entry, index) => {
    if (!isObject(entry))
      throw new IpcErrorRaised({
        code: 'VALIDATION',
        message: `JSON 数据文件第 ${index + 1} 行不是对象`,
      })
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(entry)) out[key] = toText(value)
    return out
  })
}

export const parseData = (text: string, format: DataFormat): Record<string, string>[] =>
  format === 'csv' ? parseCsvRows(text) : parseJsonRows(text)

const formatOf = (filePath: string, text: string): DataFormat => {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.csv') return 'csv'
  if (ext === '.json') return 'json'
  return sniffFormat(text)
}

/** 没有文件名时按内容判定：以 [ 或 { 开头视为 JSON，其余按 CSV */
export const sniffFormat = (text: string): DataFormat =>
  text.trimStart().startsWith('[') || text.trimStart().startsWith('{') ? 'json' : 'csv'

/** GUI 粘贴入口：渲染进程没有 fs 权限，解析只在主进程做（19 号文档） */
export const parseDataAuto = (
  text: string,
): {
  rows: Record<string, string>[]
  format: DataFormat
} => {
  const format = sniffFormat(text)
  return { rows: parseData(text, format), format }
}

export const readDataFile = (
  filePath: string,
): {
  rows: Record<string, string>[]
  format: DataFormat
} => {
  let text: string
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (e) {
    throw new IpcErrorRaised({
      code: 'VALIDATION',
      message: `数据文件不可读：${filePath}（${(e as Error).message}）`,
    })
  }
  const format = formatOf(filePath, text)
  return { rows: parseData(text, format), format }
}

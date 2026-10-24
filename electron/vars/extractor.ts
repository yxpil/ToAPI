// @author yxpil
import { JSONPath } from 'jsonpath-plus'
import type { Extractor, ExtractorScope } from '@shared/types'

export interface ExtractSource {
  status: number
  headers: [string, string][]
  bodyText: string
}

export interface ExtractOutcome {
  name: string
  scope: ExtractorScope
  value: string
  hit: boolean
  reason?: string
}

const headerOf = (source: ExtractSource, name: string): string | undefined => {
  const lower = name.toLowerCase()
  const found = source.headers.find(([k]) => k.toLowerCase() === lower)
  return found?.[1]
}

const readJson = (body: string): unknown | undefined => {
  try {
    return JSON.parse(body) as unknown
  } catch {
    return undefined
  }
}

export const preview = (value: string, max = 200): string =>
  value.length <= max ? value : `${value.slice(0, max)}…`

const runJsonPath = (expr: string, source: ExtractSource): string | null => {
  const json = readJson(source.bodyText)
  if (json === undefined) return null
  let result: unknown
  try {
    result = JSONPath({ path: expr, json: json as object, wrap: true })
  } catch {
    return null
  }
  const list = result as unknown[]
  if (!Array.isArray(list) || list.length === 0) return null
  const firstValue = list[0]
  return typeof firstValue === 'string' ? firstValue : JSON.stringify(firstValue)
}

const runRegex = (expr: string, text: string): string | null => {
  try {
    const m = new RegExp(expr).exec(text)
    if (!m) return null
    return m[1] ?? m[0]
  } catch {
    return null
  }
}

/** 单个提取器执行（03 号文档 §3.3 extractors 语义） */
export function runExtractor(extractor: Extractor, source: ExtractSource): ExtractOutcome {
  const base = { name: extractor.name, scope: extractor.scope }

  if (extractor.source === 'header') {
    // header 提取器的 expr 即头名
    const value = headerOf(source, extractor.expr)
    return value === undefined
      ? { ...base, value: '', hit: false, reason: 'header not found' }
      : { ...base, value, hit: true }
  }

  if (extractor.type === 'jsonpath') {
    if (extractor.source !== 'body') {
      return { ...base, value: '', hit: false, reason: 'jsonpath needs body' }
    }
    const value = runJsonPath(extractor.expr, source)
    return value === null
      ? { ...base, value: '', hit: false, reason: 'no match' }
      : { ...base, value, hit: true }
  }

  const target = extractor.source === 'status' ? String(source.status) : source.bodyText
  const value = runRegex(extractor.expr, target)
  return value === null
    ? { ...base, value: '', hit: false, reason: 'no match' }
    : { ...base, value, hit: true }
}

export const runAll = (extractors: Extractor[], source: ExtractSource): ExtractOutcome[] =>
  extractors.map((e) => runExtractor(e, source))

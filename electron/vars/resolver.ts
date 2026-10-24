// @author yxpil
const TOKEN_SOURCE = '\\{\\{\\s*(\\$?[A-Za-z0-9_.\\-]+)\\s*\\}\\}'

const tokenRe = (): RegExp => new RegExp(TOKEN_SOURCE, 'g')

export type ResolveStatus = 'ok' | 'missing' | 'cycle' | 'depth'

export interface ResolveResult {
  text: string
  /** 未命中的变量名，保留原文并交由 UI 高亮（07 号文档 §2.1） */
  missing: string[]
  status: ResolveStatus
  /** 循环引用链，如 a -> b -> a */
  cycle?: string[]
}

export interface VarLookup {
  get(name: string): string | undefined
}

const MAX_DEPTH = 10

/** 单次遍历替换所有 {{var}}；未命中原样保留，值内嵌套引用递归展开并检测循环 */
export function resolveVars(text: string, lookup: VarLookup): ResolveResult {
  const missing: string[] = []
  const cyclePath: string[] = []
  let cycle = false

  const expand = (input: string, visiting: string[], depth: number): string => {
    if (depth > MAX_DEPTH) {
      cycle = true
      cyclePath.push('max-depth')
      return input
    }
    // 每层递归用独立正则实例，避免共享 lastIndex 互踩
    const re = tokenRe()
    let out = ''
    let last = 0
    for (let m = re.exec(input); m !== null; m = re.exec(input)) {
      out += input.slice(last, m.index)
      const name = m[1] as string
      const value = lookup.get(name)
      if (value === undefined) {
        if (!missing.includes(name)) missing.push(name)
        out += m[0]
      } else if (visiting.includes(name)) {
        cycle = true
        cyclePath.push(...visiting.slice(visiting.indexOf(name)), name)
        out += m[0]
      } else {
        out += expand(value, [...visiting, name], depth + 1)
      }
      last = m.index + m[0].length
    }
    return out + input.slice(last)
  }

  const expanded = expand(text, [], 0)
  if (cycle) return { text: expanded, missing, status: 'cycle', cycle: cyclePath }
  return { text: expanded, missing, status: missing.length > 0 ? 'missing' : 'ok' }
}

export const findVarNames = (text: string): string[] => {
  const names: string[] = []
  const re = tokenRe()
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const name = m[1] as string
    if (!names.includes(name)) names.push(name)
  }
  return names
}

/** 变量表 → 只读查找器。优先级由数组顺序决定（后者覆盖前者）：runtime 最高 */
export const mapLookup = (...maps: ReadonlyMap<string, string>[]): VarLookup => {
  const merged = new Map<string, string>()
  for (const m of maps) for (const [k, v] of m) merged.set(k, v)
  return { get: (name) => merged.get(name) }
}

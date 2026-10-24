// @author yxpil
import type { Repos } from '../db/repo'

/** secret 变量在开放通道里永不出现明文：值本身与被值污染的文字都要遮（11 号文档 §2.3） */

export const MASK = '***'

const MIN_MASKABLE_LENGTH = 3

export const collectSecrets = (repos: Repos, projectId?: string): string[] => {
  const out = new Set<string>()
  const push = (value: string, secret: boolean): void => {
    if (secret && value.length >= MIN_MASKABLE_LENGTH) out.add(value)
  }
  const scope = projectId ? [repos.project.get(projectId)] : repos.project.list()
  for (const project of scope) {
    if (!project) continue
    for (const v of project.variables) push(v.value, v.secret)
    for (const c of repos.collection.listByProject(project.id))
      for (const v of c.variables) push(v.value, v.secret)
    for (const env of repos.environment.listByProject(project.id))
      for (const v of repos.variable.listForEnv(env.id)) push(v.value, v.secret)
  }
  for (const v of repos.variable.listGlobals()) push(v.value, v.secret)
  // 长值优先替换，避免短值把长值切开后漏网
  return [...out].sort((a, b) => b.length - a.length)
}

export class SecretMask {
  private readonly values: string[]

  constructor(values: string[]) {
    this.values = values
  }

  static forProject(repos: Repos, projectId?: string): SecretMask {
    return new SecretMask(collectSecrets(repos, projectId))
  }

  text(input: string): string {
    let out = input
    for (const value of this.values) {
      if (!out.includes(value)) continue
      out = out.split(value).join(MASK)
    }
    return out
  }

  /** 对象递归脱敏：只处理字符串叶子，键名不动 */
  value<T>(input: T): T {
    if (typeof input === 'string') return this.text(input) as unknown as T
    if (Array.isArray(input)) return input.map((item) => this.value(item)) as unknown as T
    if (input && typeof input === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
        out[key] = key === 'secret' || key === 'redacted' ? item : this.value(item)
      }
      return out as unknown as T
    }
    return input
  }

  /** 参数摘要：secret 值一律不写进审计（07 号文档 §2.8） */
  summary(params: unknown, max = 200): string {
    const shape = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.slice(0, 5).map(shape)
      if (v && typeof v === 'object') {
        const out: Record<string, unknown> = {}
        for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
          out[k] =
            typeof item === 'string' && this.values.includes(item)
              ? MASK
              : k === 'password' || k === 'token'
                ? MASK
                : shape(item)
        }
        return out
      }
      return v
    }
    return this.text(JSON.stringify(shape(params)) ?? '').slice(0, max)
  }
}

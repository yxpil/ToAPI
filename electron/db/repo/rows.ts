// @author yxpil
export type Row = Record<string, number | bigint | string | null | Uint8Array | undefined>

export const parseJson = <T>(text: string, fallback: T): T => {
  try {
    const v = JSON.parse(text) as T
    return v === null || v === undefined ? fallback : v
  } catch {
    return fallback
  }
}

export const j = (v: unknown): string => JSON.stringify(v ?? null)

export const num = (v: unknown): number => {
  const n = typeof v === 'bigint' ? Number(v) : Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}
export const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))
export const bool = (v: unknown): boolean => num(v) === 1
export const optStr = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v)

/** SELECT MAX(x) AS m 结果的统一取数 */
export const maxOf = (row: Row | undefined): number =>
  num(row?.['m']) /** 相邻 sortOrder 中值插入，间隔过小时由调用方触发重排（04 号文档 §6） */
export const midpoint = (before: number | null, after: number | null): number => {
  if (before === null && after === null) return 1000
  if (before === null) return (after as number) - 1000
  if (after === null) return before + 1000
  const mid = (before + after) / 2
  return Number.isFinite(mid) && mid > before && mid < after ? mid : before + 1000
}

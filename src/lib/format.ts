// @author yxpil
export const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** 历史分组用：今天 / 昨天 / YYYY-MM-DD（06 号文档 §3.6 的时间语义） */
export const dayLabel = (ts: number): string => {
  const date = new Date(ts)
  const now = new Date()
  const startOf = (d: Date): number =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diffDays = Math.round((startOf(now) - startOf(date)) / 86_400_000)
  if (diffDays === 0) return '今天'
  if (diffDays === 1) return '昨天'
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 通知条目与任务下次触发用的相对时间（15 号文档 §5） */
export const relTime = (ts: number, now = Date.now()): string => {
  const diff = now - ts
  const abs = Math.abs(diff)
  const units: [number, string][] = [
    [60_000, '分钟'],
    [3_600_000, '小时'],
    [86_400_000, '天'],
  ]
  let text = `${Math.round(abs / 1000)} 秒`
  for (const [ms, name] of units) {
    if (abs < ms) break
    text = `${Math.round(abs / ms)} ${name}`
  }
  return diff >= 0 ? `${text}前` : `${text}后`
}

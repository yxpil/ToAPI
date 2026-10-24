// @author yxpil
import { writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ReportFormat } from '@shared/channels'
import type { RunnerRun } from '../db/repo/runner.repo'
import { renderHtml, renderJson, renderJunit } from '../cli/reporters'
import type { FileStore } from '../infra/filestore'

/** 运行报告落盘（07/23 号文档）：GUI 导出与定时任务共用同一渲染器 */

const EXT: Record<ReportFormat, string> = { json: 'json', junit: 'xml', html: 'html' }

export const renderReport = (run: RunnerRun, format: ReportFormat): string => {
  if (format === 'json') return renderJson(run)
  if (format === 'junit') return renderJunit(run)
  return renderHtml(run)
}

const stamp = (ms: number): string => {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(
    d.getMinutes(),
  )}${pad(d.getSeconds())}`
}

/** 集合名可能带路径分隔符与空格，落盘前压成安全文件名 */
const safe = (name: string): string => {
  const cleaned = name.replace(/[^\w\u4e00-\u9fa5.-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned === '' ? 'run' : cleaned.slice(0, 60)
}

export const defaultReportPath = (files: FileStore, run: RunnerRun, format: ReportFormat): string =>
  join(files.reportsDir(), `${safe(run.scopeName)}-${stamp(run.startedAt)}.${EXT[format]}`)

/** 用户指定的路径后缀与格式不符时补一个正确后缀，避免 CI 按扩展名找不到报告 */
export function writeReport(
  files: FileStore,
  run: RunnerRun,
  format: ReportFormat,
  filePath?: string,
): string {
  const custom = filePath?.trim() ?? ''
  const target =
    custom === ''
      ? defaultReportPath(files, run, format)
      : basename(custom).toLowerCase().endsWith(`.${EXT[format]}`)
        ? custom
        : `${custom}.${EXT[format]}`
  writeFileSync(target, renderReport(run, format), 'utf8')
  return target
}

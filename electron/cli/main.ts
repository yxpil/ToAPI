// @author yxpil
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { IpcErrorRaised } from '@shared/types'
import { createKernel, type Kernel } from '../kernel'
import { readDataFile } from '../flow/data-file'
import type { RunnerItem, RunnerRun } from '../db/repo/runner.repo'
import { CliUsageError, USAGE, parseArgs, type CliOptions } from './args'
import {
  itemDetail,
  itemLine,
  renderHtml,
  renderJson,
  renderJunit,
  summaryLines,
} from './reporters'

declare const __TOAPI_VERSION__: string

/** 无头 CLI（23 号文档 §5.3）：与 GUI 共用 kernel，Runner / 变量 / 脚本 / CookieJar 行为一致 */

const version = (): string =>
  typeof __TOAPI_VERSION__ === 'string' ? __TOAPI_VERSION__ : '0.0.0-dev'

const out = (text: string): void => {
  process.stdout.write(`${text}\n`)
}

const scriptWorkerPath = (): string => {
  const self = typeof __dirname === 'string' ? __dirname : ''
  const candidates = [
    self === '' ? '' : join(self, 'script-worker.cjs'),
    join(process.cwd(), 'dist-electron', 'script-worker.cjs'),
  ].filter((c) => c !== '')
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  throw new CliUsageError(
    '未找到脚本 worker（dist-electron/script-worker.cjs），请先执行 npm run build:electron',
  )
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 进度事件里没有迭代总数，用运行前的计划值补全文案 */
const printProgress = (payload: unknown, opts: CliOptions, iterationCount: () => number): void => {
  if (opts.quiet || !isRecord(payload) || payload['finished'] === true) return
  const item = payload['item'] as RunnerItem | undefined
  if (!item) return
  out(itemLine(item, iterationCount()))
  for (const line of itemDetail(item)) out(line)
}

const openKernel = (opts: CliOptions, tempDir: string, iterationCount: () => number): Kernel => {
  const dbPath = opts.db ? resolvePath(opts.db) : join(tempDir, 'cli.db')
  if (opts.db && !existsSync(dbPath)) throw new CliUsageError(`数据库不存在：${dbPath}`)
  return createKernel({
    dbPath,
    filesDir: tempDir,
    appVersion: version(),
    scriptWorkerPath: scriptWorkerPath(),
    emit: (channel, payload) => {
      if (channel === 'event:runner-progress') printProgress(payload, opts, iterationCount)
    },
  })
}

const importCollection = (kernel: Kernel, filePath: string): string => {
  if (/\.tapi$/i.test(filePath))
    throw new CliUsageError(
      '.tapi 项目导入将在 M5.5 提供；当前请用 Postman Collection v2.1 JSON，或用 --db 打开已有数据库',
    )
  const report = kernel.postman.importCollection({ filePath: resolvePath(filePath), mode: 'new' })
  if (report.warnings.length > 0) out(`导入警告 ${report.warnings.length} 条`)
  return report.projectId
}

/** --env 既接受 Postman Environment 文件，也接受库内环境名称 */
const applyEnv = (kernel: Kernel, projectId: string, spec: string): string => {
  const { repos } = kernel
  if (existsSync(spec)) {
    const report = kernel.postman.importEnvironment({
      filePath: resolvePath(spec),
      projectId,
      mode: 'new',
    })
    const envId = report.environmentId
    if (!envId) throw new CliUsageError(`环境文件导入失败：${spec}`)
    repos.environment.activate(projectId, envId)
    return envId
  }
  const hit = repos.environment
    .listByProject(projectId)
    .find((env) => env.name === spec || env.id === spec)
  if (!hit) throw new CliUsageError(`找不到环境：${spec}`)
  repos.environment.activate(projectId, hit.id)
  return hit.id
}

/** --globals 接受 Postman Globals 导出（{values:[...]}）或普通键值对象 */
const applyGlobals = (kernel: Kernel, filePath: string): number => {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(resolvePath(filePath), 'utf8')) as unknown
  } catch (e) {
    throw new CliUsageError(`全局变量文件不可读：${filePath}（${(e as Error).message}）`)
  }
  const entries: unknown[] = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw['values'])
      ? (raw['values'] as unknown[])
      : isRecord(raw)
        ? Object.entries(raw).map(([key, value]) => ({ key, value }))
        : []
  let count = 0
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry['key'] !== 'string') continue
    if (entry['enabled'] === false) continue
    kernel.repos.variable.upsert({
      scope: 'global',
      key: entry['key'],
      value: entry['value'] === undefined || entry['value'] === null ? '' : String(entry['value']),
    })
    count += 1
  }
  return count
}

const pickProject = (kernel: Kernel, opts: CliOptions, importedId?: string): string => {
  if (importedId) return importedId
  const all = kernel.repos.project.list()
  if (!opts.project) {
    const only = all[0]
    if (only && all.length === 1) return only.id
    throw new CliUsageError(
      all.length === 0
        ? '数据库内没有项目'
        : `数据库内有 ${all.length} 个项目，请用 --project 指定：${all.map((p) => p.name).join(' / ')}`,
    )
  }
  const hit = all.find((p) => p.name === opts.project || p.id === opts.project)
  if (!hit) throw new CliUsageError(`找不到项目：${opts.project}`)
  return hit.id
}

const resolveScope = (
  kernel: Kernel,
  opts: CliOptions,
  projectId: string,
): { scopeType: 'collection' | 'project'; scopeId: string } => {
  const { repos } = kernel
  if (!repos.project.get(projectId)) throw new CliUsageError('项目不存在')
  if (opts.collection) {
    const hit = repos.collection
      .listByProject(projectId)
      .find((c) => c.name === opts.collection || c.id === opts.collection)
    if (!hit) throw new CliUsageError(`找不到集合：${opts.collection}`)
    return { scopeType: 'collection', scopeId: hit.id }
  }
  return { scopeType: 'project', scopeId: projectId }
}

const writeReports = (opts: CliOptions, run: RunnerRun): string[] => {
  const render = { json: renderJson, junit: renderJunit, html: renderHtml } as const
  const fallback = {
    json: 'toapi-report.json',
    junit: 'toapi-junit.xml',
    html: 'toapi-report.html',
  }
  const custom = { json: opts.jsonExport, junit: opts.junitExport, html: opts.htmlExport }
  const written: string[] = []
  for (const kind of ['json', 'junit', 'html'] as const) {
    if (!opts.reporters.includes(kind)) continue
    const target = resolvePath(custom[kind] ?? fallback[kind])
    writeFileSync(target, render[kind](run), 'utf8')
    written.push(target)
  }
  return written
}

const runOnce = async (opts: CliOptions): Promise<number> => {
  const tempDir = mkdtempSync(join(tmpdir(), 'toapi-cli-'))
  let plannedIterations = opts.iterationCount ?? 1
  const kernel = openKernel(opts, tempDir, () => plannedIterations)
  try {
    const importedId = opts.file ? importCollection(kernel, opts.file) : undefined
    const projectId = pickProject(kernel, opts, importedId)
    const scope = resolveScope(kernel, opts, projectId)

    if (opts.globals) out(`全局变量：${applyGlobals(kernel, opts.globals)} 个`)
    const envId = opts.env ? applyEnv(kernel, projectId, opts.env) : null

    const rows = opts.data ? readDataFile(opts.data).rows : []
    if (opts.data) {
      plannedIterations = opts.iterationCount ?? Math.max(rows.length, 1)
      out(`数据文件：${rows.length} 行 · ${plannedIterations} 次迭代`)
    }

    const { runId } = await kernel.runner.start({
      scopeType: scope.scopeType,
      scopeId: scope.scopeId,
      cancelId: 'cli',
      ...(envId ? { envId } : {}),
      ...(opts.bail ? { stopOnFail: true } : {}),
      ...(opts.delayMs ? { delayMs: opts.delayMs } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      ...(rows.length > 0 ? { iterationData: rows } : {}),
      ...(opts.iterationCount ? { iterationCount: opts.iterationCount } : {}),
    })
    await kernel.runner.whenDone(runId)

    const run = kernel.repos.runner.get(runId)
    if (!run) throw new CliUsageError('运行记录缺失，无法生成报告')
    if (!opts.quiet) for (const line of summaryLines(run)) out(line)
    for (const path of writeReports(opts, run)) out(`报告：${path}`)
    return run.failed > 0 ? 1 : 0
  } finally {
    kernel.dispose()
    rmSync(tempDir, { recursive: true, force: true })
  }
}

export const runCli = async (argv: string[]): Promise<number> => {
  let opts: CliOptions
  try {
    opts = parseArgs(argv)
  } catch (e) {
    if (e instanceof CliUsageError) {
      process.stderr.write(`错误：${e.message}\n\n${USAGE}`)
      return 2
    }
    throw e
  }

  if (opts.command === 'help') {
    out(USAGE)
    return 0
  }
  if (opts.command === 'version') {
    out(`toapi ${version()}`)
    return 0
  }

  try {
    return await runOnce(opts)
  } catch (e) {
    if (e instanceof CliUsageError || e instanceof IpcErrorRaised) {
      const message = e instanceof IpcErrorRaised ? e.payload.message : e.message
      process.stderr.write(`错误：${message}\n`)
      return 2
    }
    process.stderr.write(`错误：${(e as Error).message}\n`)
    return 2
  }
}

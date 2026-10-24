import type { Db } from '../database'
import type { AssertionResult, LogEntry } from '@shared/types'
import { ulid } from '../../infra/id'
import { j, num, optStr, parseJson, type Row, str } from './rows'

export type RunnerItemStatus = 'passed' | 'failed' | 'skipped' | 'error'

export interface RunnerItem {
  id: string
  runId: string
  apiId: string | null
  apiName: string
  status: RunnerItemStatus
  historyId: string | null
  timeMs: number
  assertions: AssertionResult[]
  logs: LogEntry[]
  error: string | null
  sortOrder: number
  /** 数据驱动迭代序号，从 1 开始（23 号文档 §5.2） */
  iteration: number
}

export interface RunnerRun {
  id: string
  scopeType: string
  scopeId: string
  scopeName: string
  envId: string | null
  startedAt: number
  finishedAt: number | null
  total: number
  passed: number
  failed: number
  skipped: number
  iterationCount: number
  items: RunnerItem[]
}

const SQL = {
  insertRun: `INSERT INTO runner_run (id, scope_type, scope_id, scope_name, env_id, started_at, total, iteration_count)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  finishRun: `UPDATE runner_run SET finished_at = ?, passed = ?, failed = ?, skipped = ?, report_json = ? WHERE id = ?`,
  insertItem: `INSERT INTO runner_item (id, run_id, api_id, api_name, status, history_id, time_ms,
                                        assertions_json, logs_json, error, sort_order, iteration)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  runById: 'SELECT * FROM runner_run WHERE id = ?',
  itemsOf: 'SELECT * FROM runner_item WHERE run_id = ? ORDER BY iteration, sort_order',
  recent: 'SELECT * FROM runner_run ORDER BY started_at DESC LIMIT ?',
} as const

const mapItem = (row: Row): RunnerItem => ({
  id: str(row['id']),
  runId: str(row['run_id']),
  apiId: optStr(row['api_id']),
  apiName: str(row['api_name']),
  status: str(row['status']) as RunnerItemStatus,
  historyId: optStr(row['history_id']),
  timeMs: num(row['time_ms']),
  assertions: parseJson<AssertionResult[]>(str(row['assertions_json']), []),
  logs: parseJson<LogEntry[]>(str(row['logs_json']), []),
  error: optStr(row['error']),
  sortOrder: num(row['sort_order']),
  iteration: num(row['iteration']) || 1,
})

export class RunnerRepo {
  constructor(private readonly db: Db) {}

  startRun(input: {
    scopeType: 'collection' | 'api' | 'case' | 'project'
    scopeId: string
    scopeName: string
    envId: string | null
    total: number
    iterationCount?: number
  }): { id: string; startedAt: number } {
    const id = ulid()
    const startedAt = Date.now()
    this.db
      .prepare(SQL.insertRun)
      .run(
        id,
        input.scopeType,
        input.scopeId,
        input.scopeName,
        input.envId,
        startedAt,
        input.total,
        input.iterationCount ?? 1,
      )
    return { id, startedAt }
  }

  addItem(input: Omit<RunnerItem, 'id' | 'runId'> & { runId: string }): RunnerItem {
    const id = ulid()
    this.db
      .prepare(SQL.insertItem)
      .run(
        id,
        input.runId,
        input.apiId,
        input.apiName,
        input.status,
        input.historyId,
        input.timeMs,
        j(input.assertions),
        j(input.logs),
        input.error,
        input.sortOrder,
        input.iteration,
      )
    return { ...input, id }
  }

  finishRun(input: {
    runId: string
    passed: number
    failed: number
    skipped: number
    report: unknown
  }): void {
    this.db
      .prepare(SQL.finishRun)
      .run(Date.now(), input.passed, input.failed, input.skipped, j(input.report), input.runId)
  }

  get(id: string): RunnerRun | null {
    const row = this.db.prepare(SQL.runById).get(id) as Row | undefined
    if (!row) return null
    return {
      id: str(row['id']),
      scopeType: str(row['scope_type']),
      scopeId: str(row['scope_id']),
      scopeName: str(row['scope_name']),
      envId: optStr(row['env_id']),
      startedAt: num(row['started_at']),
      finishedAt: row['finished_at'] === null ? null : num(row['finished_at']),
      total: num(row['total']),
      passed: num(row['passed']),
      failed: num(row['failed']),
      skipped: num(row['skipped']),
      iterationCount: num(row['iteration_count']) || 1,
      items: (this.db.prepare(SQL.itemsOf).all(id) as unknown as Row[]).map(mapItem),
    }
  }

  list(limit = 20): Omit<RunnerRun, 'items'>[] {
    return (this.db.prepare(SQL.recent).all(limit) as unknown as Row[]).map((row) => ({
      id: str(row['id']),
      scopeType: str(row['scope_type']),
      scopeId: str(row['scope_id']),
      scopeName: str(row['scope_name']),
      envId: optStr(row['env_id']),
      startedAt: num(row['started_at']),
      finishedAt: row['finished_at'] === null ? null : num(row['finished_at']),
      total: num(row['total']),
      passed: num(row['passed']),
      failed: num(row['failed']),
      skipped: num(row['skipped']),
      iterationCount: num(row['iteration_count']) || 1,
    }))
  }
}

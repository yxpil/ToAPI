// @author yxpil
import type {
  MisfirePolicy,
  NewScheduleTask,
  OverlapPolicy,
  ScheduleSpec,
  ScheduleTargetType,
  TaskNotifyOptions,
} from '@shared/channels'
import type { Db } from '../database'
import { ulid } from '../../infra/id'
import { bool, j, num, optStr, parseJson, str, type Row } from './rows'

/** 定时任务表（12 号文档 §1）：只存定义与运行缓存，触发计算交给 ScheduleService */

export interface ScheduleTask {
  id: string
  name: string
  enabled: boolean
  targetType: ScheduleTargetType
  targetId: string
  spec: ScheduleSpec
  envId: string | null
  overlap: OverlapPolicy
  misfire: MisfirePolicy
  notify: TaskNotifyOptions
  lastRunAt: number | null
  lastRunId: string | null
  lastFailed: number | null
  nextRunAt: number | null
  createdAt: number
  updatedAt: number
}

export const DEFAULT_TASK_NOTIFY: TaskNotifyOptions = {
  onSuccess: true,
  onFail: true,
  report: 'none',
}

const SQL = {
  insert: `INSERT INTO schedule_task (id, name, enabled, target_type, target_id, spec_json, env_id,
                                      overlap, misfire, notify_json, next_run_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  update: `UPDATE schedule_task SET name = ?, enabled = ?, target_type = ?, target_id = ?, spec_json = ?,
                                    env_id = ?, overlap = ?, misfire = ?, notify_json = ?, next_run_at = ?,
                                    updated_at = ?
           WHERE id = ?`,
  delete: 'DELETE FROM schedule_task WHERE id = ?',
  byId: 'SELECT * FROM schedule_task WHERE id = ?',
  all: 'SELECT * FROM schedule_task ORDER BY created_at',
  enabled: 'SELECT * FROM schedule_task WHERE enabled = 1 ORDER BY next_run_at',
  setNext: 'UPDATE schedule_task SET next_run_at = ?, updated_at = ? WHERE id = ?',
  setEnabled: 'UPDATE schedule_task SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?',
  markRun: `UPDATE schedule_task SET last_run_at = ?, last_run_id = ?, last_failed = ?,
                                     enabled = ?, updated_at = ? WHERE id = ?`,
} as const

const narrowTarget = (value: string): ScheduleTargetType =>
  value === 'project' || value === 'api' || value === 'collection' ? value : 'collection'

const narrowOverlap = (value: string): OverlapPolicy =>
  value === 'queue' || value === 'parallel' ? value : 'skip'

const narrowMisfire = (value: string): MisfirePolicy =>
  value === 'skip' ? 'skip' : 'run-on-launch'

const narrowSpec = (raw: unknown): ScheduleSpec | null => {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  if (v['kind'] === 'cron' && typeof v['expr'] === 'string')
    return { kind: 'cron', expr: v['expr'] }
  if (v['kind'] === 'interval' && typeof v['everyMs'] === 'number') {
    return { kind: 'interval', everyMs: v['everyMs'] }
  }
  if (v['kind'] === 'once' && typeof v['at'] === 'number') return { kind: 'once', at: v['at'] }
  return null
}

const narrowNotify = (raw: unknown): TaskNotifyOptions => {
  const v = (raw ?? {}) as Record<string, unknown>
  const report = v['report']
  return {
    onSuccess: v['onSuccess'] !== false,
    onFail: v['onFail'] !== false,
    report:
      report === 'json' || report === 'junit' || report === 'html'
        ? report
        : report === 'none'
          ? 'none'
          : DEFAULT_TASK_NOTIFY.report,
  }
}

const at = (value: unknown): number | null =>
  value === null || value === undefined ? null : num(value)

export const mapTask = (row: Row): ScheduleTask => ({
  id: str(row['id']),
  name: str(row['name']),
  enabled: bool(row['enabled']),
  targetType: narrowTarget(str(row['target_type'])),
  targetId: str(row['target_id']),
  spec: narrowSpec(parseJson<unknown>(str(row['spec_json']), null)) ?? {
    kind: 'interval',
    everyMs: 60_000,
  },
  envId: optStr(row['env_id']),
  overlap: narrowOverlap(str(row['overlap'])),
  misfire: narrowMisfire(str(row['misfire'])),
  notify: narrowNotify(parseJson<unknown>(str(row['notify_json']), null)),
  lastRunAt: at(row['last_run_at']),
  lastRunId: optStr(row['last_run_id']),
  lastFailed: at(row['last_failed']),
  nextRunAt: at(row['next_run_at']),
  createdAt: num(row['created_at']),
  updatedAt: num(row['updated_at']),
})

export class ScheduleRepo {
  constructor(private readonly db: Db) {}

  create(input: NewScheduleTask & { nextRunAt: number | null }): ScheduleTask {
    const id = ulid()
    const now = Date.now()
    this.db
      .prepare(SQL.insert)
      .run(
        id,
        input.name,
        input.enabled === false ? 0 : 1,
        input.targetType,
        input.targetId,
        j(input.spec),
        input.envId ?? null,
        input.overlap ?? 'skip',
        input.misfire ?? 'run-on-launch',
        j(input.notify ?? DEFAULT_TASK_NOTIFY),
        input.nextRunAt,
        now,
        now,
      )
    return this.require(id)
  }

  update(
    id: string,
    patch: Partial<Omit<ScheduleTask, 'id' | 'createdAt' | 'updatedAt'>>,
  ): ScheduleTask {
    const current = this.require(id)
    const next = { ...current, ...patch }
    this.db
      .prepare(SQL.update)
      .run(
        next.name,
        next.enabled ? 1 : 0,
        next.targetType,
        next.targetId,
        j(next.spec),
        next.envId,
        next.overlap,
        next.misfire,
        j(next.notify),
        next.nextRunAt,
        Date.now(),
        id,
      )
    return this.require(id)
  }

  require(id: string): ScheduleTask {
    const row = this.db.prepare(SQL.byId).get(id) as Row | undefined
    if (!row) throw new Error(`定时任务不存在：${id}`)
    return mapTask(row)
  }

  get(id: string): ScheduleTask | null {
    const row = this.db.prepare(SQL.byId).get(id) as Row | undefined
    return row ? mapTask(row) : null
  }

  list(): ScheduleTask[] {
    return (this.db.prepare(SQL.all).all() as unknown as Row[]).map(mapTask)
  }

  listEnabled(): ScheduleTask[] {
    return (this.db.prepare(SQL.enabled).all() as unknown as Row[]).map(mapTask)
  }

  setEnabled(id: string, enabled: boolean, nextRunAt: number | null): ScheduleTask {
    this.db.prepare(SQL.setEnabled).run(enabled ? 1 : 0, nextRunAt, Date.now(), id)
    return this.require(id)
  }

  setNextRun(id: string, nextRunAt: number | null): void {
    this.db.prepare(SQL.setNext).run(nextRunAt, Date.now(), id)
  }

  /** 触发后的运行缓存；单次任务跑完由调用方置 enabled=false */
  markRun(input: {
    id: string
    runId: string | null
    failed: number | null
    ranAt: number
    enabled: boolean
  }): ScheduleTask {
    this.db
      .prepare(SQL.markRun)
      .run(input.ranAt, input.runId, input.failed, input.enabled ? 1 : 0, Date.now(), input.id)
    return this.require(input.id)
  }

  remove(id: string): void {
    this.db.prepare(SQL.delete).run(id)
  }
}

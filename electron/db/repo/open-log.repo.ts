// @author yxpil
import type { Db } from '../database'
import { ulid } from '../../infra/id'
import { bool, num, optStr, str, type Row } from './rows'

export type OpenChannel = 'http' | 'mcp'

export interface ExternalCallRow {
  id: string
  channel: OpenChannel
  tool: string
  client: string
  paramsSummary: string
  ok: boolean
  errorCode: string | null
  timeMs: number
  createdAt: number
}

/** 审计上限：只留最近 5000 条，插入后环形清理（11 号文档 §5） */
const KEEP = 5000

const SQL = {
  add: `INSERT INTO external_call_log (id, channel, tool, client, params_summary, ok, error_code, time_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  list: 'SELECT * FROM external_call_log ORDER BY created_at DESC LIMIT ?',
  trim: `DELETE FROM external_call_log WHERE id NOT IN (SELECT id FROM external_call_log ORDER BY created_at DESC LIMIT ${KEEP})`,
  count: 'SELECT COUNT(*) AS n FROM external_call_log',
}

const map = (row: Row): ExternalCallRow => ({
  id: str(row['id']),
  channel: str(row['channel']) as OpenChannel,
  tool: str(row['tool']),
  client: str(row['client']),
  paramsSummary: str(row['params_summary']),
  ok: bool(row['ok']),
  errorCode: optStr(row['error_code']),
  timeMs: num(row['time_ms']),
  createdAt: num(row['created_at']),
})

export class OpenLogRepo {
  constructor(private readonly db: Db) {}

  add(input: Omit<ExternalCallRow, 'id' | 'createdAt'>): void {
    this.db
      .prepare(SQL.add)
      .run(
        ulid(),
        input.channel,
        input.tool,
        input.client,
        input.paramsSummary.slice(0, 500),
        input.ok ? 1 : 0,
        input.errorCode,
        input.timeMs,
        Date.now(),
      )
    this.db.prepare(SQL.trim).run()
  }

  list(limit = 100): ExternalCallRow[] {
    return (this.db.prepare(SQL.list).all(limit) as unknown as Row[]).map(map)
  }

  total(): number {
    const row = this.db.prepare(SQL.count).get() as Row | undefined
    return num(row?.['n'])
  }
}

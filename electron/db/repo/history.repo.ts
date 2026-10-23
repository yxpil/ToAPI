import type { Db } from '../database'
import type { FinalRequest, HistorySummary, HttpMethod, ResponseView } from '@shared/types'
import { ulid } from '../../infra/id'
import { bool, j, num, optStr, parseJson, type Row, str } from './rows'

export interface NewHistory {
  apiId: string | null
  projectId: string
  request: FinalRequest
  response: Omit<ResponseView, 'bodyText' | 'bodyPath'>
  bodyText?: string
  bodyPath?: string
  isSubRequest?: boolean
}

const SQL = {
  insert: `INSERT INTO history (id, api_id, project_id, request_snapshot, response, body_path, method, url,
                                status, time_ms, size_bytes, is_sub_request, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  firstPage: `SELECT id, api_id, project_id, method, url, status, time_ms, size_bytes, is_sub_request, created_at
              FROM history WHERE (? = '' OR project_id = ?) AND (? = '' OR api_id = ?)
              ORDER BY created_at DESC, id DESC LIMIT ?`,
  afterCursor: `SELECT id, api_id, project_id, method, url, status, time_ms, size_bytes, is_sub_request, created_at
                FROM history
                WHERE (? = '' OR project_id = ?) AND (? = '' OR api_id = ?)
                  AND (created_at < ? OR (created_at = ? AND id < ?))
                ORDER BY created_at DESC, id DESC LIMIT ?`,
  byId: 'SELECT * FROM history WHERE id = ?',
  delete: 'DELETE FROM history WHERE id = ?',
  clearProject: 'DELETE FROM history WHERE project_id = ?',
} as const

export const mapHistorySummary = (row: Row): HistorySummary => ({
  id: str(row['id']),
  apiId: optStr(row['api_id']),
  projectId: str(row['project_id']),
  method: str(row['method']) as HttpMethod,
  url: str(row['url']),
  status: num(row['status']),
  timeMs: num(row['time_ms']),
  sizeBytes: num(row['size_bytes']),
  isSubRequest: bool(row['is_sub_request']),
  createdAt: num(row['created_at']),
})

export interface HistoryDetail extends HistorySummary {
  request: FinalRequest
  response: Omit<ResponseView, 'bodyText' | 'bodyPath'> & { bodyText?: string }
  bodyPath: string | null
}

export class HistoryRepo {
  constructor(private readonly db: Db) {}

  add(input: NewHistory): HistorySummary {
    const id = ulid()
    const created = Date.now()
    this.db
      .prepare(SQL.insert)
      .run(
        id,
        input.apiId,
        input.projectId,
        j(input.request),
        j(input.response),
        input.bodyPath ?? null,
        input.request.method,
        input.request.url,
        input.response.status,
        input.response.timeMs,
        input.response.bodySizeBytes,
        input.isSubRequest ? 1 : 0,
        created,
      )
    return {
      id,
      apiId: input.apiId,
      projectId: input.projectId,
      method: input.request.method,
      url: input.request.url,
      status: input.response.status,
      timeMs: input.response.timeMs,
      sizeBytes: input.response.bodySizeBytes,
      isSubRequest: Boolean(input.isSubRequest),
      createdAt: created,
    }
  }

  list(input: { projectId?: string; apiId?: string; cursor?: string | null; limit?: number }): {
    items: HistorySummary[]
    nextCursor: string | null
  } {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200)
    const { ts, id: cursorId } = splitCursor(input.cursor)
    const project = input.projectId ?? ''
    const api = input.apiId ?? ''
    const rows =
      ts === null
        ? (this.db
            .prepare(SQL.firstPage)
            .all(project, project, api, api, limit + 1) as unknown as Row[])
        : (this.db
            .prepare(SQL.afterCursor)
            .all(project, project, api, api, ts, ts, cursorId ?? '', limit + 1) as unknown as Row[])

    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map(mapHistorySummary)
    const last = items.at(-1)
    return {
      items,
      nextCursor: hasMore && last ? buildCursor(last.createdAt, last.id) : null,
    }
  }

  get(id: string): HistoryDetail | null {
    const row = this.db.prepare(SQL.byId).get(id) as Row | undefined
    if (!row) return null
    const summary = mapHistorySummary(row)
    return {
      ...summary,
      request: parseJson<FinalRequest>(str(row['request_snapshot']), {
        method: 'GET',
        url: '',
        headers: [],
      }),
      response: parseJson<HistoryDetail['response']>(str(row['response']), {
        status: 0,
        statusText: '',
        headers: [],
        redirects: [],
        bodySizeBytes: 0,
        timeMs: 0,
      }),
      bodyPath: optStr(row['body_path']),
    }
  }

  remove(id: string): void {
    this.db.prepare(SQL.delete).run(id)
  }

  clearProject(projectId: string): number {
    const result = this.db.prepare(SQL.clearProject).run(projectId)
    return num(result.changes)
  }
}

export const buildCursor = (createdAt: number, id: string): string => `${createdAt}:${id}`

export const splitCursor = (
  cursor: string | null | undefined,
): { ts: number | null; id: string | null } => {
  if (!cursor) return { ts: null, id: null }
  const idx = cursor.indexOf(':')
  const ts = Number(idx < 0 ? cursor : cursor.slice(0, idx))
  if (!Number.isFinite(ts)) return { ts: null, id: null }
  return { ts, id: idx < 0 ? null : cursor.slice(idx + 1) }
}

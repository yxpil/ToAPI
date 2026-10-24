// @author yxpil
import type { NotifyEventType, NotificationView, NotifyLevel } from '@shared/channels'
import type { Db } from '../database'
import { ulid } from '../../infra/id'
import { buildCursor, splitCursor } from './history.repo'
import { bool, num, optStr, str, type Row } from './rows'

/** 通知中心留痕 + 60s 合并计数（15 号文档 §2/§3.2） */

const SQL = {
  insert: `INSERT INTO notification (id, type, level, title, body, source_type, source_id, read, count, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?)`,
  merge: `UPDATE notification SET level = ?, title = ?, body = ?, count = count + 1 WHERE id = ?`,
  byId: 'SELECT * FROM notification WHERE id = ?',
  firstPage: `SELECT * FROM notification
              WHERE (? = '' OR type = ?) AND (? = 0 OR read = 0)
              ORDER BY created_at DESC, id DESC LIMIT ?`,
  afterCursor: `SELECT * FROM notification
                WHERE (? = '' OR type = ?) AND (? = 0 OR read = 0)
                  AND (created_at < ? OR (created_at = ? AND id < ?))
                ORDER BY created_at DESC, id DESC LIMIT ?`,
  unread: 'SELECT COUNT(*) AS c FROM notification WHERE read = 0',
  latest: 'SELECT * FROM notification ORDER BY created_at DESC LIMIT ?',
  markRead: 'UPDATE notification SET read = 1 WHERE read = 0 AND id = ?',
  markAllRead: 'UPDATE notification SET read = 1 WHERE read = 0',
  trim: `DELETE FROM notification WHERE id NOT IN (
           SELECT id FROM notification ORDER BY created_at DESC, id DESC LIMIT ?
         )`,
} as const

export const mapNotification = (row: Row): NotificationView => ({
  id: str(row['id']),
  type: str(row['type']) as NotifyEventType,
  level: str(row['level']) as NotifyLevel,
  title: str(row['title']),
  body: str(row['body']),
  sourceType: optStr(row['source_type']),
  sourceId: optStr(row['source_id']),
  read: bool(row['read']),
  count: num(row['count']) || 1,
  createdAt: num(row['created_at']),
})

export interface NewNotification {
  type: NotifyEventType
  level: NotifyLevel
  title: string
  body: string
  sourceType?: string | null
  sourceId?: string | null
}

/** 通知中心的容量上限，超出按时间环形清理（15 号文档 §2） */
const KEEP = 1000

export class NotificationRepo {
  constructor(private readonly db: Db) {}

  add(input: NewNotification): NotificationView {
    const id = ulid()
    const createdAt = Date.now()
    this.db
      .prepare(SQL.insert)
      .run(
        id,
        input.type,
        input.level,
        input.title,
        input.body.slice(0, 500),
        input.sourceType ?? null,
        input.sourceId ?? null,
        createdAt,
      )
    this.db.prepare(SQL.trim).run(KEEP)
    return {
      id,
      type: input.type,
      level: input.level,
      title: input.title,
      body: input.body.slice(0, 500),
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      read: false,
      count: 1,
      createdAt,
    }
  }

  /** 合并窗口内的追加：更新同一条记录的文案与计数，返回合并后的视图 */
  merge(id: string, patch: { level: NotifyLevel; title: string; body: string }): NotificationView {
    this.db.prepare(SQL.merge).run(patch.level, patch.title, patch.body.slice(0, 500), id)
    return this.require(id)
  }

  require(id: string): NotificationView {
    const row = this.db.prepare(SQL.byId).get(id) as Row | undefined
    if (!row) throw new Error(`通知不存在：${id}`)
    return mapNotification(row)
  }

  hasUnreadError(): boolean {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM notification WHERE read = 0 AND level = ?')
      .get('error') as Row | undefined
    return num(row?.['c']) > 0
  }

  list(input: {
    cursor?: string | null
    unreadOnly?: boolean
    type?: NotifyEventType | null
    limit?: number
  }): { items: NotificationView[]; nextCursor: string | null } {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200)
    const type = input.type ?? ''
    const unread = input.unreadOnly ? 1 : 0
    const { ts, id: cursorId } = splitCursor(input.cursor)
    const rows =
      ts === null
        ? (this.db.prepare(SQL.firstPage).all(type, type, unread, limit + 1) as unknown as Row[])
        : (this.db
            .prepare(SQL.afterCursor)
            .all(type, type, unread, ts, ts, cursorId ?? '', limit + 1) as unknown as Row[])
    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map(mapNotification)
    const last = items.at(-1)
    return {
      items,
      nextCursor: hasMore && last ? buildCursor(last.createdAt, last.id) : null,
    }
  }

  unread(): number {
    const row = this.db.prepare(SQL.unread).get() as Row | undefined
    return num(row?.['c'])
  }

  latest(limit: number): NotificationView[] {
    return (this.db.prepare(SQL.latest).all(limit) as unknown as Row[]).map(mapNotification)
  }

  markRead(ids: string[]): number {
    let changed = 0
    for (const id of ids) changed += num(this.db.prepare(SQL.markRead).run(id).changes)
    return changed
  }

  markAllRead(): number {
    return num(this.db.prepare(SQL.markAllRead).run().changes)
  }
}

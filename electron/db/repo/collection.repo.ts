// @author yxpil
import type { Db } from '../database'
import type { Auth, Collection, CollectionVariable } from '@shared/types'
import { ulid } from '../../infra/id'
import { j, maxOf, num, parseJson, type Row, str } from './rows'

const SQL = {
  insert: `INSERT INTO collection (id, project_id, parent_id, name, description, auth, variables,
                                   pre_script, post_script, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  byId: 'SELECT * FROM collection WHERE id = ?',
  byProject: 'SELECT * FROM collection WHERE project_id = ? ORDER BY sort_order',
  update: `UPDATE collection SET name = ?, description = ?, auth = ?, variables = ?,
           pre_script = ?, post_script = ?, updated_at = ? WHERE id = ?`,
  delete: 'DELETE FROM collection WHERE id = ?',
  sortTail: 'UPDATE collection SET sort_order = ?, updated_at = ? WHERE id = ?',
  maxSort:
    "SELECT MAX(sort_order) AS m FROM collection WHERE project_id = ? AND IFNULL(parent_id, '') = ?",
} as const

export const mapCollection = (row: Row): Collection => ({
  id: str(row['id']),
  projectId: str(row['project_id']),
  parentId: row['parent_id'] === null ? null : str(row['parent_id']),
  name: str(row['name']),
  description: str(row['description']),
  auth: parseJson<Auth>(str(row['auth']), { type: 'inherit' }),
  variables: parseJson<CollectionVariable[]>(str(row['variables']), []),
  preScript: str(row['pre_script']),
  postScript: str(row['post_script']),
  sortOrder: num(row['sort_order']),
  createdAt: num(row['created_at']),
  updatedAt: num(row['updated_at']),
})

export class CollectionRepo {
  constructor(private readonly db: Db) {}

  create(input: { projectId: string; parentId?: string | null; name: string }): Collection {
    const now = Date.now()
    const parentId = input.parentId ?? ''
    const siblingMax = this.db.prepare(SQL.maxSort).get(input.projectId, parentId) as
      Row | undefined
    const entity: Collection = {
      id: ulid(now),
      projectId: input.projectId,
      parentId: parentId === '' ? null : parentId,
      name: input.name,
      description: '',
      auth: { type: 'inherit' },
      variables: [],
      preScript: '',
      postScript: '',
      sortOrder: maxOf(siblingMax) + 1000,
      createdAt: now,
      updatedAt: now,
    }
    this.db
      .prepare(SQL.insert)
      .run(
        entity.id,
        entity.projectId,
        entity.parentId,
        entity.name,
        entity.description,
        j(entity.auth),
        j(entity.variables),
        entity.preScript,
        entity.postScript,
        entity.sortOrder,
        entity.createdAt,
        entity.updatedAt,
      )
    return entity
  }

  get(id: string): Collection | null {
    const row = this.db.prepare(SQL.byId).get(id) as Row | undefined
    return row ? mapCollection(row) : null
  }

  listByProject(projectId: string): Collection[] {
    return (this.db.prepare(SQL.byProject).all(projectId) as unknown as Row[]).map(mapCollection)
  }

  update(
    id: string,
    patch: Partial<
      Pick<Collection, 'name' | 'description' | 'auth' | 'variables' | 'preScript' | 'postScript'>
    >,
  ): Collection | null {
    const current = this.get(id)
    if (!current) return null
    const next: Collection = { ...current, ...patch, updatedAt: Date.now() }
    this.db
      .prepare(SQL.update)
      .run(
        next.name,
        next.description,
        j(next.auth),
        j(next.variables),
        next.preScript,
        next.postScript,
        next.updatedAt,
        id,
      )
    return next
  }

  remove(id: string): void {
    this.db.prepare(SQL.delete).run(id)
  }

  setSortOrder(id: string, sortOrder: number): void {
    this.db.prepare(SQL.sortTail).run(sortOrder, Date.now(), id)
  }
}

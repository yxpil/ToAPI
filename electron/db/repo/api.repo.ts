// @author yxpil
import type { Db } from '../database'
import type { Api, Auth, Extractor, FakeConfig, KvRow, HttpMethod } from '@shared/types'
import { ulid } from '../../infra/id'
import { j, maxOf, num, optStr, parseJson, type Row, str } from './rows'

const SQL = {
  insert: `INSERT INTO api (id, collection_id, name, description, method, url, params, headers, body_type, body,
                            auth, fake, pre_script, post_script, extractors, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  byId: 'SELECT * FROM api WHERE id = ?',
  byCollection: 'SELECT * FROM api WHERE collection_id = ? ORDER BY sort_order',
  update: `UPDATE api SET name = ?, description = ?, method = ?, url = ?, params = ?, headers = ?,
            body_type = ?, body = ?, auth = ?, fake = ?, pre_script = ?, post_script = ?,
            extractors = ?, sort_order = ?, updated_at = ? WHERE id = ?`,
  updateMove: 'UPDATE api SET collection_id = ?, sort_order = ?, updated_at = ? WHERE id = ?',
  delete: 'DELETE FROM api WHERE id = ?',
  sortTail: 'UPDATE api SET sort_order = ?, updated_at = ? WHERE id = ?',
  maxSort: 'SELECT MAX(sort_order) AS m FROM api WHERE collection_id = ?',
  countInProject: `SELECT COUNT(*) AS m FROM api a
                   JOIN collection c ON c.id = a.collection_id WHERE c.project_id = ?`,
} as const

export const mapApi = (row: Row): Api => ({
  id: str(row['id']),
  collectionId: str(row['collection_id']),
  name: str(row['name']),
  description: str(row['description']),
  method: str(row['method']) as HttpMethod,
  url: str(row['url']),
  params: parseJson<KvRow[]>(str(row['params']), []),
  headers: parseJson<KvRow[]>(str(row['headers']), []),
  bodyType: str(row['body_type']) as Api['bodyType'],
  body: str(row['body']),
  auth: parseJson<Auth>(str(row['auth']), { type: 'none' }),
  fake: parseJson<FakeConfig>(str(row['fake']), {}),
  preScript: str(row['pre_script']),
  postScript: str(row['post_script']),
  extractors: parseJson<Extractor[]>(str(row['extractors']), []),
  sortOrder: num(row['sort_order']),
  createdAt: num(row['created_at']),
  updatedAt: num(row['updated_at']),
})

export class ApiRepo {
  constructor(private readonly db: Db) {}

  create(input: { collectionId: string; name: string; method?: HttpMethod; url?: string }): Api {
    const now = Date.now()
    const max = this.db.prepare(SQL.maxSort).get(input.collectionId) as Row | undefined
    const entity: Api = {
      id: ulid(now),
      collectionId: input.collectionId,
      name: input.name,
      description: '',
      method: input.method ?? 'GET',
      url: input.url ?? '',
      params: [],
      headers: [],
      bodyType: 'none',
      body: '',
      auth: { type: 'none' },
      fake: {},
      preScript: '',
      postScript: '',
      extractors: [],
      sortOrder: maxOf(max) + 1000,
      createdAt: now,
      updatedAt: now,
    }
    this.insert(entity)
    return entity
  }

  private insert(e: Api): void {
    this.db
      .prepare(SQL.insert)
      .run(
        e.id,
        e.collectionId,
        e.name,
        e.description,
        e.method,
        e.url,
        j(e.params),
        j(e.headers),
        e.bodyType,
        e.body,
        j(e.auth),
        j(e.fake),
        e.preScript,
        e.postScript,
        j(e.extractors),
        e.sortOrder,
        e.createdAt,
        e.updatedAt,
      )
  }

  get(id: string): Api | null {
    const row = this.db.prepare(SQL.byId).get(id) as Row | undefined
    return row ? mapApi(row) : null
  }

  listByCollection(collectionId: string): Api[] {
    return (this.db.prepare(SQL.byCollection).all(collectionId) as unknown as Row[]).map(mapApi)
  }

  update(id: string, patch: Partial<Omit<Api, 'id' | 'collectionId' | 'createdAt'>>): Api | null {
    const current = this.get(id)
    if (!current) return null
    const next: Api = {
      ...current,
      ...patch,
      id: current.id,
      collectionId: current.collectionId,
      updatedAt: Date.now(),
    }
    this.db
      .prepare(SQL.update)
      .run(
        next.name,
        next.description,
        next.method,
        next.url,
        j(next.params),
        j(next.headers),
        next.bodyType,
        next.body,
        j(next.auth),
        j(next.fake),
        next.preScript,
        next.postScript,
        j(next.extractors),
        next.sortOrder,
        next.updatedAt,
        id,
      )
    return next
  }

  moveToCollection(id: string, collectionId: string): Api | null {
    if (!this.get(id)) return null
    const max = this.db.prepare(SQL.maxSort).get(collectionId) as Row | undefined
    this.db.prepare(SQL.updateMove).run(collectionId, maxOf(max) + 1000, Date.now(), id)
    return this.get(id)
  }

  duplicate(id: string, targetCollectionId?: string): Api | null {
    const source = this.get(id)
    if (!source) return null
    const now = Date.now()
    const collectionId = targetCollectionId ?? source.collectionId
    const max = this.db.prepare(SQL.maxSort).get(collectionId) as Row | undefined
    const copy: Api = {
      ...source,
      id: ulid(now),
      collectionId,
      name: `${source.name} 副本`,
      sortOrder: maxOf(max) + 1000,
      createdAt: now,
      updatedAt: now,
    }
    this.insert(copy)
    return copy
  }

  remove(id: string): void {
    this.db.prepare(SQL.delete).run(id)
  }

  setSortOrder(id: string, sortOrder: number): void {
    this.db.prepare(SQL.sortTail).run(sortOrder, Date.now(), id)
  }

  countInProject(projectId: string): number {
    return maxOf(this.db.prepare(SQL.countInProject).get(projectId) as Row | undefined)
  }

  projectOf(id: string): string | null {
    const row = this.db
      .prepare(
        'SELECT c.project_id AS p FROM api a JOIN collection c ON c.id = a.collection_id WHERE a.id = ?',
      )
      .get(id) as Row | undefined
    return optStr(row?.['p'])
  }
}

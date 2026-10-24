// @author yxpil
import type { Db } from '../database'
import type {
  Auth,
  CollectionVariable,
  Project,
  ProjectNode,
  ProjectSettings,
  TreeCollectionNode,
} from '@shared/types'
import { ulid } from '../../infra/id'
import { mapCollection } from './collection.repo'
import { mapApi } from './api.repo'
import { j, maxOf, num, parseJson, type Row, str } from './rows'

const SQL = {
  insert: `INSERT INTO project (id, name, description, settings, auth, variables, pre_script, post_script,
                                sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  all: 'SELECT * FROM project ORDER BY sort_order',
  byId: 'SELECT * FROM project WHERE id = ?',
  update: `UPDATE project SET name = ?, description = ?, settings = ?, auth = ?, variables = ?,
           pre_script = ?, post_script = ?, updated_at = ? WHERE id = ?`,
  delete: 'DELETE FROM project WHERE id = ?',
  sortTail: 'UPDATE project SET sort_order = ?, updated_at = ? WHERE id = ?',
  collections: 'SELECT * FROM collection ORDER BY sort_order',
  apis: 'SELECT * FROM api ORDER BY sort_order',
  maxSort: 'SELECT MAX(sort_order) AS m FROM project',
} as const

export const mapProject = (row: Row): Project => ({
  id: str(row['id']),
  name: str(row['name']),
  description: str(row['description']),
  sortOrder: num(row['sort_order']),
  settings: parseJson<ProjectSettings>(str(row['settings']), {}),
  auth: parseJson<Auth>(str(row['auth']), { type: 'none' }),
  variables: parseJson<CollectionVariable[]>(str(row['variables']), []),
  preScript: str(row['pre_script']),
  postScript: str(row['post_script']),
  createdAt: num(row['created_at']),
  updatedAt: num(row['updated_at']),
})

export class ProjectRepo {
  constructor(private readonly db: Db) {}

  create(input: { name: string; description?: string }): Project {
    const now = Date.now()
    const max = maxOf(this.db.prepare(SQL.maxSort).get() as Row | undefined)
    const entity: Project = {
      id: ulid(now),
      name: input.name,
      description: input.description ?? '',
      sortOrder: max + 1000,
      settings: {},
      auth: { type: 'none' },
      variables: [],
      preScript: '',
      postScript: '',
      createdAt: now,
      updatedAt: now,
    }
    this.db
      .prepare(SQL.insert)
      .run(
        entity.id,
        entity.name,
        entity.description,
        j(entity.settings),
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

  get(id: string): Project | null {
    const row = this.db.prepare(SQL.byId).get(id) as Row | undefined
    return row ? mapProject(row) : null
  }

  list(): Project[] {
    return (this.db.prepare(SQL.all).all() as unknown as Row[]).map(mapProject)
  }

  update(
    id: string,
    patch: Partial<
      Pick<
        Project,
        'name' | 'description' | 'settings' | 'auth' | 'variables' | 'preScript' | 'postScript'
      >
    >,
  ): Project | null {
    const current = this.get(id)
    if (!current) return null
    const next: Project = { ...current, ...patch, id, updatedAt: Date.now() }
    this.db
      .prepare(SQL.update)
      .run(
        next.name,
        next.description,
        j(next.settings),
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

  /** 项目 → 集合（含嵌套）→ 接口 的完整树（01 号文档 §3 P0 分类管理） */
  listTree(): ProjectNode[] {
    const projects = this.list()
    const collections = (this.db.prepare(SQL.collections).all() as unknown as Row[]).map(
      mapCollection,
    )
    const apis = (this.db.prepare(SQL.apis).all() as unknown as Row[]).map(mapApi)

    const byId = new Map<string, TreeCollectionNode>()
    const projectOfCollection = new Map<string, string>()
    for (const c of collections) {
      projectOfCollection.set(c.id, c.projectId)
      byId.set(c.id, {
        id: c.id,
        name: c.name,
        parentId: c.parentId,
        sortOrder: c.sortOrder,
        children: [],
        apis: [],
      })
    }

    const sortedApis = [...apis].sort((a, b) => a.sortOrder - b.sortOrder)
    for (const api of sortedApis) {
      const node = byId.get(api.collectionId)
      node?.apis.push({
        id: api.id,
        name: api.name,
        method: api.method,
        url: api.url,
        sortOrder: api.sortOrder,
      })
    }

    const rootsByProject = new Map<string, TreeCollectionNode[]>()
    for (const node of byId.values()) {
      if (node.parentId) {
        const parent = byId.get(node.parentId)
        if (parent) {
          parent.children.push(node)
          continue
        }
      }
      const projectId = projectOfCollection.get(node.id) ?? ''
      const bucket = rootsByProject.get(projectId)
      if (bucket) bucket.push(node)
      else rootsByProject.set(projectId, [node])
    }

    const sortTree = (nodes: TreeCollectionNode[]): TreeCollectionNode[] =>
      [...nodes]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((n) => ({ ...n, children: sortTree(n.children) }))

    return projects.map((project) => ({
      project,
      collections: sortTree(rootsByProject.get(project.id) ?? []),
    }))
  }
}

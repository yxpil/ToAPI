// @author yxpil
import type { Db } from '../database'
import type { Environment } from '@shared/types'
import { ulid } from '../../infra/id'
import { bool, maxOf, optStr, type Row, str } from './rows'

const SQL = {
  insert: 'INSERT INTO environment (id, project_id, name, is_active) VALUES (?, ?, ?, ?)',
  byProject: 'SELECT * FROM environment WHERE project_id = ? ORDER BY name',
  byId: 'SELECT * FROM environment WHERE id = ?',
  rename: 'UPDATE environment SET name = ? WHERE id = ?',
  delete: 'DELETE FROM environment WHERE id = ?',
  clearActive: 'UPDATE environment SET is_active = 0 WHERE project_id = ?',
  setActive: 'UPDATE environment SET is_active = 1 WHERE id = ?',
  activeOfProject: 'SELECT * FROM environment WHERE project_id = ? AND is_active = 1',
  siblings: 'SELECT COUNT(*) AS m FROM environment WHERE project_id = ?',
} as const

export const mapEnvironment = (row: Row): Environment => ({
  id: str(row['id']),
  projectId: str(row['project_id']),
  name: str(row['name']),
  isActive: bool(row['is_active']),
})

export class EnvironmentRepo {
  constructor(private readonly db: Db) {}

  create(input: { projectId: string; name: string }): Environment {
    const entity: Environment = {
      id: ulid(),
      projectId: input.projectId,
      name: input.name,
      // 项目内首个环境自动激活，省掉一次点击
      isActive: maxOf(this.db.prepare(SQL.siblings).get(input.projectId) as Row | undefined) === 0,
    }
    this.db
      .prepare(SQL.insert)
      .run(entity.id, entity.projectId, entity.name, entity.isActive ? 1 : 0)
    return entity
  }

  get(id: string): Environment | null {
    const row = this.db.prepare(SQL.byId).get(id) as Row | undefined
    return row ? mapEnvironment(row) : null
  }

  listByProject(projectId: string): Environment[] {
    return (this.db.prepare(SQL.byProject).all(projectId) as unknown as Row[]).map(mapEnvironment)
  }

  activeFor(projectId: string): Environment | null {
    const row = this.db.prepare(SQL.activeOfProject).get(projectId) as Row | undefined
    return row ? mapEnvironment(row) : null
  }

  rename(id: string, name: string): Environment | null {
    this.db.prepare(SQL.rename).run(name, id)
    return this.get(id)
  }

  remove(id: string): void {
    this.db.prepare(SQL.delete).run(id)
  }

  /** 每个项目同时最多一个激活环境（03 号文档 §3.4，应用层保证） */
  activate(projectId: string, environmentId: string | null): void {
    this.db.prepare(SQL.clearActive).run(projectId)
    if (environmentId) this.db.prepare(SQL.setActive).run(environmentId)
  }

  projectIdOf(id: string): string | null {
    return optStr((this.db.prepare(SQL.byId).get(id) as Row | undefined)?.['project_id'])
  }

  listIdsByProject(projectId: string): string[] {
    return (this.db.prepare(SQL.byProject).all(projectId) as unknown as Row[]).map((r) =>
      str(r['id']),
    )
  }
}

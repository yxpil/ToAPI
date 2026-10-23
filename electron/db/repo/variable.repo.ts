import type { Db } from '../database'
import type { Variable, VarScope } from '@shared/types'
import { ulid } from '../../infra/id'
import { bool, optStr, type Row, str } from './rows'

const SQL = {
  upsert: `INSERT INTO variable (id, scope, environment_id, key, value, secret, enabled)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(scope, IFNULL(environment_id, ''), key)
           DO UPDATE SET value = excluded.value, secret = excluded.secret, enabled = excluded.enabled`,
  globals: "SELECT * FROM variable WHERE scope = 'global' ORDER BY key",
  forEnv: "SELECT * FROM variable WHERE scope = 'environment' AND environment_id = ? ORDER BY key",
  byId: 'SELECT * FROM variable WHERE id = ?',
  byKey: "SELECT * FROM variable WHERE scope = ? AND IFNULL(environment_id, '') = ? AND key = ?",
  delete: 'DELETE FROM variable WHERE id = ?',
  deleteByEnv: "DELETE FROM variable WHERE scope = 'environment' AND environment_id = ?",
  inProjectEnvs: `SELECT * FROM variable WHERE scope = 'environment'
                  AND environment_id IN (SELECT id FROM environment WHERE project_id = ?) ORDER BY key`,
} as const

export const mapVariable = (row: Row): Variable => ({
  id: str(row['id']),
  scope: str(row['scope']) as VarScope,
  environmentId: optStr(row['environment_id']),
  key: str(row['key']),
  value: str(row['value']),
  secret: bool(row['secret']),
  enabled: bool(row['enabled']),
})

export class VariableRepo {
  constructor(private readonly db: Db) {}

  upsert(input: {
    scope: VarScope
    environmentId?: string | null
    key: string
    value: string
    secret?: boolean
    enabled?: boolean
  }): Variable {
    const envKey = input.scope === 'environment' ? (input.environmentId ?? null) : null
    const existing = this.find(input.scope, envKey, input.key)
    const id = existing?.id ?? ulid()
    this.db
      .prepare(SQL.upsert)
      .run(
        id,
        input.scope,
        envKey,
        input.key,
        input.value,
        input.secret ? 1 : 0,
        input.enabled === false ? 0 : 1,
      )
    const row = this.db.prepare(SQL.byKey).get(input.scope, envKey ?? '', input.key) as
      Row | undefined
    return row
      ? mapVariable(row)
      : {
          id,
          scope: input.scope,
          environmentId: envKey,
          key: input.key,
          value: input.value,
          secret: Boolean(input.secret),
          enabled: input.enabled !== false,
        }
  }

  find(scope: VarScope, environmentId: string | null, key: string): Variable | null {
    const row = this.db.prepare(SQL.byKey).get(scope, environmentId ?? '', key) as Row | undefined
    return row ? mapVariable(row) : null
  }

  listGlobals(): Variable[] {
    return (this.db.prepare(SQL.globals).all() as unknown as Row[]).map(mapVariable)
  }

  listForEnv(environmentId: string): Variable[] {
    return (this.db.prepare(SQL.forEnv).all(environmentId) as unknown as Row[]).map(mapVariable)
  }

  listInProjectEnvs(projectId: string): Variable[] {
    return (this.db.prepare(SQL.inProjectEnvs).all(projectId) as unknown as Row[]).map(mapVariable)
  }

  remove(id: string): void {
    this.db.prepare(SQL.delete).run(id)
  }

  removeForEnv(environmentId: string): void {
    this.db.prepare(SQL.deleteByEnv).run(environmentId)
  }

  get(id: string): Variable | null {
    const row = this.db.prepare(SQL.byId).get(id) as Row | undefined
    return row ? mapVariable(row) : null
  }
}

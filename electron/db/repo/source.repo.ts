import type { Db } from '../database'
import { j, parseJson, type Row, str } from './rows'

export type SourceKind = 'project' | 'collection' | 'api' | 'environment'

const TABLE: Record<SourceKind, string> = {
  project: 'project',
  collection: 'collection',
  api: 'api',
  environment: 'environment',
}

/** Postman 原文留存（source_json），只增字段不改业务列，导出时回填（23 号文档 §3.2） */
export class SourceMetaRepo {
  constructor(private readonly db: Db) {}

  get(kind: SourceKind, id: string): Record<string, unknown> {
    const row = this.db.prepare(`SELECT source_json FROM ${TABLE[kind]} WHERE id = ?`).get(id) as
      Row | undefined
    return row ? parseJson<Record<string, unknown>>(str(row['source_json']), {}) : {}
  }

  set(kind: SourceKind, id: string, value: Record<string, unknown>): void {
    this.db.prepare(`UPDATE ${TABLE[kind]} SET source_json = ? WHERE id = ?`).run(j(value), id)
  }
}

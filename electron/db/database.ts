import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { MIGRATIONS } from './migrations/index'
import { createLogger } from '../infra/logger'

const log = createLogger('db')

export type Db = DatabaseSync

export function userVersion(db: Db): number {
  const row = db.prepare('PRAGMA user_version').get() as Record<string, number | bigint> | undefined
  const raw = row?.['user_version'] ?? 0
  return Number(raw)
}

/** 逐版本升级，每步包事务；失败回滚并抛出（03 号文档 §4） */
export function migrate(db: Db): number {
  let version = userVersion(db)
  for (const m of MIGRATIONS) {
    if (m.version <= version) continue
    db.exec('BEGIN')
    try {
      db.exec(m.up)
      db.exec(`PRAGMA user_version = ${m.version}`)
      db.exec('COMMIT')
      version = m.version
      log.info('migrated', { version: m.version, name: m.name })
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
  return version
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

export interface OpenOptions {
  /** 测试用内存库 */
  inMemory?: boolean
}

export function openDatabase(filePath: string, opts: OpenOptions = {}): Db {
  const target = opts.inMemory ? ':memory:' : filePath
  if (!opts.inMemory) mkdirSync(dirname(target), { recursive: true })
  const db = new DatabaseSync(target)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 3000')
  migrate(db)
  return db
}

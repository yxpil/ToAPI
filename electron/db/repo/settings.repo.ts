// @author yxpil
import type { Db } from '../database'
import { j, parseJson, str, type Row } from './rows'

/** app_settings 键值仓：开放通道配置、UI 偏好等小对象统一走这里（03 号文档 §3.9） */
export class SettingsRepo {
  constructor(private readonly db: Db) {}

  raw(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
      Row | undefined
    return row ? str(row['value']) : null
  }

  get<T>(key: string, fallback: T): T {
    const value = this.raw(key)
    return value === null ? fallback : parseJson<T>(value, fallback)
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, typeof value === 'string' ? value : j(value))
  }

  remove(key: string): void {
    this.db.prepare('DELETE FROM app_settings WHERE key = ?').run(key)
  }

  /** 只在缺省时写入，用于首次启动初始化 */
  setDefault(key: string, value: unknown): void {
    this.db
      .prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)')
      .run(key, typeof value === 'string' ? value : j(value))
  }
}

// 迁移脚本以 TS 常量内嵌，避免打包后读不到 .sql 文件（18 号文档 §3.4）
export interface Migration {
  version: number
  name: string
  up: string
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: '001_init',
    up: `
      CREATE TABLE project (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        settings TEXT NOT NULL DEFAULT '{}',
        sort_order REAL NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE collection (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        parent_id TEXT REFERENCES collection(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        pre_script TEXT NOT NULL DEFAULT '',
        post_script TEXT NOT NULL DEFAULT '',
        sort_order REAL NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX collection_project_idx ON collection(project_id, sort_order);
      CREATE INDEX collection_parent_idx ON collection(parent_id);

      CREATE TABLE api (
        id TEXT PRIMARY KEY,
        collection_id TEXT NOT NULL REFERENCES collection(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        method TEXT NOT NULL,
        url TEXT NOT NULL,
        params TEXT NOT NULL DEFAULT '[]',
        headers TEXT NOT NULL DEFAULT '[]',
        body_type TEXT NOT NULL DEFAULT 'none',
        body TEXT NOT NULL DEFAULT '',
        auth TEXT NOT NULL DEFAULT '{"type":"none"}',
        fake TEXT NOT NULL DEFAULT '{}',
        pre_script TEXT NOT NULL DEFAULT '',
        post_script TEXT NOT NULL DEFAULT '',
        extractors TEXT NOT NULL DEFAULT '[]',
        sort_order REAL NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX api_collection_idx ON api(collection_id, sort_order);

      CREATE TABLE environment (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX environment_project_idx ON environment(project_id);

      CREATE TABLE variable (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        environment_id TEXT REFERENCES environment(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL DEFAULT '',
        secret INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX variable_unique ON variable(scope, IFNULL(environment_id, ''), key);

      CREATE TABLE history (
        id TEXT PRIMARY KEY,
        api_id TEXT REFERENCES api(id) ON DELETE SET NULL,
        project_id TEXT NOT NULL,
        request_snapshot TEXT NOT NULL,
        response TEXT NOT NULL,
        body_path TEXT,
        method TEXT NOT NULL,
        url TEXT NOT NULL,
        status INTEGER NOT NULL,
        time_ms REAL NOT NULL,
        size_bytes INTEGER NOT NULL,
        is_sub_request INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX history_project_idx ON history(project_id, created_at DESC);
      CREATE INDEX history_api_idx ON history(api_id, created_at DESC);

      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
]

export const LATEST_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)

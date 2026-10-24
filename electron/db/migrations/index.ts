// @author yxpil
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
    up: `      CREATE TABLE project (
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
  {
    version: 2,
    name: '002_runner',
    up: `
      CREATE TABLE runner_run (
        id TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        scope_name TEXT NOT NULL DEFAULT '',
        env_id TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        total INTEGER NOT NULL DEFAULT 0,
        passed INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        skipped INTEGER NOT NULL DEFAULT 0,
        report_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX runner_run_started_idx ON runner_run(started_at DESC);

      CREATE TABLE runner_item (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runner_run(id) ON DELETE CASCADE,
        api_id TEXT,
        api_name TEXT NOT NULL,
        status TEXT NOT NULL,
        history_id TEXT,
        time_ms REAL NOT NULL DEFAULT 0,
        assertions_json TEXT NOT NULL DEFAULT '[]',
        logs_json TEXT NOT NULL DEFAULT '[]',
        error TEXT,
        sort_order REAL NOT NULL
      );
      CREATE INDEX runner_item_run_idx ON runner_item(run_id, sort_order);
    `,
  },
  {
    version: 3,
    name: '003_postman',
    up: `
      ALTER TABLE project ADD COLUMN auth TEXT NOT NULL DEFAULT '{"type":"none"}';
      ALTER TABLE project ADD COLUMN variables TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE project ADD COLUMN pre_script TEXT NOT NULL DEFAULT '';
      ALTER TABLE project ADD COLUMN post_script TEXT NOT NULL DEFAULT '';
      ALTER TABLE project ADD COLUMN source_json TEXT NOT NULL DEFAULT '{}';

      ALTER TABLE collection ADD COLUMN description TEXT NOT NULL DEFAULT '';
      ALTER TABLE collection ADD COLUMN auth TEXT NOT NULL DEFAULT '{"type":"inherit"}';
      ALTER TABLE collection ADD COLUMN variables TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE collection ADD COLUMN source_json TEXT NOT NULL DEFAULT '{}';

      ALTER TABLE api ADD COLUMN description TEXT NOT NULL DEFAULT '';
      ALTER TABLE api ADD COLUMN source_json TEXT NOT NULL DEFAULT '{}';

      ALTER TABLE environment ADD COLUMN source_json TEXT NOT NULL DEFAULT '{}';

      ALTER TABLE variable ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
    `,
  },
  {
    version: 4,
    name: '004_runner_iteration',
    up: `
      ALTER TABLE runner_run ADD COLUMN iteration_count INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE runner_item ADD COLUMN iteration INTEGER NOT NULL DEFAULT 1;
      DROP INDEX runner_item_run_idx;
      CREATE INDEX runner_item_run_idx ON runner_item(run_id, iteration, sort_order);
    `,
  },
]

export const LATEST_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)

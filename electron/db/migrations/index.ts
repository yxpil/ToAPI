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
  {
    version: 5,
    name: '005_open_channel',
    up: `
      CREATE TABLE external_call_log (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        tool TEXT NOT NULL,
        client TEXT NOT NULL DEFAULT '',
        params_summary TEXT NOT NULL DEFAULT '',
        ok INTEGER NOT NULL DEFAULT 1,
        error_code TEXT,
        time_ms REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX external_call_created_idx ON external_call_log(created_at DESC);
    `,
  },
  {
    version: 6,
    name: '006_schedule_notify',
    up: `
      CREATE TABLE schedule_task (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        spec_json TEXT NOT NULL,
        env_id TEXT,
        overlap TEXT NOT NULL DEFAULT 'skip',
        misfire TEXT NOT NULL DEFAULT 'run-on-launch',
        notify_json TEXT NOT NULL DEFAULT '{"onSuccess":true,"onFail":true,"report":"none"}',
        last_run_at INTEGER,
        last_run_id TEXT,
        last_failed INTEGER,
        next_run_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX schedule_task_due_idx ON schedule_task(enabled, next_run_at);

      CREATE TABLE notification (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        level TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        source_type TEXT,
        source_id TEXT,
        read INTEGER NOT NULL DEFAULT 0,
        count INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX notification_read_idx ON notification(read, created_at DESC);
      CREATE INDEX notification_type_idx ON notification(type, created_at DESC);
    `,
  },
  {
    version: 7,
    name: '007_node',
    up: `
      CREATE TABLE node (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        device_id TEXT NOT NULL DEFAULT '',
        channel_key TEXT NOT NULL DEFAULT '',
        fingerprint TEXT NOT NULL DEFAULT '',
        confirmed_fingerprint TEXT NOT NULL DEFAULT '',
        labels TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        added_at INTEGER NOT NULL,
        last_seen_at INTEGER,
        last_error TEXT,
        seq INTEGER NOT NULL DEFAULT 0,
        epoch TEXT NOT NULL DEFAULT ''
      );
      CREATE UNIQUE INDEX node_host_idx ON node(host, port);

      CREATE TABLE node_call_log (
        id TEXT PRIMARY KEY,
        /** 出站调用填本机记录的节点 id；入站（被配对方）调用留空，用 peer 标识来源 */
        node_id TEXT NOT NULL DEFAULT '',
        peer TEXT NOT NULL DEFAULT '',
        action TEXT NOT NULL,
        ok INTEGER NOT NULL DEFAULT 1,
        error_code TEXT,
        time_ms REAL NOT NULL DEFAULT 0,
        items INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX node_call_created_idx ON node_call_log(created_at DESC);
    `,
  },
]

export const LATEST_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)

/**
 * Миграции SQLite. Только добавление новых записей в конец; старые не менять.
 * Полные CRM-объекты в этих таблицах не хранятся (ТЗ §4.4) — только ссылки,
 * хеши, зашифрованные планы и минимальные результаты.
 */
export interface Migration {
  readonly id: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'init',
    sql: `
CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  portal_key TEXT NOT NULL,
  tool TEXT NOT NULL,
  operation_kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('prepared','approved','executing','succeeded','failed','unknown','denied','expired')),
  canonical_args_hash TEXT NOT NULL,
  target TEXT,
  expected_state_hash TEXT,
  file_hash TEXT,
  policy_version TEXT NOT NULL,
  plan_encrypted TEXT NOT NULL,
  idempotency_key TEXT,
  result_encrypted TEXT,
  error_code TEXT,
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  approved_at TEXT,
  executing_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_operations_principal_status ON operations(principal_id, status);

CREATE TABLE IF NOT EXISTS idempotency (
  principal_id TEXT NOT NULL,
  portal_key TEXT NOT NULL,
  tool TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, portal_key, tool, idempotency_key)
);

CREATE TABLE IF NOT EXISTS cursors (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  portal_key TEXT NOT NULL,
  tool TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cursors_expires ON cursors(expires_at);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  request_id TEXT NOT NULL,
  principal_hash TEXT NOT NULL,
  portal_key TEXT NOT NULL,
  tool TEXT,
  method TEXT,
  api_version TEXT,
  operation_kind TEXT NOT NULL,
  target_alias TEXT,
  args_hash TEXT,
  approval_id TEXT,
  outcome TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  error_code TEXT,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  portal_key TEXT PRIMARY KEY,
  member_id TEXT,
  user_id INTEGER,
  scopes TEXT,
  access_encrypted TEXT NOT NULL,
  refresh_encrypted TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS file_manifests (
  token TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  original_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  staging_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS capabilities_cache (
  cache_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
`,
  },
  {
    id: 2,
    name: 'scan-status-and-admin-panel',
    sql: `
ALTER TABLE file_manifests ADD COLUMN scan_status TEXT NOT NULL DEFAULT 'skipped';

CREATE TABLE IF NOT EXISTS admin_users (
  name TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id_hash TEXT PRIMARY KEY,
  user_name TEXT NOT NULL,
  csrf TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions(expires_at);
`,
  },
  {
    id: 3,
    name: 'tenant-id',
    // SaaS-ТЗ §6.2, S1: каждая строка арендатора помечена tenant_id; существующие данные — арендатор `local`.
    sql: `
ALTER TABLE operations ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'local';
ALTER TABLE idempotency ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'local';
ALTER TABLE cursors ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'local';
ALTER TABLE audit ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'local';
ALTER TABLE file_manifests ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'local';
CREATE INDEX IF NOT EXISTS idx_operations_tenant_principal ON operations(tenant_id, principal_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS ux_idempotency_tenant ON idempotency(tenant_id, principal_id, portal_key, tool, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_cursors_tenant ON cursors(tenant_id, id);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_ts ON audit(tenant_id, ts);
CREATE INDEX IF NOT EXISTS idx_file_manifests_tenant ON file_manifests(tenant_id, token);
`,
  },
  {
    id: 4,
    name: 'idempotency-tenant-pk',
    // Первичный ключ idempotency с арендатором (как в PostgreSQL): один ключ у разных арендаторов не конфликтует.
    sql: `
CREATE TABLE idempotency_v4 (
  tenant_id TEXT NOT NULL DEFAULT 'local',
  principal_id TEXT NOT NULL,
  portal_key TEXT NOT NULL,
  tool TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, principal_id, portal_key, tool, idempotency_key)
);
INSERT INTO idempotency_v4 (tenant_id, principal_id, portal_key, tool, idempotency_key, args_hash, operation_id, created_at, expires_at)
  SELECT tenant_id, principal_id, portal_key, tool, idempotency_key, args_hash, operation_id, created_at, expires_at FROM idempotency;
DROP TABLE idempotency;
ALTER TABLE idempotency_v4 RENAME TO idempotency;
`,
  },
];

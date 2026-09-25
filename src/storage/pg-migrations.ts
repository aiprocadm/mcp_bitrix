/**
 * Схема PostgreSQL режима saas (SaaS-ТЗ §6). Только добавление новых миграций в конец.
 *
 * Изоляция: таблицы данных арендатора — `tenant_id NOT NULL` + ROW LEVEL SECURITY (ENABLE + FORCE) с политикой
 * `tenant_id = current_setting('app.tenant_id', true)`. Сервис подключается ролью БЕЗ superuser и BYPASSRLS
 * (суперпользователь обходит RLS даже при FORCE) — проверяется при старте (`assertRlsEnforced`).
 * Каталог (tenants, планы, биллинг, клиенты OAuth, учёт) — без RLS: нужен до выбора арендатора и владельцу сервиса;
 * данных порталов в нём нет.
 *
 * В SQL миграций нельзя использовать `?` (адаптер переводит его в параметр).
 */
import { S3_MIGRATIONS } from './pg-migrations/s3.js';
import { S4_MIGRATIONS } from './pg-migrations/s4.js';
import { S5S9_MIGRATIONS } from './pg-migrations/s5s9.js';
import { S6S7_MIGRATIONS } from './pg-migrations/s6s7.js';
import { S8_MIGRATIONS } from './pg-migrations/s8.js';

export interface PgMigration {
  readonly id: number;
  readonly name: string;
  readonly sql: string;
}

/** Таблицы данных арендатора под RLS. */
export const RLS_TABLES = [
  'operations',
  'idempotency',
  'cursors',
  'audit',
  'file_manifests',
  'tenant_users',
  'bitrix_tokens',
  'mcp_consents',
  'tenant_settings',
] as const;

const rls = (table: string) => `
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ${table}
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));`;

const CORE_MIGRATIONS: readonly PgMigration[] = [
  {
    id: 1,
    name: 'core-tenant-tables',
    sql: `
CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
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
CREATE INDEX idx_operations_tenant_principal ON operations(tenant_id, principal_id, status);

CREATE TABLE idempotency (
  tenant_id TEXT NOT NULL,
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

CREATE TABLE cursors (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  portal_key TEXT NOT NULL,
  tool TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_cursors_tenant_expires ON cursors(tenant_id, expires_at);

CREATE TABLE audit (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
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
CREATE INDEX idx_audit_tenant_ts ON audit(tenant_id, ts);

CREATE TABLE file_manifests (
  token TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  original_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  staging_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  scan_status TEXT NOT NULL DEFAULT 'skipped'
);
${['operations', 'idempotency', 'cursors', 'audit', 'file_manifests'].map(rls).join('\n')}
`,
  },
  {
    id: 2,
    name: 'control-plane',
    sql: `
-- Каталог арендаторов: портал Bitrix24 = арендатор (D1). DEK — ключ данных арендатора под KEK (D7).
CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL UNIQUE,
  domain TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','suspended','uninstalled','deleted')),
  dek_encrypted TEXT,
  app_token_hash TEXT,
  trial_used INTEGER NOT NULL DEFAULT 0,
  installed_at TEXT NOT NULL,
  uninstalled_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE tenant_users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bitrix_user_id INTEGER NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  email TEXT,
  role TEXT NOT NULL CHECK (role IN ('reader','operator','administrator')),
  status TEXT NOT NULL CHECK (status IN ('active','disabled','reauth_required')),
  token_generation INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, bitrix_user_id)
);

CREATE TABLE bitrix_tokens (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES tenant_users(id) ON DELETE CASCADE,
  access_encrypted TEXT NOT NULL,
  refresh_encrypted TEXT NOT NULL,
  access_expires_at TEXT NOT NULL,
  refresh_issued_at TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  client_endpoint TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE tenant_settings (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  modules_json TEXT NOT NULL DEFAULT '[]',
  approval_policy TEXT NOT NULL DEFAULT 'self' CHECK (approval_policy IN ('self','admin_for_high_risk')),
  user_daily_call_limit INTEGER,
  output_policy_json TEXT,
  default_role TEXT NOT NULL DEFAULT 'operator' CHECK (default_role IN ('reader','operator','administrator')),
  updated_at TEXT NOT NULL
);

-- Сервер авторизации MCP (§7.1): клиенты DCR, коды, refresh-токены (хеши), согласия.
CREATE TABLE mcp_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  redirect_uris_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE mcp_auth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES mcp_clients(client_id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE mcp_refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  family_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  rotated_at TEXT,
  revoked_at TEXT
);
CREATE INDEX idx_mcp_refresh_family ON mcp_refresh_tokens(family_id);
CREATE INDEX idx_mcp_refresh_user ON mcp_refresh_tokens(tenant_id, user_id);

CREATE TABLE mcp_consents (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, user_id, client_id)
);

-- Тарифы, подписки, платежи, счета (§9, §10). Деньги — копейки INTEGER/BIGINT.
CREATE TABLE plans (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price_kopecks BIGINT NOT NULL CHECK (price_kopecks >= 0),
  period_months INTEGER NOT NULL CHECK (period_months IN (1, 12)),
  trial_days INTEGER NOT NULL DEFAULT 0,
  limits_json TEXT NOT NULL,
  modules_json TEXT NOT NULL,
  destructive_allowed INTEGER NOT NULL DEFAULT 0,
  public INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE subscriptions (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  plan_code TEXT NOT NULL REFERENCES plans(code),
  status TEXT NOT NULL CHECK (status IN ('trialing','active','past_due','suspended','canceled')),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  pending_plan_code TEXT REFERENCES plans(code),
  payment_method_encrypted TEXT,
  payment_method_title TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  suspended_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_payment_id TEXT UNIQUE,
  idempotence_key TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL CHECK (purpose IN ('initial','renewal','upgrade')),
  plan_code TEXT NOT NULL,
  amount_kopecks BIGINT NOT NULL CHECK (amount_kopecks >= 0),
  currency TEXT NOT NULL DEFAULT 'RUB',
  status TEXT NOT NULL CHECK (status IN ('pending','waiting_for_capture','succeeded','canceled','refunded')),
  description TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_payments_tenant ON payments(tenant_id, created_at);

CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  number TEXT NOT NULL UNIQUE,
  plan_code TEXT NOT NULL,
  amount_kopecks BIGINT NOT NULL CHECK (amount_kopecks >= 0),
  buyer_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('issued','paid','canceled')),
  created_at TEXT NOT NULL,
  paid_at TEXT,
  marked_by TEXT
);

-- Учёт использования (§9.2): агрегаты по арендатору/пользователю/периоду, без содержимого.
CREATE TABLE usage_counters (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  period TEXT NOT NULL,
  calls BIGINT NOT NULL DEFAULT 0,
  writes BIGINT NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, user_id, period)
);

-- Кабинет клиента (§11.1) и панель владельца (§11.3).
CREATE TABLE cabinet_sessions (
  id_hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  csrf TEXT NOT NULL,
  authenticated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_cabinet_sessions_expires ON cabinet_sessions(expires_at);

CREATE TABLE owner_users (
  name TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('service_owner','support')),
  password_hash TEXT NOT NULL,
  totp_secret_encrypted TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE support_actions (
  id BIGSERIAL PRIMARY KEY,
  actor TEXT NOT NULL,
  tenant_id TEXT,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_support_actions_tenant ON support_actions(tenant_id, created_at);
${['tenant_users', 'bitrix_tokens', 'mcp_consents', 'tenant_settings'].map(rls).join('\n')}
`,
  },
];

/** Все миграции по возрастанию номера; дубль номера — ошибка загрузки. */
export const PG_MIGRATIONS: readonly PgMigration[] = (() => {
  const all = [
    ...CORE_MIGRATIONS,
    ...S3_MIGRATIONS,
    ...S4_MIGRATIONS,
    ...S5S9_MIGRATIONS,
    ...S6S7_MIGRATIONS,
    ...S8_MIGRATIONS,
  ].sort((a, b) => a.id - b.id);
  for (let i = 1; i < all.length; i += 1) {
    if (all[i]?.id === all[i - 1]?.id)
      throw new Error(`Миграция PostgreSQL ${String(all[i]?.id)} объявлена дважды`);
  }
  return all;
})();

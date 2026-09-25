/**
 * Миграции PostgreSQL этапа S9: панель владельца `/owner` (SaaS-ТЗ §11.3). Номера — только 55–59
 * (50–54 — кабинет S5 в `s5s9.ts`; диапазоны разных этапов не пересекаются). В SQL нельзя использовать `?`.
 *
 * Всё здесь — каталог сервиса без RLS (как `owner_users`/`support_actions` миграции 2): данных порталов нет.
 * `owner_users.name` — email владельца/сотрудника поддержки в нижнем регистре.
 */
import type { PgMigration } from '../pg-migrations.js';

export const S9_MIGRATIONS: readonly PgMigration[] = [
  {
    id: 55,
    name: 's9-owner-panel',
    sql: `
-- Вход владельца (§11.3): пароль (scrypt) + TOTP (RFC 6238). Блокировка после серии неудачных попыток,
-- защита от повторного использования кода: принимается только шаг TOTP больше последнего принятого.
ALTER TABLE owner_users ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE owner_users ADD COLUMN locked_until TEXT;
ALTER TABLE owner_users ADD COLUMN last_totp_step BIGINT NOT NULL DEFAULT 0;
ALTER TABLE owner_users ADD COLUMN last_login_at TEXT;
ALTER TABLE owner_users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;

-- Сессии панели: в БД только SHA-256 cookie; CSRF-токен на сессию; абсолютный срок и срок бездействия.
CREATE TABLE owner_sessions (
  id_hash TEXT PRIMARY KEY,
  owner_name TEXT NOT NULL REFERENCES owner_users(name) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_owner_sessions_expires ON owner_sessions(expires_at);
CREATE INDEX idx_owner_sessions_owner ON owner_sessions(owner_name);

-- Объявления в кабинете клиента (§11.3): всем арендаторам (tenant_id NULL) или одному.
CREATE TABLE announcements (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK (level IN ('info','warning','critical')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_announcements_active ON announcements(active, starts_at);

CREATE INDEX idx_support_actions_created ON support_actions(created_at);
`,
  },
];

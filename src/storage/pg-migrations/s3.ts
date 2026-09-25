/**
 * Миграции PostgreSQL этапа S3: тиражное приложение Bitrix24, токены пользователей. Номера — только из диапазона 30–39
 * (диапазоны разных этапов не пересекаются; порядок применения — по номеру). В SQL нельзя использовать `?`.
 *
 * Токены пользователей — таблица `bitrix_tokens` миграции 2 (без изменений).
 */
import type { PgMigration } from '../pg-migrations.js';

export const S3_MIGRATIONS: readonly PgMigration[] = [
  {
    id: 30,
    name: 's3-tenant-app-status',
    // Последняя проверка app.info (SaaS-ТЗ §8): статус приложения и лицензии портала для кабинета и панели владельца.
    // Каталог без RLS (как tenants/subscriptions): только флаги статуса, данных портала нет.
    sql: `
CREATE TABLE tenant_app_status (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  checked_at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  app_status TEXT,
  installed INTEGER,
  payment_expired INTEGER,
  days_left INTEGER,
  license TEXT,
  license_family TEXT,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  error_code TEXT,
  error_reason TEXT
);
`,
  },
];

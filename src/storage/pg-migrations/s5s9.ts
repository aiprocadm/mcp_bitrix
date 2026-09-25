/**
 * Миграции PostgreSQL этапа S5/S9: кабинет клиента, панель владельца. Номера — только из диапазона 50–59
 * (диапазоны разных этапов не пересекаются; порядок применения — по номеру). В SQL нельзя использовать `?`.
 * Внутри диапазона: S5 (кабинет `/app`) — 50–54, S9 (панель владельца `/owner`) — 55–59.
 *
 * 50 (S5): сессии кабинета и состояния входа через Bitrix24.
 *  - `cabinet_sessions` (миграция 2) переходит под RLS: сессия — данные арендатора, cookie несёт id арендатора,
 *    поиск идёт в его контексте (`withTenant`); подобранная cookie с чужим id арендатора не находит ничего.
 *    Внешние ключи с каскадом: удаление пользователя/арендатора удаляет его сессии.
 *  - `cabinet_login_states` — каталог без RLS (запись создаётся до выбора арендатора): хеш одноразового `state`,
 *    хеш cookie привязки браузера, домен портала, адрес возврата, срок. Секретов и данных порталов нет.
 */
import type { PgMigration } from '../pg-migrations.js';

export const S5S9_MIGRATIONS: readonly PgMigration[] = [
  {
    id: 50,
    name: 's5-cabinet-sessions',
    sql: `
ALTER TABLE cabinet_sessions ADD COLUMN last_seen_at TEXT;
ALTER TABLE cabinet_sessions ADD CONSTRAINT fk_cabinet_sessions_tenant
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
ALTER TABLE cabinet_sessions ADD CONSTRAINT fk_cabinet_sessions_user
  FOREIGN KEY (user_id) REFERENCES tenant_users(id) ON DELETE CASCADE;
CREATE INDEX idx_cabinet_sessions_user ON cabinet_sessions(tenant_id, user_id);
ALTER TABLE cabinet_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cabinet_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cabinet_sessions
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE TABLE cabinet_login_states (
  state_hash TEXT PRIMARY KEY,
  bind_hash TEXT NOT NULL,
  portal TEXT NOT NULL,
  return_to TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_cabinet_login_states_expires ON cabinet_login_states(expires_at);
`,
  },
];

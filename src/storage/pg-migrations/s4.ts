/**
 * Миграции PostgreSQL этапа S4: сервер авторизации MCP. Номера — только из диапазона 40–49
 * (диапазоны разных этапов не пересекаются; порядок применения — по номеру). В SQL нельзя использовать `?`.
 *
 * 40: дополняет таблицы миграции 2 (mcp_clients, mcp_auth_codes, mcp_refresh_tokens, mcp_consents):
 *  - клиенты: вид регистрации (DCR RFC 7591 / Client ID Metadata Document), метаданные, хеш секрета
 *    конфиденциального клиента, срок кэша документа CIMD;
 *  - коды: семья refresh-токенов (повтор кода → отзыв выданного по нему, OAuth 2.1 §4.1.3) и поколение пользователя;
 *  - refresh: поколение пользователя на момент выдачи (отзыв §7.4);
 *  - каскадное удаление с клиентом и арендатором (удаление неиспользуемых клиентов, удаление арендатора).
 *    Ссылочные действия PostgreSQL выполняются без RLS, поэтому согласия (таблица под RLS) удаляются вместе с клиентом.
 */
import type { PgMigration } from '../pg-migrations.js';

export const S4_MIGRATIONS: readonly PgMigration[] = [
  {
    id: 40,
    name: 's4-oauth-server',
    sql: `
ALTER TABLE mcp_clients ADD COLUMN kind TEXT NOT NULL DEFAULT 'dcr' CHECK (kind IN ('dcr','cimd'));
ALTER TABLE mcp_clients ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE mcp_clients ADD COLUMN secret_hash TEXT;
ALTER TABLE mcp_clients ADD COLUMN metadata_expires_at TEXT;
CREATE INDEX idx_mcp_clients_unused ON mcp_clients ((COALESCE(last_used_at, created_at)));

ALTER TABLE mcp_auth_codes ADD COLUMN family_id TEXT NOT NULL DEFAULT '';
ALTER TABLE mcp_auth_codes ADD COLUMN token_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mcp_auth_codes ADD CONSTRAINT fk_mcp_auth_codes_tenant
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
CREATE INDEX idx_mcp_auth_codes_expires ON mcp_auth_codes(expires_at);

ALTER TABLE mcp_refresh_tokens ADD COLUMN token_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mcp_refresh_tokens ADD CONSTRAINT fk_mcp_refresh_client
  FOREIGN KEY (client_id) REFERENCES mcp_clients(client_id) ON DELETE CASCADE;
ALTER TABLE mcp_refresh_tokens ADD CONSTRAINT fk_mcp_refresh_tenant
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
CREATE INDEX idx_mcp_refresh_expires ON mcp_refresh_tokens(expires_at);
CREATE INDEX idx_mcp_refresh_client ON mcp_refresh_tokens(client_id);

ALTER TABLE mcp_consents ADD CONSTRAINT fk_mcp_consents_client
  FOREIGN KEY (client_id) REFERENCES mcp_clients(client_id) ON DELETE CASCADE;
ALTER TABLE mcp_consents ADD CONSTRAINT fk_mcp_consents_tenant
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
CREATE INDEX idx_mcp_consents_client ON mcp_consents(client_id);
`,
  },
];

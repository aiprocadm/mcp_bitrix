/**
 * Миграции PostgreSQL этапа S4: сервер авторизации MCP. Номера — только из диапазона 40–49
 * (диапазоны разных этапов не пересекаются; порядок применения — по номеру). В SQL нельзя использовать `?`.
 */
import type { PgMigration } from '../pg-migrations.js';

export const S4_MIGRATIONS: readonly PgMigration[] = [];

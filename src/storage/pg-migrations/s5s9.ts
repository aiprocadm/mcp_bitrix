/**
 * Миграции PostgreSQL этапа S5/S9: кабинет клиента, панель владельца. Номера — только из диапазона 50–59
 * (диапазоны разных этапов не пересекаются; порядок применения — по номеру). В SQL нельзя использовать `?`.
 */
import type { PgMigration } from '../pg-migrations.js';

export const S5S9_MIGRATIONS: readonly PgMigration[] = [];

/**
 * Миграции PostgreSQL этапа S8: эксплуатация. Номера — только из диапазона 80–89
 * (диапазоны разных этапов не пересекаются; порядок применения — по номеру). В SQL нельзя использовать `?`.
 */
import type { PgMigration } from '../pg-migrations.js';

export const S8_MIGRATIONS: readonly PgMigration[] = [];

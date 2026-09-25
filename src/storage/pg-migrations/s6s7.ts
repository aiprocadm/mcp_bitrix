/**
 * Миграции PostgreSQL этапа S6/S7: тарифы, учёт, биллинг. Номера — только из диапазона 60–79
 * (диапазоны разных этапов не пересекаются; порядок применения — по номеру). В SQL нельзя использовать `?`.
 */
import type { PgMigration } from '../pg-migrations.js';

export const S6S7_MIGRATIONS: readonly PgMigration[] = [];

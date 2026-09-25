/**
 * Миграции PostgreSQL этапа S3: тиражное приложение Bitrix24, токены пользователей. Номера — только из диапазона 30–39
 * (диапазоны разных этапов не пересекаются; порядок применения — по номеру). В SQL нельзя использовать `?`.
 */
import type { PgMigration } from '../pg-migrations.js';

export const S3_MIGRATIONS: readonly PgMigration[] = [];

/**
 * Асинхронный доступ к SQL-хранилищу (SaaS-ТЗ §6.1, D6): один код хранилищ для SQLite (single) и PostgreSQL (saas).
 *
 * Правила SQL в хранилищах, чтобы запрос работал в обоих диалектах:
 *  - параметры только `?` (адаптер PostgreSQL переводит в `$1…`);
 *  - upsert — `INSERT … ON CONFLICT (…) DO UPDATE/NOTHING` (оба диалекта), без `INSERT OR REPLACE`;
 *  - даты — ISO-строки в TEXT, счётчики — INTEGER/BIGINT, булевы — INTEGER 0/1;
 *  - каждая таблица арендатора имеет `tenant_id`; запросы арендатора идут через `withTenant`
 *    (PostgreSQL: транзакция с `app.tenant_id` для Row Level Security; SQLite: без изменений).
 */
export type SqlValue = string | number | bigint | null | Uint8Array;

export interface SqlExecutor {
  readonly dialect: 'sqlite' | 'postgres';
  get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<T[]>;
  /** Число изменённых строк. */
  run(sql: string, ...params: SqlValue[]): Promise<number>;
}

export interface SqlDb extends SqlExecutor {
  /** Транзакция: всё внутри fn выполняется атомарно на одном соединении. */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  /** Запросы арендатора: PostgreSQL — транзакция с установленным app.tenant_id (RLS); SQLite — сам fn. */
  withTenant<T>(tenantId: string, fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  /** Проверка доступности (health/readiness, проба аудита). */
  ping(): Promise<void>;
  schemaVersion(): Promise<number>;
  close(): Promise<void>;
}

/** Числа из драйверов: SQLite отдаёт number/bigint, PostgreSQL — string для BIGINT/COUNT. */
export function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' && v !== '') return Number(v);
  return 0;
}

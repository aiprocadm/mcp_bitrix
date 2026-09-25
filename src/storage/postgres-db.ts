/**
 * Адаптер SqlDb для PostgreSQL (SaaS-ТЗ §6.1, D6): пул соединений, перевод `?` → `$n`,
 * транзакции на одном соединении и контекст арендатора для Row Level Security.
 *
 * `withTenant(id, fn)` = BEGIN; set_config('app.tenant_id', id, true); fn; COMMIT — политика RLS каждой таблицы
 * арендатора сравнивает tenant_id с этим значением, поэтому запрос, забывший фильтр, всё равно не видит чужих строк.
 * Строка подключения — секрет: в ошибки попадает только код PostgreSQL, не текст и не адрес.
 */
import pg from 'pg';
import { AppError } from '../errors/app-error.js';
import { PG_MIGRATIONS, type PgMigration } from './pg-migrations.js';
import { toNumber, type SqlDb, type SqlExecutor, type SqlValue } from './sql.js';

/** `?` вне строковых литералов и идентификаторов в кавычках → `$1, $2…`. */
export function toPgPlaceholders(sql: string): string {
  let out = '';
  let n = 0;
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i += 1) {
    const c = sql.charAt(i);
    if (quote) {
      out += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      out += c;
      continue;
    }
    if (c === '?') {
      n += 1;
      out += `$${String(n)}`;
      continue;
    }
    out += c;
  }
  return out;
}

const TENANT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function dbError(e: unknown): AppError {
  const code = e && typeof e === 'object' && 'code' in e ? String(e.code) : 'unknown';
  return new AppError('INTERNAL_ERROR', 'Ошибка хранилища PostgreSQL', { reason: `pg:${code}` });
}

function executor(client: pg.PoolClient | pg.Pool): SqlExecutor {
  const query = async (sql: string, params: SqlValue[]) => {
    try {
      return await client.query(toPgPlaceholders(sql), params as unknown[]);
    } catch (e) {
      throw dbError(e);
    }
  };
  return {
    dialect: 'postgres',
    get: async <T>(sql: string, ...p: SqlValue[]) => (await query(sql, p)).rows[0] as T | undefined,
    all: async <T>(sql: string, ...p: SqlValue[]) => (await query(sql, p)).rows as T[],
    run: async (sql: string, ...p: SqlValue[]) => (await query(sql, p)).rowCount ?? 0,
  };
}

export interface PostgresOptions {
  readonly connectionString: string;
  readonly maxConnections?: number;
  readonly migrations?: readonly PgMigration[];
  /** По умолчанию true: отказ старта под ролью, обходящей RLS (superuser/BYPASSRLS). */
  readonly requireRls?: boolean;
}

export class PostgresSqlDb implements SqlDb {
  readonly dialect = 'postgres' as const;
  private readonly root: SqlExecutor;

  private constructor(readonly pool: pg.Pool) {
    this.root = executor(pool);
  }

  /** Подключение и миграции под advisory-блокировкой (несколько экземпляров стартуют одновременно). */
  static async open(opts: PostgresOptions): Promise<PostgresSqlDb> {
    const pool = new pg.Pool({
      connectionString: opts.connectionString,
      max: opts.maxConnections ?? 10,
      application_name: 'bitrix24-mcp',
    });
    // Ошибка простаивающего соединения не должна ронять процесс; следующий запрос получит новое.
    pool.on('error', () => undefined);
    const db = new PostgresSqlDb(pool);
    try {
      if (opts.requireRls !== false) await db.assertRlsEnforced();
      await db.migrate(opts.migrations ?? PG_MIGRATIONS);
    } catch (e) {
      await pool.end().catch(() => undefined);
      throw e instanceof AppError ? e : dbError(e);
    }
    return db;
  }

  /**
   * Суперпользователь и роль с BYPASSRLS обходят политики даже при FORCE ROW LEVEL SECURITY:
   * такой запуск сделал бы изоляцию арендаторов декоративной (SaaS-ТЗ §12 п.1).
   */
  async assertRlsEnforced(): Promise<void> {
    const r = await this.root.get<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    if (!r || r.rolsuper || r.rolbypassrls) {
      throw new AppError(
        'CONFIG_INVALID',
        'DATABASE_URL: роль PostgreSQL обходит RLS (superuser или BYPASSRLS); изоляция арендаторов не гарантирована',
        {
          field: 'DATABASE_URL',
          nextAction:
            'Создайте отдельную роль без SUPERUSER и BYPASSRLS, владельца базы сервиса (docs/saas/operations.md)',
        },
      );
    }
  }

  private async migrate(migrations: readonly PgMigration[]): Promise<void> {
    await this.transaction(async (tx) => {
      await tx.run('SELECT pg_advisory_xact_lock(724119)');
      await tx.run(
        'CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
      );
      const applied = new Set(
        (await tx.all<{ id: unknown }>('SELECT id FROM schema_migrations')).map((r) => toNumber(r.id)),
      );
      for (const m of migrations) {
        if (applied.has(m.id)) continue;
        await tx.run(m.sql);
        await tx.run(
          'INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)',
          m.id,
          m.name,
          new Date().toISOString(),
        );
      }
    });
  }

  get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<T | undefined> {
    return this.root.get<T>(sql, ...params);
  }

  all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<T[]> {
    return this.root.all<T>(sql, ...params);
  }

  run(sql: string, ...params: SqlValue[]): Promise<number> {
    return this.root.run(sql, ...params);
  }

  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    let client: pg.PoolClient;
    try {
      client = await this.pool.connect();
    } catch (e) {
      throw dbError(e);
    }
    try {
      await client.query('BEGIN');
      const result = await fn(executor(client));
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  withTenant<T>(tenantId: string, fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    if (!TENANT_ID_RE.test(tenantId)) {
      return Promise.reject(new AppError('INTERNAL_ERROR', 'Недопустимый идентификатор арендатора'));
    }
    return this.transaction(async (tx) => {
      await tx.get("SELECT set_config('app.tenant_id', ?, true) AS t", tenantId);
      return fn(tx);
    });
  }

  async ping(): Promise<void> {
    await this.root.get('SELECT 1 AS one');
  }

  async schemaVersion(): Promise<number> {
    const r = await this.root.get<{ v: unknown }>('SELECT MAX(id) AS v FROM schema_migrations');
    return toNumber(r?.v);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

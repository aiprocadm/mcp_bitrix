/**
 * Адаптер SqlDb поверх синхронного SQLite (node:sqlite, режим single).
 * Одиночный запрос синхронен и атомарен. Транзакция может ждать (await) внутри — на это время
 * остальные запросы этого соединения ждут её завершения, иначе они попали бы в чужую транзакцию.
 */
import type { SQLInputValue } from 'node:sqlite';
import type { Database } from './database.js';
import type { SqlDb, SqlExecutor, SqlValue } from './sql.js';

export class SqliteSqlDb implements SqlDb {
  readonly dialect = 'sqlite' as const;
  private busy: Promise<void> | null = null;

  constructor(readonly sqlite: Database) {}

  private direct(): SqlExecutor {
    const db = this.sqlite;
    return {
      dialect: 'sqlite',
      get: <T>(sql: string, ...p: SqlValue[]) => Promise.resolve(db.get<T>(sql, ...(p as SQLInputValue[]))),
      all: <T>(sql: string, ...p: SqlValue[]) => Promise.resolve(db.all<T>(sql, ...(p as SQLInputValue[]))),
      run: (sql: string, ...p: SqlValue[]) =>
        Promise.resolve(Number(db.run(sql, ...(p as SQLInputValue[])).changes)),
    };
  }

  private async idle(): Promise<void> {
    while (this.busy) await this.busy;
  }

  async get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<T | undefined> {
    await this.idle();
    return this.direct().get<T>(sql, ...params);
  }

  async all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<T[]> {
    await this.idle();
    return this.direct().all<T>(sql, ...params);
  }

  async run(sql: string, ...params: SqlValue[]): Promise<number> {
    await this.idle();
    return this.direct().run(sql, ...params);
  }

  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    await this.idle();
    let release!: () => void;
    this.busy = new Promise<void>((r) => (release = r));
    this.sqlite.db.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn(this.direct());
      this.sqlite.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.sqlite.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.busy = null;
      release();
    }
  }

  /** В SQLite нет RLS: изоляция арендатора — фильтром tenant_id в каждом запросе хранилища. */
  withTenant<T>(_tenantId: string, fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    // Каждый запрос fn ждёт чужие транзакции (через методы this), а не попадает в них.
    return fn(this);
  }

  async ping(): Promise<void> {
    await this.get('SELECT 1 AS one');
  }

  schemaVersion(): Promise<number> {
    return Promise.resolve(this.sqlite.schemaVersion());
  }

  close(): Promise<void> {
    this.sqlite.close();
    return Promise.resolve();
  }
}

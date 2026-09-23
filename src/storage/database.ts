/**
 * SQLite через встроенный node:sqlite (ADR-0001). WAL, foreign keys, busy timeout,
 * миграции с журналом. Один процесс — один экземпляр.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { AppError } from '../errors/app-error.js';
import { MIGRATIONS } from './migrations.js';

export type Row = Record<string, SQLInputValue | null>;

export class Database {
  private constructor(
    readonly db: DatabaseSync,
    readonly filePath: string,
  ) {}

  static open(filePath: string): Database {
    if (filePath !== ':memory:') mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(filePath, { timeout: 5000 });
    } catch (e) {
      throw new AppError('CONFIG_INVALID', 'Не удалось открыть базу данных SQLite', {
        field: 'DATABASE_URL',
        reason: e instanceof Error ? e.name : 'unknown',
      });
    }
    if (filePath !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA synchronous = NORMAL');
    const instance = new Database(db, filePath);
    instance.migrate();
    return instance;
  }

  private migrate(): void {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
    );
    const applied = new Set(
      (this.db.prepare('SELECT id FROM schema_migrations').all() as { id: number }[]).map((r) => r.id),
    );
    for (const m of MIGRATIONS) {
      if (applied.has(m.id)) continue;
      this.transaction(() => {
        this.db.exec(m.sql);
        this.db
          .prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)')
          .run(m.id, m.name, new Date().toISOString());
      });
    }
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  run(sql: string, ...params: SQLInputValue[]): { changes: number | bigint } {
    const r = this.db.prepare(sql).run(...params);
    return { changes: r.changes };
  }

  schemaVersion(): number {
    const row = this.get<{ v: number | null }>('SELECT MAX(id) AS v FROM schema_migrations');
    return row?.v ?? 0;
  }

  close(): void {
    this.db.close();
  }
}

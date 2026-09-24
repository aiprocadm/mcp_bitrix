import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../src/bitrix/rate-limiter.js';
import {
  computeDelayMs,
  DEFAULT_RETRY,
  isRetryableReadError,
  parseRetryAfter,
} from '../../src/bitrix/retry.js';
import { AppError } from '../../src/errors/app-error.js';
import { SecretBox } from '../../src/security/crypto.js';
import { Database } from '../../src/storage/database.js';
import { AuditLog } from '../../src/logging/audit.js';
import { createSilentLogger } from '../../src/logging/logger.js';

describe('retry (ТЗ §14.2)', () => {
  it('экспоненциальная задержка с jitter в пределах 500 мс..8 с', () => {
    expect(computeDelayMs(0, DEFAULT_RETRY, undefined, () => 0)).toBe(250);
    expect(computeDelayMs(0, DEFAULT_RETRY, undefined, () => 1)).toBe(500);
    expect(computeDelayMs(1, DEFAULT_RETRY, undefined, () => 1)).toBe(1000);
    expect(computeDelayMs(10, DEFAULT_RETRY, undefined, () => 1)).toBe(8000);
  });
  it('Retry-After поднимает задержку, но не выше потолка', () => {
    expect(computeDelayMs(0, DEFAULT_RETRY, 3000, () => 0)).toBe(3000);
    expect(computeDelayMs(0, DEFAULT_RETRY, 60_000, () => 0)).toBe(8000);
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('garbage')).toBeUndefined();
  });
  it('повторяемы только таймаут, лимит и 502/503/504', () => {
    expect(isRetryableReadError(new AppError('BITRIX_TIMEOUT', 'x'))).toBe(true);
    expect(isRetryableReadError(new AppError('BITRIX_RATE_LIMITED', 'x'))).toBe(true);
    expect(isRetryableReadError(new AppError('BITRIX_UPSTREAM_ERROR', 'x', { httpStatus: 503 }))).toBe(true);
    expect(isRetryableReadError(new AppError('BITRIX_UPSTREAM_ERROR', 'x', { httpStatus: 500 }))).toBe(false);
    expect(isRetryableReadError(new AppError('BITRIX_ACCESS_DENIED', 'x'))).toBe(false);
    expect(isRetryableReadError(new AppError('VALIDATION_ERROR', 'x'))).toBe(false);
  });
});

describe('rate limiter (ТЗ §8.6)', () => {
  it('не выпускает больше N запросов в секунду и держит concurrency', async () => {
    let now = 0;
    const timers: { at: number; fn: () => void }[] = [];
    const limiter = new RateLimiter({
      requestsPerSecond: 2,
      maxConcurrency: 5,
      maxQueueSize: 10,
      now: () => now,
      setTimeoutFn: ((fn: () => void, ms: number) => {
        timers.push({ at: now + ms, fn });
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
    });
    const started: number[] = [];
    const tasks = [1, 2, 3, 4].map(async () => {
      const release = await limiter.acquire();
      started.push(now);
      release();
    });
    await new Promise((r) => setImmediate(r));
    expect(started).toEqual([0, 0]);
    // продвигаем время: срабатывает отложенный pump
    now = 1000;
    timers.splice(0).forEach((t) => t.fn());
    await Promise.all(tasks);
    expect(started).toEqual([0, 0, 1000, 1000]);
  });

  it('переполненная очередь → BITRIX_RATE_LIMITED', async () => {
    const limiter = new RateLimiter({ requestsPerSecond: 1, maxConcurrency: 1, maxQueueSize: 1 });
    const release = await limiter.acquire();
    const waiting = limiter.acquire();
    await expect(limiter.acquire()).rejects.toMatchObject({ code: 'BITRIX_RATE_LIMITED' });
    release();
    (await waiting)();
  });
});

describe('crypto', () => {
  it('шифрует и расшифровывает; чужой ключ и чужой AAD не подходят', () => {
    const a = new SecretBox(Buffer.alloc(32, 1));
    const b = new SecretBox(Buffer.alloc(32, 2));
    const ct = a.encrypt('план записи', 'op-1');
    expect(ct.startsWith('v1:')).toBe(true);
    expect(ct).not.toContain('план');
    expect(a.decrypt(ct, 'op-1')).toBe('план записи');
    expect(() => b.decrypt(ct, 'op-1')).toThrow(AppError);
    expect(() => a.decrypt(ct, 'op-2')).toThrow(AppError);
    expect(() => a.decrypt('garbage')).toThrow(AppError);
  });
});

describe('database + audit', () => {
  it('миграции идемпотентны, транзакция откатывается', () => {
    const db = Database.open(':memory:');
    expect(db.schemaVersion()).toBe(2);
    expect(() =>
      db.transaction(() => {
        db.run(
          "INSERT INTO cursors (id, principal_id, portal_key, tool, binding_hash, state_json, created_at, expires_at) VALUES ('c','p','k','t','h','s','2026','2027')",
        );
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.get('SELECT COUNT(*) AS n FROM cursors')).toEqual({ n: 0 });
    db.close();
  });

  it('T44: недоступный аудит запрещает запись, чтение остаётся', () => {
    const logger = createSilentLogger();
    const noDb = new AuditLog(undefined, Buffer.alloc(32, 1), logger, true, 90);
    expect(noDb.isAvailable()).toBe(false);
    expect(() => noDb.assertAvailableForWrite()).toThrow(AppError);
    const disabled = new AuditLog(undefined, Buffer.alloc(32, 1), logger, false, 90);
    expect(() => disabled.assertAvailableForWrite()).not.toThrow();

    const db = Database.open(':memory:');
    const audit = new AuditLog(db, Buffer.alloc(32, 1), logger, true, 90);
    audit.record({
      requestId: 'r1',
      principalId: 'owner',
      portalKey: 'k',
      operationKind: 'read',
      outcome: 'success',
      tool: 'x',
    });
    const row = db.get<{ principal_hash: string; tool: string }>('SELECT principal_hash, tool FROM audit');
    expect(row?.tool).toBe('x');
    expect(row?.principal_hash).not.toBe('owner');
    db.close();
    audit.record({
      requestId: 'r2',
      principalId: 'owner',
      portalKey: 'k',
      operationKind: 'create',
      outcome: 'success',
    });
    expect(audit.isAvailable()).toBe(false);
    expect(() => audit.assertAvailableForWrite()).toThrow(AppError);
  });
});

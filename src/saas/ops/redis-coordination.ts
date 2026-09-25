/**
 * Координация экземпляров через Redis (SaaS-ТЗ §3 D6, §5.1, §7.3, §9.2, §13; этап S8).
 * Реализует общий интерфейс `Coordination` (src/saas/coordination.ts) и аренду лидера для worker.
 *
 * Блокировка — SET key token NX PX ttl, снятие и продление — Lua-скриптами «только своим токеном»
 * (шаблон из документации SET: https://redis.io/docs/latest/commands/set/ — раздел о распределённых блокировках).
 * Счётчики — INCRBY + PEXPIRE атомарно одним скриптом; drain — SCAN по префиксу + GETDEL каждого ключа
 * (GETDEL атомарен: параллельный INCRBY попадает либо в забранное значение, либо в новый ключ — ни потерь, ни
 * двойного счёта, S16).
 *
 * Окно лимита (`allow`) — СКОЛЬЗЯЩЕЕ окно на ZSET (журнал запусков) одним Lua-скриптом. Почему не фиксированное
 * окно INCR+PEXPIRE: на границе фиксированного окна проходит до 2×limit запросов за windowMs, а лимит Bitrix24 на портал
 * (S15) нарушать нельзя — портал ответит QUERY_LIMIT_EXCEEDED всем экземплярам сразу. Скользящее окно точно, а память
 * мала (не больше limit элементов на ключ; для портала это единицы). Время берётся из Redis (`TIME`), а не у экземпляра:
 * часы разных машин не сравниваются. Скрипты с TIME допустимы с Redis 5 (репликация эффектов, по умолчанию в 7.x).
 */
import { randomBytes } from 'node:crypto';
import { LockTimeoutError, type Coordination } from '../coordination.js';
import {
  RedisClient,
  RedisReplyError,
  RedisScript,
  type RedisClientOptions,
  type RedisSubscriber,
} from './redis-client.js';

/** Аренда с продлением (лидер worker): отдельный интерфейс, чтобы WorkerRunner не зависел от Redis. */
export interface LeaseStore {
  /** Взять аренду, если свободна: токен владельца или null. */
  tryAcquire(key: string, ttlMs: number): Promise<string | null>;
  /** Продлить свою аренду; false — аренда уже чужая или истекла. */
  renew(key: string, token: string, ttlMs: number): Promise<boolean>;
  /** Снять свою аренду (чужую не трогает). */
  release(key: string, token: string): Promise<void>;
}

const RELEASE = new RedisScript(
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
);
const RENEW = new RedisScript(
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end",
);
const INCR_TTL = new RedisScript(
  "local v = redis.call('INCRBY', KEYS[1], ARGV[1]) " +
    "if redis.call('PTTL', KEYS[1]) < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end " +
    'return v',
);
/** Возвращает {1, 0} — разрешено; {0, ms} — отказ, ms до освобождения места в окне. */
const SLIDING_WINDOW = new RedisScript(
  "local t = redis.call('TIME') " +
    'local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000) ' +
    'local window = tonumber(ARGV[2]) ' +
    "redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window) " +
    "if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[1]) then " +
    "  redis.call('ZADD', KEYS[1], now, ARGV[3]) " +
    "  redis.call('PEXPIRE', KEYS[1], window) " +
    '  return {1, 0} ' +
    'end ' +
    "local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES') " +
    'local wait = window - (now - tonumber(oldest[2])) ' +
    'if wait < 1 then wait = 1 end ' +
    'return {0, wait}',
);

export interface RedisCoordinationOptions extends RedisClientOptions {
  /** Пространство имён всех ключей и каналов (например, `mcp:`); разные стенды на одном Redis не пересекаются. */
  readonly namespace?: string;
  /** Начальная и максимальная пауза между попытками взять занятую блокировку. */
  readonly lockRetryMinMs?: number;
  readonly lockRetryMaxMs?: number;
}

/** Экранирование glob-шаблона MATCH (https://redis.io/docs/latest/commands/keys/): * ? [ ] \ */
function globEscape(s: string): string {
  return s.replace(/[*?[\]\\]/g, (c) => `\\${c}`);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class RedisCoordination implements Coordination, LeaseStore {
  readonly redis: RedisClient;
  private subscriberConn: RedisSubscriber | undefined;
  private readonly ns: string;

  constructor(private readonly o: RedisCoordinationOptions) {
    this.redis = new RedisClient(o);
    this.ns = o.namespace ?? 'mcp:';
  }

  private k(key: string): string {
    return this.ns + key;
  }

  /** Проверка доступности (для /readyz и старта). */
  async ping(): Promise<boolean> {
    try {
      return await this.redis.ping();
    } catch {
      return false;
    }
  }

  // --- блокировки и аренда ----------------------------------------------------------------------------------

  async tryAcquire(key: string, ttlMs: number): Promise<string | null> {
    const token = randomBytes(16).toString('hex');
    return (await this.redis.set(this.k(key), token, { nx: true, pxMs: ttlMs })) ? token : null;
  }

  async renew(key: string, token: string, ttlMs: number): Promise<boolean> {
    return (await this.redis.eval(RENEW, [this.k(key)], [token, Math.max(1, Math.round(ttlMs))])) === 1;
  }

  async release(key: string, token: string): Promise<void> {
    await this.redis.eval(RELEASE, [this.k(key)], [token]);
  }

  async withLock<T>(key: string, opts: { ttlMs: number; waitMs: number }, fn: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + opts.waitMs;
    let delay = this.o.lockRetryMinMs ?? 10;
    const maxDelay = this.o.lockRetryMaxMs ?? 200;
    let token: string | null;
    for (;;) {
      token = await this.tryAcquire(key, opts.ttlMs);
      if (token) break;
      const left = deadline - Date.now();
      if (left <= 0) throw new LockTimeoutError(key);
      // экспоненциальная пауза с джиттером, но не дальше срока ожидания
      await sleep(Math.min(left, Math.round(delay * (0.5 + Math.random()))));
      delay = Math.min(maxDelay, delay * 2);
    }
    try {
      return await fn();
    } finally {
      // Снятие только своим токеном: если TTL истёк и блокировку взял другой, его блокировка не пострадает.
      try {
        await this.release(key, token);
      } catch {
        // Redis недоступен: блокировка истечёт сама по ttlMs.
      }
    }
  }

  // --- счётчики --------------------------------------------------------------------------------------------

  async incr(key: string, by: number, ttlMs: number): Promise<number> {
    const r = await this.redis.eval(
      INCR_TTL,
      [this.k(key)],
      [Math.trunc(by), Math.max(1, Math.round(ttlMs))],
    );
    return typeof r === 'number' ? r : Number(r);
  }

  async get(key: string): Promise<number> {
    const v = await this.redis.get(this.k(key));
    return v === null ? 0 : Number(v);
  }

  async drain(prefix: string): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const match = globEscape(this.k(prefix)) + '*';
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, match);
      cursor = next;
      for (const full of keys) {
        let v: string | null;
        try {
          v = await this.redis.getdel(full);
        } catch (e) {
          // не счётчик (например, ZSET окна лимита под тем же префиксом) — пропускаем, не прерывая сброс
          if (e instanceof RedisReplyError && e.message.startsWith('WRONGTYPE')) continue;
          throw e;
        }
        if (v === null) continue; // забрал другой экземпляр или истёк
        const n = Number(v);
        if (!Number.isFinite(n) || n === 0) continue;
        const key = full.slice(this.ns.length);
        out.set(key, (out.get(key) ?? 0) + n);
      }
    } while (cursor !== '0');
    return out;
  }

  // --- лимит частоты ---------------------------------------------------------------------------------------

  /** Скользящее окно: ok или сколько ждать до освобождения места. */
  async acquireSlot(
    key: string,
    limit: number,
    windowMs: number,
  ): Promise<{ ok: boolean; retryAfterMs: number }> {
    const member = `${String(Date.now())}-${randomBytes(6).toString('hex')}`;
    const r = await this.redis.eval(
      SLIDING_WINDOW,
      [this.k(key)],
      [limit, Math.max(1, Math.round(windowMs)), member],
    );
    if (!Array.isArray(r)) throw new Error('Неожиданный ответ скрипта окна лимита');
    return { ok: Number(r[0]) === 1, retryAfterMs: Number(r[1]) };
  }

  async allow(key: string, limit: number, windowMs: number): Promise<boolean> {
    return (await this.acquireSlot(key, limit, windowMs)).ok;
  }

  // --- pub/sub ---------------------------------------------------------------------------------------------

  async publish(channel: string, message: string): Promise<void> {
    await this.redis.publish(this.k(channel), message);
  }

  async subscribe(channel: string, handler: (message: string) => void): Promise<() => Promise<void>> {
    this.subscriberConn ??= this.redis.subscriber();
    return this.subscriberConn.subscribe(this.k(channel), handler);
  }

  async close(): Promise<void> {
    await Promise.all([this.redis.close(), this.subscriberConn?.close()]);
  }
}

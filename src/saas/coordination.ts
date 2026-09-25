/**
 * Координация экземпляров сервиса (SaaS-ТЗ §5.1, §13): блокировки (single-flight обновления токенов, лидер worker),
 * атомарные счётчики (учёт использования, лимиты), лимит частоты к порталу, оповещение об инвалидации.
 * Реализации: InMemoryCoordination — один процесс и тесты; RedisCoordination — кластер (этап S8).
 */
export interface Coordination {
  /** Выполнить fn под эксклюзивной блокировкой key (ожидание не дольше waitMs; держится не дольше ttlMs). */
  withLock<T>(key: string, opts: { ttlMs: number; waitMs: number }, fn: () => Promise<T>): Promise<T>;
  /** Атомарно увеличить счётчик; ttlMs задаёт срок жизни ключа при первом увеличении. Возвращает новое значение. */
  incr(key: string, by: number, ttlMs: number): Promise<number>;
  get(key: string): Promise<number>;
  /** Забрать (обнулить) счётчики по префиксу: для сброса агрегатов в PostgreSQL. */
  drain(prefix: string): Promise<Map<string, number>>;
  /** Окно лимита частоты: true — запрос разрешён (не больше limit за windowMs). */
  allow(key: string, limit: number, windowMs: number): Promise<boolean>;
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, handler: (message: string) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

export class LockTimeoutError extends Error {
  constructor(key: string) {
    super(`Не удалось получить блокировку ${key}`);
    this.name = 'LockTimeoutError';
  }
}

export class InMemoryCoordination implements Coordination {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly counters = new Map<string, { value: number; expiresAt: number }>();
  private readonly windows = new Map<string, number[]>();
  private readonly subscribers = new Map<string, Set<(m: string) => void>>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async withLock<T>(key: string, opts: { ttlMs: number; waitMs: number }, fn: () => Promise<T>): Promise<T> {
    const deadline = this.now() + opts.waitMs;
    for (;;) {
      const held = this.locks.get(key);
      if (!held) break;
      if (this.now() >= deadline) throw new LockTimeoutError(key);
      await Promise.race([held, new Promise((r) => setTimeout(r, Math.max(1, deadline - this.now())))]);
    }
    let release!: () => void;
    this.locks.set(key, new Promise<void>((r) => (release = r)));
    try {
      return await fn();
    } finally {
      this.locks.delete(key);
      release();
    }
  }

  private live(key: string): { value: number; expiresAt: number } | undefined {
    const c = this.counters.get(key);
    if (c && c.expiresAt <= this.now()) {
      this.counters.delete(key);
      return undefined;
    }
    return c;
  }

  incr(key: string, by: number, ttlMs: number): Promise<number> {
    const c = this.live(key) ?? { value: 0, expiresAt: this.now() + ttlMs };
    c.value += by;
    this.counters.set(key, c);
    return Promise.resolve(c.value);
  }

  get(key: string): Promise<number> {
    return Promise.resolve(this.live(key)?.value ?? 0);
  }

  drain(prefix: string): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const [k] of [...this.counters]) {
      if (!k.startsWith(prefix)) continue;
      const c = this.live(k);
      if (c && c.value !== 0) out.set(k, c.value);
      this.counters.delete(k);
    }
    return Promise.resolve(out);
  }

  allow(key: string, limit: number, windowMs: number): Promise<boolean> {
    const t = this.now();
    const list = (this.windows.get(key) ?? []).filter((x) => x > t - windowMs);
    const ok = list.length < limit;
    if (ok) list.push(t);
    this.windows.set(key, list);
    return Promise.resolve(ok);
  }

  publish(channel: string, message: string): Promise<void> {
    for (const h of this.subscribers.get(channel) ?? []) h(message);
    return Promise.resolve();
  }

  subscribe(channel: string, handler: (message: string) => void): Promise<() => Promise<void>> {
    const set = this.subscribers.get(channel) ?? new Set();
    set.add(handler);
    this.subscribers.set(channel, set);
    return Promise.resolve(() => {
      set.delete(handler);
      return Promise.resolve();
    });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

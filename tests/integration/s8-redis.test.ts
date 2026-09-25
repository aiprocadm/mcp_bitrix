/**
 * S8 на НАСТОЯЩЕМ redis-server: блокировки (основа S03), счётчики и drain (основа S16), общий лимит (S15),
 * pub/sub, переподключение после рестарта Redis, пароль, лидерство worker.
 */
import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LockTimeoutError } from '../../src/saas/coordination.js';
import { ClusterPortalLimiter } from '../../src/saas/ops/cluster-limiter.js';
import { createSaasMetrics } from '../../src/saas/ops/metrics.js';
import { RedisClient, RedisConnectionError } from '../../src/saas/ops/redis-client.js';
import { RedisCoordination } from '../../src/saas/ops/redis-coordination.js';
import { WorkerRunner, type WorkerTask } from '../../src/saas/ops/worker.js';
import { REDIS_AVAILABLE, startTestRedis, type TestRedis } from '../helpers/s8-redis.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('условие не выполнено вовремя');
    await sleep(20);
  }
}

describe.skipIf(!REDIS_AVAILABLE)('S8: координация на настоящем Redis', () => {
  let server: TestRedis;
  const opened: RedisCoordination[] = [];
  const coord = (ns = 'test:') => {
    const c = new RedisCoordination({
      url: server.url,
      namespace: ns,
      commandTimeoutMs: 2000,
      reconnectMaxDelayMs: 200,
    });
    opened.push(c);
    return c;
  };

  beforeAll(async () => {
    server = await startTestRedis();
  });
  afterAll(async () => {
    await Promise.all(opened.map((c) => c.close()));
    await server.stop();
  });

  it('блокировка эксклюзивна между двумя клиентами; single-flight: одно обновление на двоих (основа S03)', async () => {
    const a = coord();
    const b = coord();
    let inside = 0;
    let maxInside = 0;
    let refreshes = 0;
    let cached: string | undefined;
    const refresh = async (c: RedisCoordination) =>
      c.withLock('lock:token:u1', { ttlMs: 5000, waitMs: 5000 }, async () => {
        inside += 1;
        maxInside = Math.max(maxInside, inside);
        await sleep(15);
        if (!cached) {
          refreshes += 1;
          cached = 'new-pair';
        }
        inside -= 1;
        return cached;
      });
    const results = await Promise.all([a, b, a, b, a, b, a, b].map((c) => refresh(c)));
    expect(maxInside).toBe(1);
    expect(refreshes).toBe(1);
    expect(new Set(results)).toEqual(new Set(['new-pair']));
  });

  it('блокировка не снимается и не продлевается чужим токеном', async () => {
    const a = coord();
    const b = coord();
    const token = await a.tryAcquire('lock:foreign', 5000);
    expect(token).toBeTruthy();
    await b.release('lock:foreign', 'чужой-токен');
    expect(await b.tryAcquire('lock:foreign', 5000)).toBeNull();
    expect(await b.renew('lock:foreign', 'чужой-токен', 60_000)).toBe(false);
    expect(await a.renew('lock:foreign', token ?? '', 5000)).toBe(true);
    await a.release('lock:foreign', token ?? '');
    expect(await b.tryAcquire('lock:foreign', 5000)).toBeTruthy();
  });

  it('блокировка истекает по TTL; ожидание дольше waitMs → LockTimeoutError', async () => {
    const a = coord();
    const b = coord();
    expect(await a.tryAcquire('lock:ttl', 150)).toBeTruthy();
    await expect(
      b.withLock('lock:ttl', { ttlMs: 1000, waitMs: 30 }, () => Promise.resolve(1)),
    ).rejects.toBeInstanceOf(LockTimeoutError);
    // ожидание в пределах waitMs дожидается истечения TTL
    await expect(
      b.withLock('lock:ttl', { ttlMs: 1000, waitMs: 1000 }, () => Promise.resolve(2)),
    ).resolves.toBe(2);
  });

  it('withLock: fn дольше TTL — после истечения чужая блокировка не снимается старым владельцем', async () => {
    const a = coord();
    const b = coord();
    let bToken: string | null = null;
    await a.withLock('lock:long', { ttlMs: 80, waitMs: 0 }, async () => {
      await sleep(150);
      bToken = await b.tryAcquire('lock:long', 5000); // TTL a истёк — b взял
    });
    expect(bToken).toBeTruthy();
    // a при выходе вызвал release своим токеном — блокировка b цела
    expect(await a.tryAcquire('lock:long', 5000)).toBeNull();
  });

  it('incr/drain без потерь и двойного счёта при параллельных incr двух клиентов (основа S16)', async () => {
    const a = coord();
    const b = coord();
    const total = 400;
    let drained = 0;
    let stop = false;
    const drainer = (async () => {
      while (!stop) {
        for (const v of (await b.drain('usage:')).values()) drained += v;
        await sleep(2);
      }
    })();
    const ops: Promise<number>[] = [];
    for (let i = 0; i < total; i++) {
      const c = i % 2 ? a : b;
      ops.push(c.incr(`usage:t${String(i % 3)}:calls`, 1, 60_000));
    }
    await Promise.all(ops);
    stop = true;
    await drainer;
    for (const v of (await a.drain('usage:')).values()) drained += v;
    expect(drained).toBe(total);
    expect((await a.drain('usage:')).size).toBe(0);
  });

  it('incr ставит TTL при первом увеличении; get видит значение; drain возвращает ключи без пространства имён', async () => {
    const a = coord('ns1:');
    expect(await a.incr('cnt:x', 5, 10_000)).toBe(5);
    expect(await a.incr('cnt:x', 2, 99_000_000)).toBe(7);
    const pttl = await a.redis.command(['PTTL', 'ns1:cnt:x']);
    expect(typeof pttl === 'number' && pttl > 0 && pttl <= 10_000).toBe(true);
    expect(await a.get('cnt:x')).toBe(7);
    // префикс с символами glob экранируется: не захватывает соседние ключи
    await a.incr('cnt*y', 1, 10_000);
    expect(await a.drain('cnt*')).toEqual(new Map([['cnt*y', 1]]));
    expect(await a.drain('cnt:')).toEqual(new Map([['cnt:x', 7]]));
    expect(await a.get('cnt:x')).toBe(0);
  });

  it('allow: лимит суммарный для двух клиентов (скользящее окно, S15)', async () => {
    const a = coord();
    const b = coord();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).allow('rl:sum', 5, 1000)),
    );
    expect(results.filter(Boolean)).toHaveLength(5);
    const slot = await a.acquireSlot('rl:sum', 5, 1000);
    expect(slot.ok).toBe(false);
    expect(slot.retryAfterMs).toBeGreaterThan(0);
    expect(slot.retryAfterMs).toBeLessThanOrEqual(1000);
  });

  it('S15: три экземпляра ClusterPortalLimiter не превышают суммарную частоту к порталу', async () => {
    const limit = 5;
    const windowMs = 300;
    const metrics = createSaasMetrics();
    const limiters = [coord(), coord(), coord()].map(
      (store) =>
        new ClusterPortalLimiter({
          store,
          portalKey: 'tenant-s15',
          requestsPerSecond: limit,
          windowMs,
          maxConcurrency: 4,
          maxQueueSize: 100,
          metrics,
        }),
    );
    const grants: number[] = [];
    const started = performance.now();
    await Promise.all(
      limiters.flatMap((l) =>
        Array.from({ length: 8 }, async () => {
          const release = await l.acquire();
          grants.push(performance.now());
          await sleep(5);
          release();
        }),
      ),
    );
    const elapsed = performance.now() - started;
    expect(grants).toHaveLength(24);
    // 24 запроса по 5 за окно 300 мс: не быстрее 4 полных окон
    expect(elapsed).toBeGreaterThanOrEqual(4 * windowMs - 50);
    // в любом окне (с допуском на сетевую задержку записи отметок) — не больше limit
    grants.sort((x, y) => x - y);
    for (const g of grants) {
      const inWindow = grants.filter((t) => t >= g && t < g + windowMs - 25).length;
      expect(inWindow).toBeLessThanOrEqual(limit);
    }
    expect(metrics.registry.render()).toMatch(
      /mcp_bitrix_limiter_wait_seconds_count\{portal="[0-9a-f]{12}"\} 24/,
    );
    expect(metrics.registry.render()).not.toContain('tenant-s15');
  });

  it('лимитер: переполнение очереди → BITRIX_RATE_LIMITED, отмена → BITRIX_TIMEOUT', async () => {
    const l = new ClusterPortalLimiter({
      store: coord(),
      portalKey: 'tenant-q',
      requestsPerSecond: 1,
      windowMs: 60_000,
      maxConcurrency: 1,
      maxQueueSize: 1,
    });
    const r1 = await l.acquire();
    const ac = new AbortController();
    const waiting = l.acquire(ac.signal);
    await expect(l.acquire()).rejects.toMatchObject({ code: 'BITRIX_RATE_LIMITED' });
    ac.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'BITRIX_TIMEOUT' });
    r1();
    expect(l.stats()).toEqual({ active: 0, queued: 0 });
  });

  it('pub/sub: сообщение доходит до подписчика другого клиента; после отписки — нет', async () => {
    const a = coord();
    const b = coord();
    const got: string[] = [];
    const unsubscribe = await a.subscribe('invalidate', (m) => got.push(m));
    await b.publish('invalidate', 'tenant:1');
    await until(() => got.length === 1, 2000);
    expect(got).toEqual(['tenant:1']);
    await unsubscribe();
    await sleep(50);
    await b.publish('invalidate', 'tenant:2');
    await sleep(100);
    expect(got).toEqual(['tenant:1']);
  });

  it('переподключение после рестарта redis: команды и подписки восстанавливаются', async () => {
    const own = await startTestRedis();
    const a = new RedisCoordination({ url: own.url, commandTimeoutMs: 1000, reconnectMaxDelayMs: 100 });
    const b = new RedisCoordination({ url: own.url, commandTimeoutMs: 1000, reconnectMaxDelayMs: 100 });
    try {
      const got: string[] = [];
      await a.subscribe('ch', (m) => got.push(m));
      expect(await a.incr('k', 1, 60_000)).toBe(1);
      await own.kill();
      await expect(a.incr('k', 1, 60_000)).rejects.toBeInstanceOf(RedisConnectionError);
      await own.restart();
      // первая команда после рестарта ждёт переподключения в очереди (не отправлена — повтор безопасен)
      expect(await a.incr('k', 1, 60_000)).toBe(1); // сохранение выключено: данные после рестарта пусты
      // подписчик переподписывается сам
      const deadline = Date.now() + 3000;
      while (got.length === 0 && Date.now() < deadline) {
        await b.publish('ch', 'after-restart');
        await sleep(50);
      }
      expect(got[0]).toBe('after-restart');
    } finally {
      await a.close();
      await b.close();
      await own.stop();
    }
  });

  it('пароль (requirepass): верный — работает; неверный — отказ без утечки пароля в ошибке', async () => {
    const pw = 's8-test-password';
    const own = await startTestRedis({ password: pw });
    const good = new RedisClient({ url: own.url });
    const bad = new RedisClient({
      url: `redis://:wrong-${pw}@127.0.0.1:${String(own.port)}`,
      connectTimeoutMs: 300,
    });
    const none = new RedisClient({ url: `redis://127.0.0.1:${String(own.port)}`, commandTimeoutMs: 1000 });
    try {
      expect(await good.ping()).toBe(true);
      const err = await bad.connect().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(RedisConnectionError);
      expect((err as Error).message).not.toContain(pw);
      await expect(none.ping()).rejects.toThrow(/NOAUTH/);
    } finally {
      await Promise.all([good.close(), bad.close(), none.close()]);
      await own.stop();
    }
  });

  it('таймаут команды разрывает соединение, клиент восстанавливается', async () => {
    const a = new RedisClient({ url: server.url, commandTimeoutMs: 100, reconnectMaxDelayMs: 50 });
    try {
      // BLPOP по пустому списку ждёт ответа дольше таймаута команды
      await expect(a.command(['BLPOP', 'test:empty-list', '0.3'])).rejects.toBeInstanceOf(
        RedisConnectionError,
      );
      await sleep(350);
      expect(await a.ping()).toBe(true);
    } finally {
      await a.close();
    }
  });

  it('worker: из двух раннеров работает один; при остановке лидера второй подхватывает', async () => {
    const runs: Record<string, number> = { w1: 0, w2: 0 };
    const mk = (id: string, c: RedisCoordination) => {
      const tasks: WorkerTask[] = [
        {
          name: 'usage.flush',
          intervalMs: 30,
          run: () => {
            runs[id] = (runs[id] ?? 0) + 1;
            return Promise.resolve();
          },
        },
        {
          name: 'always.fails',
          intervalMs: 30,
          run: () => Promise.reject(new Error('сбой задачи')),
        },
      ];
      return new WorkerRunner({
        lease: c,
        tasks,
        instanceId: id,
        metrics: createSaasMetrics(),
        settings: {
          leaseKey: 'worker:leader:t1',
          leaseTtlMs: 600,
          renewIntervalMs: 100,
          shutdownGraceMs: 500,
        },
      });
    };
    const w1 = mk('w1', coord());
    const w2 = mk('w2', coord());
    w1.start();
    await until(() => w1.isLeader(), 2000);
    w2.start();
    await sleep(400);
    expect(w1.isLeader()).toBe(true);
    expect(w2.isLeader()).toBe(false);
    expect(runs['w1']).toBeGreaterThan(2);
    expect(runs['w2']).toBe(0);
    // ошибка одной задачи не мешает другой
    const st = w1.status();
    expect(st.tasks.find((t) => t.name === 'always.fails')?.failures).toBeGreaterThan(0);

    await w1.stop(); // снимает аренду — второй берёт её на ближайшем тике
    await until(() => w2.isLeader(), 1000);
    const before = runs['w2'] ?? 0;
    await sleep(200);
    expect(runs['w2']).toBeGreaterThan(before);
    const w1runs = runs['w1'];
    await sleep(100);
    expect(runs['w1']).toBe(w1runs);
    await w2.stop();
  });

  it('worker: лидер, потерявший аренду (истекла), прекращает задачи; SIGTERM останавливает и снимает аренду', async () => {
    const c = coord();
    let aborted = false;
    const w = new WorkerRunner({
      lease: c,
      tasks: [
        {
          name: 'long.task',
          intervalMs: 10_000,
          run: (signal) =>
            new Promise<void>((resolve) => {
              signal.addEventListener('abort', () => {
                aborted = true;
                resolve();
              });
            }),
        },
      ],
      settings: {
        leaseKey: 'worker:leader:t2',
        leaseTtlMs: 500,
        renewIntervalMs: 100,
        shutdownGraceMs: 1000,
      },
    });
    w.start();
    await until(() => w.isLeader(), 2000);
    // кто-то (ручное вмешательство/split) забрал аренду: продление вернёт false
    await c.redis.command(['SET', 'test:worker:leader:t2', 'другой', 'PX', '5000']);
    await until(() => !w.isLeader(), 2000);
    expect(aborted).toBe(true);
    await c.redis.del('test:worker:leader:t2');
    await until(() => w.isLeader(), 2000);

    const proc = new EventEmitter();
    let stopped = false;
    w.bindSignals(
      () => {
        stopped = true;
      },
      proc as unknown as Pick<NodeJS.Process, 'once' | 'off'>,
    );
    proc.emit('SIGTERM');
    await until(() => stopped, 3000);
    expect(w.isLeader()).toBe(false);
    expect(await c.tryAcquire('worker:leader:t2', 1000)).toBeTruthy(); // аренда снята
  });
});

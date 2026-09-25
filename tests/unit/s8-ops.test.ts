/** S8: разбор RESP2/RESP3, адрес Redis, метрики Prometheus, настройки, worker на аренде в памяти. */
import { describe, expect, it } from 'vitest';
import {
  createSaasMetrics,
  MetricsRegistry,
  portalAlias,
  renderPrometheus,
} from '../../src/saas/ops/metrics.js';
import {
  encodeCommand,
  parseRedisUrl,
  RedisReplyError,
  RespParser,
  type RedisPush,
  type RedisReply,
} from '../../src/saas/ops/redis-client.js';
import { readOpsSettings, selectTasks } from '../../src/saas/ops/settings.js';
import { MemoryLeaseStore, WorkerRunner } from '../../src/saas/ops/worker.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('RESP', () => {
  it('команда кодируется массивом bulk-строк (байтовая длина UTF-8)', () => {
    expect(encodeCommand(['SET', 'ключ', 5]).toString()).toBe('*3\r\n$3\r\nSET\r\n$8\r\nключ\r\n$1\r\n5\r\n');
  });

  it('разбирает типы RESP2 и RESP3, в том числе по частям', () => {
    const wire =
      '+OK\r\n-ERR boom\r\n:42\r\n$5\r\nhello\r\n$-1\r\n*2\r\n$1\r\na\r\n:1\r\n*-1\r\n' +
      '_\r\n,3.5\r\n#t\r\n(12345678901234567890\r\n=8\r\ntxt:abcd\r\n%1\r\n+k\r\n:2\r\n~1\r\n+s\r\n' +
      '|1\r\n+key\r\n+meta\r\n+v\r\n+after\r\n>3\r\n$7\r\nmessage\r\n$2\r\nch\r\n$1\r\nm\r\n!3\r\nBAD\r\n';
    const p = new RespParser();
    const out: (RedisReply | RedisPush)[] = [];
    const bytes = Buffer.from(wire);
    for (let i = 0; i < bytes.length; i += 3) out.push(...p.feed(bytes.subarray(i, i + 3)));
    expect(out[0]).toBe('OK');
    expect(out[1]).toBeInstanceOf(RedisReplyError);
    expect((out[1] as Error).message).toBe('ERR boom');
    expect(out.slice(2, 13)).toEqual([
      42,
      'hello',
      null,
      ['a', 1],
      null,
      null,
      3.5,
      true,
      '12345678901234567890',
      'abcd',
      ['k', 2],
    ]);
    expect(out[13]).toEqual(['s']);
    expect(out[14]).toBe('v'); // атрибут пропущен
    expect(out[15]).toBe('after');
    expect(out[16]).toEqual({ push: ['message', 'ch', 'm'] });
    expect(out[17]).toBeInstanceOf(RedisReplyError);
  });

  it('bulk-строка с \\r\\n внутри и многобайтовые символы', () => {
    const p = new RespParser();
    const s = 'a\r\nб';
    const len = Buffer.byteLength(s);
    expect(p.feed(Buffer.from(`$${String(len)}\r\n${s}\r\n`))).toEqual([s]);
  });

  it('адрес Redis: пароль, пользователь, база, TLS; ошибки без пароля', () => {
    expect(parseRedisUrl('redis://:p%40ss@redis:6380/2')).toEqual({
      host: 'redis',
      port: 6380,
      tls: false,
      username: undefined,
      password: 'p@ss',
      db: 2,
    });
    expect(parseRedisUrl('rediss://u:p@r.example.com').tls).toBe(true);
    expect(parseRedisUrl('rediss://u:p@r.example.com').port).toBe(6379);
    expect(() => parseRedisUrl('http://x:supersecret@h')).toThrow(/схема/);
    try {
      parseRedisUrl('redis://x:supersecret@h/abc');
    } catch (e) {
      expect((e as Error).message).not.toContain('supersecret');
    }
  });
});

describe('метрики Prometheus', () => {
  it('счётчики, датчики, гистограммы в текстовом формате 0.0.4; экранирование меток', () => {
    const r = new MetricsRegistry();
    const c = r.counter('t_calls_total', 'Вызовы', ['tool', 'outcome']);
    c.inc({ tool: 'crm_list', outcome: 'ok' });
    c.inc({ tool: 'crm_list', outcome: 'ok' }, 2);
    c.inc({ tool: 'bad"tool\n', outcome: 'VALIDATION_ERROR' });
    const h = r.histogram('t_dur_seconds', 'Длительность', ['tool'], [0.1, 1]);
    h.observe({ tool: 'x' }, 0.05);
    h.observe({ tool: 'x' }, 0.5);
    h.observe({ tool: 'x' }, 5);
    r.gauge('t_up', 'Жив').set({}, 1);
    const { contentType, body } = renderPrometheus(r);
    expect(contentType).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(body).toContain('# TYPE t_calls_total counter');
    expect(body).toContain('t_calls_total{tool="crm_list",outcome="ok"} 3');
    // небезопасное значение метки не попадает в вывод
    expect(body).toContain('t_calls_total{tool="other",outcome="VALIDATION_ERROR"} 1');
    expect(body).toContain('t_dur_seconds_bucket{tool="x",le="0.1"} 1');
    expect(body).toContain('t_dur_seconds_bucket{tool="x",le="1"} 2');
    expect(body).toContain('t_dur_seconds_bucket{tool="x",le="+Inf"} 3');
    expect(body).toContain('t_dur_seconds_sum{tool="x"} 5.55');
    expect(body).toContain('t_dur_seconds_count{tool="x"} 3');
    expect(body).toContain('t_up 1');
    expect(body.endsWith('\n')).toBe(true);
    for (const line of body.split('\n').filter((l) => l && !l.startsWith('#'))) {
      expect(line).toMatch(/^[a-zA-Z_:][a-zA-Z0-9_:]*(\{.*\})? [-+0-9.eInfNa]+$/);
    }
  });

  it('лимит кардинальности: лишние ряды отбрасываются и считаются', () => {
    const r = new MetricsRegistry(2);
    const c = r.counter('t_many_total', 'x', ['k']);
    for (const k of ['a', 'b', 'c', 'd']) c.inc({ k });
    expect(r.render()).toContain('mcp_metrics_series_dropped_total 2');
    expect(r.render()).not.toContain('k="c"');
  });

  it('метрики сервиса: вызовы, биллинг в копейках; портал — псевдоним', () => {
    const m = createSaasMetrics();
    m.toolCall('task_add', 'ok', 0.02);
    m.toolCall('task_add', 'QUOTA_EXCEEDED', 0.001);
    m.billing.payment('succeeded', 99_000);
    m.billing.renewal('failed');
    m.httpResponse('/mcp', 503);
    m.limiterQueue.set({ portal: portalAlias('b24-portal.bitrix24.ru') }, 3);
    const body = m.registry.render();
    expect(body).toContain('mcp_tool_calls_total{tool="task_add",outcome="QUOTA_EXCEEDED"} 1');
    expect(body).toContain('mcp_billing_payments_kopecks_total{status="succeeded"} 99000');
    expect(body).toContain('mcp_billing_renewals_total{result="failed"} 1');
    expect(body).toContain('mcp_http_responses_total{route="/mcp",class="5xx"} 1');
    expect(body).not.toContain('b24-portal');
    expect(() => m.billing.payment('succeeded', 1.5)).toThrow();
  });

  it('повторная регистрация возвращает ту же метрику; другой тип — ошибка', () => {
    const r = new MetricsRegistry();
    expect(r.counter('x_total', 'x')).toBe(r.counter('x_total', 'x'));
    expect(() => r.gauge('x_total', 'x')).toThrow();
    expect(() => r.counter('bad-name', 'x')).toThrow();
  });
});

describe('настройки эксплуатации', () => {
  it('разбор переменных и выбор задач', () => {
    const s = readOpsSettings({
      REDIS_URL: 'redis://:x@r:6379',
      WORKER_TASKS: 'usage.flush, billing.renewals',
      WORKER_TASK_INTERVALS: 'usage.flush=30000',
    });
    expect(s.worker.leaseTtlMs).toBe(15_000);
    const tasks = selectTasks(
      [
        { name: 'usage.flush', intervalMs: 60_000 },
        { name: 'billing.renewals', intervalMs: 3_600_000 },
        { name: 'retention.cleanup', intervalMs: 86_400_000 },
      ],
      s,
    );
    expect(tasks).toEqual([
      { name: 'usage.flush', intervalMs: 30_000 },
      { name: 'billing.renewals', intervalMs: 3_600_000 },
    ]);
    expect(() => readOpsSettings({})).toThrow(/REDIS_URL/);
    expect(() =>
      readOpsSettings({
        REDIS_URL: 'redis://r',
        WORKER_LEASE_TTL_MS: '1000',
        WORKER_RENEW_INTERVAL_MS: '1000',
      }),
    ).toThrow(/меньше/);
    expect(() => readOpsSettings({ REDIS_URL: 'redis://r', WORKER_TASK_INTERVALS: 'x=5' })).toThrow();
  });
});

describe('WorkerRunner (аренда в памяти)', () => {
  it('изоляция ошибок задач, метрики, остановка ждёт задачи и снимает аренду', async () => {
    const lease = new MemoryLeaseStore();
    const metrics = createSaasMetrics();
    let ok = 0;
    const w = new WorkerRunner({
      lease,
      metrics,
      tasks: [
        {
          name: 'good.task',
          intervalMs: 10,
          run: () => {
            ok += 1;
            return Promise.resolve();
          },
        },
        { name: 'bad.task', intervalMs: 10, run: () => Promise.reject(new Error('упала')) },
        {
          name: 'sync.throw',
          intervalMs: 10,
          run: () => {
            throw new Error('сразу');
          },
        },
      ],
      settings: { leaseTtlMs: 300, renewIntervalMs: 50, shutdownGraceMs: 200 },
    });
    w.start();
    await sleep(120);
    expect(w.isLeader()).toBe(true);
    expect(ok).toBeGreaterThan(2);
    const st = w.status();
    expect(st.tasks.find((t) => t.name === 'bad.task')?.failures).toBeGreaterThan(0);
    expect(st.tasks.find((t) => t.name === 'sync.throw')?.failures).toBeGreaterThan(0);
    const body = metrics.registry.render();
    expect(body).toMatch(/mcp_worker_task_runs_total\{task="bad.task",result="error"\} \d+/);
    expect(body).toContain('mcp_worker_leader 1');
    await w.stop();
    expect(metrics.registry.render()).toContain('mcp_worker_leader 0');
    const after = ok;
    await sleep(50);
    expect(ok).toBe(after);
    expect(await lease.tryAcquire('worker:leader', 1000)).toBeTruthy();
  });

  it('неверные задачи отклоняются при создании', () => {
    const lease = new MemoryLeaseStore();
    const run = () => Promise.resolve();
    expect(() => new WorkerRunner({ lease, tasks: [{ name: 'Плохое имя', intervalMs: 1, run }] })).toThrow();
    expect(
      () =>
        new WorkerRunner({
          lease,
          tasks: [
            { name: 'a', intervalMs: 1, run },
            { name: 'a', intervalMs: 1, run },
          ],
        }),
    ).toThrow(/дважды/);
  });
});

/**
 * Запуск процесса режима saas (SaaS-ТЗ §5.1, §13): PROCESS_ROLE=web — HTTP-приложение (src/saas/http.ts);
 * PROCESS_ROLE=worker — задачи с лидером по аренде в Redis (src/saas/worker-tasks.ts) и служебный HTTP
 * (/healthz, /readyz, /metrics) для проверок контейнера и Prometheus.
 */
import { hostname } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from '../config/env.js';
import { renderPrometheus } from './ops/metrics.js';
import type { LeaseStore } from './ops/redis-coordination.js';
import { selectTasks } from './ops/settings.js';
import { MemoryLeaseStore, WorkerRunner } from './ops/worker.js';
import { safeEqualStr, startSaasHttp, type SaasHttpOptions } from './http.js';
import { createSaasRuntime, type SaasRuntime, type SaasRuntimeOptions } from './runtime.js';
import { saasWebHttpOptions, type SaasWebOptions } from './web.js';
import { createWorkerTasks, type WorkerTaskOptions } from './worker-tasks.js';

export interface SaasProcessHandle {
  readonly runtime: SaasRuntime;
  readonly role: 'web' | 'worker';
  readonly port: number;
  readonly worker: WorkerRunner | undefined;
  close(): Promise<void>;
}

const isLeaseStore = (c: unknown): c is LeaseStore =>
  typeof (c as Partial<LeaseStore>).tryAcquire === 'function' &&
  typeof (c as Partial<LeaseStore>).renew === 'function';

/** Служебный HTTP worker: только loopback/внутренняя сеть; /metrics — по тем же правилам, что у web. */
export function buildWorkerHttpApp(rt: SaasRuntime, runner: WorkerRunner): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1024 });
  app.get('/healthz', () => ({ status: 'ok' }));
  app.get('/readyz', async (_req, reply) => {
    const r = await rt.readiness();
    const ready = r.database && r.redis;
    return reply.code(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not-ready',
      leader: runner.isLeader(),
      database: r.database ? 'ok' : 'error',
      redis: r.redis ? 'ok' : 'error',
    });
  });
  app.get('/metrics', (request, reply) => {
    const m0 = /^Bearer\s+(.+)$/i.exec((request.headers.authorization ?? '').trim());
    const tokenOk =
      rt.metricsToken !== undefined && m0?.[1] !== undefined && safeEqualStr(m0[1], rt.metricsToken);
    const remote = request.socket.remoteAddress ?? '';
    const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    if (!tokenOk && !loopback) return reply.code(404).send({ error: 'not_found' });
    const m = renderPrometheus(rt.metrics.registry);
    return reply.header('Content-Type', m.contentType).send(m.body);
  });
  return app;
}

export async function startSaas(
  config: AppConfig,
  opts: SaasRuntimeOptions & {
    http?: SaasHttpOptions;
    /** Кабинет `/app` подключается всегда; сюда — панель владельца и прочие разделы. */
    web?: SaasWebOptions;
    worker?: WorkerTaskOptions;
    host?: string;
    port?: number;
  } = {},
): Promise<SaasProcessHandle> {
  const rt = await createSaasRuntime(config, opts);
  const role = config.deployment.processRole;
  try {
    if (role === 'web') {
      const handle = await startSaasHttp(rt, {
        ...saasWebHttpOptions(rt, opts.web),
        ...opts.http,
        ...(opts.host ? { host: opts.host } : {}),
        ...(opts.port !== undefined ? { port: opts.port } : {}),
      });
      return {
        runtime: rt,
        role,
        port: handle.port,
        worker: undefined,
        async close() {
          await handle.close().catch(() => undefined);
          await rt.close();
        },
      };
    }
    const ops = config.deployment.ops;
    const runner = new WorkerRunner({
      lease: isLeaseStore(rt.coordination) ? rt.coordination : new MemoryLeaseStore(),
      tasks: ops ? selectTasks(createWorkerTasks(rt, opts.worker), ops) : createWorkerTasks(rt, opts.worker),
      ...(ops ? { settings: ops.worker } : {}),
      logger: rt.logger,
      metrics: rt.metrics,
      instanceId: `${hostname()}:${String(process.pid)}`,
    });
    const app = buildWorkerHttpApp(rt, runner);
    await app.listen({ host: opts.host ?? config.server.host, port: opts.port ?? config.server.port });
    const addr = app.server.address();
    runner.start();
    rt.logger.info({ mode: 'saas', role: 'worker' }, 'saas worker started');
    return {
      runtime: rt,
      role,
      port: typeof addr === 'object' && addr ? addr.port : config.server.port,
      worker: runner,
      async close() {
        await runner.stop();
        app.server.closeAllConnections();
        await app.close().catch(() => undefined);
        await rt.close();
      },
    };
  } catch (e) {
    await rt.close();
    throw e;
  }
}

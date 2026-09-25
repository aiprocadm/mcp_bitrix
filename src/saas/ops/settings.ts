/**
 * Настройки эксплуатации (этап S8). env.ts не меняется: сборка режима saas читает переменные через
 * `readOpsSettings(process.env)` (или переносит их в свою схему конфигурации).
 *
 *  REDIS_URL                  — секрет (может содержать пароль): redis://[user:pass@]host:port/db, rediss:// — TLS
 *  REDIS_NAMESPACE            — префикс ключей/каналов (по умолчанию `mcp:`)
 *  REDIS_COMMAND_TIMEOUT_MS   — таймаут команды (по умолчанию 3000)
 *  WORKER_LEASE_TTL_MS        — срок аренды лидера worker (15000)
 *  WORKER_RENEW_INTERVAL_MS   — период продления аренды (5000, < TTL)
 *  WORKER_SHUTDOWN_GRACE_MS   — ожидание задач при SIGTERM (25000; меньше stop_grace_period в compose)
 *  WORKER_TASKS               — включённые задачи через запятую (пусто — все зарегистрированные)
 *  WORKER_TASK_INTERVALS      — переопределение интервалов: `usage.flush=60000,billing.renewals=3600000`
 *  PORTAL_LIMIT_FALLBACK_RPS  — запасной лимит на экземпляр при недоступном Redis (по умолчанию rps/2)
 */
import type { WorkerSettings } from './worker.js';

export interface OpsSettings {
  readonly redisUrl: string;
  readonly redisNamespace: string;
  readonly redisCommandTimeoutMs: number;
  readonly worker: WorkerSettings;
  /** undefined — все задачи. */
  readonly enabledTasks: ReadonlySet<string> | undefined;
  readonly taskIntervals: ReadonlyMap<string, number>;
  readonly portalLimitFallbackRps: number | undefined;
}

/** Имена задач worker по этапам (реализации — в модулях этапов; имена фиксированы для метрик и настроек). */
export const WORKER_TASK_NAMES = {
  usageFlush: 'usage.flush', // S6: сброс счётчиков Redis → PostgreSQL, раз в минуту (§9.2)
  billingRenewals: 'billing.renewals', // S7: рекуррентные списания и переходы §10.2
  appInfo: 'bitrix.app_info', // S3: app.info раз в сутки (§8)
  retention: 'retention.cleanup', // §6.3: аудит 90 дней, данные после окончания подписки, криптоудаление
  dcrCleanup: 'oauth.dcr_cleanup', // S4: неиспользуемые клиенты DCR через 30 дней (§7.1)
  dataDeletion: 'retention.data_deletion', // §6.3: криптоудаление через 30 дней после окончания подписки/удаления приложения
  tokenRefresh: 'bitrix.token_refresh', // §7.3: продление refresh-токенов Bitrix24 до истечения 180 дней
} as const;

function int(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  def: number,
  min: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name}: ожидается целое ≥ ${String(min)}`);
  return n;
}

export function readOpsSettings(env: Readonly<Record<string, string | undefined>>): OpsSettings {
  const redisUrl = env['REDIS_URL'];
  if (!redisUrl) throw new Error('REDIS_URL обязателен в режиме saas');
  const worker: WorkerSettings = {
    leaseKey: 'worker:leader',
    leaseTtlMs: int(env, 'WORKER_LEASE_TTL_MS', 15_000, 1000),
    renewIntervalMs: int(env, 'WORKER_RENEW_INTERVAL_MS', 5_000, 100),
    shutdownGraceMs: int(env, 'WORKER_SHUTDOWN_GRACE_MS', 25_000, 0),
  };
  if (worker.renewIntervalMs >= worker.leaseTtlMs) {
    throw new Error('WORKER_RENEW_INTERVAL_MS должен быть меньше WORKER_LEASE_TTL_MS');
  }
  const tasksRaw = (env['WORKER_TASKS'] ?? '').trim();
  const enabledTasks = tasksRaw
    ? new Set(
        tasksRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      )
    : undefined;
  const taskIntervals = new Map<string, number>();
  for (const pair of (env['WORKER_TASK_INTERVALS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [name, ms] = pair.split('=');
    const n = Number(ms);
    if (!name || !Number.isInteger(n) || n < 1000) {
      throw new Error('WORKER_TASK_INTERVALS: формат имя=мс, интервал ≥ 1000');
    }
    taskIntervals.set(name, n);
  }
  const fb = env['PORTAL_LIMIT_FALLBACK_RPS'];
  const namespace = env['REDIS_NAMESPACE'] ?? 'mcp:';
  if (!/^[A-Za-z0-9_.:-]{1,40}$/.test(namespace))
    throw new Error('REDIS_NAMESPACE: латиница, цифры, _.:- до 40 символов');
  return {
    redisUrl,
    redisNamespace: namespace,
    redisCommandTimeoutMs: int(env, 'REDIS_COMMAND_TIMEOUT_MS', 3000, 100),
    worker,
    enabledTasks,
    taskIntervals,
    portalLimitFallbackRps: fb ? int(env, 'PORTAL_LIMIT_FALLBACK_RPS', 1, 1) : undefined,
  };
}

/** Применить WORKER_TASKS / WORKER_TASK_INTERVALS к списку задач. */
export function selectTasks<T extends { name: string; intervalMs: number }>(
  tasks: readonly T[],
  s: OpsSettings,
): T[] {
  return tasks
    .filter((t) => !s.enabledTasks || s.enabledTasks.has(t.name))
    .map((t) => {
      const ms = s.taskIntervals.get(t.name);
      return ms ? { ...t, intervalMs: ms } : t;
    });
}

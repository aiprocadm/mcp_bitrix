/**
 * Задачи worker режима saas (SaaS-ТЗ §5.1, §6.3, §7.1, §7.3, §8, §9.2, §10.2; имена — WORKER_TASK_NAMES S8).
 * Все задачи идемпотентны (возможно краткое пересечение лидеров, docs/saas/s8-operations.md) и прерываются по signal.
 *
 *  usage.flush          — счётчики учёта Redis → PostgreSQL (раз в минуту)
 *  billing.renewals     — продления/льготный период/остановка (renewDue) и сверка зависших платежей
 *  bitrix.app_info      — app.info каждого работающего портала (раз в сутки)
 *  retention.cleanup    — истёкшие планы/idempotency, зависшие executing → unknown, курсоры, файлы, аудит 90 дней
 *  oauth.dcr_cleanup    — неиспользуемые клиенты DCR, истёкшие коды и refresh, ротация ключа подписи
 *  bitrix.token_refresh — продление refresh-токенов Bitrix24 (живут 180 дней) у пользователей без активности
 */
import { CursorStore } from '../bitrix/pagination.js';
import { OperationsStore } from '../storage/operations.js';
import type { Tenant, TenantStatus } from './repos/tenants.js';
import { WORKER_TASK_NAMES } from './ops/settings.js';
import type { WorkerTask } from './ops/worker.js';
import type { SaasRuntime } from './runtime.js';
import { tenantDeletionFromRuntime } from './tenant-deletion.js';

export interface WorkerTaskOptions {
  /** executing старше этого считается прерванным падением экземпляра (T16 для кластера). По умолчанию 15 мин. */
  readonly staleExecutingMs?: number;
  /** Возраст refresh-токена Bitrix24, после которого worker продлевает пару. По умолчанию 150 дней (из 180). */
  readonly refreshTokenMaxAgeMs?: number;
  readonly now?: () => number;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Все арендаторы с данными статусами, постранично. */
export async function* tenantsWithStatus(
  rt: Pick<SaasRuntime, 'repos'>,
  statuses: readonly TenantStatus[],
  signal?: AbortSignal,
): AsyncGenerator<Tenant> {
  for (const status of statuses) {
    for (let offset = 0; ; offset += 200) {
      if (signal?.aborted) return;
      const page = await rt.repos.tenants.list({ status, limit: 200, offset });
      for (const t of page) yield t;
      if (page.length < 200) break;
    }
  }
}

/** Обслуживание данных одного арендатора (§6.3). Возвращает число затронутых записей по видам. */
export async function retentionCleanup(
  rt: Pick<SaasRuntime, 'db' | 'platform' | 'fileStaging' | 'audit' | 'config'>,
  tenantId: string,
  staleExecutingMs: number,
  now = Date.now(),
): Promise<{ expired: number; unknown: number }> {
  const ops = new OperationsStore(rt.db, tenantId);
  const expired = await ops.expireStale();
  const cutoff = new Date(now - staleExecutingMs).toISOString();
  const unknown = await rt.db.withTenant(tenantId, (x) =>
    x.run(
      "UPDATE operations SET status = 'unknown', finished_at = ? WHERE tenant_id = ? AND status = 'executing' AND executing_at < ?",
      new Date(now).toISOString(),
      tenantId,
      cutoff,
    ),
  );
  await new CursorStore(
    rt.db,
    rt.platform.secretBox,
    rt.config.limits.cursorTtlSeconds,
    tenantId,
  ).cleanupExpired();
  await rt.fileStaging.forTenant(tenantId).cleanupExpired();
  await rt.audit.cleanup(tenantId);
  return { expired, unknown };
}

/**
 * Арендаторы, чьи данные пора удалить (§6.3): подписка остановлена дольше срока хранения (биллинг отметил
 * deletion_requested_at) или приложение удалено с портала дольше срока хранения. Уже удалённые — пропускаются.
 */
export async function tenantsDueForDeletion(rt: SaasRuntime, now: number, limit = 100): Promise<string[]> {
  const before = new Date(now - rt.billing.settings.dataRetentionDays * DAY).toISOString();
  const rows = await rt.db.all<{ id: string }>(
    `SELECT t.id FROM tenants t
      WHERE t.status <> 'deleted'
        AND ((t.status = 'uninstalled' AND t.uninstalled_at IS NOT NULL AND t.uninstalled_at <= ?)
          OR EXISTS (SELECT 1 FROM subscriptions s
                      WHERE s.tenant_id = t.id AND s.deletion_requested_at IS NOT NULL
                        AND s.status IN ('suspended','canceled')))
      ORDER BY t.id LIMIT ?`,
    before,
    limit,
  );
  return rows.map((r) => r.id);
}

export function createWorkerTasks(rt: SaasRuntime, o: WorkerTaskOptions = {}): WorkerTask[] {
  const now = o.now ?? Date.now;
  const log = rt.logger;
  const reason = (e: unknown) => (e instanceof Error ? e.name : 'unknown');
  return [
    {
      name: WORKER_TASK_NAMES.usageFlush,
      intervalMs: rt.billing.settings.usageFlushIntervalMs,
      async run() {
        await rt.billing.usage.flush();
      },
    },
    {
      name: WORKER_TASK_NAMES.billingRenewals,
      intervalMs: 5 * MIN,
      initialDelayMs: 10_000,
      async run(signal) {
        const s = await rt.billing.subscriptions.renewDue();
        for (let i = 0; i < s.charged; i += 1) rt.metrics.billing.renewal('succeeded');
        for (let i = 0; i < s.failed; i += 1) rt.metrics.billing.renewal('failed');
        if (signal.aborted) return;
        await rt.billing.subscriptions.reconcilePending();
      },
    },
    {
      name: WORKER_TASK_NAMES.appInfo,
      intervalMs: DAY,
      initialDelayMs: MIN,
      timeoutMs: 2 * HOUR,
      async run(signal) {
        for await (const t of tenantsWithStatus(rt, ['active', 'suspended'], signal)) {
          if (signal.aborted) return;
          try {
            await rt.bitrix.appStatus.checkAppStatus(t.id);
          } catch (e) {
            log.warn({ tenantId: t.id, reason: reason(e) }, 'app.info task failed for tenant');
          }
        }
      },
    },
    {
      name: WORKER_TASK_NAMES.retention,
      intervalMs: HOUR,
      initialDelayMs: 30_000,
      async run(signal) {
        for await (const t of tenantsWithStatus(rt, ['active', 'suspended', 'uninstalled'], signal)) {
          if (signal.aborted) return;
          try {
            await retentionCleanup(rt, t.id, o.staleExecutingMs ?? 15 * MIN, now());
          } catch (e) {
            log.warn({ tenantId: t.id, reason: reason(e) }, 'retention cleanup failed for tenant');
          }
        }
      },
    },
    {
      name: WORKER_TASK_NAMES.dataDeletion,
      intervalMs: HOUR,
      initialDelayMs: 5 * MIN,
      async run(signal) {
        const deletion = tenantDeletionFromRuntime(rt);
        for (const tenantId of await tenantsDueForDeletion(rt, now())) {
          if (signal.aborted) return;
          try {
            await deletion.deleteAll(tenantId, { actor: 'worker', reason: 'retention-expired' });
          } catch (e) {
            log.warn({ tenantId, reason: reason(e) }, 'tenant data deletion failed');
          }
        }
      },
    },
    {
      name: WORKER_TASK_NAMES.dcrCleanup,
      intervalMs: DAY,
      initialDelayMs: 2 * MIN,
      async run() {
        const r = await rt.oauth.server.runMaintenance();
        log.info({ ...r }, 'oauth maintenance done');
      },
    },
    {
      name: WORKER_TASK_NAMES.tokenRefresh,
      intervalMs: DAY,
      initialDelayMs: 5 * MIN,
      timeoutMs: 2 * HOUR,
      async run(signal) {
        const maxAge = o.refreshTokenMaxAgeMs ?? 150 * DAY;
        for await (const t of tenantsWithStatus(rt, ['active', 'suspended'], signal)) {
          for (const userId of await rt.bitrix.tokens.usersWithTokens(t.id)) {
            if (signal.aborted) return;
            try {
              const stored = await rt.bitrix.tokens.load(t.id, userId);
              if (!stored || now() - Date.parse(stored.refreshIssuedAt) < maxAge) continue;
              // Обновление — тем же single-flight, что и на запросе; отказ помечает пользователя reauth_required.
              const provider = await rt.bitrix.providers.open(t.id, userId);
              await provider.tryRefresh();
            } catch (e) {
              log.warn({ tenantId: t.id, reason: reason(e) }, 'bitrix token renewal failed');
            }
          }
        }
      },
    },
  ];
}

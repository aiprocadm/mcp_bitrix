/**
 * Хуки диспетчера режима saas (SaaS-ТЗ §5.2 п.3–5, §9.2, §9.3, §11.2): подключаются к общему пути вызова
 * инструмента (src/mcp/register-tools.ts `DispatchHooks`); в single не используются.
 *
 *  - tools/list по тарифу: инструмент вне тарифа/выключенного модуля скрыт (`planHiddenReason`, S09);
 *  - перед handler — `EntitlementService.check` (SUBSCRIPTION_INACTIVE, FEATURE_UNAVAILABLE, QUOTA_EXCEEDED);
 *  - учёт «вызова» (D11) — только если вызов дошёл до Bitrix24: слот лимитера портала, взятый внутри вызова
 *    (AsyncLocalStorage — счётчик на вызов, а не на общий клиент портала);
 *  - метрики вызова (исход, длительность);
 *  - APPROVAL_REQUIRED дополняется ссылкой на подтверждение в кабинете и коротким кодом сверки (D12).
 * «Запись» (succeeded/unknown) учитывает наблюдатель MutationExecutor (runtime.ts, `onMutationFinished`).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { PortalLimiter } from '../bitrix/rate-limiter.js';
import type { AppLogger } from '../logging/logger.js';
import type { DispatchHooks } from '../mcp/register-tools.js';
import type { Envelope } from '../mcp/result.js';
import { planHiddenReason, type EntitlementService, type TenantEntitlement } from './billing/entitlements.js';
import type { UsageMeter } from './billing/usage-meter.js';
import type { SaasMetrics } from './ops/metrics.js';

/** Обращения к Bitrix24 внутри текущего вызова инструмента. */
interface BitrixReach {
  calls: number;
}

const reach = new AsyncLocalStorage<BitrixReach>();

/**
 * Лимитер портала, отмечающий обращение к Bitrix24 в текущем вызове: каждый HTTP-запрос BitrixClient
 * берёт слот лимитера непосредственно перед отправкой.
 */
export class ReachCountingLimiter implements PortalLimiter {
  constructor(private readonly inner: PortalLimiter) {}

  async acquire(signal?: AbortSignal): Promise<() => void> {
    const release = await this.inner.acquire(signal);
    const r = reach.getStore();
    if (r) r.calls += 1;
    return release;
  }

  stats(): { active: number; queued: number } {
    return this.inner.stats();
  }
}

// Ссылка и код сверки — единый источник с кабинетом: код в чате должен совпасть с кодом на странице (§11.2).
import { approvalShortCode, approvalUrl } from './cabinet/approval-link.js';

export { approvalShortCode, approvalUrl };

/** APPROVAL_REQUIRED → + approvalUrl, approvalCode и nextAction про кабинет (вместо CLI режима single). */
export function withApprovalUrl(envelope: Envelope, publicBaseUrl: string): Envelope {
  if (envelope.success || envelope.error.code !== 'APPROVAL_REQUIRED') return envelope;
  const d = envelope.error.details;
  const operationId = d.operationId;
  if (!operationId) return envelope;
  const url = approvalUrl(publicBaseUrl, operationId);
  const code = approvalShortCode(operationId);
  const approved = d.status === 'approved';
  return {
    ...envelope,
    error: {
      ...envelope.error,
      details: {
        ...d,
        approvalUrl: url,
        approvalCode: code,
        nextAction: approved
          ? `Вызовите инструмент повторно с теми же параметрами и approvalId=${operationId}`
          : `Покажите пользователю ссылку ${url} (код сверки ${code}): он проверит план и подтвердит в кабинете. ` +
            `После подтверждения повторите вызов с теми же параметрами и approvalId=${operationId}`,
      },
    },
  };
}

export interface SaasHookDeps {
  readonly entitlements: EntitlementService;
  readonly usage: UsageMeter;
  readonly metrics: SaasMetrics;
  readonly publicBaseUrl: string;
  readonly logger: AppLogger;
}

/** Хуки сессии пользователя арендатора. `snapshot` — тариф на момент открытия сессии (для tools/list). */
export function saasDispatchHooks(
  deps: SaasHookDeps,
  session: { readonly tenantId: string; readonly userId: string; readonly snapshot: TenantEntitlement },
): DispatchHooks {
  const { tenantId, userId } = session;
  return {
    hiddenReason(def) {
      const reason = planHiddenReason(def, session.snapshot);
      return reason ? `тариф арендатора: ${reason}` : undefined;
    },
    async beforeHandler(def) {
      await deps.entitlements.check({ tenantId, userId, tool: def });
    },
    async around(call, next) {
      const started = performance.now();
      const r: BitrixReach = { calls: 0 };
      let envelope = await reach.run(r, next);
      if (r.calls > 0) {
        try {
          const ent = await deps.entitlements.load(tenantId);
          await deps.usage.recordCall({
            tenantId,
            userId,
            tool: call.def.name,
            ...(ent.plan ? { limits: ent.plan.limits } : {}),
          });
        } catch (e) {
          // Вызов уже состоялся; потеря учёта не должна превращать ответ в ошибку (Redis недоступен → алерт).
          deps.logger.warn(
            { tenantId, reason: e instanceof Error ? e.name : 'unknown' },
            'usage record failed',
          );
        }
      }
      envelope = withApprovalUrl(envelope, deps.publicBaseUrl);
      deps.metrics.toolCall(
        call.def.name,
        envelope.success ? 'ok' : envelope.error.code,
        (performance.now() - started) / 1000,
      );
      return envelope;
    },
  };
}

/**
 * События биллинга для писем, кабинета и эксплуатации (SaaS-ТЗ §9.3, §10.2, §6.3).
 * Здесь только интерфейс: письма (SMTP) и баннеры кабинета реализуют другие этапы. Реализация не должна
 * бросать исключения наружу — биллинг вызывает её через `safeNotify` и продолжает работу.
 */
import type { AppLogger } from '../../logging/logger.js';
import type { SubscriptionStatus } from '../repos/plans.js';

export type UsageMetric = 'calls' | 'writes';

export interface QuotaThresholdEvent {
  readonly tenantId: string;
  readonly metric: UsageMetric;
  /** Период учёта YYYY-MM. */
  readonly period: string;
  readonly used: number;
  readonly limit: number;
  /** 80 — предупреждение, 100 — квота исчерпана. */
  readonly percent: number;
}

export type SubscriptionEventType =
  | 'payment_succeeded'
  | 'payment_failed'
  | 'trial_ended'
  | 'past_due'
  | 'suspended'
  | 'canceled'
  | 'reactivated'
  | 'plan_changed'
  | 'plan_change_scheduled'
  | 'invoice_paid'
  | 'refunded';

export interface SubscriptionEvent {
  readonly tenantId: string;
  readonly type: SubscriptionEventType;
  readonly status: SubscriptionStatus;
  readonly planCode: string;
  readonly amountKopecks?: number;
  readonly periodEnd?: string;
  /** Остаток попыток списания (past_due). */
  readonly attemptsLeft?: number;
}

export interface DataDeletionDueEvent {
  readonly tenantId: string;
  readonly since: string;
}

export interface BillingNotifier {
  quotaThreshold(e: QuotaThresholdEvent): Promise<void> | void;
  subscriptionEvent(e: SubscriptionEvent): Promise<void> | void;
  /** Подписка остановлена дольше срока хранения: удаление данных выполняет владелец процесса удаления (§14). */
  dataDeletionDue(e: DataDeletionDueEvent): Promise<void> | void;
}

export const NOOP_NOTIFIER: BillingNotifier = {
  quotaThreshold: () => undefined,
  subscriptionEvent: () => undefined,
  dataDeletionDue: () => undefined,
};

export async function safeNotify(logger: AppLogger, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
  } catch (e) {
    logger.warn({ reason: e instanceof Error ? e.name : typeof e }, 'billing notifier failed');
  }
}

/**
 * Жизненный цикл подписки и платежи (SaaS-ТЗ §10, D8–D10).
 *
 * ```
 * trialing ──оплата──► active ──продление ok──► active
 *    │ истёк            │ продление не прошло
 *    └──► suspended     ▼
 *                  past_due (льготный период 7 дней, 3 попытки списания) ──оплата──► active
 *                       │ не оплачено
 *                       ▼
 *                  suspended ──оплата──► active;  30 дней → событие dataDeletionDue (удаление — не здесь)
 * cancel → действует до конца оплаченного периода → canceled (доступ закрыт, срок хранения идёт)
 * ```
 *
 * Правила:
 *  - статус платежа берётся ТОЛЬКО из API провайдера (`getPayment`); уведомление — лишь повод спросить;
 *  - применение платежа идемпотентно: строка платежа и подписка меняются в одной транзакции под FOR UPDATE,
 *    повторное уведомление/повторный запуск worker ничего не меняют;
 *  - способ оплаты и контакт для чека хранятся под DEK арендатора (SecretBox с AAD), в логи не попадают;
 *  - деньги — целые копейки; доплата при повышении — `prorateKopecks` (BigInt).
 */
import { randomUUID } from 'node:crypto';
import { AppError } from '../../errors/app-error.js';
import type { AppLogger } from '../../logging/logger.js';
import type { SqlDb, SqlExecutor } from '../../storage/sql.js';
import type { Coordination } from '../coordination.js';
import type { TenantKeyRing } from '../keyring.js';
import { planAllowsModule, type Plan, type PlansRepo } from '../repos/plans.js';
import type { TenantUsersRepo } from '../repos/tenants.js';
import {
  BillingStore,
  TERMINAL_PAYMENT,
  type InvoiceBuyer,
  type InvoiceRecord,
  type PaymentPurpose,
  type PaymentRecord,
  type SubRecord,
} from './billing-store.js';
import { ENTITLEMENTS_CHANNEL } from './entitlements.js';
import { addDays, addMonths, prorateKopecks } from './money.js';
import { safeNotify, type BillingNotifier, type SubscriptionEvent } from './notifier.js';
import type { PaymentProvider, ProviderPayment, ReceiptInput } from './payment-provider.js';
import type { BillingSettings } from './settings.js';

const pmAad = (tenantId: string) => `payment-method:${tenantId}`;
const contactAad = (tenantId: string) => `receipt-contact:${tenantId}`;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,63}$/;
const PHONE_RE = /^\d{10,15}$/;

export interface ReceiptContact {
  readonly email?: string;
  readonly phone?: string;
}

export interface CheckoutRequest {
  readonly planCode: string;
  readonly contact: ReceiptContact;
  /** Явное согласие на автосписание (галочка в кабинете). Без него продление — только вручную. */
  readonly savePaymentMethod: boolean;
}

export interface CheckoutResult {
  readonly paymentId: string;
  readonly amountKopecks: number;
  readonly confirmationUrl: string | undefined;
  readonly status: PaymentRecord['status'];
}

export type ChangePlanResult =
  | { kind: 'upgraded'; surchargeKopecks: number; paymentId?: string }
  | { kind: 'payment_pending'; surchargeKopecks: number; paymentId: string; confirmationUrl?: string }
  | { kind: 'payment_failed'; surchargeKopecks: number; paymentId: string }
  | { kind: 'scheduled'; effectiveAt: string; warnings: string[] };

export type NotificationResult =
  | { accepted: false; reason: 'UNTRUSTED_SOURCE' | 'MALFORMED' | 'NO_PROVIDER' }
  | { accepted: true; outcome: 'applied' | 'duplicate' | 'pending' | 'unknown_payment' | 'ignored' };

export type ApplyOutcome = 'applied' | 'duplicate' | 'pending';

export interface RenewalSummary {
  processed: number;
  charged: number;
  failed: number;
  suspended: number;
  canceled: number;
  deletionRequested: number;
}

export interface SubscriptionServiceOptions {
  readonly db: SqlDb;
  readonly keys: TenantKeyRing;
  readonly plans: PlansRepo;
  readonly settings: BillingSettings;
  readonly notifier: BillingNotifier;
  readonly logger: AppLogger;
  /** Не задан — онлайн-оплата недоступна (только счета). */
  readonly provider?: PaymentProvider;
  /** Для предупреждений при понижении тарифа (пользователи сверх лимита). */
  readonly users?: TenantUsersRepo;
  /** Блокировки worker и оповещение других экземпляров о смене подписки. */
  readonly coordination?: Coordination;
  readonly now?: () => Date;
}

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${String(d.getUTCFullYear())}`;
};

export class SubscriptionService {
  private readonly now: () => Date;

  constructor(private readonly o: SubscriptionServiceOptions) {
    this.now = o.now ?? (() => new Date());
  }

  private get provider(): PaymentProvider {
    if (!this.o.provider)
      throw new AppError('FEATURE_UNAVAILABLE', 'Онлайн-оплата не настроена; доступна оплата по счёту', {
        reason: 'ONLINE_PAYMENT_UNAVAILABLE',
      });
    return this.o.provider;
  }

  private async plan(code: string, forPurchase: boolean): Promise<Plan> {
    const p = await this.o.plans.get(code);
    if (!p || (forPurchase && (!p.active || p.priceKopecks <= 0)))
      throw new AppError('VALIDATION_ERROR', 'Тариф недоступен для оплаты', { field: 'planCode' });
    return p;
  }

  private async sub(x: SqlExecutor, tenantId: string, lock = false): Promise<SubRecord> {
    const s = await BillingStore.subscription(x, tenantId, lock);
    if (!s) throw new AppError('NOT_FOUND', 'Подписка не найдена', { reason: 'SUBSCRIPTION_NOT_FOUND' });
    return s;
  }

  private async changed(events: SubscriptionEvent[]): Promise<void> {
    const tenants = new Set(events.map((e) => e.tenantId));
    for (const t of tenants) {
      if (this.o.coordination)
        await this.o.coordination.publish(ENTITLEMENTS_CHANNEL, t).catch(() => undefined);
    }
    for (const e of events) await safeNotify(this.o.logger, () => this.o.notifier.subscriptionEvent(e));
  }

  private async encrypt(tenantId: string, value: string, aad: string): Promise<string> {
    const box = await this.o.keys.boxFor(this.o.db, tenantId);
    return box.encrypt(value, aad);
  }

  private async decrypt(tenantId: string, value: string, aad: string): Promise<string> {
    const box = await this.o.keys.boxFor(this.o.db, tenantId);
    return box.decrypt(value, aad);
  }

  private async receiptFor(sub: SubRecord, plan: Plan, start: string, end: string): Promise<ReceiptInput> {
    if (!sub.receiptContactEncrypted)
      throw new AppError('VALIDATION_ERROR', 'Не указан email или телефон для чека', { field: 'contact' });
    const contact = JSON.parse(
      await this.decrypt(sub.tenantId, sub.receiptContactEncrypted, contactAad(sub.tenantId)),
    ) as ReceiptContact;
    return {
      customerContact: contact,
      itemDescription: `Доступ к сервису MCP для Bitrix24, тариф «${plan.name}», период ${fmtDate(start)}–${fmtDate(end)}`,
    };
  }

  /** Начало оплачиваемого периода: действующий оплаченный период продлевается с его конца, иначе — с сейчас. */
  private paidPeriodStart(sub: SubRecord, now: Date): string {
    if (sub.status === 'active' || sub.status === 'past_due') {
      const graceEnd = new Date(sub.periodEnd).getTime() + this.o.settings.graceDays * 86_400_000;
      if (graceEnd > now.getTime()) return sub.periodEnd;
    }
    return now.toISOString();
  }

  // ---------------------------------------------------------------- оформление (первая оплата, возобновление)

  /**
   * Оплата тарифа через страницу провайдера: первая оплата после пробного периода, возобновление после
   * past_due/suspended/canceled, переход с оплаты по счёту на карту. Подписка меняется только после
   * подтверждения статуса через API (уведомление или `syncPayment`).
   */
  async checkout(tenantId: string, req: CheckoutRequest): Promise<CheckoutResult> {
    const provider = this.provider;
    const plan = await this.plan(req.planCode, true);
    const contact = normalizeContact(req.contact);
    const now = this.now();
    const at = now.toISOString();
    const contactEnc = await this.encrypt(tenantId, JSON.stringify(contact), contactAad(tenantId));
    const { sub, row } = await this.o.db.transaction(async (x) => {
      const s = await this.sub(x, tenantId, true);
      await BillingStore.setReceiptContact(x, tenantId, contactEnc, at);
      s.receiptContactEncrypted = contactEnc;
      const id = randomUUID();
      const inserted = await BillingStore.insertPayment(
        x,
        {
          id,
          tenantId,
          provider: provider.name,
          idempotenceKey: id,
          purpose: 'initial',
          planCode: plan.code,
          amountKopecks: plan.priceKopecks,
          currency: 'RUB',
          description: `Подписка «${plan.name}»`,
          periodAnchor: s.periodEnd,
        },
        at,
      );
      if (!inserted) throw new AppError('INTERNAL_ERROR', 'Платёж не создан');
      return { sub: s, row: inserted };
    });
    const start = this.paidPeriodStart(sub, now);
    let p: ProviderPayment;
    try {
      p = await provider.createPayment({
        idempotenceKey: row.idempotenceKey,
        amountKopecks: row.amountKopecks,
        description: `MCP для Bitrix24: тариф «${plan.name}»`,
        receipt: await this.receiptFor(sub, plan, start, addMonths(start, plan.periodMonths)),
        metadata: { tenant_id: tenantId, payment_id: row.id },
        returnUrl: this.o.settings.returnUrl,
        savePaymentMethod: req.savePaymentMethod,
      });
    } catch (e) {
      // Пользователь не получил страницу оплаты — платить по этой попытке нечем; новая попытка — новый платёж.
      await BillingStore.setPaymentStatus(this.o.db, row.id, 'canceled', at);
      throw e;
    }
    await BillingStore.setProviderPaymentId(this.o.db, row.id, p.id, at);
    let status: PaymentRecord['status'] = 'pending';
    if (p.status === 'succeeded' || p.status === 'canceled') {
      await this.apply(row.id, p);
      status = p.status;
    }
    this.o.logger.info({ tenantId, paymentId: row.id }, 'billing checkout created');
    return {
      paymentId: row.id,
      amountKopecks: row.amountKopecks,
      confirmationUrl: p.confirmationUrl,
      status,
    };
  }

  /** Страница возврата из оплаты / сверка: статус из API провайдера. Чужой платёж — как несуществующий. */
  async syncPayment(tenantId: string, paymentId: string): Promise<PaymentRecord['status']> {
    const row = await BillingStore.payment(this.o.db, paymentId);
    if (row?.tenantId !== tenantId)
      throw new AppError('NOT_FOUND', 'Платёж не найден', { reason: 'PAYMENT_NOT_FOUND' });
    if (TERMINAL_PAYMENT.has(row.status) || !row.providerPaymentId) return row.status;
    await this.apply(row.id, await this.provider.getPayment(row.providerPaymentId));
    return (await BillingStore.payment(this.o.db, paymentId))?.status ?? row.status;
  }

  // ---------------------------------------------------------------- уведомления провайдера (§10.1, S10)

  /**
   * Уведомление провайдера: только с документированных адресов; статус ВСЕГДА перепроверяется `getPayment`;
   * неизвестный платёж — журнал и игнор; повтор — идемпотентен. `sourceIp` — адрес отправителя, установленный
   * доверенным обратным прокси (не из произвольного заголовка клиента).
   */
  async handleNotification(body: unknown, sourceIp: string): Promise<NotificationResult> {
    const provider = this.o.provider;
    if (!provider) return { accepted: false, reason: 'NO_PROVIDER' };
    if (!provider.isTrustedSource(sourceIp)) {
      this.o.logger.warn({ reason: 'UNTRUSTED_SOURCE' }, 'billing notification rejected');
      return { accepted: false, reason: 'UNTRUSTED_SOURCE' };
    }
    const n = provider.parseNotification(body);
    if (!n) return { accepted: false, reason: 'MALFORMED' };
    if (n.objectType !== 'payment') {
      this.o.logger.info({ event: n.event }, 'billing notification ignored');
      return { accepted: true, outcome: 'ignored' };
    }
    const row = await BillingStore.paymentByProviderId(this.o.db, provider.name, n.objectId);
    if (!row) {
      this.o.logger.warn(
        { providerPaymentId: n.objectId, event: n.event },
        'billing notification for unknown payment',
      );
      return { accepted: true, outcome: 'unknown_payment' };
    }
    if (TERMINAL_PAYMENT.has(row.status)) return { accepted: true, outcome: 'duplicate' };
    const actual = await provider.getPayment(n.objectId);
    if (actual.id !== n.objectId) throw new AppError('INTERNAL_ERROR', 'Провайдер вернул другой платёж');
    const outcome = await this.apply(row.id, actual);
    return { accepted: true, outcome };
  }

  /**
   * Применение статуса платежа из API к платежу и подписке — одна транзакция, идемпотентно.
   * Сумма и валюта сверяются с созданным платежом; расхождение — журнал, платёж не применяется.
   */
  async apply(localPaymentId: string, actual: ProviderPayment): Promise<ApplyOutcome> {
    const now = this.now();
    const at = now.toISOString();
    const events: SubscriptionEvent[] = [];
    let pmEncrypted: string | undefined;
    const row0 = await BillingStore.payment(this.o.db, localPaymentId);
    if (!row0) throw new AppError('NOT_FOUND', 'Платёж не найден', { reason: 'PAYMENT_NOT_FOUND' });
    if (actual.status === 'succeeded' && actual.paymentMethod?.saved) {
      pmEncrypted = await this.encrypt(row0.tenantId, actual.paymentMethod.id, pmAad(row0.tenantId));
    }
    const plan = await this.o.plans.get(row0.planCode);
    const outcome = await this.o.db.transaction(async (x): Promise<ApplyOutcome> => {
      const row = await BillingStore.payment(x, localPaymentId, true);
      if (!row) throw new AppError('NOT_FOUND', 'Платёж не найден', { reason: 'PAYMENT_NOT_FOUND' });
      if (TERMINAL_PAYMENT.has(row.status)) return 'duplicate';
      if (row.providerPaymentId && row.providerPaymentId !== actual.id)
        throw new AppError('INTERNAL_ERROR', 'Платёж провайдера не совпадает с платежом сервиса');
      if (!row.providerPaymentId) await BillingStore.setProviderPaymentId(x, row.id, actual.id, at);
      if (actual.status === 'pending' || actual.status === 'waiting_for_capture') return 'pending';
      if (actual.amountKopecks !== row.amountKopecks || actual.currency !== row.currency) {
        this.o.logger.error({ paymentId: row.id }, 'billing payment amount mismatch; not applied');
        return 'pending';
      }
      const sub = await this.sub(x, row.tenantId, true);
      if (actual.status === 'canceled') {
        await BillingStore.setPaymentStatus(x, row.id, 'canceled', at);
        if (row.purpose === 'renewal' && sub.periodEnd === row.periodAnchor) {
          const e = this.failRenewal(sub, now);
          await BillingStore.writeSubscription(x, sub, at);
          events.push(...e);
        } else {
          events.push({
            tenantId: sub.tenantId,
            type: 'payment_failed',
            status: sub.status,
            planCode: sub.planCode,
          });
        }
        return 'applied';
      }
      // succeeded
      await BillingStore.setPaymentStatus(x, row.id, 'succeeded', at);
      if (!plan) throw new AppError('INTERNAL_ERROR', 'Тариф платежа не найден');
      if (pmEncrypted) {
        await BillingStore.setPaymentMethod(
          x,
          sub.tenantId,
          pmEncrypted,
          actual.paymentMethod?.title ?? null,
          at,
        );
      }
      events.push(...this.succeed(sub, row, plan, now));
      await BillingStore.writeSubscription(x, sub, at);
      return 'applied';
    });
    if (events.length) await this.changed(events);
    return outcome;
  }

  /** Эффект успешного платежа на подписку (мутирует sub). */
  private succeed(sub: SubRecord, row: PaymentRecord, plan: Plan, now: Date): SubscriptionEvent[] {
    const prev = sub.status;
    const base = { tenantId: sub.tenantId, amountKopecks: row.amountKopecks };
    if (row.purpose === 'upgrade') {
      sub.planCode = plan.code;
      sub.pendingPlanCode = null;
      return [
        { ...base, type: 'plan_changed', status: sub.status, planCode: plan.code, periodEnd: sub.periodEnd },
      ];
    }
    let start: string;
    if (row.purpose === 'renewal') {
      if (sub.periodEnd !== row.periodAnchor) {
        // Период уже продлён (другой платёж/счёт): деньги учтены, подписку второй раз не продлеваем.
        this.o.logger.warn({ paymentId: row.id }, 'billing renewal for stale period');
        return [{ ...base, type: 'payment_succeeded', status: sub.status, planCode: sub.planCode }];
      }
      start = this.paidPeriodStart(sub, now);
    } else {
      start = this.paidPeriodStart(sub, now);
    }
    this.activate(sub, plan, start);
    const events: SubscriptionEvent[] = [
      { ...base, type: 'payment_succeeded', status: 'active', planCode: plan.code, periodEnd: sub.periodEnd },
    ];
    if (prev === 'suspended' || prev === 'canceled' || prev === 'past_due')
      events.push({ tenantId: sub.tenantId, type: 'reactivated', status: 'active', planCode: plan.code });
    return events;
  }

  private activate(sub: SubRecord, plan: Plan, start: string): void {
    sub.planCode = plan.code;
    sub.status = 'active';
    sub.periodStart = start;
    sub.periodEnd = addMonths(start, plan.periodMonths);
    sub.pendingPlanCode = null;
    sub.cancelAtPeriodEnd = false;
    sub.retryCount = 0;
    sub.nextRetryAt = null;
    sub.suspendedAt = null;
    sub.deletionRequestedAt = null;
  }

  /** Неуспешное продление: past_due, следующая попытка по расписанию, после последней — до конца льготы. */
  private failRenewal(sub: SubRecord, now: Date): SubscriptionEvent[] {
    const offsets = this.o.settings.retryOffsetsDays;
    sub.retryCount += 1;
    sub.status = 'past_due';
    const next = offsets[sub.retryCount];
    sub.nextRetryAt =
      next !== undefined ? addDays(sub.periodEnd, next) : addDays(sub.periodEnd, this.o.settings.graceDays);
    if (new Date(sub.nextRetryAt).getTime() < now.getTime() && next !== undefined)
      sub.nextRetryAt = now.toISOString();
    const attemptsLeft = Math.max(0, offsets.length - sub.retryCount);
    return [
      {
        tenantId: sub.tenantId,
        type: 'payment_failed',
        status: 'past_due',
        planCode: sub.planCode,
        attemptsLeft,
      },
      {
        tenantId: sub.tenantId,
        type: 'past_due',
        status: 'past_due',
        planCode: sub.planCode,
        periodEnd: addDays(sub.periodEnd, this.o.settings.graceDays),
        attemptsLeft,
      },
    ];
  }

  // ---------------------------------------------------------------- продление (worker, §10.2, S11)

  /**
   * Задача worker: пробные периоды, продления, повторы списаний, остановка после льготы, события удаления.
   * Каждая подписка — под блокировкой `billing:renew:<арендатор>` (несколько worker не спишут дважды; кроме того,
   * ключ идемпотентности продления детерминирован: период + номер попытки).
   */
  async renewDue(at?: Date, limit = 100): Promise<RenewalSummary> {
    const now = at ?? this.now();
    const summary: RenewalSummary = {
      processed: 0,
      charged: 0,
      failed: 0,
      suspended: 0,
      canceled: 0,
      deletionRequested: 0,
    };
    const tenants = await BillingStore.dueTenants(this.o.db, now.toISOString(), limit);
    for (const tenantId of tenants) {
      try {
        await this.withTenantLock(tenantId, () => this.renewOne(tenantId, now, summary));
        summary.processed += 1;
      } catch (e) {
        this.o.logger.error(
          {
            tenantId,
            reason:
              e instanceof AppError ? (e.details.reason ?? e.code) : e instanceof Error ? e.name : 'unknown',
          },
          'billing renewal failed',
        );
      }
    }
    const before = addDays(now.toISOString(), -this.o.settings.dataRetentionDays);
    for (const d of await BillingStore.deletionDue(this.o.db, before, limit)) {
      if (await BillingStore.markDeletionRequested(this.o.db, d.tenantId, now.toISOString())) {
        summary.deletionRequested += 1;
        await safeNotify(this.o.logger, () => this.o.notifier.dataDeletionDue(d));
      }
    }
    return summary;
  }

  private withTenantLock<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    const c = this.o.coordination;
    return c ? c.withLock(`billing:renew:${tenantId}`, { ttlMs: 120_000, waitMs: 1_000 }, fn) : fn();
  }

  private async renewOne(tenantId: string, now: Date, summary: RenewalSummary): Promise<void> {
    const at = now.toISOString();
    const sub = await this.sub(this.o.db, tenantId);
    const prevStatus = sub.status;
    const t = now.getTime();
    const ended = new Date(sub.periodEnd).getTime() <= t;
    const events: SubscriptionEvent[] = [];
    if (sub.status === 'trialing' && ended) {
      sub.status = 'suspended';
      sub.suspendedAt = at;
      events.push(
        { tenantId, type: 'trial_ended', status: 'suspended', planCode: sub.planCode },
        { tenantId, type: 'suspended', status: 'suspended', planCode: sub.planCode },
      );
      summary.suspended += 1;
    } else if (sub.status === 'active' && ended && sub.cancelAtPeriodEnd) {
      sub.status = 'canceled';
      sub.suspendedAt = at;
      events.push({ tenantId, type: 'canceled', status: 'canceled', planCode: sub.planCode });
      summary.canceled += 1;
    } else if (
      sub.status === 'past_due' &&
      t >= new Date(sub.periodEnd).getTime() + this.o.settings.graceDays * 86_400_000
    ) {
      sub.status = 'suspended';
      sub.suspendedAt = at;
      sub.nextRetryAt = null;
      events.push({ tenantId, type: 'suspended', status: 'suspended', planCode: sub.planCode });
      summary.suspended += 1;
    } else if ((sub.status === 'active' && ended) || sub.status === 'past_due') {
      const r = await this.charge(sub, now);
      if (r === 'succeeded') summary.charged += 1;
      if (r === 'canceled') summary.failed += 1;
      return;
    } else {
      return;
    }
    const applied = await this.o.db.transaction(async (x) => {
      const cur = await this.sub(x, tenantId, true);
      // Состояние изменилось, пока решали (оплата пришла параллельно) — ничего не делаем.
      if (cur.status !== prevStatus || cur.periodEnd !== sub.periodEnd) return false;
      await BillingStore.writeSubscription(x, { ...cur, ...pickState(sub) }, at);
      return true;
    });
    if (applied) await this.changed(events);
  }

  /** Попытка списания продления сохранённым способом (или сверка уже созданной попытки). */
  private async charge(sub: SubRecord, now: Date): Promise<'succeeded' | 'canceled' | 'pending' | 'skipped'> {
    const at = now.toISOString();
    const planCode = sub.pendingPlanCode ?? sub.planCode;
    const plan = await this.o.plans.get(planCode);
    if (!plan) throw new AppError('INTERNAL_ERROR', 'Тариф подписки не найден');
    if (plan.priceKopecks === 0) {
      // Бесплатный тариф (назначен владельцем): продление без платежа.
      await this.o.db.transaction(async (x) => {
        const cur = await this.sub(x, sub.tenantId, true);
        if (cur.periodEnd !== sub.periodEnd) return;
        this.activate(cur, plan, cur.periodEnd);
        await BillingStore.writeSubscription(x, cur, at);
      });
      return 'succeeded';
    }
    const provider = this.o.provider;
    if (!provider || !sub.paymentMethodEncrypted) {
      // Нечем списать: past_due без попыток; по окончании льготы — suspended.
      if (sub.status === 'past_due') return 'skipped';
      const events = await this.o.db.transaction(async (x) => {
        const cur = await this.sub(x, sub.tenantId, true);
        if (cur.status !== 'active' || cur.periodEnd !== sub.periodEnd) return [];
        cur.retryCount = this.o.settings.retryOffsetsDays.length - 1;
        const e = this.failRenewal(cur, now);
        await BillingStore.writeSubscription(x, cur, at);
        return e;
      });
      await this.changed(events);
      return 'canceled';
    }
    const key = `ren:${sub.tenantId}:${String(new Date(sub.periodEnd).getTime())}:${String(sub.retryCount)}`;
    let row = await BillingStore.paymentByKey(this.o.db, key);
    if (row && TERMINAL_PAYMENT.has(row.status)) return 'skipped';
    if (!row) {
      row = await BillingStore.insertPayment(
        this.o.db,
        {
          id: randomUUID(),
          tenantId: sub.tenantId,
          provider: provider.name,
          idempotenceKey: key,
          purpose: 'renewal' satisfies PaymentPurpose,
          planCode: plan.code,
          amountKopecks: plan.priceKopecks,
          currency: 'RUB',
          description: `Продление подписки «${plan.name}»`,
          periodAnchor: sub.periodEnd,
        },
        at,
      );
      row ??= await BillingStore.paymentByKey(this.o.db, key);
      if (!row) throw new AppError('INTERNAL_ERROR', 'Платёж продления не создан');
    }
    let actual: ProviderPayment;
    try {
      if (row.providerPaymentId) {
        actual = await provider.getPayment(row.providerPaymentId);
      } else {
        const start = sub.periodEnd;
        actual = await provider.chargeSaved({
          idempotenceKey: key,
          amountKopecks: row.amountKopecks,
          description: `MCP для Bitrix24: продление «${plan.name}»`,
          receipt: await this.receiptFor(sub, plan, start, addMonths(start, plan.periodMonths)),
          metadata: { tenant_id: sub.tenantId, payment_id: row.id },
          paymentMethodId: await this.decrypt(sub.tenantId, sub.paymentMethodEncrypted, pmAad(sub.tenantId)),
        });
      }
    } catch (e) {
      const err = AppError.from(e);
      if (err.code === 'VALIDATION_ERROR' || err.code === 'NOT_FOUND') {
        // Провайдер отклонил запрос (например, способ оплаты больше недействителен) — неуспешная попытка.
        const events = await this.o.db.transaction(async (x) => {
          const cur = await this.sub(x, sub.tenantId, true);
          const r = await BillingStore.payment(x, row.id, true);
          if (!r || TERMINAL_PAYMENT.has(r.status) || cur.periodEnd !== row.periodAnchor) return [];
          await BillingStore.setPaymentStatus(x, row.id, 'canceled', at);
          const ev = this.failRenewal(cur, now);
          await BillingStore.writeSubscription(x, cur, at);
          return ev;
        });
        await this.changed(events);
        return 'canceled';
      }
      // Недоступность провайдера: исход неизвестен — повтор с тем же ключом позже (не второе списание).
      throw err;
    }
    const outcome = await this.apply(row.id, actual);
    if (outcome === 'pending') return 'pending';
    return actual.status === 'succeeded' ? 'succeeded' : 'canceled';
  }

  /** Сверка «зависших» платежей со статусом из API (worker): уведомление могло не дойти. */
  async reconcilePending(olderThanMs = 5 * 60_000, limit = 100): Promise<number> {
    const provider = this.o.provider;
    if (!provider) return 0;
    const before = new Date(this.now().getTime() - olderThanMs).toISOString();
    let n = 0;
    for (const row of await BillingStore.pendingPayments(this.o.db, before, limit)) {
      if (!row.providerPaymentId || row.provider !== provider.name) continue;
      try {
        if ((await this.apply(row.id, await provider.getPayment(row.providerPaymentId))) === 'applied')
          n += 1;
      } catch (e) {
        this.o.logger.warn(
          { paymentId: row.id, reason: e instanceof Error ? e.name : 'unknown' },
          'billing reconcile failed',
        );
      }
    }
    return n;
  }

  // ---------------------------------------------------------------- отмена и смена тарифа

  /** Отмена: подписка действует до конца оплаченного периода, затем canceled. */
  async cancel(tenantId: string): Promise<void> {
    const at = this.now().toISOString();
    const events = await this.o.db.transaction(async (x): Promise<SubscriptionEvent[]> => {
      const s = await this.sub(x, tenantId, true);
      if (s.status === 'active') {
        s.cancelAtPeriodEnd = true;
        await BillingStore.writeSubscription(x, s, at);
        return [];
      }
      if (s.status === 'past_due') {
        s.status = 'canceled';
        s.suspendedAt = at;
        s.nextRetryAt = null;
        await BillingStore.writeSubscription(x, s, at);
        return [{ tenantId, type: 'canceled', status: 'canceled', planCode: s.planCode }];
      }
      throw new AppError('VALIDATION_ERROR', 'Отменять нечего: подписка не оплачена', { status: s.status });
    });
    await this.changed(events);
  }

  /**
   * Приложение удалено с портала (SaaS-ТЗ §4 сценарий 6, §10.2 «uninstalled»): списания останавливаются сразу.
   * Подписка в работе (trialing/active/past_due) → canceled с отметкой остановки (отсчёт 30 дней хранения §6.3,
   * затем dataDeletionDue); сохранённый способ оплаты стирается — автосписаний после удаления нет. Повторный
   * вызов (повтор события Bitrix24) ничего не меняет. Остаток оплаченного периода не возвращается автоматически:
   * возврат — вручную владельцем (`refund`). При переустановке пробный период не повторяется (§9.1) — нужна оплата.
   */
  async stopForUninstall(tenantId: string): Promise<{ stopped: boolean }> {
    const at = this.now().toISOString();
    const events = await this.o.db.transaction(async (x): Promise<SubscriptionEvent[]> => {
      const s = await BillingStore.subscription(x, tenantId, true);
      if (!s) return [];
      const hadMethod = s.paymentMethodEncrypted !== null;
      if (hadMethod) {
        await x.run(
          'UPDATE subscriptions SET payment_method_encrypted = NULL, payment_method_title = NULL, updated_at = ? WHERE tenant_id = ?',
          at,
          tenantId,
        );
      }
      if (s.status === 'suspended' || s.status === 'canceled') return [];
      s.status = 'canceled';
      s.cancelAtPeriodEnd = false;
      s.pendingPlanCode = null;
      s.nextRetryAt = null;
      s.suspendedAt = at;
      await BillingStore.writeSubscription(x, s, at);
      return [{ tenantId, type: 'canceled', status: 'canceled', planCode: s.planCode }];
    });
    await this.changed(events);
    if (events.length) this.o.logger.info({ tenantId }, 'subscription stopped: app uninstalled');
    return { stopped: events.length > 0 };
  }

  /** Отказ от отмены до конца периода. */
  async resume(tenantId: string): Promise<void> {
    const at = this.now().toISOString();
    await this.o.db.transaction(async (x) => {
      const s = await this.sub(x, tenantId, true);
      if (s.status !== 'active' || !s.cancelAtPeriodEnd)
        throw new AppError('VALIDATION_ERROR', 'Подписка не отменена', { status: s.status });
      s.cancelAtPeriodEnd = false;
      await BillingStore.writeSubscription(x, s, at);
    });
  }

  /**
   * Смена тарифа (§10.2): повышение — сразу, с доплатой пропорционально остатку периода (сохранённым способом
   * или через страницу оплаты); понижение и смена длительности периода — с начала следующего периода,
   * с предупреждениями, если текущее использование не укладывается в новый тариф.
   */
  async changePlan(tenantId: string, planCode: string): Promise<ChangePlanResult> {
    const target = await this.plan(planCode, false);
    if (!target.active) throw new AppError('VALIDATION_ERROR', 'Тариф недоступен', { field: 'planCode' });
    const now = this.now();
    const at = now.toISOString();
    const sub = await this.sub(this.o.db, tenantId);
    if (sub.status !== 'active')
      throw new AppError(
        'VALIDATION_ERROR',
        'Сменить тариф можно у оплаченной подписки; иначе оформите оплату',
        {
          status: sub.status,
          nextAction: `Оплатите выбранный тариф в кабинете: ${this.o.settings.cabinetUrl}/billing`,
        },
      );
    if (target.code === sub.planCode && !sub.pendingPlanCode)
      throw new AppError('VALIDATION_ERROR', 'Этот тариф уже действует', { field: 'planCode' });
    const current = await this.plan(sub.planCode, false);
    const isUpgrade =
      target.priceKopecks > current.priceKopecks && target.periodMonths === current.periodMonths;
    if (!isUpgrade) {
      const warnings: string[] = [];
      if (this.o.users) {
        const active = await this.o.users.countActive(tenantId);
        if (active > target.limits.users)
          warnings.push(
            `Активных пользователей ${String(active)}, в тарифе «${target.name}» — ${String(target.limits.users)}: лишние будут отключены`,
          );
      }
      const lost = current.modules.includes('*')
        ? target.modules.includes('*')
          ? []
          : ['все модули вне тарифа']
        : current.modules.filter((m) => !planAllowsModule(target, m));
      if (lost.length) warnings.push(`Станут недоступны модули: ${lost.join(', ')}`);
      if (current.destructiveAllowed && !target.destructiveAllowed)
        warnings.push('Удаления станут недоступны');
      await this.o.db.transaction(async (x) => {
        const s = await this.sub(x, tenantId, true);
        s.pendingPlanCode = target.code === s.planCode ? null : target.code;
        await BillingStore.writeSubscription(x, s, at);
      });
      await this.changed([
        {
          tenantId,
          type: 'plan_change_scheduled',
          status: sub.status,
          planCode: target.code,
          periodEnd: sub.periodEnd,
        },
      ]);
      return { kind: 'scheduled', effectiveAt: sub.periodEnd, warnings };
    }
    const periodMs = new Date(sub.periodEnd).getTime() - new Date(sub.periodStart).getTime();
    const remainingMs = new Date(sub.periodEnd).getTime() - now.getTime();
    const surcharge = prorateKopecks(target.priceKopecks - current.priceKopecks, remainingMs, periodMs);
    if (surcharge === 0) {
      await this.o.db.transaction(async (x) => {
        const s = await this.sub(x, tenantId, true);
        s.planCode = target.code;
        s.pendingPlanCode = null;
        await BillingStore.writeSubscription(x, s, at);
      });
      await this.changed([{ tenantId, type: 'plan_changed', status: 'active', planCode: target.code }]);
      return { kind: 'upgraded', surchargeKopecks: 0 };
    }
    const provider = this.provider;
    const id = randomUUID();
    const row = await BillingStore.insertPayment(
      this.o.db,
      {
        id,
        tenantId,
        provider: provider.name,
        idempotenceKey: `upg:${id}`,
        purpose: 'upgrade',
        planCode: target.code,
        amountKopecks: surcharge,
        currency: 'RUB',
        description: `Доплата за переход на «${target.name}»`,
        periodAnchor: sub.periodEnd,
      },
      at,
    );
    if (!row) throw new AppError('INTERNAL_ERROR', 'Платёж не создан');
    const base = {
      idempotenceKey: row.idempotenceKey,
      amountKopecks: surcharge,
      description: `MCP для Bitrix24: переход на «${target.name}»`,
      receipt: await this.receiptFor(sub, target, at, sub.periodEnd),
      metadata: { tenant_id: tenantId, payment_id: row.id },
    };
    const p = sub.paymentMethodEncrypted
      ? await provider.chargeSaved({
          ...base,
          paymentMethodId: await this.decrypt(tenantId, sub.paymentMethodEncrypted, pmAad(tenantId)),
        })
      : await provider.createPayment({
          ...base,
          returnUrl: this.o.settings.returnUrl,
          savePaymentMethod: false,
        });
    await BillingStore.setProviderPaymentId(this.o.db, row.id, p.id, at);
    if (p.status === 'succeeded' || p.status === 'canceled') {
      await this.apply(row.id, p);
      return p.status === 'succeeded'
        ? { kind: 'upgraded', surchargeKopecks: surcharge, paymentId: row.id }
        : { kind: 'payment_failed', surchargeKopecks: surcharge, paymentId: row.id };
    }
    return {
      kind: 'payment_pending',
      surchargeKopecks: surcharge,
      paymentId: row.id,
      ...(p.confirmationUrl ? { confirmationUrl: p.confirmationUrl } : {}),
    };
  }

  // ---------------------------------------------------------------- счета юрлицам и ручные операции владельца

  /** Счёт юрлицу/ИП (§10.1): номер, реквизиты покупателя из формы кабинета, сумма тарифа. */
  async issueInvoice(tenantId: string, planCode: string, buyer: InvoiceBuyer): Promise<InvoiceRecord> {
    const plan = await this.plan(planCode, true);
    const clean = validateBuyer(buyer);
    const now = this.now();
    return this.o.db.transaction(async (x) => {
      await this.sub(x, tenantId);
      const seq = await BillingStore.nextInvoiceNumber(x);
      const inv: InvoiceRecord = {
        id: randomUUID(),
        tenantId,
        number: `MCP-${String(now.getUTCFullYear())}-${String(seq).padStart(6, '0')}`,
        planCode: plan.code,
        amountKopecks: plan.priceKopecks,
        buyer: clean,
        status: 'issued',
        createdAt: now.toISOString(),
        paidAt: null,
        markedBy: null,
      };
      await BillingStore.insertInvoice(x, inv);
      return inv;
    });
  }

  async invoices(tenantId: string): Promise<InvoiceRecord[]> {
    return BillingStore.invoices(this.o.db, tenantId);
  }

  async invoice(tenantId: string, id: string): Promise<InvoiceRecord> {
    const inv = await BillingStore.invoice(this.o.db, id);
    if (inv?.tenantId !== tenantId) throw new AppError('NOT_FOUND', 'Счёт не найден');
    return inv;
  }

  /**
   * Ручная отметка оплаты счёта владельцем (панель §11.3): запись в support_actions и активация подписки —
   * одной транзакцией; повторная отметка ничего не меняет.
   */
  async markInvoicePaid(
    invoiceId: string,
    by: { actor: string; reason: string },
  ): Promise<{ alreadyPaid: boolean }> {
    if (!by.actor.trim() || !by.reason.trim())
      throw new AppError('VALIDATION_ERROR', 'Укажите, кто и на каком основании отмечает оплату', {
        field: 'reason',
      });
    const now = this.now();
    const at = now.toISOString();
    const events: SubscriptionEvent[] = [];
    const res = await this.o.db.transaction(async (x) => {
      const inv = await BillingStore.invoice(x, invoiceId, true);
      if (!inv) throw new AppError('NOT_FOUND', 'Счёт не найден');
      if (inv.status === 'paid') return { alreadyPaid: true };
      if (inv.status !== 'issued') throw new AppError('CONFLICT', 'Счёт аннулирован');
      const plan = await this.plan(inv.planCode, false);
      const sub = await this.sub(x, inv.tenantId, true);
      const prev = sub.status;
      await BillingStore.markInvoicePaid(x, inv.id, by.actor, at);
      await BillingStore.supportAction(
        x,
        {
          actor: by.actor,
          tenantId: inv.tenantId,
          action: 'invoice.mark_paid',
          reason: by.reason,
          details: {
            invoiceId: inv.id,
            number: inv.number,
            amountKopecks: inv.amountKopecks,
            planCode: inv.planCode,
          },
        },
        at,
      );
      this.activate(sub, plan, this.paidPeriodStart(sub, now));
      await BillingStore.writeSubscription(x, sub, at);
      events.push({
        tenantId: inv.tenantId,
        type: 'invoice_paid',
        status: 'active',
        planCode: plan.code,
        amountKopecks: inv.amountKopecks,
        periodEnd: sub.periodEnd,
      });
      if (prev === 'suspended' || prev === 'canceled' || prev === 'past_due')
        events.push({ tenantId: inv.tenantId, type: 'reactivated', status: 'active', planCode: plan.code });
      return { alreadyPaid: false };
    });
    await this.changed(events);
    return res;
  }

  /** Возврат — только вручную владельцем (§10.2), с записью в журнал. Подписку не меняет. */
  async refund(
    paymentId: string,
    amountKopecks: number,
    by: { actor: string; reason: string },
  ): Promise<{ refundId: string; status: string }> {
    const provider = this.provider;
    if (!Number.isSafeInteger(amountKopecks) || amountKopecks <= 0)
      throw new AppError('VALIDATION_ERROR', 'Сумма возврата — целое число копеек больше нуля', {
        field: 'amount',
      });
    if (!by.actor.trim() || !by.reason.trim())
      throw new AppError('VALIDATION_ERROR', 'Укажите, кто и на каком основании делает возврат', {
        field: 'reason',
      });
    const row = await BillingStore.payment(this.o.db, paymentId);
    if (!row?.providerPaymentId) throw new AppError('NOT_FOUND', 'Платёж не найден');
    if (row.status !== 'succeeded') throw new AppError('CONFLICT', 'Вернуть можно только успешный платёж');
    if (amountKopecks > row.amountKopecks - row.refundedKopecks)
      throw new AppError('VALIDATION_ERROR', 'Сумма возврата больше остатка платежа', { field: 'amount' });
    const r = await provider.refund({
      idempotenceKey: `ref:${randomUUID()}`,
      paymentId: row.providerPaymentId,
      amountKopecks,
      description: `Возврат по платежу ${row.id}`,
    });
    const at = this.now().toISOString();
    await this.o.db.transaction(async (x) => {
      if (r.status !== 'canceled') {
        const full = row.refundedKopecks + amountKopecks >= row.amountKopecks;
        await BillingStore.addRefund(x, row.id, amountKopecks, full, at);
      }
      await BillingStore.supportAction(
        x,
        {
          actor: by.actor,
          tenantId: row.tenantId,
          action: 'payment.refund',
          reason: by.reason,
          details: { paymentId: row.id, refundId: r.id, amountKopecks, status: r.status },
        },
        at,
      );
    });
    await this.changed([
      { tenantId: row.tenantId, type: 'refunded', status: 'active', planCode: row.planCode, amountKopecks },
    ]);
    return { refundId: r.id, status: r.status };
  }

  /** Платежи арендатора для кабинета (без идентификаторов способа оплаты). */
  async payments(tenantId: string, limit = 50): Promise<PaymentRecord[]> {
    return BillingStore.payments(this.o.db, tenantId, limit);
  }
}

function pickState(s: SubRecord): Partial<SubRecord> {
  return { status: s.status, suspendedAt: s.suspendedAt, nextRetryAt: s.nextRetryAt };
}

function normalizeContact(c: ReceiptContact): ReceiptContact {
  const email = c.email?.trim().toLowerCase();
  const phone = c.phone?.replace(/[\s()+-]/g, '');
  if (email && !EMAIL_RE.test(email))
    throw new AppError('VALIDATION_ERROR', 'Некорректный email для чека', { field: 'contact.email' });
  if (phone && !PHONE_RE.test(phone))
    throw new AppError('VALIDATION_ERROR', 'Телефон для чека — 10–15 цифр', { field: 'contact.phone' });
  if (!email && !phone)
    throw new AppError('VALIDATION_ERROR', 'Укажите email или телефон для чека', { field: 'contact' });
  return { ...(email ? { email } : {}), ...(phone ? { phone } : {}) };
}

function validateBuyer(b: InvoiceBuyer): InvoiceBuyer {
  const name = b.name.trim();
  if (!name || name.length > 300)
    throw new AppError('VALIDATION_ERROR', 'Укажите наименование покупателя', { field: 'buyer.name' });
  if (!/^(\d{10}|\d{12})$/.test(b.inn))
    throw new AppError('VALIDATION_ERROR', 'ИНН покупателя — 10 или 12 цифр', { field: 'buyer.inn' });
  if (b.kpp !== undefined && b.kpp !== '' && !/^\d{9}$/.test(b.kpp))
    throw new AppError('VALIDATION_ERROR', 'КПП — 9 цифр', { field: 'buyer.kpp' });
  if (b.email !== undefined && b.email !== '' && !EMAIL_RE.test(b.email.trim()))
    throw new AppError('VALIDATION_ERROR', 'Некорректный email', { field: 'buyer.email' });
  const address = b.address?.trim();
  if (address && address.length > 500)
    throw new AppError('VALIDATION_ERROR', 'Адрес слишком длинный', { field: 'buyer.address' });
  return {
    name,
    inn: b.inn,
    ...(b.kpp ? { kpp: b.kpp } : {}),
    ...(address ? { address } : {}),
    ...(b.email ? { email: b.email.trim() } : {}),
  };
}

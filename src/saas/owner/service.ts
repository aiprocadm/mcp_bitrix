/**
 * Операции панели владельца (SaaS-ТЗ §11.3, §4, D15): обзор арендаторов, платежей и метрик и ручные действия.
 *
 * Что видит владелец — только метаданные: домен портала, тариф, статусы, числа учёта, КОДЫ ошибок из аудита
 * (без целей, аргументов, хешей и тел), платежи и счета. Токены Bitrix24, планы/результаты операций, данные
 * порталов, способ оплаты и контакт для чека сюда не читаются вовсе (D15: инструмента «посмотреть данные клиента» нет).
 *
 * Каталог (tenants, subscriptions, plans, payments, invoices, usage_counters, support_actions, announcements) —
 * без RLS; таблицы арендатора (tenant_users, audit) читаются только через `withTenant(id)` — как в репозиториях,
 * роль БД та же, без BYPASSRLS.
 *
 * Каждое действие пишет `support_actions` (кто, что, у какого арендатора, основание) — в той же транзакции,
 * что и изменение; отметка оплаты счёта и возврат — внутри SubscriptionService (там же журнал).
 */
import { AppError, ERROR_CODES } from '../../errors/app-error.js';
import type { AppLogger } from '../../logging/logger.js';
import { toNumber, type SqlDb, type SqlExecutor } from '../../storage/sql.js';
import { BillingStore, type InvoiceRecord, type PaymentRecord } from '../billing/billing-store.js';
import { ENTITLEMENTS_CHANNEL, type EntitlementService } from '../billing/entitlements.js';
import type { SubscriptionService } from '../billing/subscription-service.js';
import { publishInvalidate } from '../bitrix/invalidation.js';
import type { Coordination } from '../coordination.js';
import type { MetricsRegistry } from '../ops/metrics.js';
import type { Plan, PlansRepo, Subscription, SubscriptionsRepo } from '../repos/plans.js';
import type { Tenant, TenantStatus, TenantsRepo } from '../repos/tenants.js';
import type { OwnerRole, OwnerUser } from './accounts.js';
import {
  Announcements,
  validateAnnouncement,
  type Announcement,
  type AnnouncementInput,
} from './announcements.js';

const DAY_MS = 86_400_000;
const KNOWN_CODES: ReadonlySet<string> = new Set(ERROR_CODES);
const TENANT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const MAX_TRIAL_EXTENSION_DAYS = 90;

export interface ErrorCount {
  code: string;
  count: number;
}

export interface TenantOverview {
  id: string;
  domain: string;
  status: TenantStatus;
  installedAt: string;
  planCode: string | null;
  planName: string | null;
  subscriptionStatus: Subscription['status'] | null;
  periodEnd: string | null;
  activeUsers: number;
  callsMonth: number;
  writesMonth: number;
  errors7d: ErrorCount[];
}

export interface SupportActionView {
  id: number;
  actor: string;
  tenantId: string | null;
  domain: string | null;
  action: string;
  reason: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface TenantDetail {
  tenant: Tenant;
  subscription: Subscription | undefined;
  plan: Plan | undefined;
  users: { active: number; disabled: number; reauth: number };
  usage: { month: string; calls: number; writes: number };
  errors7d: ErrorCount[];
  errors30d: ErrorCount[];
  payments: PaymentRecord[];
  invoices: InvoiceView[];
  actions: SupportActionView[];
}

/** Счёт для панели: реквизиты покупателя (юрлицо) — только наименование и ИНН. */
export interface InvoiceView {
  id: string;
  tenantId: string;
  domain: string | null;
  number: string;
  planCode: string;
  amountKopecks: number;
  buyerName: string;
  buyerInn: string;
  status: InvoiceRecord['status'];
  createdAt: string;
  paidAt: string | null;
  markedBy: string | null;
}

export interface PaymentView extends PaymentRecord {
  domain: string | null;
}

export interface MetricsSummary {
  generatedAt: string;
  tenantsByStatus: Record<string, number>;
  subscriptionsByStatus: Record<string, number>;
  /** Ежемесячная выручка по действующим оплаченным подпискам (active/past_due), копейки. */
  mrrKopecks: number;
  payments30d: { status: string; count: number; amountKopecks: number; refundedKopecks: number }[];
  invoicesIssued: number;
  usageMonth: { month: string; calls: number; writes: number };
  /** Метрики этого процесса (реестр S8): вызовы по исходу, HTTP 5xx, продления. Undefined — реестр не передан. */
  process:
    | {
        toolCallsByOutcome: { outcome: string; count: number }[];
        http5xx: number;
        renewals: Record<string, number>;
      }
    | undefined;
}

export interface OwnerServiceOptions {
  readonly db: SqlDb;
  readonly tenants: TenantsRepo;
  readonly plans: PlansRepo;
  readonly subscriptions: SubscriptionsRepo;
  readonly billing: SubscriptionService;
  readonly coordination: Coordination;
  /** Отзыв доступа арендатора (§7.4): refresh-токены, поколение, неисполненные операции (`OAuthServer.revokeTenant`). */
  readonly revokeTenant: (tenantId: string) => Promise<{ refreshRevoked: number; operationsDenied: number }>;
  /** Кэш прав этого экземпляра (остальные — по событию `billing:entitlements`). */
  readonly entitlements?: EntitlementService;
  readonly metrics?: MetricsRegistry;
  readonly logger: AppLogger;
  readonly now?: () => Date;
}

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : String(v));

function monthOf(d: Date): string {
  return `${String(d.getUTCFullYear())}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function requireReason(reason: string): string {
  const r = reason.trim();
  if (r.length < 3 || r.length > 500)
    throw new AppError('VALIDATION_ERROR', 'Укажите основание действия (3–500 символов)', {
      field: 'reason',
    });
  return r;
}

function requireRole(actor: OwnerUser, role: OwnerRole): void {
  if (role === 'service_owner' && actor.role !== 'service_owner')
    throw new AppError('ACCESS_DENIED', 'Действие доступно только владельцу сервиса', {
      reason: 'OWNER_ROLE_REQUIRED',
    });
}

function tenantIdOrThrow(id: string): string {
  if (!TENANT_ID_RE.test(id)) throw new AppError('NOT_FOUND', 'Арендатор не найден');
  return id;
}

/** Разбор текстового формата Prometheus (только нужные ряды; без внешних пакетов). */
export function parsePrometheus(
  text: string,
): { name: string; labels: Record<string, string>; value: number }[] {
  const out: { name: string; labels: Record<string, string>; value: number }[] = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})? (\S+)$/.exec(line);
    if (!m?.[1]) continue;
    const labels: Record<string, string> = {};
    for (const lm of (m[2] ?? '').matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g))
      if (lm[1]) labels[lm[1]] = (lm[2] ?? '').replace(/\\(.)/g, (_s, c: string) => (c === 'n' ? '\n' : c));
    const value = Number(m[3]);
    if (Number.isFinite(value)) out.push({ name: m[1], labels, value });
  }
  return out;
}

export class OwnerService {
  private readonly now: () => Date;

  constructor(private readonly o: OwnerServiceOptions) {
    this.now = o.now ?? (() => new Date());
  }

  // ------------------------------------------------------------------ чтение

  /** Коды ошибок аудита арендатора с момента since (только коды из закрытого набора, остальное — `other`). */
  private async errorCounts(tenantId: string, since: string): Promise<ErrorCount[]> {
    const rows = await this.o.db.withTenant(tenantId, (x) =>
      x.all<{ error_code: string; n: unknown }>(
        `SELECT error_code, COUNT(*) AS n FROM audit
         WHERE tenant_id = ? AND ts >= ? AND error_code IS NOT NULL GROUP BY error_code`,
        tenantId,
        since,
      ),
    );
    const acc = new Map<string, number>();
    for (const r of rows) {
      const code = KNOWN_CODES.has(r.error_code) ? r.error_code : 'other';
      acc.set(code, (acc.get(code) ?? 0) + toNumber(r.n));
    }
    return [...acc]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
  }

  private async userCounts(tenantId: string): Promise<{ active: number; disabled: number; reauth: number }> {
    const rows = await this.o.db.withTenant(tenantId, (x) =>
      x.all<{ status: string; n: unknown }>(
        'SELECT status, COUNT(*) AS n FROM tenant_users WHERE tenant_id = ? GROUP BY status',
        tenantId,
      ),
    );
    const get = (s: string) => toNumber(rows.find((r) => r.status === s)?.n);
    return { active: get('active'), disabled: get('disabled'), reauth: get('reauth_required') };
  }

  private async usageMonth(tenantId: string, month: string): Promise<{ calls: number; writes: number }> {
    const r = await this.o.db.get<{ calls: unknown; writes: unknown }>(
      'SELECT COALESCE(SUM(calls), 0) AS calls, COALESCE(SUM(writes), 0) AS writes FROM usage_counters WHERE tenant_id = ? AND period = ?',
      tenantId,
      month,
    );
    return { calls: toNumber(r?.calls), writes: toNumber(r?.writes) };
  }

  async listTenants(opts: {
    status?: TenantStatus | undefined;
    q?: string | undefined;
    limit: number;
    offset: number;
  }): Promise<TenantOverview[]> {
    const params: (string | number)[] = [];
    const where: string[] = [];
    if (opts.status) {
      where.push('t.status = ?');
      params.push(opts.status);
    }
    const q = opts.q?.trim().toLowerCase();
    if (q) {
      where.push("t.domain LIKE ? ESCAPE '\\'");
      params.push(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    const rows = await this.o.db.all<Row>(
      `SELECT t.id, t.domain, t.status, t.installed_at, s.plan_code, s.status AS sub_status, s.period_end, p.name AS plan_name
       FROM tenants t LEFT JOIN subscriptions s ON s.tenant_id = t.id LEFT JOIN plans p ON p.code = s.plan_code
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY t.created_at DESC LIMIT ? OFFSET ?`,
      ...params,
      Math.min(Math.max(opts.limit, 1), 200),
      Math.max(opts.offset, 0),
    );
    const now = this.now();
    const month = monthOf(now);
    const since = new Date(now.getTime() - 7 * DAY_MS).toISOString();
    const out: TenantOverview[] = [];
    for (const r of rows) {
      const id = str(r['id']);
      const usage = await this.usageMonth(id, month);
      out.push({
        id,
        domain: str(r['domain']),
        status: str(r['status']) as TenantStatus,
        installedAt: str(r['installed_at']),
        planCode: r['plan_code'] ? str(r['plan_code']) : null,
        planName: r['plan_name'] ? str(r['plan_name']) : null,
        subscriptionStatus: r['sub_status'] ? (str(r['sub_status']) as Subscription['status']) : null,
        periodEnd: r['period_end'] ? str(r['period_end']) : null,
        activeUsers: (await this.userCounts(id)).active,
        callsMonth: usage.calls,
        writesMonth: usage.writes,
        errors7d: await this.errorCounts(id, since),
      });
    }
    return out;
  }

  async tenantDetail(id: string): Promise<TenantDetail> {
    const tenant = await this.o.tenants.get(tenantIdOrThrow(id));
    if (!tenant) throw new AppError('NOT_FOUND', 'Арендатор не найден');
    const subscription = await this.o.subscriptions.get(id);
    const plan = subscription ? await this.o.plans.get(subscription.planCode) : undefined;
    const now = this.now();
    const month = monthOf(now);
    return {
      tenant,
      subscription,
      plan,
      users: await this.userCounts(id),
      usage: { month, ...(await this.usageMonth(id, month)) },
      errors7d: await this.errorCounts(id, new Date(now.getTime() - 7 * DAY_MS).toISOString()),
      errors30d: await this.errorCounts(id, new Date(now.getTime() - 30 * DAY_MS).toISOString()),
      payments: await BillingStore.payments(this.o.db, id, 20),
      invoices: (await BillingStore.invoices(this.o.db, id)).map((i) => invoiceView(i, tenant.domain)),
      actions: await this.supportLog({ tenantId: id, limit: 50 }),
    };
  }

  async recentPayments(limit = 100): Promise<PaymentView[]> {
    const rows = await this.o.db.all<Row>(
      `SELECT p.*, t.domain FROM payments p LEFT JOIN tenants t ON t.id = p.tenant_id
       ORDER BY p.created_at DESC LIMIT ?`,
      Math.min(Math.max(limit, 1), 500),
    );
    return rows.map((r) => ({
      id: str(r['id']),
      tenantId: str(r['tenant_id']),
      provider: str(r['provider']),
      providerPaymentId: r['provider_payment_id'] ? str(r['provider_payment_id']) : null,
      idempotenceKey: str(r['idempotence_key']),
      purpose: str(r['purpose']) as PaymentRecord['purpose'],
      planCode: str(r['plan_code']),
      amountKopecks: toNumber(r['amount_kopecks']),
      currency: str(r['currency']),
      status: str(r['status']) as PaymentRecord['status'],
      description: str(r['description']),
      periodAnchor: r['period_anchor'] ? str(r['period_anchor']) : null,
      refundedKopecks: toNumber(r['refunded_kopecks']),
      createdAt: str(r['created_at']),
      processedAt: r['processed_at'] ? str(r['processed_at']) : null,
      domain: r['domain'] ? str(r['domain']) : null,
    }));
  }

  async recentInvoices(limit = 100): Promise<InvoiceView[]> {
    const rows = await this.o.db.all<Row>(
      `SELECT i.id, i.tenant_id, t.domain FROM invoices i LEFT JOIN tenants t ON t.id = i.tenant_id
       ORDER BY CASE i.status WHEN 'issued' THEN 0 ELSE 1 END, i.created_at DESC LIMIT ?`,
      Math.min(Math.max(limit, 1), 500),
    );
    const out: InvoiceView[] = [];
    for (const r of rows) {
      const inv = await BillingStore.invoice(this.o.db, str(r['id']));
      if (inv) out.push(invoiceView(inv, r['domain'] ? str(r['domain']) : null));
    }
    return out;
  }

  async supportLog(opts: { tenantId?: string; limit: number }): Promise<SupportActionView[]> {
    const rows = opts.tenantId
      ? await this.o.db.all<Row>(
          `SELECT a.*, t.domain FROM support_actions a LEFT JOIN tenants t ON t.id = a.tenant_id
           WHERE a.tenant_id = ? ORDER BY a.id DESC LIMIT ?`,
          opts.tenantId,
          opts.limit,
        )
      : await this.o.db.all<Row>(
          `SELECT a.*, t.domain FROM support_actions a LEFT JOIN tenants t ON t.id = a.tenant_id
           ORDER BY a.id DESC LIMIT ?`,
          opts.limit,
        );
    return rows.map((r) => {
      let details: Record<string, unknown>;
      try {
        details = JSON.parse(str(r['details_json'])) as Record<string, unknown>;
      } catch {
        details = {};
      }
      return {
        id: toNumber(r['id']),
        actor: str(r['actor']),
        tenantId: r['tenant_id'] ? str(r['tenant_id']) : null,
        domain: r['domain'] ? str(r['domain']) : null,
        action: str(r['action']),
        reason: str(r['reason']),
        details,
        createdAt: str(r['created_at']),
      };
    });
  }

  async listPlans(): Promise<Plan[]> {
    return this.o.plans.list({ publicOnly: false });
  }

  async announcements(): Promise<Announcement[]> {
    return Announcements.list(this.o.db);
  }

  async metricsSummary(): Promise<MetricsSummary> {
    const now = this.now();
    const month = monthOf(now);
    const tenants = await this.o.db.all<{ status: string; n: unknown }>(
      'SELECT status, COUNT(*) AS n FROM tenants GROUP BY status',
    );
    const subs = await this.o.db.all<{ status: string; n: unknown }>(
      'SELECT status, COUNT(*) AS n FROM subscriptions GROUP BY status',
    );
    const paid = await this.o.db.all<{ price_kopecks: unknown; period_months: unknown; n: unknown }>(
      `SELECT p.price_kopecks, p.period_months, COUNT(*) AS n FROM subscriptions s JOIN plans p ON p.code = s.plan_code
       WHERE s.status IN ('active','past_due') GROUP BY p.price_kopecks, p.period_months`,
    );
    const pay = await this.o.db.all<{ status: string; n: unknown; amount: unknown; refunded: unknown }>(
      `SELECT status, COUNT(*) AS n, COALESCE(SUM(amount_kopecks), 0) AS amount, COALESCE(SUM(refunded_kopecks), 0) AS refunded
       FROM payments WHERE created_at >= ? GROUP BY status ORDER BY status`,
      new Date(now.getTime() - 30 * DAY_MS).toISOString(),
    );
    const inv = await this.o.db.get<{ n: unknown }>(
      "SELECT COUNT(*) AS n FROM invoices WHERE status = 'issued'",
    );
    const usage = await this.o.db.get<{ calls: unknown; writes: unknown }>(
      'SELECT COALESCE(SUM(calls), 0) AS calls, COALESCE(SUM(writes), 0) AS writes FROM usage_counters WHERE period = ?',
      month,
    );
    const toRecord = (rows: { status: string; n: unknown }[]) =>
      Object.fromEntries(rows.map((r) => [r.status, toNumber(r.n)]));
    let process: MetricsSummary['process'];
    if (this.o.metrics) {
      const samples = parsePrometheus(this.o.metrics.render());
      const byOutcome = new Map<string, number>();
      let http5xx = 0;
      const renewals: Record<string, number> = {};
      for (const s of samples) {
        if (s.name === 'mcp_tool_calls_total') {
          const k = s.labels['outcome'] ?? 'other';
          byOutcome.set(k, (byOutcome.get(k) ?? 0) + s.value);
        } else if (s.name === 'mcp_http_responses_total' && s.labels['class'] === '5xx') http5xx += s.value;
        else if (s.name === 'mcp_billing_renewals_total')
          renewals[s.labels['result'] ?? 'other'] = (renewals[s.labels['result'] ?? 'other'] ?? 0) + s.value;
      }
      process = {
        toolCallsByOutcome: [...byOutcome]
          .map(([outcome, count]) => ({ outcome, count }))
          .sort((a, b) => b.count - a.count),
        http5xx,
        renewals,
      };
    }
    return {
      generatedAt: now.toISOString(),
      tenantsByStatus: toRecord(tenants),
      subscriptionsByStatus: toRecord(subs),
      mrrKopecks: paid.reduce(
        (sum, r) =>
          sum +
          Math.floor(toNumber(r.price_kopecks) / Math.max(1, toNumber(r.period_months))) * toNumber(r.n),
        0,
      ),
      payments30d: pay.map((r) => ({
        status: r.status,
        count: toNumber(r.n),
        amountKopecks: toNumber(r.amount),
        refundedKopecks: toNumber(r.refunded),
      })),
      invoicesIssued: toNumber(inv?.n),
      usageMonth: { month, calls: toNumber(usage?.calls), writes: toNumber(usage?.writes) },
      process,
    };
  }

  // ------------------------------------------------------------------ действия

  private async record(
    x: SqlExecutor,
    actor: OwnerUser,
    tenantId: string | null,
    action: string,
    reason: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    await BillingStore.supportAction(
      x,
      { actor: actor.name, tenantId, action, reason, details: { role: actor.role, ...details } },
      this.now().toISOString(),
    );
  }

  /** Сброс кэша прав арендатора на всех экземплярах и контекстов арендатора (TenantScopeRegistry). */
  private async entitlementsChanged(tenantIds: readonly string[]): Promise<void> {
    for (const t of tenantIds) {
      this.o.entitlements?.invalidate(t);
      await this.o.coordination.publish(ENTITLEMENTS_CHANNEL, t).catch(() => undefined);
    }
  }

  /** Вход/выход и прочие события учётной записи владельца — тоже в журнал. */
  async recordAccountEvent(actor: OwnerUser, action: 'owner.login' | 'owner.logout'): Promise<void> {
    await this.record(this.o.db, actor, null, action, action === 'owner.login' ? 'вход' : 'выход', {});
  }

  /**
   * Продление пробного периода (support и владелец): пробная подписка (или остановленная по окончании пробного
   * периода) получает +days дней от max(сейчас, конец периода) и снова работает.
   */
  async extendTrial(
    actor: OwnerUser,
    tenantIdRaw: string,
    days: number,
    reasonRaw: string,
  ): Promise<{ periodEnd: string }> {
    const tenantId = tenantIdOrThrow(tenantIdRaw);
    const reason = requireReason(reasonRaw);
    if (!Number.isSafeInteger(days) || days < 1 || days > MAX_TRIAL_EXTENSION_DAYS)
      throw new AppError('VALIDATION_ERROR', `Продление — от 1 до ${String(MAX_TRIAL_EXTENSION_DAYS)} дней`, {
        field: 'days',
      });
    const now = this.now();
    const at = now.toISOString();
    const res = await this.o.db.transaction(async (x) => {
      const t = await x.get<{ status: string }>(
        'SELECT status FROM tenants WHERE id = ? FOR UPDATE',
        tenantId,
      );
      if (!t) throw new AppError('NOT_FOUND', 'Арендатор не найден');
      if (t.status === 'uninstalled' || t.status === 'deleted')
        throw new AppError('CONFLICT', 'Приложение удалено с портала: продлевать нечего', {
          status: t.status,
        });
      const sub = await BillingStore.subscription(x, tenantId, true);
      if (!sub) throw new AppError('NOT_FOUND', 'Подписка не найдена');
      const plan = await this.o.plans.get(sub.planCode);
      const trialPlan = plan?.priceKopecks === 0;
      if (!(sub.status === 'trialing' || (sub.status === 'suspended' && trialPlan)))
        throw new AppError('CONFLICT', 'Продлить можно только пробный период', { status: sub.status });
      const before = sub.periodEnd;
      const base = Math.max(now.getTime(), Date.parse(sub.periodEnd));
      sub.periodEnd = new Date(base + days * DAY_MS).toISOString();
      sub.status = 'trialing';
      sub.suspendedAt = null;
      sub.deletionRequestedAt = null;
      sub.nextRetryAt = null;
      sub.retryCount = 0;
      await BillingStore.writeSubscription(x, sub, at);
      await this.record(x, actor, tenantId, 'trial.extend', reason, {
        days,
        periodEndBefore: before,
        periodEndAfter: sub.periodEnd,
      });
      return { periodEnd: sub.periodEnd };
    });
    await this.entitlementsChanged([tenantId]);
    return res;
  }

  /**
   * Блокировка арендатора владельцем (§12 п.7): статус `suspended` (верификатор токенов сразу отказывает),
   * затем отзыв доступа (§7.4: refresh-токены, поколение, неисполненные операции) и сброс кэшей экземпляров.
   * Данные арендатора не удаляются.
   */
  async blockTenant(
    actor: OwnerUser,
    tenantIdRaw: string,
    reasonRaw: string,
  ): Promise<{ refreshRevoked: number; operationsDenied: number }> {
    requireRole(actor, 'service_owner');
    const tenantId = tenantIdOrThrow(tenantIdRaw);
    const reason = requireReason(reasonRaw);
    const at = this.now().toISOString();
    const changed = await this.o.db.run(
      "UPDATE tenants SET status = 'suspended', updated_at = ? WHERE id = ? AND status = 'active'",
      at,
      tenantId,
    );
    if (changed !== 1) {
      const t = await this.o.tenants.get(tenantId);
      if (!t) throw new AppError('NOT_FOUND', 'Арендатор не найден');
      throw new AppError('CONFLICT', 'Заблокировать можно только работающего арендатора', {
        status: t.status,
      });
    }
    let revoked = { refreshRevoked: 0, operationsDenied: 0 };
    let revokeError: string | undefined;
    try {
      revoked = await this.o.revokeTenant(tenantId);
    } catch (e) {
      revokeError = AppError.from(e).code;
      this.o.logger.error({ tenantId, reason: revokeError }, 'owner block: revoke failed');
    }
    await this.record(this.o.db, actor, tenantId, 'tenant.block', reason, {
      ...revoked,
      ...(revokeError ? { revokeError } : {}),
    });
    await publishInvalidate(this.o.coordination, tenantId).catch(() => undefined);
    await this.entitlementsChanged([tenantId]);
    if (revokeError)
      throw new AppError(
        'INTERNAL_ERROR',
        'Арендатор заблокирован, но отзыв токенов не завершён — повторите',
        {
          reason: revokeError,
        },
      );
    return revoked;
  }

  async unblockTenant(actor: OwnerUser, tenantIdRaw: string, reasonRaw: string): Promise<void> {
    requireRole(actor, 'service_owner');
    const tenantId = tenantIdOrThrow(tenantIdRaw);
    const reason = requireReason(reasonRaw);
    await this.o.db.transaction(async (x) => {
      const n = await x.run(
        "UPDATE tenants SET status = 'active', updated_at = ? WHERE id = ? AND status = 'suspended'",
        this.now().toISOString(),
        tenantId,
      );
      if (n !== 1) {
        const t = await x.get<{ status: string }>('SELECT status FROM tenants WHERE id = ?', tenantId);
        if (!t) throw new AppError('NOT_FOUND', 'Арендатор не найден');
        throw new AppError('CONFLICT', 'Арендатор не заблокирован', { status: t.status });
      }
      await this.record(x, actor, tenantId, 'tenant.unblock', reason, {});
    });
    await publishInvalidate(this.o.coordination, tenantId).catch(() => undefined);
    await this.entitlementsChanged([tenantId]);
  }

  /** Отметка оплаты счёта юрлица (§10.1): журнал и активация подписки — в SubscriptionService одной транзакцией. */
  async markInvoicePaid(
    actor: OwnerUser,
    invoiceId: string,
    reasonRaw: string,
  ): Promise<{ alreadyPaid: boolean }> {
    requireRole(actor, 'service_owner');
    if (!UUID_RE.test(invoiceId)) throw new AppError('NOT_FOUND', 'Счёт не найден');
    return this.o.billing.markInvoicePaid(invoiceId, { actor: actor.name, reason: requireReason(reasonRaw) });
  }

  /**
   * Возврат (§10.2) — через провайдера; успешный возврат журналирует SubscriptionService. Неудача (отказ
   * провайдера, проверка суммы) тоже попадает в журнал — с кодом ошибки, без текста провайдера.
   */
  async refund(
    actor: OwnerUser,
    paymentId: string,
    amountKopecks: number,
    reasonRaw: string,
  ): Promise<{ refundId: string; status: string }> {
    requireRole(actor, 'service_owner');
    const reason = requireReason(reasonRaw);
    if (!UUID_RE.test(paymentId)) throw new AppError('NOT_FOUND', 'Платёж не найден');
    try {
      return await this.o.billing.refund(paymentId, amountKopecks, { actor: actor.name, reason });
    } catch (e) {
      const err = AppError.from(e);
      const p = await BillingStore.payment(this.o.db, paymentId);
      if (p)
        await this.record(this.o.db, actor, p.tenantId, 'payment.refund_failed', reason, {
          paymentId,
          amountKopecks: Number.isSafeInteger(amountKopecks) ? amountKopecks : null,
          errorCode: err.code,
        });
      throw err;
    }
  }

  /** Правка тарифа (D10): цены и лимиты — данные; прежние и новые значения — в журнал. */
  async savePlan(actor: OwnerUser, plan: Plan, reasonRaw: string): Promise<void> {
    requireRole(actor, 'service_owner');
    const reason = requireReason(reasonRaw);
    const before = await this.o.plans.get(plan.code);
    await this.o.plans.upsert(plan);
    await this.record(this.o.db, actor, null, before ? 'plan.update' : 'plan.create', reason, {
      code: plan.code,
      before: before ?? null,
      after: plan,
    });
    const affected = await this.o.db.all<{ tenant_id: string }>(
      'SELECT tenant_id FROM subscriptions WHERE plan_code = ? OR pending_plan_code = ?',
      plan.code,
      plan.code,
    );
    await this.entitlementsChanged(affected.map((r) => r.tenant_id));
  }

  async createAnnouncement(actor: OwnerUser, input: AnnouncementInput): Promise<number> {
    requireRole(actor, 'service_owner');
    const a = validateAnnouncement(input);
    if (a.tenantId !== null) {
      tenantIdOrThrow(a.tenantId);
      if (!(await this.o.tenants.get(a.tenantId))) throw new AppError('NOT_FOUND', 'Арендатор не найден');
    }
    const at = this.now().toISOString();
    return this.o.db.transaction(async (x) => {
      const id = await Announcements.insert(x, a, actor.name, at);
      await this.record(x, actor, a.tenantId, 'announcement.create', 'публикация объявления', {
        id,
        level: a.level,
        title: a.title,
        startsAt: a.startsAt,
        endsAt: a.endsAt,
      });
      return id;
    });
  }

  async deactivateAnnouncement(actor: OwnerUser, id: number): Promise<void> {
    requireRole(actor, 'service_owner');
    const at = this.now().toISOString();
    await this.o.db.transaction(async (x) => {
      const a = Number.isSafeInteger(id) ? await Announcements.get(x, id) : undefined;
      if (!a) throw new AppError('NOT_FOUND', 'Объявление не найдено');
      if (!(await Announcements.deactivate(x, id, at)))
        throw new AppError('CONFLICT', 'Объявление уже снято');
      await this.record(x, actor, a.tenantId, 'announcement.deactivate', 'снятие объявления', { id });
    });
  }
}

function invoiceView(i: InvoiceRecord, domain: string | null): InvoiceView {
  return {
    id: i.id,
    tenantId: i.tenantId,
    domain,
    number: i.number,
    planCode: i.planCode,
    amountKopecks: i.amountKopecks,
    buyerName: i.buyer.name,
    buyerInn: i.buyer.inn,
    status: i.status,
    createdAt: i.createdAt,
    paidAt: i.paidAt,
    markedBy: i.markedBy,
  };
}

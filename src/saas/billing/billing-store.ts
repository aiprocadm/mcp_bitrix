/**
 * SQL биллинга поверх `SqlExecutor` — чтобы изменения платежа и подписки шли в ОДНОЙ транзакции
 * (идемпотентность уведомлений и продлений, SaaS-ТЗ §10.1). Таблицы — каталог без RLS (§6.2);
 * каждый запрос арендатора содержит `tenant_id = ?`.
 */
import { toNumber, type SqlExecutor } from '../../storage/sql.js';
import type { SubscriptionStatus } from '../repos/plans.js';

export type PaymentPurpose = 'initial' | 'renewal' | 'upgrade';
export type PaymentStatus = 'pending' | 'waiting_for_capture' | 'succeeded' | 'canceled' | 'refunded';

export interface SubRecord {
  tenantId: string;
  planCode: string;
  status: SubscriptionStatus;
  periodStart: string;
  periodEnd: string;
  cancelAtPeriodEnd: boolean;
  pendingPlanCode: string | null;
  paymentMethodEncrypted: string | null;
  paymentMethodTitle: string | null;
  receiptContactEncrypted: string | null;
  retryCount: number;
  nextRetryAt: string | null;
  suspendedAt: string | null;
  deletionRequestedAt: string | null;
}

export interface PaymentRecord {
  id: string;
  tenantId: string;
  provider: string;
  providerPaymentId: string | null;
  idempotenceKey: string;
  purpose: PaymentPurpose;
  planCode: string;
  amountKopecks: number;
  currency: string;
  status: PaymentStatus;
  description: string;
  periodAnchor: string | null;
  refundedKopecks: number;
  createdAt: string;
  processedAt: string | null;
}

export interface InvoiceBuyer {
  name: string;
  inn: string;
  kpp?: string;
  address?: string;
  email?: string;
}

export interface InvoiceRecord {
  id: string;
  tenantId: string;
  number: string;
  planCode: string;
  amountKopecks: number;
  buyer: InvoiceBuyer;
  status: 'issued' | 'paid' | 'canceled';
  createdAt: string;
  paidAt: string | null;
  markedBy: string | null;
}

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : String(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : str(v));

const toSub = (r: Row): SubRecord => ({
  tenantId: str(r['tenant_id']),
  planCode: str(r['plan_code']),
  status: str(r['status']) as SubscriptionStatus,
  periodStart: str(r['period_start']),
  periodEnd: str(r['period_end']),
  cancelAtPeriodEnd: toNumber(r['cancel_at_period_end']) === 1,
  pendingPlanCode: strOrNull(r['pending_plan_code']),
  paymentMethodEncrypted: strOrNull(r['payment_method_encrypted']),
  paymentMethodTitle: strOrNull(r['payment_method_title']),
  receiptContactEncrypted: strOrNull(r['receipt_contact_encrypted']),
  retryCount: toNumber(r['retry_count']),
  nextRetryAt: strOrNull(r['next_retry_at']),
  suspendedAt: strOrNull(r['suspended_at']),
  deletionRequestedAt: strOrNull(r['deletion_requested_at']),
});

const toPayment = (r: Row): PaymentRecord => ({
  id: str(r['id']),
  tenantId: str(r['tenant_id']),
  provider: str(r['provider']),
  providerPaymentId: strOrNull(r['provider_payment_id']),
  idempotenceKey: str(r['idempotence_key']),
  purpose: str(r['purpose']) as PaymentPurpose,
  planCode: str(r['plan_code']),
  amountKopecks: toNumber(r['amount_kopecks']),
  currency: str(r['currency']),
  status: str(r['status']) as PaymentStatus,
  description: str(r['description']),
  periodAnchor: strOrNull(r['period_anchor']),
  refundedKopecks: toNumber(r['refunded_kopecks']),
  createdAt: str(r['created_at']),
  processedAt: strOrNull(r['processed_at']),
});

const toInvoice = (r: Row): InvoiceRecord => ({
  id: str(r['id']),
  tenantId: str(r['tenant_id']),
  number: str(r['number']),
  planCode: str(r['plan_code']),
  amountKopecks: toNumber(r['amount_kopecks']),
  buyer: JSON.parse(str(r['buyer_json'])) as InvoiceBuyer,
  status: str(r['status']) as InvoiceRecord['status'],
  createdAt: str(r['created_at']),
  paidAt: strOrNull(r['paid_at']),
  markedBy: strOrNull(r['marked_by']),
});

export const TERMINAL_PAYMENT: ReadonlySet<PaymentStatus> = new Set(['succeeded', 'canceled', 'refunded']);

export const BillingStore = {
  async subscription(x: SqlExecutor, tenantId: string, lock = false): Promise<SubRecord | undefined> {
    const r = await x.get<Row>(
      `SELECT * FROM subscriptions WHERE tenant_id = ?${lock ? ' FOR UPDATE' : ''}`,
      tenantId,
    );
    return r ? toSub(r) : undefined;
  },

  /** Запись состояния подписки (способ оплаты и контакт чека — отдельными методами). */
  async writeSubscription(x: SqlExecutor, s: SubRecord, at: string): Promise<void> {
    await x.run(
      `UPDATE subscriptions SET plan_code = ?, status = ?, period_start = ?, period_end = ?, cancel_at_period_end = ?,
         pending_plan_code = ?, retry_count = ?, next_retry_at = ?, suspended_at = ?, deletion_requested_at = ?, updated_at = ?
       WHERE tenant_id = ?`,
      s.planCode,
      s.status,
      s.periodStart,
      s.periodEnd,
      s.cancelAtPeriodEnd ? 1 : 0,
      s.pendingPlanCode,
      s.retryCount,
      s.nextRetryAt,
      s.suspendedAt,
      s.deletionRequestedAt,
      at,
      s.tenantId,
    );
  },

  async setPaymentMethod(
    x: SqlExecutor,
    tenantId: string,
    encrypted: string,
    title: string | null,
    at: string,
  ): Promise<void> {
    await x.run(
      'UPDATE subscriptions SET payment_method_encrypted = ?, payment_method_title = ?, updated_at = ? WHERE tenant_id = ?',
      encrypted,
      title,
      at,
      tenantId,
    );
  },

  async setReceiptContact(x: SqlExecutor, tenantId: string, encrypted: string, at: string): Promise<void> {
    await x.run(
      'UPDATE subscriptions SET receipt_contact_encrypted = ?, updated_at = ? WHERE tenant_id = ?',
      encrypted,
      at,
      tenantId,
    );
  },

  /** Подписки, которым пора что-то сделать (worker): конец пробного/оплаченного периода, повтор списания. */
  async dueTenants(x: SqlExecutor, at: string, limit: number): Promise<string[]> {
    const rows = await x.all<{ tenant_id: string }>(
      `SELECT tenant_id FROM subscriptions
       WHERE (status IN ('trialing','active') AND period_end <= ?)
          OR (status = 'past_due' AND (next_retry_at IS NULL OR next_retry_at <= ?))
       ORDER BY period_end LIMIT ?`,
      at,
      at,
      limit,
    );
    return rows.map((r) => r.tenant_id);
  },

  /** Остановленные дольше срока хранения, событие удаления ещё не отправлено (§6.3). */
  async deletionDue(
    x: SqlExecutor,
    before: string,
    limit: number,
  ): Promise<{ tenantId: string; since: string }[]> {
    const rows = await x.all<{ tenant_id: string; suspended_at: string }>(
      `SELECT tenant_id, suspended_at FROM subscriptions
       WHERE status IN ('suspended','canceled') AND suspended_at IS NOT NULL AND suspended_at <= ?
         AND deletion_requested_at IS NULL ORDER BY suspended_at LIMIT ?`,
      before,
      limit,
    );
    return rows.map((r) => ({ tenantId: r.tenant_id, since: r.suspended_at }));
  },

  async markDeletionRequested(x: SqlExecutor, tenantId: string, at: string): Promise<boolean> {
    const n = await x.run(
      'UPDATE subscriptions SET deletion_requested_at = ?, updated_at = ? WHERE tenant_id = ? AND deletion_requested_at IS NULL',
      at,
      at,
      tenantId,
    );
    return n === 1;
  },

  /** Новый платёж; конфликт ключа идемпотентности — undefined (платёж уже создан другим процессом). */
  async insertPayment(
    x: SqlExecutor,
    p: Omit<PaymentRecord, 'refundedKopecks' | 'processedAt' | 'createdAt' | 'status' | 'providerPaymentId'>,
    at: string,
  ): Promise<PaymentRecord | undefined> {
    const n = await x.run(
      `INSERT INTO payments (id, tenant_id, provider, provider_payment_id, idempotence_key, purpose, plan_code, amount_kopecks,
         currency, status, description, period_anchor, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?) ON CONFLICT (idempotence_key) DO NOTHING`,
      p.id,
      p.tenantId,
      p.provider,
      p.idempotenceKey,
      p.purpose,
      p.planCode,
      p.amountKopecks,
      p.currency,
      p.description,
      p.periodAnchor,
      at,
      at,
    );
    return n === 1 ? BillingStore.payment(x, p.id) : undefined;
  },

  async payment(x: SqlExecutor, id: string, lock = false): Promise<PaymentRecord | undefined> {
    const r = await x.get<Row>(`SELECT * FROM payments WHERE id = ?${lock ? ' FOR UPDATE' : ''}`, id);
    return r ? toPayment(r) : undefined;
  },

  async paymentByKey(x: SqlExecutor, key: string): Promise<PaymentRecord | undefined> {
    const r = await x.get<Row>('SELECT * FROM payments WHERE idempotence_key = ?', key);
    return r ? toPayment(r) : undefined;
  },

  async paymentByProviderId(
    x: SqlExecutor,
    provider: string,
    providerPaymentId: string,
    lock = false,
  ): Promise<PaymentRecord | undefined> {
    const r = await x.get<Row>(
      `SELECT * FROM payments WHERE provider = ? AND provider_payment_id = ?${lock ? ' FOR UPDATE' : ''}`,
      provider,
      providerPaymentId,
    );
    return r ? toPayment(r) : undefined;
  },

  async setProviderPaymentId(
    x: SqlExecutor,
    id: string,
    providerPaymentId: string,
    at: string,
  ): Promise<void> {
    await x.run(
      'UPDATE payments SET provider_payment_id = ?, updated_at = ? WHERE id = ? AND provider_payment_id IS NULL',
      providerPaymentId,
      at,
      id,
    );
  },

  async setPaymentStatus(x: SqlExecutor, id: string, status: PaymentStatus, at: string): Promise<void> {
    await x.run(
      'UPDATE payments SET status = ?, processed_at = ?, updated_at = ? WHERE id = ?',
      status,
      TERMINAL_PAYMENT.has(status) ? at : null,
      at,
      id,
    );
  },

  async addRefund(x: SqlExecutor, id: string, amount: number, full: boolean, at: string): Promise<void> {
    await x.run(
      `UPDATE payments SET refunded_kopecks = refunded_kopecks + ?, status = ?, updated_at = ? WHERE id = ?`,
      amount,
      full ? 'refunded' : 'succeeded',
      at,
      id,
    );
  },

  async payments(x: SqlExecutor, tenantId: string, limit: number): Promise<PaymentRecord[]> {
    const rows = await x.all<Row>(
      'SELECT * FROM payments WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?',
      tenantId,
      limit,
    );
    return rows.map(toPayment);
  },

  async pendingPayments(x: SqlExecutor, before: string, limit: number): Promise<PaymentRecord[]> {
    const rows = await x.all<Row>(
      `SELECT * FROM payments WHERE status IN ('pending','waiting_for_capture') AND created_at <= ?
       ORDER BY created_at LIMIT ?`,
      before,
      limit,
    );
    return rows.map(toPayment);
  },

  async nextInvoiceNumber(x: SqlExecutor): Promise<number> {
    const r = await x.get<{ n: unknown }>("SELECT nextval('invoice_number_seq') AS n");
    return toNumber(r?.n);
  },

  async insertInvoice(x: SqlExecutor, inv: InvoiceRecord): Promise<void> {
    await x.run(
      `INSERT INTO invoices (id, tenant_id, number, plan_code, amount_kopecks, buyer_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'issued', ?)`,
      inv.id,
      inv.tenantId,
      inv.number,
      inv.planCode,
      inv.amountKopecks,
      JSON.stringify(inv.buyer),
      inv.createdAt,
    );
  },

  async invoice(x: SqlExecutor, id: string, lock = false): Promise<InvoiceRecord | undefined> {
    const r = await x.get<Row>(`SELECT * FROM invoices WHERE id = ?${lock ? ' FOR UPDATE' : ''}`, id);
    return r ? toInvoice(r) : undefined;
  },

  async invoices(x: SqlExecutor, tenantId: string): Promise<InvoiceRecord[]> {
    const rows = await x.all<Row>(
      'SELECT * FROM invoices WHERE tenant_id = ? ORDER BY created_at DESC',
      tenantId,
    );
    return rows.map(toInvoice);
  },

  async markInvoicePaid(x: SqlExecutor, id: string, actor: string, at: string): Promise<void> {
    await x.run(
      "UPDATE invoices SET status = 'paid', paid_at = ?, marked_by = ? WHERE id = ? AND status = 'issued'",
      at,
      actor,
      id,
    );
  },

  /** Журнал действий владельца/поддержки (§11.3). */
  async supportAction(
    x: SqlExecutor,
    a: {
      actor: string;
      tenantId: string | null;
      action: string;
      reason: string;
      details: Record<string, unknown>;
    },
    at: string,
  ): Promise<void> {
    await x.run(
      'INSERT INTO support_actions (actor, tenant_id, action, reason, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      a.actor,
      a.tenantId,
      a.action,
      a.reason,
      JSON.stringify(a.details),
      at,
    );
  },
};

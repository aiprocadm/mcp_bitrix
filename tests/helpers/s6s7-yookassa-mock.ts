/**
 * Имитация HTTP API ЮKassa для тестов S6/S7 в форме официальных моделей SDK yookassa-python
 * (PaymentResponse, RefundResponse, WebhookNotification): POST /payments, GET /payments/{id}, POST /refunds.
 * Idempotence-Key соблюдается как у API: повтор с тем же ключом возвращает тот же объект.
 * Это mock, а не тестовый магазин: реальные платежи здесь не проверяются.
 */
import { randomUUID } from 'node:crypto';
import type { FetchLike } from '../../src/bitrix/client.js';

export type ChargeOutcome = 'succeeded' | 'canceled' | 'pending';

interface MockPayment {
  id: string;
  status: 'pending' | 'waiting_for_capture' | 'succeeded' | 'canceled';
  paid: boolean;
  amount: { value: string; currency: string };
  description?: string | undefined;
  metadata: Record<string, string>;
  created_at: string;
  test: boolean;
  confirmation?: { type: 'redirect'; confirmation_url: string; return_url?: string };
  payment_method?: { type: string; id: string; saved: boolean; title: string };
  cancellation_details?: { party: string; reason: string };
  savePaymentMethod: boolean;
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

export class YooKassaMock {
  readonly requests: RecordedRequest[] = [];
  readonly payments = new Map<string, MockPayment>();
  private readonly byKey = new Map<string, string>();
  /** Исход следующих рекуррентных списаний (payment_method_id). */
  chargeOutcomes: ChargeOutcome[] = [];
  /** Сколько следующих запросов «падают» до ответа (сетевая ошибка). */
  failNext = 0;
  /** Сколько следующих POST отвечают 202 (запрос в обработке, SDK повторяет). */
  accepted202Next = 0;

  constructor(
    readonly shopId = '123456',
    readonly secretKey = 'test_SeCrEtKeY_do_not_log',
  ) {}

  /** Пользователь оплатил на странице ЮKassa (или отказался). */
  complete(id: string, outcome: 'succeeded' | 'canceled', save = true): void {
    const p = this.payments.get(id);
    if (!p) throw new Error('нет платежа');
    p.status = outcome;
    p.paid = outcome === 'succeeded';
    if (outcome === 'succeeded') {
      p.payment_method = {
        type: 'bank_card',
        id: `pm-${randomUUID()}`,
        saved: save && p.savePaymentMethod,
        title: 'Bank card *4444',
      };
    } else {
      p.cancellation_details = { party: 'yoo_money', reason: 'insufficient_funds' };
    }
  }

  /** Тело уведомления (WebhookNotification SDK) — со статусом, который тест может подделать. */
  notification(id: string, event = 'payment.succeeded', statusOverride?: string): Record<string, unknown> {
    const p = this.payments.get(id);
    return {
      type: 'notification',
      event,
      object: {
        ...(p ? this.view(p) : { id, amount: { value: '1.00', currency: 'RUB' } }),
        ...(statusOverride ? { status: statusOverride, paid: true } : {}),
      },
    };
  }

  private view(p: MockPayment): Record<string, unknown> {
    const rest: Record<string, unknown> = { ...p };
    delete rest['savePaymentMethod'];
    return { ...rest, refundable: p.status === 'succeeded' };
  }

  readonly fetch: FetchLike = (url, init) => Promise.resolve().then(() => this.handle(url, init));

  private handle(url: string, init: RequestInit): Response {
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const body =
      typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    this.requests.push({ method: init.method ?? 'GET', url, headers, body });
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new TypeError('fetch failed');
    }
    const expected = `Basic ${Buffer.from(`${this.shopId}:${this.secretKey}`).toString('base64')}`;
    if (headers['authorization'] !== expected)
      return json(401, { type: 'error', code: 'invalid_credentials' });
    const u = new URL(url);
    if (u.hostname !== 'api.yookassa.ru' || !u.pathname.startsWith('/v3/'))
      return json(404, { type: 'error', code: 'not_found' });
    const path = u.pathname.slice(3);
    if (init.method === 'POST') {
      const key = headers['idempotence-key'];
      if (!key) return json(400, { type: 'error', code: 'invalid_request' });
      if (this.accepted202Next > 0) {
        this.accepted202Next -= 1;
        return json(202, { type: 'processing', retry_after: 1 });
      }
      const known = this.byKey.get(`${path}:${key}`);
      if (path === '/payments') {
        const existing = known ? this.payments.get(known) : undefined;
        if (existing) return json(200, this.view(existing));
        return this.createPayment(key, body ?? {});
      }
      if (path === '/refunds') {
        const paymentId = String(body?.['payment_id']);
        if (!this.payments.has(paymentId)) return json(404, { type: 'error', code: 'not_found' });
        return json(200, {
          id: known ?? `rf-${randomUUID()}`,
          payment_id: paymentId,
          status: 'succeeded',
          amount: body?.['amount'],
          created_at: new Date().toISOString(),
        });
      }
    }
    const m = /^\/payments\/([A-Za-z0-9-]+)$/.exec(path);
    if (init.method === 'GET' && m?.[1]) {
      const p = this.payments.get(m[1]);
      return p ? json(200, this.view(p)) : json(404, { type: 'error', code: 'not_found' });
    }
    return json(404, { type: 'error', code: 'not_found' });
  }

  private createPayment(key: string, body: Record<string, unknown>): Response {
    const amount = body['amount'] as { value: string; currency: string } | undefined;
    if (!amount || typeof amount.value !== 'string' || !/^\d+\.\d{2}$/.test(amount.value))
      return json(400, { type: 'error', code: 'invalid_request', parameter: 'amount' });
    const receipt = body['receipt'] as { customer?: Record<string, string>; items?: unknown[] } | undefined;
    if (
      !receipt?.customer ||
      (!receipt.customer['email'] && !receipt.customer['phone']) ||
      !receipt.items?.length
    )
      return json(400, { type: 'error', code: 'invalid_request', parameter: 'receipt' });
    const id = `2d${randomUUID().slice(2)}`;
    const pmId = body['payment_method_id'];
    const p: MockPayment = {
      id,
      status: 'pending',
      paid: false,
      amount,
      description: typeof body['description'] === 'string' ? body['description'] : undefined,
      metadata: (body['metadata'] as Record<string, string> | undefined) ?? {},
      created_at: new Date().toISOString(),
      test: true,
      savePaymentMethod: body['save_payment_method'] === true,
    };
    if (typeof pmId === 'string') {
      const outcome = this.chargeOutcomes.shift() ?? 'succeeded';
      p.status = outcome;
      p.paid = outcome === 'succeeded';
      p.payment_method = { type: 'bank_card', id: pmId, saved: true, title: 'Bank card *4444' };
      if (outcome === 'canceled')
        p.cancellation_details = { party: 'card_issuer', reason: 'insufficient_funds' };
    } else {
      const conf = body['confirmation'] as { type: string; return_url: string } | undefined;
      if (conf?.type !== 'redirect')
        return json(400, { type: 'error', code: 'invalid_request', parameter: 'confirmation' });
      p.confirmation = {
        type: 'redirect',
        confirmation_url: `https://yoomoney.ru/checkout/payments/v2/contract?orderId=${id}`,
        return_url: conf.return_url,
      };
    }
    this.payments.set(id, p);
    this.byKey.set(`/payments:${key}`, id);
    return json(200, this.view(p));
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Адрес из документированного списка ЮKassa (security_helper.py) и посторонний. */
export const YOOKASSA_IP = '185.71.76.5';
export const FOREIGN_IP = '203.0.113.7';

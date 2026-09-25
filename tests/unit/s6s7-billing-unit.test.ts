/**
 * SaaS-ТЗ S6/S7: деньги в копейках, доплата при повышении тарифа, клиент ЮKassa (форма запросов по SDK
 * yookassa-python, Idempotence-Key при повторе, allowlist хоста, адреса уведомлений), видимость по тарифу.
 * Mock HTTP ЮKassa — не тестовый магазин.
 */
import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors/app-error.js';
import { allTools } from '../../src/tools/index.js';
import { ALL_MODULES } from '../../src/config/modules.js';
import { DEFAULT_PLANS, type Plan } from '../../src/saas/repos/plans.js';
import { addMonths, amountToKopecks, kopecksToAmount, prorateKopecks } from '../../src/saas/billing/money.js';
import { YooKassaProvider } from '../../src/saas/billing/yookassa.js';
import {
  planHiddenReason,
  subscriptionAllowsWork,
  visibleModulesFor,
  type TenantEntitlement,
} from '../../src/saas/billing/entitlements.js';
import type { SellerSettings } from '../../src/saas/billing/settings.js';
import { FOREIGN_IP, YOOKASSA_IP, YooKassaMock } from '../helpers/s6s7-yookassa-mock.js';

const SELLER: SellerSettings = {
  name: 'ООО «Тест»',
  inn: '7700000000',
  taxSystemCode: 2,
  vatCode: 1,
  paymentSubject: 'service',
  paymentMode: 'full_payment',
};

function provider(mock: YooKassaMock) {
  return new YooKassaProvider({
    settings: {
      shopId: mock.shopId,
      secretKey: mock.secretKey,
      apiUrl: 'https://api.yookassa.ru/v3',
      timeoutMs: 5000,
    },
    seller: SELLER,
    fetch: mock.fetch,
    sleep: () => Promise.resolve(),
  });
}

const receipt = { customerContact: { email: 'buh@example.ru' }, itemDescription: 'Доступ к сервису MCP' };

describe('деньги — только целые копейки', () => {
  it('копейки ↔ строка суммы ЮKassa без float', () => {
    expect(kopecksToAmount(99_000)).toBe('990.00');
    expect(kopecksToAmount(5)).toBe('0.05');
    expect(kopecksToAmount(299_001)).toBe('2990.01');
    expect(amountToKopecks('990.00')).toBe(99_000);
    expect(amountToKopecks('0.1')).toBe(10);
    expect(amountToKopecks('7990')).toBe(799_000);
    expect(() => kopecksToAmount(1.5)).toThrow(AppError);
    expect(() => amountToKopecks('1e3')).toThrow(AppError);
    expect(() => amountToKopecks('-1.00')).toThrow(AppError);
  });

  it('доплата при повышении: пропорционально остатку, округление до копейки половина вверх', () => {
    const day = 86_400_000;
    // Старт (990 ₽) → Команда (2990 ₽), остаток 15 из 30 дней: 2000 ₽ × 1/2 = 1000 ₽.
    expect(prorateKopecks(299_000 - 99_000, 15 * day, 30 * day)).toBe(100_000);
    // 200 000 коп × 10/31 = 64 516,129… → 64 516.
    expect(prorateKopecks(200_000, 10 * day, 31 * day)).toBe(64_516);
    // 1 коп × 1/2 = 0,5 → 1 (половина вверх).
    expect(prorateKopecks(1, 1, 2)).toBe(1);
    expect(prorateKopecks(100, 0, 30 * day)).toBe(0);
    expect(prorateKopecks(-5, day, day)).toBe(0);
    // Остаток больше периода обрезается.
    expect(prorateKopecks(1000, 40 * day, 30 * day)).toBe(1000);
  });

  it('календарные месяцы: 31 января + 1 = конец февраля', () => {
    expect(addMonths('2027-01-31T10:00:00.000Z', 1)).toBe('2027-02-28T10:00:00.000Z');
    expect(addMonths('2026-10-15T00:00:00.000Z', 12)).toBe('2027-10-15T00:00:00.000Z');
  });
});

describe('ЮKassa: запросы по моделям SDK', () => {
  it('первая оплата: Basic shopId:secretKey, Idempotence-Key, сумма строкой, чек 54-ФЗ, redirect, save_payment_method', async () => {
    const mock = new YooKassaMock();
    const p = await provider(mock).createPayment({
      idempotenceKey: 'k-1',
      amountKopecks: 99_000,
      description: 'MCP для Bitrix24: тариф «Старт»',
      receipt,
      metadata: { tenant_id: 't1', payment_id: 'p1' },
      returnUrl: 'https://mcp.example.ru/app/billing/return',
      savePaymentMethod: true,
    });
    const req = mock.requests[0];
    expect(req?.url).toBe('https://api.yookassa.ru/v3/payments');
    expect(req?.headers['authorization']).toBe(
      `Basic ${Buffer.from(`${mock.shopId}:${mock.secretKey}`).toString('base64')}`,
    );
    expect(req?.headers['idempotence-key']).toBe('k-1');
    expect(req?.body).toMatchObject({
      amount: { value: '990.00', currency: 'RUB' },
      capture: true,
      confirmation: { type: 'redirect', return_url: 'https://mcp.example.ru/app/billing/return' },
      save_payment_method: true,
      metadata: { tenant_id: 't1', payment_id: 'p1' },
      receipt: {
        customer: { email: 'buh@example.ru' },
        tax_system_code: 2,
        items: [
          {
            description: 'Доступ к сервису MCP',
            quantity: '1.00',
            amount: { value: '990.00', currency: 'RUB' },
            vat_code: 1,
            payment_mode: 'full_payment',
            payment_subject: 'service',
          },
        ],
      },
    });
    expect(req?.body).not.toHaveProperty('payment_method_id');
    expect(p.status).toBe('pending');
    expect(p.amountKopecks).toBe(99_000);
    expect(p.confirmationUrl).toMatch(/^https:\/\/yoomoney\.ru\//);
  });

  it('рекуррентное списание: payment_method_id, без confirmation', async () => {
    const mock = new YooKassaMock();
    const p = await provider(mock).chargeSaved({
      idempotenceKey: 'ren:1',
      amountKopecks: 299_000,
      description: 'продление',
      receipt,
      metadata: {},
      paymentMethodId: 'pm-saved',
    });
    expect(mock.requests[0]?.body).toMatchObject({
      payment_method_id: 'pm-saved',
      amount: { value: '2990.00' },
    });
    expect(mock.requests[0]?.body).not.toHaveProperty('confirmation');
    expect(p.status).toBe('succeeded');
    expect(p.paymentMethod).toMatchObject({ id: 'pm-saved', saved: true });
  });

  it('чек без email/телефона не отправляется', async () => {
    const mock = new YooKassaMock();
    await expect(
      provider(mock).chargeSaved({
        idempotenceKey: 'x',
        amountKopecks: 100,
        description: 'd',
        receipt: { customerContact: {}, itemDescription: 'x' },
        metadata: {},
        paymentMethodId: 'pm',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(mock.requests).toHaveLength(0);
  });

  it('повтор после сетевой ошибки и HTTP 202 — с тем же Idempotence-Key; второго платежа нет', async () => {
    const mock = new YooKassaMock();
    mock.failNext = 1;
    mock.accepted202Next = 1;
    const input = {
      idempotenceKey: 'same-key',
      amountKopecks: 99_000,
      description: 'd',
      receipt,
      metadata: {},
      paymentMethodId: 'pm-1',
    };
    const p = await provider(mock).chargeSaved(input);
    expect(mock.requests).toHaveLength(3);
    expect(new Set(mock.requests.map((r) => r.headers['idempotence-key']))).toEqual(new Set(['same-key']));
    // Повторный вызов тем же ключом (например, worker перезапустился) — тот же платёж.
    const again = await provider(mock).chargeSaved(input);
    expect(again.id).toBe(p.id);
    expect(mock.payments.size).toBe(1);
  });

  it('недоступность после всех попыток — ошибка без секрета и тела ответа', async () => {
    const mock = new YooKassaMock();
    mock.failNext = 5;
    const err = await provider(mock)
      .getPayment('2d000000-000f-5000-8000-000000000000')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).details.reason).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
    expect(JSON.stringify((err as AppError).toJSON())).not.toContain(mock.secretKey);
    const bad = new YooKassaMock('123456', 'other');
    const p = new YooKassaProvider({
      settings: {
        shopId: '123456',
        secretKey: 'wrong_secret',
        apiUrl: 'https://api.yookassa.ru/v3',
        timeoutMs: 1000,
      },
      seller: SELLER,
      fetch: bad.fetch,
    });
    const auth = await p.getPayment('abc').catch((e: unknown) => e);
    expect((auth as AppError).code).toBe('CONFIG_INVALID');
    expect(JSON.stringify((auth as AppError).toJSON())).not.toContain('wrong_secret');
  });

  it('allowlist хоста API: другой адрес — CONFIG_INVALID', () => {
    for (const apiUrl of [
      'https://evil.example/v3',
      'http://api.yookassa.ru/v3',
      'https://api.yookassa.ru:8443/v3',
    ]) {
      expect(
        () =>
          new YooKassaProvider({
            settings: { shopId: '1', secretKey: 's', apiUrl, timeoutMs: 1000 },
            seller: SELLER,
            fetch: new YooKassaMock().fetch,
          }),
      ).toThrow(AppError);
    }
  });

  it('адреса уведомлений — список security_helper.py SDK; разбор уведомления не доверяет статусу', () => {
    const p = provider(new YooKassaMock());
    expect(p.isTrustedSource(YOOKASSA_IP)).toBe(true);
    expect(p.isTrustedSource('77.75.156.11')).toBe(true);
    expect(p.isTrustedSource('::ffff:77.75.153.10')).toBe(true);
    expect(p.isTrustedSource('2a02:5180:0:1509::1')).toBe(true);
    expect(p.isTrustedSource(FOREIGN_IP)).toBe(false);
    expect(p.isTrustedSource('77.75.156.12')).toBe(false);
    expect(p.isTrustedSource('not-an-ip')).toBe(false);
    expect(
      p.parseNotification({
        type: 'notification',
        event: 'payment.succeeded',
        object: { id: 'abc-1', status: 'succeeded' },
      }),
    ).toEqual({ event: 'payment.succeeded', objectType: 'payment', objectId: 'abc-1' });
    expect(p.parseNotification({ event: 'payment.succeeded', object: { id: 'x' } })).toBeUndefined();
    expect(
      p.parseNotification({ type: 'notification', event: 'payment.succeeded', object: { id: '../x' } }),
    ).toBeUndefined();
  });
});

describe('S09: видимость по тарифу', () => {
  const plan = (code: string): Plan => {
    const p = DEFAULT_PLANS.find((x) => x.code === code);
    if (!p) throw new Error(code);
    return p;
  };
  const ent = (p: Plan, modules: string[] = []): TenantEntitlement => ({
    tenantId: 't',
    plan: p,
    subscription: undefined,
    settings: {
      tenantId: 't',
      modules,
      approvalPolicy: 'self',
      userDailyCallLimit: null,
      defaultRole: 'operator',
      outputPolicyJson: null,
    },
    modules: visibleModulesFor(p, { modules }, ALL_MODULES),
  });

  it('Старт: модули вне тарифа и удаления скрыты; system виден всегда', () => {
    const e = ent(plan('start'));
    const hidden = allTools().filter((t) => planHiddenReason(t, e));
    const visible = allTools().filter((t) => !planHiddenReason(t, e));
    expect(hidden.some((t) => t.module === 'telephony' && planHiddenReason(t, e) === 'NOT_IN_PLAN')).toBe(
      true,
    );
    expect(
      visible.every((t) => ['system', 'crm', 'tasks', 'calendar', 'chat', 'disk'].includes(t.module)),
    ).toBe(true);
    expect(visible.some((t) => t.operation === 'delete')).toBe(false);
    expect(visible.map((t) => t.name)).toEqual(
      expect.arrayContaining(['bitrix_connection_info', 'bitrix_server_version', 'operation_status']),
    );
  });

  it('администратор сужает модули; Бизнес — удаления видны', () => {
    const e = ent(plan('business'), ['crm']);
    expect(e.modules).toEqual(new Set(['system', 'crm']));
    const tasks = allTools().find((t) => t.module === 'tasks');
    expect(tasks && planHiddenReason(tasks, e)).toBe('MODULE_DISABLED');
    const del = allTools().find((t) => t.module === 'crm' && t.operation === 'delete');
    expect(del && planHiddenReason(del, e)).toBeUndefined();
  });

  it('доступ по статусу подписки (§10.2)', () => {
    const base = {
      tenantId: 't',
      planCode: 'start',
      periodStart: '2026-10-01T00:00:00.000Z',
      periodEnd: '2026-11-01T00:00:00.000Z',
      cancelAtPeriodEnd: false,
      pendingPlanCode: null,
      paymentMethodTitle: null,
      hasPaymentMethod: false,
      retryCount: 0,
      nextRetryAt: null,
      suspendedAt: null,
    };
    const inside = new Date('2026-10-15T00:00:00Z');
    const after = new Date('2026-11-02T00:00:00Z');
    expect(subscriptionAllowsWork({ ...base, status: 'trialing' }, inside)).toBe(true);
    expect(subscriptionAllowsWork({ ...base, status: 'trialing' }, after)).toBe(false);
    expect(subscriptionAllowsWork({ ...base, status: 'past_due' }, after)).toBe(true);
    expect(subscriptionAllowsWork({ ...base, status: 'canceled' }, inside)).toBe(true);
    expect(subscriptionAllowsWork({ ...base, status: 'canceled' }, after)).toBe(false);
    expect(subscriptionAllowsWork({ ...base, status: 'suspended' }, inside)).toBe(false);
    expect(subscriptionAllowsWork(undefined, inside)).toBe(false);
  });
});

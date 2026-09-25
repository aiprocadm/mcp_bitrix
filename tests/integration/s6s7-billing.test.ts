/**
 * SaaS-ТЗ S6/S7 на настоящем PostgreSQL + mock HTTP ЮKassa (форма моделей SDK yookassa-python):
 * S08 (квота посреди работы, диагностика), S09 (модуль вне тарифа), S10 (поддельное/повторное/неизвестное
 * уведомление, расхождение статуса с API), S11 (продление с часами-заглушкой), S16 (учёт при падении процесса),
 * доплата при повышении, счета юрлицам, секреты не в логах, изоляция платежей арендаторов.
 * Не проверено здесь: тестовый/боевой магазин ЮKassa (реальные платежи, чеки ОФД).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors/app-error.js';
import { ALL_MODULES } from '../../src/config/modules.js';
import type { AppLogger } from '../../src/logging/logger.js';
import { InMemoryCoordination } from '../../src/saas/coordination.js';
import { PlansRepo, SubscriptionsRepo } from '../../src/saas/repos/plans.js';
import { TenantSettingsRepo, TenantsRepo, TenantUsersRepo } from '../../src/saas/repos/tenants.js';
import { EntitlementService } from '../../src/saas/billing/entitlements.js';
import { UsageMeter } from '../../src/saas/billing/usage-meter.js';
import { SubscriptionService } from '../../src/saas/billing/subscription-service.js';
import { YooKassaProvider } from '../../src/saas/billing/yookassa.js';
import { BILLING_DEFAULTS, type BillingSettings } from '../../src/saas/billing/settings.js';
import type {
  BillingNotifier,
  DataDeletionDueEvent,
  QuotaThresholdEvent,
  SubscriptionEvent,
} from '../../src/saas/billing/notifier.js';
import { openSaasTestDb, PG_AVAILABLE, type SaasTestDb } from '../helpers/saas.js';
import { FOREIGN_IP, YOOKASSA_IP, YooKassaMock } from '../helpers/s6s7-yookassa-mock.js';

let s: SaasTestDb;
beforeAll(async () => {
  if (PG_AVAILABLE) {
    s = await openSaasTestDb();
    await new PlansRepo(s.db).seedDefaults();
  }
}, 60_000);
afterAll(async () => {
  if (PG_AVAILABLE) await s.close();
});

const DAY = 86_400_000;

/** Логгер-перехватчик: всё, что уходит в логи, проверяется на отсутствие секретов. */
function captureLogger(lines: string[]): AppLogger {
  const rec =
    (level: string) =>
    (...args: unknown[]) => {
      lines.push(`${level} ${JSON.stringify(args)}`);
    };
  const l = {
    info: rec('info'),
    warn: rec('warn'),
    error: rec('error'),
    debug: rec('debug'),
    child: () => l,
  };
  return l as unknown as AppLogger;
}

class RecordingNotifier implements BillingNotifier {
  quota: QuotaThresholdEvent[] = [];
  events: SubscriptionEvent[] = [];
  deletions: DataDeletionDueEvent[] = [];
  quotaThreshold(e: QuotaThresholdEvent) {
    this.quota.push(e);
  }
  subscriptionEvent(e: SubscriptionEvent) {
    this.events.push(e);
  }
  dataDeletionDue(e: DataDeletionDueEvent) {
    this.deletions.push(e);
  }
  types(tenantId: string) {
    return this.events.filter((e) => e.tenantId === tenantId).map((e) => e.type);
  }
}

const SETTINGS: BillingSettings = {
  cabinetUrl: 'https://mcp.example.ru/app',
  returnUrl: 'https://mcp.example.ru/app/billing/return',
  yookassa: undefined,
  seller: {
    name: 'ООО «Тест»',
    inn: '7700000000',
    taxSystemCode: 2,
    vatCode: 1,
    paymentSubject: 'service',
    paymentMode: 'full_payment',
  },
  ...BILLING_DEFAULTS,
};

interface Stand {
  clock: { now: Date };
  mock: YooKassaMock;
  coord: InMemoryCoordination;
  notifier: RecordingNotifier;
  logs: string[];
  usage: UsageMeter;
  ent: EntitlementService;
  billing: SubscriptionService;
  subs: SubscriptionsRepo;
  settingsRepo: TenantSettingsRepo;
  tenantId: string;
  userId: string;
}

async function stand(start = '2026-10-01T09:00:00.000Z'): Promise<Stand> {
  const clock = { now: new Date(start) };
  const now = () => clock.now;
  const mock = new YooKassaMock();
  const coord = new InMemoryCoordination();
  const notifier = new RecordingNotifier();
  const logs: string[] = [];
  const logger = captureLogger(logs);
  const plans = new PlansRepo(s.db);
  const subs = new SubscriptionsRepo(s.db);
  const settingsRepo = new TenantSettingsRepo(s.db);
  const users = new TenantUsersRepo(s.db);
  const tenants = new TenantsRepo(s.db, s.keys);
  const { tenant } = await tenants.upsertInstalled({
    memberId: `m-${randomUUID()}`,
    domain: `p${randomUUID().slice(0, 8)}.bitrix24.ru`,
    appTokenHash: 'h',
  });
  const trial = await plans.get('trial');
  if (!trial) throw new Error('trial');
  // Worker обрабатывает все подписки кластера: подписки прошлых тестов «паркуются», чтобы не попадать в продления.
  await s.db.run(
    "UPDATE subscriptions SET status = 'suspended', suspended_at = ?, deletion_requested_at = ?, next_retry_at = NULL",
    '2000-01-01T00:00:00.000Z',
    '2000-01-01T00:00:00.000Z',
  );
  await subs.startTrial(tenant.id, trial, clock.now);
  const user = await users.upsertFromBitrix({
    tenantId: tenant.id,
    bitrixUserId: 1,
    displayName: 'Иван',
    email: null,
    defaultRole: 'operator',
  });
  const usage = new UsageMeter({ db: s.db, coordination: coord, notifier, logger, now });
  const ent = new EntitlementService({
    plans,
    subscriptions: subs,
    settings: settingsRepo,
    usage,
    cabinetUrl: SETTINGS.cabinetUrl,
    allModules: ALL_MODULES,
    now,
    cacheTtlMs: 60_000,
  });
  await ent.listen(coord);
  const provider = new YooKassaProvider({
    settings: {
      shopId: mock.shopId,
      secretKey: mock.secretKey,
      apiUrl: 'https://api.yookassa.ru/v3',
      timeoutMs: 5000,
    },
    seller: SETTINGS.seller,
    fetch: mock.fetch,
    sleep: () => Promise.resolve(),
  });
  const billing = new SubscriptionService({
    db: s.db,
    keys: s.keys,
    plans,
    settings: SETTINGS,
    notifier,
    logger,
    provider,
    users,
    coordination: coord,
    now,
  });
  return {
    clock,
    mock,
    coord,
    notifier,
    logs,
    usage,
    ent,
    billing,
    subs,
    settingsRepo,
    tenantId: tenant.id,
    userId: user.id,
  };
}

const tool = (name: string, module: string, operation: 'read' | 'create' | 'delete' = 'read') => ({
  name,
  module,
  operation,
});

/** Первая оплата тарифа: checkout → пользователь платит на странице → уведомление → active. */
async function payInitial(st: Stand, planCode = 'start', save = true) {
  const r = await st.billing.checkout(st.tenantId, {
    planCode,
    contact: { email: 'Buh@Example.ru' },
    savePaymentMethod: save,
  });
  const providerId = [...st.mock.payments.values()].at(-1)?.id ?? '';
  st.mock.complete(providerId, 'succeeded', save);
  const n = await st.billing.handleNotification(st.mock.notification(providerId), YOOKASSA_IP);
  return { ...r, providerId, n };
}

describe.skipIf(!PG_AVAILABLE)('S6: квоты, тариф, учёт (PostgreSQL)', () => {
  it('S08: квота вызовов исчерпана посреди работы → QUOTA_EXCEEDED; диагностика работает; 80% — уведомление', async () => {
    const st = await stand();
    await payInitial(st, 'start');
    const plan = await new PlansRepo(s.db).get('start');
    if (!plan) throw new Error('start');
    // Владелец снизил квоту тарифа для теста нельзя (тарифы общие) — используем реальный лимит через засев учёта.
    const limit = plan.limits.callsPerMonth;
    const call = tool('crm_list', 'crm');
    for (let i = 0; i < 3; i += 1) {
      await st.ent.check({ tenantId: st.tenantId, userId: st.userId, tool: call });
      await st.usage.recordCall({
        tenantId: st.tenantId,
        userId: st.userId,
        tool: 'crm_list',
        limits: plan.limits,
      });
    }
    // Остальное использование месяца уже в PostgreSQL (другие экземпляры сбросили раньше).
    await st.usage.flush();
    await s.db.run(
      'UPDATE usage_counters SET calls = calls + ? WHERE tenant_id = ? AND user_id = ? AND period = ?',
      limit - 4,
      st.tenantId,
      st.userId,
      '2026-10',
    );
    // Новый процесс (пустая память) засевает квоту из PostgreSQL.
    const usage2 = new UsageMeter({
      db: s.db,
      coordination: new InMemoryCoordination(),
      notifier: st.notifier,
      logger: captureLogger(st.logs),
      now: () => st.clock.now,
    });
    const ent2 = new EntitlementService({
      plans: new PlansRepo(s.db),
      subscriptions: st.subs,
      settings: st.settingsRepo,
      usage: usage2,
      cabinetUrl: SETTINGS.cabinetUrl,
      allModules: ALL_MODULES,
      now: () => st.clock.now,
    });
    expect((await usage2.monthUsage(st.tenantId)).calls).toBe(limit - 1);
    await ent2.check({ tenantId: st.tenantId, userId: st.userId, tool: call });
    await usage2.recordCall({
      tenantId: st.tenantId,
      userId: st.userId,
      tool: 'crm_list',
      limits: plan.limits,
    });
    expect(st.notifier.quota).toContainEqual(
      expect.objectContaining({ tenantId: st.tenantId, metric: 'calls', percent: 100, limit }),
    );
    const err = await ent2
      .check({ tenantId: st.tenantId, userId: st.userId, tool: tool('task_add', 'tasks', 'create') })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('QUOTA_EXCEEDED');
    expect((err as AppError).details).toMatchObject({ reason: 'MONTHLY_CALLS', retryable: false });
    expect((err as AppError).details.nextAction).toContain('/app/billing');
    for (const name of ['bitrix_connection_info', 'bitrix_server_version', 'operation_status'])
      await expect(
        ent2.check({ tenantId: st.tenantId, userId: st.userId, tool: tool(name, 'system') }),
      ).resolves.toBeDefined();
  });

  it('80%: уведомление ровно один раз; дневной лимит пользователя → QUOTA_EXCEEDED/USER_DAILY_LIMIT', async () => {
    const st = await stand();
    const limits = { users: 3, callsPerMonth: 10, writesPerMonth: 5 };
    for (let i = 0; i < 9; i += 1)
      await st.usage.recordCall({ tenantId: st.tenantId, userId: st.userId, tool: 'crm_get', limits });
    expect(st.notifier.quota.filter((q) => q.tenantId === st.tenantId)).toEqual([
      expect.objectContaining({ metric: 'calls', percent: 80, used: 8, limit: 10 }),
    ]);
    const settings = await st.settingsRepo.get(st.tenantId);
    await st.settingsRepo.save({ ...settings, userDailyCallLimit: 9 });
    st.ent.invalidate(st.tenantId);
    const err = await st.ent
      .check({ tenantId: st.tenantId, userId: st.userId, tool: tool('crm_get', 'crm') })
      .catch((e: unknown) => e);
    expect((err as AppError).code).toBe('QUOTA_EXCEEDED');
    expect((err as AppError).details.reason).toBe('USER_DAILY_LIMIT');
    // Следующие сутки — лимит снова доступен.
    st.clock.now = new Date(st.clock.now.getTime() + DAY);
    await expect(
      st.ent.check({ tenantId: st.tenantId, userId: st.userId, tool: tool('crm_get', 'crm') }),
    ).resolves.toBeDefined();
  });

  it('квота записей: инструменты записи блокируются, чтение — нет', async () => {
    const st = await stand();
    const trial = await new PlansRepo(s.db).get('trial');
    if (!trial) throw new Error('trial');
    for (let i = 0; i < trial.limits.writesPerMonth; i += 1)
      await st.usage.recordWrite({ tenantId: st.tenantId, userId: st.userId, tool: 'task_add' });
    const err = await st.ent
      .check({ tenantId: st.tenantId, userId: st.userId, tool: tool('task_add', 'tasks', 'create') })
      .catch((e: unknown) => e);
    expect((err as AppError).details.reason).toBe('MONTHLY_WRITES');
    await expect(
      st.ent.check({ tenantId: st.tenantId, userId: st.userId, tool: tool('task_list', 'tasks') }),
    ).resolves.toBeDefined();
  });

  it('S09: модуль вне тарифа → FEATURE_UNAVAILABLE/NOT_IN_PLAN; скрыт; модуль выключен администратором; удаления', async () => {
    const st = await stand();
    await payInitial(st, 'start');
    const tel = await st.ent
      .check({ tenantId: st.tenantId, userId: st.userId, tool: tool('telephony_calls', 'telephony') })
      .catch((e: unknown) => e);
    expect((tel as AppError).code).toBe('FEATURE_UNAVAILABLE');
    expect((tel as AppError).details.reason).toBe('NOT_IN_PLAN');
    expect((await st.ent.visibleModules(st.tenantId)).has('telephony')).toBe(false);
    const del = await st.ent
      .check({ tenantId: st.tenantId, userId: st.userId, tool: tool('crm_delete', 'crm', 'delete') })
      .catch((e: unknown) => e);
    expect((del as AppError).details.reason).toBe('DESTRUCTIVE_NOT_IN_PLAN');
    const settings = await st.settingsRepo.get(st.tenantId);
    await st.settingsRepo.save({ ...settings, modules: ['crm'] });
    st.ent.invalidate(st.tenantId);
    const off = await st.ent
      .check({ tenantId: st.tenantId, userId: st.userId, tool: tool('task_list', 'tasks') })
      .catch((e: unknown) => e);
    expect((off as AppError).details.reason).toBe('MODULE_DISABLED');
    expect([...(await st.ent.visibleModules(st.tenantId))].sort()).toEqual(['crm', 'system']);
  });

  it('S16: падение процесса — потеря не больше несброшенного интервала, двойного счёта нет; отчёт кабинета', async () => {
    const st = await stand();
    const ev = { tenantId: st.tenantId, userId: st.userId, tool: 'crm_list' };
    for (let i = 0; i < 5; i += 1) await st.usage.recordCall(ev);
    await st.usage.recordWrite({ ...ev, tool: 'task_add' });
    expect(await st.usage.flush()).toBeGreaterThan(0);
    expect(await st.usage.flush()).toBe(0); // повторный сброс ничего не добавляет
    for (let i = 0; i < 3; i += 1) await st.usage.recordCall(ev); // эти 3 не успели сброситься — «падение»
    // Новый процесс: память (InMemoryCoordination) потеряна.
    const coord2 = new InMemoryCoordination();
    const usage2 = new UsageMeter({
      db: s.db,
      coordination: coord2,
      notifier: st.notifier,
      logger: captureLogger(st.logs),
      now: () => st.clock.now,
    });
    expect(await usage2.monthUsage(st.tenantId)).toEqual({ calls: 5, writes: 1 });
    await usage2.recordCall(ev);
    await usage2.recordCall({ ...ev, tool: 'crm_get' });
    await usage2.stop(); // сброс при остановке
    await usage2.flush();
    const r = await usage2.report(st.tenantId, '2026-10');
    expect(r).toMatchObject({ calls: 7, writes: 1, note: expect.stringContaining('1 минуты') as unknown });
    expect(r.byTool).toEqual(
      expect.arrayContaining([
        { tool: 'crm_list', calls: 6, writes: 0 },
        { tool: 'crm_get', calls: 1, writes: 0 },
        { tool: 'task_add', calls: 0, writes: 1 },
      ]),
    );
    expect(r.byUser).toEqual([{ userId: st.userId, calls: 7, writes: 1 }]);
    expect(r.byDay).toEqual([{ day: '2026-10-01', calls: 7, writes: 1 }]);
    const owner = await usage2.ownerReport('2026-10');
    expect(owner.find((o) => o.tenantId === st.tenantId)).toEqual({
      tenantId: st.tenantId,
      calls: 7,
      writes: 1,
    });
  });

  it('конкурентные вызовы: счётчики атомарны, сумма точная', async () => {
    const st = await stand();
    await Promise.all(
      Array.from({ length: 50 }, () =>
        st.usage.recordCall({ tenantId: st.tenantId, userId: st.userId, tool: 'crm_list' }),
      ),
    );
    await Promise.all([st.usage.flush(), st.usage.flush()]);
    expect((await st.usage.report(st.tenantId, '2026-10')).calls).toBe(50);
  });
});

describe.skipIf(!PG_AVAILABLE)('S7: биллинг ЮKassa (PostgreSQL + mock API)', () => {
  it('первая оплата: redirect → active; способ оплаты и контакт — под DEK арендатора, не в открытом виде', async () => {
    const st = await stand();
    const r = await payInitial(st, 'start');
    expect(r.confirmationUrl).toMatch(/^https:\/\/yoomoney\.ru\//);
    expect(r.n).toEqual({ accepted: true, outcome: 'applied' });
    const sub = await st.subs.get(st.tenantId);
    expect(sub).toMatchObject({
      status: 'active',
      planCode: 'start',
      hasPaymentMethod: true,
      paymentMethodTitle: 'Bank card *4444',
    });
    expect(sub?.periodStart).toBe('2026-10-01T09:00:00.000Z');
    expect(sub?.periodEnd).toBe('2026-11-01T09:00:00.000Z');
    const pmId = [...st.mock.payments.values()][0]?.payment_method?.id ?? '';
    const raw = await s.db.get<{ payment_method_encrypted: string; receipt_contact_encrypted: string }>(
      'SELECT payment_method_encrypted, receipt_contact_encrypted FROM subscriptions WHERE tenant_id = ?',
      st.tenantId,
    );
    expect(raw?.payment_method_encrypted).not.toContain(pmId);
    expect(raw?.receipt_contact_encrypted).not.toContain('buh@example.ru');
    const box = await s.keys.boxFor(s.db, st.tenantId);
    expect(box.decrypt(raw?.payment_method_encrypted ?? '', `payment-method:${st.tenantId}`)).toBe(pmId);
    expect(() => box.decrypt(raw?.payment_method_encrypted ?? '', 'payment-method:other')).toThrow();
    expect(st.mock.requests[0]?.body).toMatchObject({
      save_payment_method: true,
      receipt: { customer: { email: 'buh@example.ru' } },
    });
    expect(st.notifier.types(st.tenantId)).toContain('payment_succeeded');
  });

  it('S10: поддельное (чужой IP), расхождение статуса с API, повтор, неизвестный платёж', async () => {
    const st = await stand();
    const c = await st.billing.checkout(st.tenantId, {
      planCode: 'team',
      contact: { phone: '+7 (921) 123-45-67' },
      savePaymentMethod: true,
    });
    const providerId = [...st.mock.payments.values()][0]?.id ?? '';
    // Поддельное: чужой адрес, «succeeded» в теле — отказ без обращения к API и без изменений.
    const before = st.mock.requests.length;
    expect(
      await st.billing.handleNotification(
        st.mock.notification(providerId, 'payment.succeeded', 'succeeded'),
        FOREIGN_IP,
      ),
    ).toEqual({
      accepted: false,
      reason: 'UNTRUSTED_SOURCE',
    });
    expect(st.mock.requests.length).toBe(before);
    // С доверенного адреса, но статус в теле подделан: API говорит pending — подписка не меняется.
    expect(
      await st.billing.handleNotification(
        st.mock.notification(providerId, 'payment.succeeded', 'succeeded'),
        YOOKASSA_IP,
      ),
    ).toEqual({ accepted: true, outcome: 'pending' });
    expect(st.mock.requests.at(-1)).toMatchObject({
      method: 'GET',
      url: `https://api.yookassa.ru/v3/payments/${providerId}`,
    });
    expect((await st.subs.get(st.tenantId))?.status).toBe('trialing');
    // Настоящая оплата → применяется один раз; повтор уведомления — duplicate, период не сдвигается.
    st.mock.complete(providerId, 'succeeded');
    expect(await st.billing.handleNotification(st.mock.notification(providerId), YOOKASSA_IP)).toEqual({
      accepted: true,
      outcome: 'applied',
    });
    const once = await st.subs.get(st.tenantId);
    expect(once).toMatchObject({ status: 'active', planCode: 'team' });
    st.clock.now = new Date(st.clock.now.getTime() + 3_600_000);
    expect(await st.billing.handleNotification(st.mock.notification(providerId), YOOKASSA_IP)).toEqual({
      accepted: true,
      outcome: 'duplicate',
    });
    expect((await st.subs.get(st.tenantId))?.periodEnd).toBe(once?.periodEnd);
    expect(st.notifier.types(st.tenantId).filter((t) => t === 'payment_succeeded')).toHaveLength(1);
    // Неизвестный платёж: журнал и игнор.
    expect(
      await st.billing.handleNotification(
        {
          type: 'notification',
          event: 'payment.succeeded',
          object: { id: '2d000000-0000-0000-0000-00000000dead', status: 'succeeded' },
        },
        YOOKASSA_IP,
      ),
    ).toEqual({ accepted: true, outcome: 'unknown_payment' });
    expect(st.logs.some((l) => l.includes('unknown payment'))).toBe(true);
    // Мусор вместо уведомления.
    expect(await st.billing.handleNotification({ hello: 1 }, YOOKASSA_IP)).toEqual({
      accepted: false,
      reason: 'MALFORMED',
    });
    // Платёж чужого арендатора не виден через syncPayment.
    const other = await stand();
    await expect(other.billing.syncPayment(other.tenantId, c.paymentId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('S10: API говорит canceled при «succeeded» в уведомлении — подписка не активируется', async () => {
    const st = await stand();
    await st.billing.checkout(st.tenantId, {
      planCode: 'start',
      contact: { email: 'a@b.ru' },
      savePaymentMethod: false,
    });
    const providerId = [...st.mock.payments.values()][0]?.id ?? '';
    st.mock.complete(providerId, 'canceled');
    expect(
      await st.billing.handleNotification(
        st.mock.notification(providerId, 'payment.succeeded', 'succeeded'),
        YOOKASSA_IP,
      ),
    ).toEqual({ accepted: true, outcome: 'applied' });
    expect((await st.subs.get(st.tenantId))?.status).toBe('trialing');
    expect(st.notifier.types(st.tenantId)).toEqual(['payment_failed']);
  });

  it('S11: продление ok → неуспех → past_due (3 попытки за 7 дней, доступ есть) → suspended (доступа нет) → оплата → active', async () => {
    const st = await stand();
    await payInitial(st, 'start');
    const call = { tenantId: st.tenantId, userId: st.userId, tool: tool('crm_list', 'crm') };
    // Месяц прошёл: автосписание успешно, период сдвинут от конца прошлого.
    st.clock.now = new Date('2026-11-01T09:00:00.000Z');
    expect((await st.billing.renewDue()).charged).toBe(1);
    let sub = await st.subs.get(st.tenantId);
    expect(sub).toMatchObject({
      status: 'active',
      periodStart: '2026-11-01T09:00:00.000Z',
      periodEnd: '2026-12-01T09:00:00.000Z',
    });
    const renewal = st.mock.requests.at(-1);
    expect(renewal?.body).toMatchObject({
      amount: { value: '990.00' },
      payment_method_id: expect.any(String) as unknown,
    });
    expect(renewal?.body?.['receipt']).toMatchObject({ customer: { email: 'buh@example.ru' } });
    // Повторный запуск worker в тот же момент — второго списания нет.
    expect((await st.billing.renewDue()).processed).toBe(0);
    // Следующее продление не проходит трижды.
    st.mock.chargeOutcomes = ['canceled', 'canceled', 'canceled'];
    st.clock.now = new Date('2026-12-01T09:00:00.000Z');
    expect((await st.billing.renewDue()).failed).toBe(1);
    sub = await st.subs.get(st.tenantId);
    expect(sub).toMatchObject({ status: 'past_due', retryCount: 1, nextRetryAt: '2026-12-04T09:00:00.000Z' });
    st.ent.invalidate(st.tenantId);
    await expect(st.ent.check(call)).resolves.toBeDefined(); // льготный период: всё работает
    st.clock.now = new Date('2026-12-02T09:00:00.000Z');
    expect((await st.billing.renewDue()).processed).toBe(0); // до следующей попытки — ничего
    st.clock.now = new Date('2026-12-04T09:00:00.000Z');
    await st.billing.renewDue();
    st.clock.now = new Date('2026-12-07T09:00:00.000Z');
    await st.billing.renewDue();
    sub = await st.subs.get(st.tenantId);
    expect(sub).toMatchObject({ status: 'past_due', retryCount: 3, nextRetryAt: '2026-12-08T09:00:00.000Z' });
    const charges = st.mock.requests.filter((r) => r.method === 'POST' && r.body?.['payment_method_id']);
    expect(charges).toHaveLength(4); // 1 успешное + 3 попытки
    expect(new Set(charges.map((r) => r.headers['idempotence-key'])).size).toBe(4);
    // Льгота кончилась: suspended, инструменты → SUBSCRIPTION_INACTIVE, диагностика — работает.
    st.clock.now = new Date('2026-12-08T09:00:00.000Z');
    expect((await st.billing.renewDue()).suspended).toBe(1);
    expect((await st.subs.get(st.tenantId))?.status).toBe('suspended');
    const err = await st.ent.check(call).catch((e: unknown) => e); // кэш сброшен событием через Coordination
    expect((err as AppError).code).toBe('SUBSCRIPTION_INACTIVE');
    expect((err as AppError).details.nextAction).toContain('https://mcp.example.ru/app/billing');
    await expect(st.ent.check({ ...call, tool: tool('operation_status', 'system') })).resolves.toBeDefined();
    // Оплата из кабинета → active с сегодняшнего дня.
    st.clock.now = new Date('2026-12-10T09:00:00.000Z');
    await payInitial(st, 'start');
    sub = await st.subs.get(st.tenantId);
    expect(sub).toMatchObject({
      status: 'active',
      retryCount: 0,
      suspendedAt: null,
      periodStart: '2026-12-10T09:00:00.000Z',
    });
    await expect(st.ent.check(call)).resolves.toBeDefined();
    // «Письма отправлены»: события жизненного цикла.
    expect(st.notifier.types(st.tenantId)).toEqual([
      'payment_succeeded',
      'payment_succeeded',
      'payment_failed',
      'past_due',
      'payment_failed',
      'past_due',
      'payment_failed',
      'past_due',
      'suspended',
      'payment_succeeded',
      'reactivated',
    ]);
  });

  it('пробный период без оплаты → suspended; через 30 дней — событие удаления данных (один раз)', async () => {
    const st = await stand('2026-10-01T00:00:00.000Z');
    st.clock.now = new Date('2026-10-15T00:00:00.000Z');
    await st.billing.renewDue();
    expect((await st.subs.get(st.tenantId))?.status).toBe('suspended');
    expect(st.notifier.types(st.tenantId)).toEqual(['trial_ended', 'suspended']);
    st.clock.now = new Date('2026-11-14T00:00:00.000Z');
    await st.billing.renewDue();
    expect(st.notifier.deletions.filter((d) => d.tenantId === st.tenantId)).toEqual([
      { tenantId: st.tenantId, since: '2026-10-15T00:00:00.000Z' },
    ]);
    await st.billing.renewDue();
    expect(st.notifier.deletions.filter((d) => d.tenantId === st.tenantId)).toHaveLength(1);
    // Данные сервис сам не удаляет.
    expect(await new TenantsRepo(s.db, s.keys).get(st.tenantId)).toMatchObject({ status: 'active' });
  });

  it('отмена: действует до конца периода, затем canceled без списания', async () => {
    const st = await stand();
    await payInitial(st, 'start');
    await st.billing.cancel(st.tenantId);
    st.clock.now = new Date('2026-11-01T09:00:00.000Z');
    const n = st.mock.requests.length;
    expect((await st.billing.renewDue()).canceled).toBe(1);
    expect(st.mock.requests.length).toBe(n);
    expect((await st.subs.get(st.tenantId))?.status).toBe('canceled');
    const err = await st.ent
      .check({ tenantId: st.tenantId, userId: st.userId, tool: tool('crm_list', 'crm') })
      .catch((e: unknown) => e);
    expect((err as AppError).code).toBe('SUBSCRIPTION_INACTIVE');
  });

  it('повышение тарифа: доплата пропорционально остатку в копейках, списание сохранённым способом, сразу', async () => {
    const st = await stand();
    await payInitial(st, 'start'); // 01.10 09:00 – 01.11 09:00 (31 день)
    st.clock.now = new Date('2026-10-11T09:00:00.000Z'); // остаток 21 из 31 дня
    const r = await st.billing.changePlan(st.tenantId, 'team');
    // (299000 − 99000) × 21/31 = 135483,87… → 135484 копейки.
    expect(r).toEqual({
      kind: 'upgraded',
      surchargeKopecks: 135_484,
      paymentId: expect.any(String) as unknown,
    });
    expect(st.mock.requests.at(-1)?.body).toMatchObject({ amount: { value: '1354.84', currency: 'RUB' } });
    const sub = await st.subs.get(st.tenantId);
    expect(sub).toMatchObject({ planCode: 'team', periodEnd: '2026-11-01T09:00:00.000Z' });
    // Понижение — с начала следующего периода; продление по цене нового тарифа.
    const down = await st.billing.changePlan(st.tenantId, 'start');
    expect(down).toMatchObject({ kind: 'scheduled', effectiveAt: '2026-11-01T09:00:00.000Z' });
    expect((await st.subs.get(st.tenantId))?.planCode).toBe('team');
    st.clock.now = new Date('2026-11-01T09:00:00.000Z');
    await st.billing.renewDue();
    expect(await st.subs.get(st.tenantId)).toMatchObject({ planCode: 'start', pendingPlanCode: null });
    expect(st.mock.requests.at(-1)?.body).toMatchObject({ amount: { value: '990.00' } });
  });

  it('повышение без сохранённого способа — страница оплаты; тариф меняется только после оплаты', async () => {
    const st = await stand();
    await payInitial(st, 'start', false);
    st.clock.now = new Date('2026-10-16T21:00:00.000Z');
    const r = await st.billing.changePlan(st.tenantId, 'business');
    expect(r.kind).toBe('payment_pending');
    if (r.kind !== 'payment_pending') throw new Error();
    expect(r.confirmationUrl).toBeDefined();
    expect((await st.subs.get(st.tenantId))?.planCode).toBe('start');
    const pid = [...st.mock.payments.values()].at(-1)?.id ?? '';
    st.mock.complete(pid, 'succeeded', false);
    expect(await st.billing.syncPayment(st.tenantId, r.paymentId)).toBe('succeeded');
    expect((await st.subs.get(st.tenantId))?.planCode).toBe('business');
  });

  it('счёт юрлицу: номер, реквизиты, сумма; ручная отметка владельцем в support_actions, повтор — без изменений', async () => {
    const st = await stand();
    await expect(
      st.billing.issueInvoice(st.tenantId, 'team', { name: 'ООО «Покупатель»', inn: '123' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const inv = await st.billing.issueInvoice(st.tenantId, 'team', {
      name: ' ООО «Покупатель» ',
      inn: '7701234567',
      kpp: '770101001',
      address: 'Москва',
    });
    expect(inv).toMatchObject({ status: 'issued', amountKopecks: 299_000, planCode: 'team' });
    expect(inv.number).toMatch(/^MCP-2026-\d{6}$/);
    expect(inv.buyer.name).toBe('ООО «Покупатель»');
    const other = await stand();
    await expect(other.billing.invoice(other.tenantId, inv.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(st.billing.markInvoicePaid(inv.id, { actor: 'owner', reason: '' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(await st.billing.markInvoicePaid(inv.id, { actor: 'owner', reason: 'п/п №15 от 02.10' })).toEqual({
      alreadyPaid: false,
    });
    expect(await st.billing.markInvoicePaid(inv.id, { actor: 'owner', reason: 'повтор' })).toEqual({
      alreadyPaid: true,
    });
    expect(await st.subs.get(st.tenantId)).toMatchObject({ status: 'active', planCode: 'team' });
    const log = await s.db.all<{ actor: string; action: string; reason: string }>(
      'SELECT actor, action, reason FROM support_actions WHERE tenant_id = ?',
      st.tenantId,
    );
    expect(log).toEqual([{ actor: 'owner', action: 'invoice.mark_paid', reason: 'п/п №15 от 02.10' }]);
    expect((await st.billing.invoice(st.tenantId, inv.id)).status).toBe('paid');
  });

  it('возврат — вручную владельцем, с журналом', async () => {
    const st = await stand();
    const { paymentId } = await payInitial(st, 'start');
    await expect(
      st.billing.refund(paymentId, 100_000, { actor: 'owner', reason: 'x' }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(
      (await st.billing.refund(paymentId, 99_000, { actor: 'owner', reason: 'ошибочная оплата' })).status,
    ).toBe('succeeded');
    const row = await s.db.get<{ status: string; refunded_kopecks: string }>(
      'SELECT status, refunded_kopecks FROM payments WHERE id = ?',
      paymentId,
    );
    expect(row).toMatchObject({ status: 'refunded' });
    expect(Number(row?.refunded_kopecks)).toBe(99_000);
  });

  it('секреты не попадают в логи и ошибки: ключ магазина, способ оплаты, контакт', async () => {
    const st = await stand();
    await payInitial(st, 'start');
    st.clock.now = new Date('2026-11-01T09:00:00.000Z');
    st.mock.chargeOutcomes = ['canceled'];
    await st.billing.renewDue();
    await st.billing.handleNotification(
      { type: 'notification', event: 'payment.succeeded', object: { id: 'nope-1' } },
      YOOKASSA_IP,
    );
    const pmId = [...st.mock.payments.values()][0]?.payment_method?.id ?? '';
    const all = st.logs.join('\n');
    expect(all.length).toBeGreaterThan(0);
    for (const secret of [
      st.mock.secretKey,
      pmId,
      'buh@example.ru',
      Buffer.from(`${st.mock.shopId}:${st.mock.secretKey}`).toString('base64'),
    ])
      expect(all).not.toContain(secret);
  });
});

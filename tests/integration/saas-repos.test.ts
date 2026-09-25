/**
 * SaaS-ТЗ S2 (§6, D7, §9.1): control plane на настоящем PostgreSQL — арендаторы, пользователи (RLS),
 * настройки, тарифы, подписки; конвертное шифрование и криптоудаление.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors/app-error.js';
import { DEFAULT_PLANS, planAllowsModule, PlansRepo, SubscriptionsRepo } from '../../src/saas/repos/plans.js';
import {
  normalizePortalDomain,
  TenantSettingsRepo,
  TenantsRepo,
  TenantUsersRepo,
} from '../../src/saas/repos/tenants.js';
import { openSaasTestDb, PG_AVAILABLE, type SaasTestDb } from '../helpers/saas.js';

let s: SaasTestDb;
beforeAll(async () => {
  if (PG_AVAILABLE) s = await openSaasTestDb();
}, 60_000);
afterAll(async () => {
  if (PG_AVAILABLE) await s.close();
});

const member = () => `m-${randomUUID()}`;

describe.skipIf(!PG_AVAILABLE)('control plane (PostgreSQL)', () => {
  it('арендатор: установка, повторная установка того же портала, домен нормализуется; пробный период один раз', async () => {
    const tenants = new TenantsRepo(s.db, s.keys);
    const memberId = member();
    const first = await tenants.upsertInstalled({
      memberId,
      domain: 'https://Portal-A.bitrix24.ru/',
      appTokenHash: 'h1',
    });
    expect(first.created).toBe(true);
    expect(first.tenant.domain).toBe('portal-a.bitrix24.ru');
    await tenants.setStatus(first.tenant.id, 'uninstalled');
    const again = await tenants.upsertInstalled({
      memberId,
      domain: 'portal-a.bitrix24.ru',
      appTokenHash: 'h2',
    });
    expect(again.created).toBe(false);
    expect(again.tenant.id).toBe(first.tenant.id);
    expect(again.tenant.status).toBe('active');
    expect(await tenants.appTokenHash(first.tenant.id)).toBe('h2');
    expect(await tenants.claimTrial(first.tenant.id)).toBe(true);
    expect(await tenants.claimTrial(first.tenant.id)).toBe(false);
    expect(() => normalizePortalDomain('javascript:alert(1)')).toThrow(AppError);
  });

  it('D7: у каждого арендатора свой DEK; шифротекст A не расшифровать ключом B; криптоудаление', async () => {
    const tenants = new TenantsRepo(s.db, s.keys);
    const a = (
      await tenants.upsertInstalled({ memberId: member(), domain: 'a.bitrix24.ru', appTokenHash: 'x' })
    ).tenant;
    const b = (
      await tenants.upsertInstalled({ memberId: member(), domain: 'b.bitrix24.ru', appTokenHash: 'x' })
    ).tenant;
    const boxA = await s.keys.boxFor(s.db, a.id);
    const boxB = await s.keys.boxFor(s.db, b.id);
    const secret = boxA.encrypt('refresh-token-A', 'bitrix-token');
    expect(boxA.decrypt(secret, 'bitrix-token')).toBe('refresh-token-A');
    expect(() => boxB.decrypt(secret, 'bitrix-token')).toThrow();
    const raw = await s.db.get<{ dek_encrypted: string }>(
      'SELECT dek_encrypted FROM tenants WHERE id = ?',
      a.id,
    );
    expect(raw?.dek_encrypted).not.toContain('refresh');
    await s.keys.destroy(s.db, a.id);
    await expect(s.keys.boxFor(s.db, a.id)).rejects.toMatchObject({
      details: { reason: 'TENANT_KEY_DESTROYED' },
    });
  });

  it('пользователи под RLS: создание при входе, роль по умолчанию, отключение повышает поколение токенов; чужой арендатор не видит', async () => {
    const tenants = new TenantsRepo(s.db, s.keys);
    const users = new TenantUsersRepo(s.db);
    const a = (
      await tenants.upsertInstalled({ memberId: member(), domain: 'u-a.bitrix24.ru', appTokenHash: 'x' })
    ).tenant;
    const b = (
      await tenants.upsertInstalled({ memberId: member(), domain: 'u-b.bitrix24.ru', appTokenHash: 'x' })
    ).tenant;
    const u = await users.upsertFromBitrix({
      tenantId: a.id,
      bitrixUserId: 7,
      displayName: 'Иван',
      email: null,
      defaultRole: 'operator',
    });
    expect(u).toMatchObject({ role: 'operator', status: 'active', tokenGeneration: 0 });
    const again = await users.upsertFromBitrix({
      tenantId: a.id,
      bitrixUserId: 7,
      displayName: 'Иван Т.',
      email: 'i@example.ru',
      defaultRole: 'reader',
    });
    expect(again.id).toBe(u.id);
    expect(again.role).toBe('operator');
    expect(again.email).toBe('i@example.ru');
    await users.setStatus(a.id, u.id, 'disabled');
    expect((await users.get(a.id, u.id))?.tokenGeneration).toBe(1);
    expect(await users.get(b.id, u.id)).toBeUndefined();
    expect(await users.list(b.id)).toEqual([]);
    expect(await users.countActive(a.id)).toBe(0);
  });

  it('настройки арендатора: значения по умолчанию и сохранение', async () => {
    const tenants = new TenantsRepo(s.db, s.keys);
    const settings = new TenantSettingsRepo(s.db);
    const t = (
      await tenants.upsertInstalled({ memberId: member(), domain: 's.bitrix24.ru', appTokenHash: 'x' })
    ).tenant;
    expect(await settings.get(t.id)).toMatchObject({
      modules: [],
      approvalPolicy: 'self',
      defaultRole: 'operator',
    });
    await settings.save({
      tenantId: t.id,
      modules: ['crm', 'tasks'],
      approvalPolicy: 'admin_for_high_risk',
      userDailyCallLimit: 500,
      defaultRole: 'reader',
      outputPolicyJson: null,
    });
    expect(await settings.get(t.id)).toMatchObject({
      modules: ['crm', 'tasks'],
      userDailyCallLimit: 500,
      defaultRole: 'reader',
    });
  });

  it('тарифы §9.1: наполнение не затирает правки владельца; проверка тарифа; модули', async () => {
    const plans = new PlansRepo(s.db);
    const base = DEFAULT_PLANS.find((p) => p.code === 'start');
    if (!base) throw new Error('нет тарифа start');
    await plans.seedDefaults();
    expect((await plans.list({ publicOnly: true })).map((p) => p.code)).toEqual([
      'start',
      'team',
      'business',
    ]);
    const start = await plans.get('start');
    expect(start?.priceKopecks).toBe(99_000);
    await plans.upsert({ ...(start ?? base), priceKopecks: 129_000 });
    await plans.seedDefaults();
    expect((await plans.get('start'))?.priceKopecks).toBe(129_000);
    await expect(plans.upsert({ ...base, modules: ['nonexistent'] })).rejects.toThrow(AppError);
    expect(planAllowsModule(base, 'crm')).toBe(true);
    expect(planAllowsModule(base, 'catalog')).toBe(false);
    expect(planAllowsModule(base, 'system')).toBe(true);
  });

  it('подписка: пробный период, сохранение состояния, выборка к продлению', async () => {
    const tenants = new TenantsRepo(s.db, s.keys);
    const plans = new PlansRepo(s.db);
    await plans.seedDefaults();
    const subs = new SubscriptionsRepo(s.db);
    const t = (
      await tenants.upsertInstalled({ memberId: member(), domain: 'sub.bitrix24.ru', appTokenHash: 'x' })
    ).tenant;
    const trial = await plans.get('trial');
    if (!trial) throw new Error('нет тарифа trial');
    const sub = await subs.startTrial(t.id, trial, new Date('2030-01-01T00:00:00Z'));
    expect(sub).toMatchObject({
      status: 'trialing',
      planCode: 'trial',
      periodEnd: '2030-01-15T00:00:00.000Z',
      hasPaymentMethod: false,
    });
    await subs.save({
      ...sub,
      status: 'active',
      planCode: 'team',
      paymentMethodEncrypted: 'enc-pm',
      paymentMethodTitle: 'Карта *4242',
    });
    expect(await subs.get(t.id)).toMatchObject({
      status: 'active',
      planCode: 'team',
      hasPaymentMethod: true,
      paymentMethodTitle: 'Карта *4242',
    });
    const due = await subs.due('2030-02-01T00:00:00.000Z', 100);
    expect(due.map((d) => d.tenantId)).toContain(t.id);
    await subs.clearPaymentMethod(t.id);
    expect((await subs.get(t.id))?.hasPaymentMethod).toBe(false);
  });
});

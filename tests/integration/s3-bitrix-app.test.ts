/**
 * SaaS-ТЗ S3 (§7.2–7.4, §8, D1–D4, D7): тиражное приложение Bitrix24 на настоящем PostgreSQL и имитации облака
 * Bitrix24 (формы ответов — по официальной документации, см. tests/helpers/s3-bitrix-cloud.ts).
 * Тест-кейсы: установка новая/повторная (пробный период один раз), шифрование токенов, S03 (single-flight),
 * S04 (OnAppUninstall: верный/поддельный application_token), S17 (отказ обновления → reauth_required),
 * провайдер (getAuth, проактивное обновление, изоляция арендаторов), вход через Bitrix24, app.info.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BitrixAuthProvider } from '../../src/auth/bitrix-auth-provider.js';
import { BitrixClient } from '../../src/bitrix/client.js';
import { RateLimiter } from '../../src/bitrix/rate-limiter.js';
import { AppError } from '../../src/errors/app-error.js';
import { createSilentLogger } from '../../src/logging/logger.js';
import { InMemoryCoordination, type Coordination } from '../../src/saas/coordination.js';
import { PlansRepo, SubscriptionsRepo } from '../../src/saas/repos/plans.js';
import { TenantSettingsRepo, TenantsRepo, TenantUsersRepo } from '../../src/saas/repos/tenants.js';
import {
  BitrixAppStatusService,
  BitrixEventsService,
  BitrixInstallService,
  BitrixLoginService,
  BitrixOAuthClient,
  BitrixOAuthProviderFactory,
  BitrixTokenStore,
  bitrixAppUrls,
  parseLaunchParams,
  TENANT_INVALIDATE_CHANNEL,
  tokenAad,
  type PortalClientFactory,
} from '../../src/saas/bitrix/index.js';
import { eventForm, FakeBitrixCloud, OAUTH_ORIGIN } from '../helpers/s3-bitrix-cloud.js';
import { openSaasTestDb, PG_AVAILABLE, type SaasTestDb } from '../helpers/saas.js';

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

const PUBLIC = 'https://mcp.example.test';

/** Один «экземпляр сервиса»: свои объекты, общие БД и координация (как два процесса за балансировщиком). */
function instance(cloud: FakeBitrixCloud, coordination: Coordination = new InMemoryCoordination()) {
  const logger = createSilentLogger();
  const settings = {
    clientId: cloud.clientId,
    clientSecret: cloud.clientSecret,
    oauthServerUrl: OAUTH_ORIGIN,
    publicBaseUrl: PUBLIC,
  };
  const urls = bitrixAppUrls(settings);
  const tenants = new TenantsRepo(s.db, s.keys);
  const users = new TenantUsersRepo(s.db);
  const plans = new PlansRepo(s.db);
  const subscriptions = new SubscriptionsRepo(s.db);
  const tokens = new BitrixTokenStore(s.db, s.keys);
  const oauth = new BitrixOAuthClient({ settings, fetch: cloud.fetch, logger });
  const portal: PortalClientFactory = (auth, hosts) => client(cloud, auth, hosts);
  const providers = new BitrixOAuthProviderFactory({
    tenants,
    users,
    tokens,
    oauth,
    coordination,
    logger,
    urls,
  });
  const install = new BitrixInstallService({
    tenants,
    users,
    plans,
    subscriptions,
    tokens,
    oauth,
    portal,
    coordination,
    logger,
    urls,
  });
  const events = new BitrixEventsService({ db: s.db, tenants, install, coordination, logger });
  const login = new BitrixLoginService({
    tenants,
    users,
    settings: new TenantSettingsRepo(s.db),
    tokens,
    oauth,
    portal,
    coordination,
    logger,
    urls,
  });
  const status = new BitrixAppStatusService({
    db: s.db,
    tenants,
    users,
    tokens,
    providers,
    portal,
    logger,
  });
  return {
    tenants,
    users,
    subscriptions,
    tokens,
    providers,
    install,
    events,
    login,
    status,
    urls,
    coordination,
  };
}

function client(cloud: FakeBitrixCloud, auth: BitrixAuthProvider, hosts: readonly string[]): BitrixClient {
  return new BitrixClient({
    auth,
    fetch: cloud.fetch,
    limiter: new RateLimiter({ requestsPerSecond: 100, maxConcurrency: 4, maxQueueSize: 100 }),
    logger: createSilentLogger(),
    allowedHosts: hosts,
    timeoutMs: 5000,
    uploadTimeoutMs: 5000,
    maxUpstreamResponseBytes: 1_000_000,
    maxReadRetries: 0,
    sleep: () => Promise.resolve(),
  });
}

async function catchApp(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    if (AppError.is(e)) return e;
    throw e;
  }
  throw new Error('ожидалась ошибка');
}

/** Портал с администратором (id 1) и сотрудником (id 7); событие ONAPPINSTALL от администратора. */
function newPortal(cloud: FakeBitrixCloud) {
  const memberId = `m${randomUUID().replaceAll('-', '')}`;
  const domain = `p${randomUUID().slice(0, 8)}.bitrix24.ru`;
  cloud.addPortal(memberId, domain, [
    { id: 1, admin: true, name: 'Анна', lastName: 'Админова' },
    { id: 7, admin: false, name: 'Иван', lastName: 'Тестов' },
  ]);
  const applicationToken = randomUUID().replaceAll('-', '');
  const installBody = (userId = 1, appToken = applicationToken) => {
    const pair = cloud.issue(memberId, userId);
    return eventForm({
      event: 'ONAPPINSTALL',
      data: { VERSION: '1', ACTIVE: 'Y', INSTALLED: 'Y', LANGUAGE_ID: 'ru' },
      auth: {
        domain,
        scope: 'crm,task,user_brief',
        access_token: pair.accessToken,
        refresh_token: pair.refreshToken,
        expires_in: 3600,
        server_endpoint: 'https://oauth.bitrix.info/rest/',
        status: 'F',
        client_endpoint: `https://${domain}/rest/`,
        member_id: memberId,
        application_token: appToken,
      },
    });
  };
  const uninstallBody = (appToken = applicationToken, clean = 0) =>
    eventForm({
      event: 'ONAPPUNINSTALL',
      data: { LANGUAGE_ID: 'ru', CLEAN: clean },
      auth: {
        domain,
        server_endpoint: 'https://oauth.bitrix.info/rest/',
        client_endpoint: `https://${domain}/rest/`,
        member_id: memberId,
        application_token: appToken,
      },
    });
  return { memberId, domain, applicationToken, installBody, uninstallBody };
}

async function installed(cloud: FakeBitrixCloud, w = instance(cloud)) {
  const p = newPortal(cloud);
  const r = await w.events.handle(p.installBody());
  if (r.event !== 'ONAPPINSTALL' || !('install' in r)) throw new Error('не установлено');
  return { ...p, w, install: r.install };
}

describe.skipIf(!PG_AVAILABLE)('S3: установка приложения', () => {
  it('новая установка: арендатор, администратор, токены, подписка на события, пробный период', async () => {
    const cloud = new FakeBitrixCloud();
    const { w, install, memberId, domain } = await installed(cloud);
    expect(install.created).toBe(true);
    expect(install.trialStarted).toBe(true);
    expect(install.nextUrl).toBe(`${PUBLIC}/app`);
    expect(install.warnings).toEqual([]);
    const tenant = await w.tenants.getByMemberId(memberId);
    expect(tenant).toMatchObject({ domain, status: 'active', trialUsed: true });
    const user = await w.users.get(install.tenantId, install.userId);
    expect(user).toMatchObject({ bitrixUserId: 1, role: 'administrator', status: 'active' });
    expect(user?.displayName).toBe('Анна Админова');
    expect(await w.subscriptions.get(install.tenantId)).toMatchObject({
      planCode: 'trial',
      status: 'trialing',
    });
    // Подписка на удаление/обновление — на публичный обработчик сервиса.
    expect([...install.eventsBound].sort()).toEqual(['ONAPPUNINSTALL', 'ONAPPUPDATE']);
    const portal = cloud.portals.get(memberId);
    expect(portal?.handlers.map((h) => h.handler)).toEqual([`${PUBLIC}/b24/events`, `${PUBLIC}/b24/events`]);
    // Подлинность первой установки проверена на сервере авторизации нашим client_secret; секрет — только туда.
    expect(cloud.oauthCalls.map((c) => c.grantType)).toEqual(['refresh_token']);
    expect(
      cloud.urls.filter((u) => u.includes(cloud.clientSecret)).every((u) => u.startsWith(OAUTH_ORIGIN)),
    ).toBe(true);
    expect(cloud.restCalls.every((c) => c.host === domain)).toBe(true);
  });

  it('повторная установка после удаления: тот же арендатор, пробный период не повторяется; событие работающего арендатора с чужим application_token отклонено', async () => {
    const cloud = new FakeBitrixCloud();
    const { w, install, installBody, uninstallBody, memberId } = await installed(cloud);
    // Повтор события с тем же токеном — идемпотентно, без нового пробного периода.
    const again = await w.events.handle(installBody());
    expect(again.event === 'ONAPPINSTALL' && 'install' in again && again.install.created).toBe(false);
    // Подделка: работающий арендатор, другой application_token → 403 без обращения к серверу авторизации.
    const before = cloud.oauthCalls.length;
    const forged = await catchApp(w.events.handle(installBody(1, 'f'.repeat(32))));
    expect(forged).toMatchObject({ code: 'ACCESS_DENIED', details: { reason: 'APP_TOKEN_MISMATCH' } });
    expect(cloud.oauthCalls.length).toBe(before);

    await w.events.handle(uninstallBody());
    expect((await w.tenants.getByMemberId(memberId))?.status).toBe('uninstalled');
    // Переустановка: новый application_token (приложение поставлено заново).
    const newToken = randomUUID().replaceAll('-', '');
    const re = await w.events.handle(installBody(1, newToken));
    if (!('install' in re)) throw new Error('ожидалась установка');
    expect(re.install).toMatchObject({ tenantId: install.tenantId, created: false, trialStarted: false });
    expect((await w.tenants.getByMemberId(memberId))?.status).toBe('active');
    expect(await w.subscriptions.get(install.tenantId)).toMatchObject({ planCode: 'trial' });
    // Подписки на события не дублируются (event.get перед event.bind).
    expect(re.install.eventsBound).toEqual([]);
  });

  it('поддельная установка: пара не подтверждена сервером авторизации или member_id чужой → отказ, арендатор не создан', async () => {
    const cloud = new FakeBitrixCloud();
    const w = instance(cloud);
    const p = newPortal(cloud);
    const fake = eventForm({
      event: 'ONAPPINSTALL',
      auth: {
        domain: p.domain,
        access_token: 'a'.repeat(32),
        refresh_token: 'b'.repeat(32),
        client_endpoint: 'https://evil.example/rest/',
        member_id: p.memberId,
        application_token: p.applicationToken,
      },
    });
    expect(await catchApp(w.events.handle(fake))).toMatchObject({ code: 'ACCESS_DENIED' });
    // Настоящая пара другого портала, выдаваемая за этот member_id.
    const other = newPortal(cloud);
    const pair = cloud.issue(other.memberId, 1);
    const spoof = eventForm({
      event: 'ONAPPINSTALL',
      auth: {
        domain: p.domain,
        access_token: pair.accessToken,
        refresh_token: pair.refreshToken,
        client_endpoint: `https://${p.domain}/rest/`,
        member_id: p.memberId,
        application_token: p.applicationToken,
      },
    });
    expect(await catchApp(w.events.handle(spoof))).toMatchObject({
      code: 'ACCESS_DENIED',
      details: { reason: 'MEMBER_ID_MISMATCH' },
    });
    expect(await w.tenants.getByMemberId(p.memberId)).toBeUndefined();
    // Ни одного запроса на адрес злоумышленника.
    expect(cloud.urls.some((u) => u.includes('evil.example'))).toBe(false);
  });

  it('мастер установки (AUTH_ID/REFRESH_ID): подписка на ONAPPINSTALL/ONAPPUNINSTALL/ONAPPUPDATE; не администратор — отказ', async () => {
    const cloud = new FakeBitrixCloud();
    const w = instance(cloud);
    const p = newPortal(cloud);
    const launch = (userId: number) => {
      const pair = cloud.issue(p.memberId, userId);
      return new URLSearchParams({
        DOMAIN: p.domain,
        PROTOCOL: '1',
        LANG: 'ru',
        APP_SID: 'dd8cec11e347088fe87c44870a9f1dba',
        AUTH_ID: pair.accessToken,
        AUTH_EXPIRES: '3600',
        REFRESH_ID: pair.refreshToken,
        SERVER_ENDPOINT: 'https://oauth.bitrix.info/rest/',
        member_id: p.memberId,
        status: 'F',
        PLACEMENT: 'DEFAULT',
      });
    };
    expect(await catchApp(w.install.prepareInstall(parseLaunchParams(launch(7))))).toMatchObject({
      code: 'ACCESS_DENIED',
      details: { reason: 'INSTALLER_NOT_PORTAL_ADMIN' },
    });
    const r = await w.install.prepareInstall(parseLaunchParams(launch(1)));
    expect(r).toMatchObject({ memberId: p.memberId, domain: p.domain, alreadyInstalled: false });
    expect([...r.eventsBound].sort()).toEqual(['ONAPPINSTALL', 'ONAPPUNINSTALL', 'ONAPPUPDATE']);
    // Арендатор создаётся только событием ONAPPINSTALL (в нём application_token).
    expect(await w.tenants.getByMemberId(p.memberId)).toBeUndefined();
  });

  it('D7: в БД нет открытых токенов; шифротекст привязан к арендатору и пользователю (AAD)', async () => {
    const cloud = new FakeBitrixCloud();
    const a = await installed(cloud);
    const b = await installed(cloud, a.w);
    const rows = await s.db.withTenant(a.install.tenantId, (x) =>
      x.all('SELECT * FROM bitrix_tokens WHERE tenant_id = ?', a.install.tenantId),
    );
    expect(rows).toHaveLength(1);
    expect(cloud.hasPlaintext(JSON.stringify(rows))).toBeUndefined();
    const row = rows[0] as { access_encrypted: string; refresh_encrypted: string };
    const boxA = await s.keys.boxFor(s.db, a.install.tenantId);
    const boxB = await s.keys.boxFor(s.db, b.install.tenantId);
    const aad = tokenAad(a.install.tenantId, a.install.userId);
    expect(boxA.decrypt(row.refresh_encrypted, aad)).toMatch(/^[0-9a-f]{32}$/);
    expect(() => boxB.decrypt(row.refresh_encrypted, aad)).toThrow();
    expect(() => boxA.decrypt(row.refresh_encrypted, tokenAad(a.install.tenantId, randomUUID()))).toThrow();
    // application_token хранится только хешем.
    const t = await s.db.get<{ app_token_hash: string }>(
      'SELECT app_token_hash FROM tenants WHERE id = ?',
      a.install.tenantId,
    );
    expect(t?.app_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(t?.app_token_hash).not.toContain(a.applicationToken);
  });
});

describe.skipIf(!PG_AVAILABLE)('S3: провайдер OAuth пользователя', () => {
  it('getAuth: client_endpoint (legacy) и /rest/api/ (REST 3.0), токен в поле auth; ключ портала общий для пользователей арендатора', async () => {
    const cloud = new FakeBitrixCloud();
    const { w, install, domain, memberId } = await installed(cloud);
    const p = await w.providers.open(install.tenantId, install.userId);
    expect(p.mode).toBe('oauth');
    expect(p.portalOrigin).toBe(`https://${domain}`);
    expect(p.identityUserId).toBe(1);
    expect(p.allowedHosts).toEqual([domain]);
    const legacy = p.getAuth('legacy');
    expect(legacy.baseUrl).toBe(`https://${domain}/rest/`);
    expect(p.getAuth('v3').baseUrl).toBe(`https://${domain}/rest/api/`);
    expect(Object.keys(legacy.bodyFields)).toEqual(['auth']);
    // Второй сотрудник входит через Bitrix24 (полный протокол): ключ портала тот же, токены свои.
    const login = await w.login.completeLogin(cloud.issueCode(memberId, 7));
    expect(login.user).toMatchObject({ bitrixUserId: 7, role: 'operator', status: 'active' });
    const p7 = await w.providers.open(install.tenantId, login.user.id);
    expect(p7.portalKey).toBe(p.portalKey);
    expect(p7.identityUserId).toBe(7);
    expect(p7.getAuth('legacy').bodyFields['auth']).not.toBe(legacy.bodyFields['auth']);
    const r = await client(cloud, p7, p7.allowedHosts).call('legacy', 'profile');
    expect(r.result).toMatchObject({ ID: '7' });
  });

  it('изоляция арендаторов: пользователь A не получает провайдер/токены в контексте B; клиент A не ходит на портал B', async () => {
    const cloud = new FakeBitrixCloud();
    const a = await installed(cloud);
    const b = await installed(cloud, a.w);
    const err = await catchApp(a.w.providers.open(b.install.tenantId, a.install.userId));
    expect(err).toMatchObject({ code: 'BITRIX_AUTH_FAILED', details: { reason: 'USER_NOT_FOUND' } });
    expect(await a.w.tokens.load(b.install.tenantId, a.install.userId)).toBeUndefined();
    // RLS: даже без фильтра по пользователю в контексте B строк A нет.
    const leak = await s.db.withTenant(b.install.tenantId, (x) =>
      x.all('SELECT user_id FROM bitrix_tokens WHERE user_id = ?', a.install.userId),
    );
    expect(leak).toEqual([]);
    const pa = await a.w.providers.open(a.install.tenantId, a.install.userId);
    expect(pa.allowedHosts).toEqual([a.domain]);
    expect(pa.allowedHosts).not.toContain(b.domain);
  });

  it('проактивное обновление: access истекает < 60 с → одна пара заранее, повторно не обновляется', async () => {
    const cloud = new FakeBitrixCloud();
    cloud.expiresIn = 30;
    const { w, install } = await installed(cloud);
    cloud.expiresIn = 3600;
    const p = await w.providers.open(install.tenantId, install.userId);
    const before = cloud.refreshCount;
    const oldToken = p.getAuth('legacy').bodyFields['auth']; // запускает фоновое обновление
    await p.ensureFresh(); // дожидается того же обновления
    expect(cloud.refreshCount).toBe(before + 1);
    expect(p.getAuth('legacy').bodyFields['auth']).not.toBe(oldToken);
    await p.ensureFresh();
    expect(cloud.refreshCount).toBe(before + 1);
    const r = await client(cloud, p, p.allowedHosts).call('legacy', 'profile');
    expect(r.result).toMatchObject({ ID: '1' });
  });

  it('S03: два экземпляра одновременно обновляют токен одного пользователя → один запрос refresh, оба получают новую пару', async () => {
    const cloud = new FakeBitrixCloud();
    const shared = new InMemoryCoordination();
    const { install } = await installed(cloud, instance(cloud, shared));
    const w1 = instance(cloud, shared);
    const w2 = instance(cloud, shared);
    const p1 = await w1.providers.open(install.tenantId, install.userId);
    const p2 = await w2.providers.open(install.tenantId, install.userId);
    cloud.expireAllAccess();
    cloud.oauthDelayMs = 30;
    const before = cloud.refreshCount;
    const genBefore = (await w1.tokens.load(install.tenantId, install.userId))?.generation ?? -1;
    const [r1, r2] = await Promise.all([
      client(cloud, p1, p1.allowedHosts).call('legacy', 'profile'),
      client(cloud, p2, p2.allowedHosts).call('legacy', 'profile'),
    ]);
    expect(r1.result).toMatchObject({ ID: '1' });
    expect(r2.result).toMatchObject({ ID: '1' });
    expect(cloud.refreshCount).toBe(before + 1);
    const a1 = p1.getAuth('legacy').bodyFields['auth'];
    expect(a1).toBe(p2.getAuth('legacy').bodyFields['auth']);
    const stored = await w1.tokens.load(install.tenantId, install.userId);
    expect(stored?.generation).toBe(genBefore + 1);
    expect(stored?.accessToken).toBe(a1);
  });

  it('S17: отказ обновления (invalid_grant) → reauth_required, токены удалены, BITRIX_AUTH_FAILED с nextAction; без повторов', async () => {
    const cloud = new FakeBitrixCloud();
    const shared = new InMemoryCoordination();
    const w = instance(cloud, shared);
    const invalidated: string[] = [];
    await shared.subscribe(TENANT_INVALIDATE_CHANNEL, (m) => invalidated.push(m));
    const { install, memberId } = await installed(cloud, w);
    const genBefore = (await w.users.get(install.tenantId, install.userId))?.tokenGeneration ?? -1;
    const p = await w.providers.open(install.tenantId, install.userId);
    const c = client(cloud, p, p.allowedHosts);
    cloud.expireAllAccess();
    const stored = await w.tokens.load(install.tenantId, install.userId);
    cloud.revokeRefresh(stored?.refreshToken ?? '');
    const oauthBefore = cloud.oauthCalls.length;
    const err = await catchApp(c.call('legacy', 'profile'));
    expect(err.code).toBe('BITRIX_AUTH_FAILED');
    expect(err.details.reason).toBe('OAUTH_invalid_grant');
    expect(err.details.nextAction).toContain(`${PUBLIC}/app`);
    expect(err.details.retryable).toBe(false);
    expect(cloud.oauthCalls.length).toBe(oauthBefore + 1);
    const user = await w.users.get(install.tenantId, install.userId);
    expect(user?.status).toBe('reauth_required');
    expect(user?.tokenGeneration).toBe(genBefore + 1);
    expect(await w.tokens.load(install.tenantId, install.userId)).toBeUndefined();
    expect(invalidated).toContain(`${install.tenantId}:${install.userId}`);
    // Повтор: та же ошибка без единого сетевого запроса (ни к серверу авторизации, ни к порталу).
    const netBefore = cloud.urls.length;
    const again = await catchApp(c.call('legacy', 'profile'));
    expect(again.details.reason).toBe('OAUTH_invalid_grant');
    expect(cloud.urls.length).toBe(netBefore);
    // Другой экземпляр: провайдер не открывается, к серверу авторизации не ходит.
    const other = await catchApp(instance(cloud, shared).providers.open(install.tenantId, install.userId));
    expect(other).toMatchObject({ code: 'BITRIX_AUTH_FAILED', details: { reason: 'REAUTH_REQUIRED' } });
    expect(cloud.urls.length).toBe(netBefore);
    // Повторный вход через Bitrix24 возвращает пользователя в работу.
    const login = await w.login.completeLogin(cloud.issueCode(memberId, 1));
    expect(login.user.status).toBe('active');
  });

  it('S17: истёк платный период приложения (PAYMENT_REQUIRED) → понятный nextAction; сбой сервера авторизации — временная ошибка без reauth', async () => {
    const cloud = new FakeBitrixCloud();
    const { w, install } = await installed(cloud);
    const p = await w.providers.open(install.tenantId, install.userId);
    const c = client(cloud, p, p.allowedHosts);
    cloud.expireAllAccess();
    cloud.oauthHttpFailure = 503;
    const transient = await catchApp(c.call('legacy', 'profile'));
    expect(transient).toMatchObject({ code: 'BITRIX_UPSTREAM_ERROR', details: { retryable: true } });
    expect((await w.users.get(install.tenantId, install.userId))?.status).toBe('active');
    expect(await w.tokens.load(install.tenantId, install.userId)).toBeDefined();
    cloud.oauthHttpFailure = undefined;
    cloud.refreshError = 'PAYMENT_REQUIRED';
    const paid = await catchApp(c.call('legacy', 'profile'));
    expect(paid).toMatchObject({ code: 'BITRIX_AUTH_FAILED', details: { reason: 'OAUTH_PAYMENT_REQUIRED' } });
    expect(paid.details.nextAction).toContain('продлите приложение');
    expect((await w.users.get(install.tenantId, install.userId))?.status).toBe('reauth_required');
  });
});

describe.skipIf(!PG_AVAILABLE)('S3: события приложения', () => {
  async function seedOperations(tenantId: string): Promise<void> {
    const now = new Date().toISOString();
    const exp = new Date(Date.now() + 3_600_000).toISOString();
    await s.db.withTenant(tenantId, async (x) => {
      for (const [id, status] of [
        [randomUUID(), 'prepared'],
        [randomUUID(), 'approved'],
        [randomUUID(), 'succeeded'],
      ] as const) {
        await x.run(
          `INSERT INTO operations (id, tenant_id, principal_id, portal_key, tool, operation_kind, status, canonical_args_hash, policy_version, plan_encrypted, created_at, expires_at)
           VALUES (?, ?, 'u', 'pk', 'task_add', 'create', ?, 'h', 'v1', 'x', ?, ?)`,
          id,
          tenantId,
          status,
          now,
          exp,
        );
      }
    });
  }

  const opStatuses = (tenantId: string) =>
    s.db.withTenant(tenantId, (x) =>
      x.all<{ status: string }>(
        'SELECT status FROM operations WHERE tenant_id = ? ORDER BY status',
        tenantId,
      ),
    );

  it('S04: поддельный application_token → отказ, ничего не изменено; верный → токены удалены, поколения +1, операции аннулированы', async () => {
    const cloud = new FakeBitrixCloud();
    const shared = new InMemoryCoordination();
    const w = instance(cloud, shared);
    const invalidated: string[] = [];
    await shared.subscribe(TENANT_INVALIDATE_CHANNEL, (m) => invalidated.push(m));
    const { install, uninstallBody, memberId } = await installed(cloud, w);
    await w.login.completeLogin(cloud.issueCode(memberId, 7));
    await seedOperations(install.tenantId);
    const gens = async () => (await w.users.list(install.tenantId)).map((u) => u.tokenGeneration);
    const gensBefore = await gens();

    for (const body of [
      uninstallBody('0'.repeat(32)),
      uninstallBody(install.tenantId.replaceAll('-', '')),
      eventForm({ event: 'ONAPPUNINSTALL', auth: { member_id: memberId } }),
      eventForm({
        event: 'ONAPPUNINSTALL',
        auth: { member_id: `m${randomUUID().replaceAll('-', '')}`, application_token: 'a'.repeat(32) },
      }),
    ]) {
      expect(await catchApp(w.events.handle(body))).toMatchObject({ code: 'ACCESS_DENIED' });
    }
    expect((await w.tenants.get(install.tenantId))?.status).toBe('active');
    expect(await w.tokens.usersWithTokens(install.tenantId)).toHaveLength(2);
    expect(await gens()).toEqual(gensBefore);
    expect((await opStatuses(install.tenantId)).map((o) => o.status)).toEqual([
      'approved',
      'prepared',
      'succeeded',
    ]);
    expect(invalidated).toEqual([]);

    const r = await w.events.handle(uninstallBody(undefined, 1));
    if (!('uninstall' in r)) throw new Error('ожидалось удаление');
    expect(r.uninstall).toMatchObject({
      tenantId: install.tenantId,
      tokensDeleted: 2,
      usersRevoked: 2,
      operationsDenied: 2,
      cleanRequested: true,
    });
    const tenant = await w.tenants.get(install.tenantId);
    expect(tenant?.status).toBe('uninstalled');
    expect(tenant?.uninstalledAt).not.toBeNull();
    expect(await w.tokens.usersWithTokens(install.tenantId)).toEqual([]);
    expect(await gens()).toEqual(gensBefore.map((g) => g + 1));
    expect((await opStatuses(install.tenantId)).map((o) => o.status)).toEqual([
      'denied',
      'denied',
      'succeeded',
    ]);
    expect(invalidated).toEqual([install.tenantId]);
    // После удаления провайдер не открывается (приложение не установлено).
    expect(await catchApp(w.providers.open(install.tenantId, install.userId))).toMatchObject({
      details: { reason: 'APP_NOT_INSTALLED' },
    });
  });

  it('ONAPPUPDATE: новый application_token принимается от администратора портала, переподписка без дублей', async () => {
    const cloud = new FakeBitrixCloud();
    const { w, install, memberId, domain, applicationToken } = await installed(cloud);
    const newToken = randomUUID().replaceAll('-', '');
    const update = (userId: number) => {
      const pair = cloud.issue(memberId, userId);
      return eventForm({
        event: 'ONAPPUPDATE',
        data: { VERSION: '2', PREVIOUS_VERSION: '1', LANGUAGE_ID: 'ru' },
        auth: {
          domain,
          access_token: pair.accessToken,
          refresh_token: pair.refreshToken,
          client_endpoint: `https://${domain}/rest/`,
          member_id: memberId,
          application_token: newToken,
        },
      });
    };
    expect(await catchApp(w.events.handle(update(7)))).toMatchObject({ code: 'ACCESS_DENIED' });
    const r = await w.events.handle(update(1));
    expect(r).toMatchObject({ event: 'ONAPPUPDATE', tenantId: install.tenantId, eventsBound: [] });
    // Старый токен больше не подходит, новый — подходит.
    const uninstall = (t: string) =>
      eventForm({ event: 'ONAPPUNINSTALL', auth: { member_id: memberId, application_token: t } });
    expect(await catchApp(w.events.handle(uninstall(applicationToken)))).toMatchObject({
      code: 'ACCESS_DENIED',
    });
    expect(await w.events.handle(uninstall(newToken))).toMatchObject({ event: 'ONAPPUNINSTALL' });
  });
});

describe.skipIf(!PG_AVAILABLE)('S3: вход через Bitrix24 и app.info', () => {
  it('вход: адрес авторизации только для установленного портала; код портала без установки → «установите приложение»', async () => {
    const cloud = new FakeBitrixCloud();
    const { w, domain } = await installed(cloud);
    const state = 'st_' + randomUUID().replaceAll('-', '');
    const url = new URL(await w.login.authorizeUrl(domain.toUpperCase(), state));
    expect(url.origin).toBe(`https://${domain}`);
    expect(url.pathname).toBe('/oauth/authorize/');
    expect(url.searchParams.get('client_id')).toBe(cloud.clientId);
    expect(url.searchParams.get('state')).toBe(state);
    expect(url.toString()).not.toContain(cloud.clientSecret);
    expect(await catchApp(w.login.authorizeUrl('evil.example.com', state))).toMatchObject({
      code: 'NOT_FOUND',
      details: { reason: 'APP_NOT_INSTALLED' },
    });
    const stranger = newPortal(cloud);
    expect(await catchApp(w.login.completeLogin(cloud.issueCode(stranger.memberId, 1)))).toMatchObject({
      code: 'NOT_FOUND',
      details: { reason: 'APP_NOT_INSTALLED' },
    });
    // Код одноразовый: повтор отклоняет сервер авторизации.
    const code = cloud.issueCode(stranger.memberId, 1);
    await catchApp(w.login.completeLogin(code));
    expect(await catchApp(w.login.completeLogin(code))).toMatchObject({ code: 'BITRIX_AUTH_FAILED' });
  });

  it('checkAppStatus: app.info → статус лицензии и оплаты приложения для кабинета, результат сохраняется', async () => {
    const cloud = new FakeBitrixCloud();
    const { w, install, memberId } = await installed(cloud);
    const ok = await w.status.checkAppStatus(install.tenantId);
    expect(ok).toMatchObject({
      ok: true,
      appStatus: 'F',
      installed: true,
      paymentExpired: false,
      daysLeft: null,
      license: 'ru_ent250',
      licenseFamily: 'ent',
      warnings: [],
    });
    const portal = cloud.portals.get(memberId);
    if (portal) portal.appInfo = { ...portal.appInfo, STATUS: 'P', PAYMENT_EXPIRED: 'Y', DAYS: -3 };
    const expired = await w.status.checkAppStatus(install.tenantId);
    expect(expired).toMatchObject({
      ok: true,
      paymentExpired: true,
      daysLeft: -3,
      warnings: ['APP_PAYMENT_EXPIRED'],
    });
    expect(await w.status.lastStatus(install.tenantId)).toEqual(expired);
    // Нет пользователя с рабочими токенами → явное предупреждение, а не молчание.
    await w.tokens.deleteAllForTenant(install.tenantId);
    const none = await w.status.checkAppStatus(install.tenantId);
    expect(none).toMatchObject({ ok: false, warnings: ['NO_AUTHORIZED_USER'] });
  });
});

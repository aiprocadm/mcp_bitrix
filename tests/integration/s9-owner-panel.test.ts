/**
 * SaaS-ТЗ S9: панель владельца `/owner` на настоящем PostgreSQL (без PG — явный skip) через HTTP Fastify.
 * Проверяется: вход паролем + TOTP (неверный пароль/код, повтор кода, блокировка, лимит по IP), cookie и заголовки
 * безопасности, CSRF и Origin, журнал support_actions на каждое действие, блокировка отзывает доступ (реальный
 * AuthorizationServer S4), роль support, отсутствие токенов/секретов/данных порталов на страницах.
 * Возврат — через mock HTTP ЮKassa (не тестовый магазин). Реальный браузер и боевой стенд не проверялись.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSilentLogger } from '../../src/logging/logger.js';
import { BILLING_DEFAULTS, type BillingSettings } from '../../src/saas/billing/settings.js';
import { InMemoryCoordination } from '../../src/saas/coordination.js';
import { NOOP_NOTIFIER } from '../../src/saas/billing/notifier.js';
import { SubscriptionService } from '../../src/saas/billing/subscription-service.js';
import { YooKassaProvider } from '../../src/saas/billing/yookassa.js';
import { PlansRepo, SubscriptionsRepo } from '../../src/saas/repos/plans.js';
import { TenantUsersRepo } from '../../src/saas/repos/tenants.js';
import { OwnerAccounts, ownerSecretsBox } from '../../src/saas/owner/accounts.js';
import { Announcements } from '../../src/saas/owner/announcements.js';
import { registerOwnerPanel, type OwnerPanelDeps } from '../../src/saas/owner/panel.js';
import { base32Encode, totp } from '../../src/saas/owner/totp.js';
import { MetricsRegistry, createSaasMetrics } from '../../src/saas/ops/metrics.js';
import { OperationsStore } from '../../src/storage/operations.js';
import { openSaasTestDb, PG_AVAILABLE, TEST_KEK, type SaasTestDb } from '../helpers/saas.js';
import {
  authorizeToRedirect,
  makeStand,
  newPortal,
  parse,
  registerClient,
  RESOURCE,
  tokenRequest,
  verifierFor,
  type OAuthStand,
} from '../helpers/s4-oauth.js';
import { YOOKASSA_IP, YooKassaMock } from '../helpers/s6s7-yookassa-mock.js';

const CB = 'https://claude.ai/api/mcp/auth_callback';
const OWNER_EMAIL = 'owner@example.ru';
const SUPPORT_EMAIL = 'support@example.ru';
const LOCK_EMAIL = 'lock@example.ru';
const PASSWORD = 'owner correct horse battery';
const PLANTED = {
  target: 'Сделка ПЛАНТ-ЦЕЛЬ-7731',
  argsHash: 'argshash-planted-9f1c',
  bitrixAccess: 'b24-access-PLANTED-token',
  pmTitle: 'Bank card *4444',
};

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

interface Panel {
  app: FastifyInstance;
  base: string;
}

async function fullTokens(st: OAuthStand) {
  const portal = await newPortal(st, 1);
  const clientId = await registerClient(st);
  const verifier = verifierFor('owner');
  const back = await authorizeToRedirect(st, {
    clientId,
    verifier,
    portal: portal.domain,
    loginCode: portal.loginCode,
  });
  const res = await st.as.token(
    tokenRequest({
      grant_type: 'authorization_code',
      code: back.searchParams.get('code') ?? '',
      redirect_uri: CB,
      code_verifier: verifier,
      client_id: clientId,
      resource: RESOURCE,
    }),
  );
  expect(res.status).toBe(200);
  return { ...portal, clientId, ...(parse(res) as { access_token: string; refresh_token: string }) };
}

describe.skipIf(!PG_AVAILABLE)('S9: панель владельца /owner (PostgreSQL)', () => {
  let st: OAuthStand;
  let panel: Panel;
  let deps: OwnerPanelDeps;
  let billing: SubscriptionService;
  let mock: YooKassaMock;
  let accounts: OwnerAccounts;
  const secrets: Record<string, Buffer> = {};
  let trialTenant: Awaited<ReturnType<typeof fullTokens>>;
  let paidTenant: { tenantId: string; domain: string };
  let paymentId: string;
  let invoiceId: string;
  let registry: MetricsRegistry;

  const startPanel = async (extra: Partial<OwnerPanelDeps> = {}): Promise<Panel> => {
    const app = Fastify();
    // Порт неизвестен до listen: origin проверяется по фактическому адресу (как PUBLIC_BASE_URL за nginx).
    const box: { origin: string } = { origin: '' };
    const d: OwnerPanelDeps = {
      ...deps,
      ...extra,
      get publicOrigin() {
        return box.origin;
      },
    };
    registerOwnerPanel(app, d);
    const addr = await app.listen({ port: 0, host: '127.0.0.1' });
    box.origin = addr;
    return { app, base: addr };
  };

  const form = (f: Record<string, string>) => new URLSearchParams(f).toString();
  const post = (p: Panel, path: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(`${p.base}${path}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: p.base, ...headers },
      body: form(body),
    });
  const get = (p: Panel, path: string, cookie?: string) =>
    fetch(`${p.base}${path}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  const code = (email: string) => totp(secrets[email] ?? Buffer.alloc(0), st.clock.t);
  const login = async (email: string, p = panel): Promise<{ cookie: string; csrf: string }> => {
    st.clock.advance(31); // новый шаг TOTP: повтор кода отклоняется
    const r = await post(p, '/owner/login', { email, password: PASSWORD, code: code(email) });
    expect(r.status).toBe(303);
    const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const pageHtml = await (await get(p, '/owner/tenants', cookie)).text();
    const csrf = /name="_csrf" value="([^"]+)"/.exec(pageHtml)?.[1] ?? '';
    expect(csrf).not.toBe('');
    return { cookie, csrf };
  };
  const actions = async (tenantId: string | null, action: string) =>
    tenantId === null
      ? s.db.all<{ actor: string; reason: string; details_json: string }>(
          'SELECT actor, reason, details_json FROM support_actions WHERE tenant_id IS NULL AND action = ? ORDER BY id',
          action,
        )
      : s.db.all<{ actor: string; reason: string; details_json: string }>(
          'SELECT actor, reason, details_json FROM support_actions WHERE tenant_id = ? AND action = ? ORDER BY id',
          tenantId,
          action,
        );

  beforeAll(async () => {
    st = await makeStand(s);
    mock = new YooKassaMock();
    const plans = new PlansRepo(s.db);
    const subs = new SubscriptionsRepo(s.db);
    const now = () => new Date(st.clock.t);
    billing = new SubscriptionService({
      db: s.db,
      keys: s.keys,
      plans,
      settings: SETTINGS,
      notifier: NOOP_NOTIFIER,
      logger: createSilentLogger(),
      provider: new YooKassaProvider({
        settings: {
          shopId: mock.shopId,
          secretKey: mock.secretKey,
          apiUrl: 'https://api.yookassa.ru/v3',
          timeoutMs: 5000,
        },
        seller: SETTINGS.seller,
        fetch: mock.fetch,
        sleep: () => Promise.resolve(),
      }),
      users: new TenantUsersRepo(s.db),
      coordination: st.coordination,
      now,
    });
    const trial = await plans.get('trial');
    if (!trial) throw new Error('trial');

    // Арендатор на пробном периоде с пользователем, MCP-токенами, операцией, аудитом и токенами Bitrix24.
    trialTenant = await fullTokens(st);
    await subs.startTrial(trialTenant.tenantId, trial, now());
    const user = await st.verifier.verify(`Bearer ${trialTenant.access_token}`);
    await new OperationsStore(s.db, trialTenant.tenantId).createPrepared({
      id: `op-${randomUUID()}`,
      principalId: user.userId,
      portalKey: 'k',
      tool: 'task_create',
      operationKind: 'create',
      argsHash: PLANTED.argsHash,
      target: PLANTED.target,
      expectedStateHash: null,
      fileHash: null,
      policyVersion: '1',
      planEncrypted: 'x',
      idempotencyKey: null,
      expiresAt: new Date(st.clock.t + 3600_000).toISOString(),
    });
    await s.db.withTenant(trialTenant.tenantId, async (x) => {
      for (const codeName of ['BITRIX_ACCESS_DENIED', 'BITRIX_ACCESS_DENIED', 'QUOTA_EXCEEDED']) {
        await x.run(
          `INSERT INTO audit (tenant_id, ts, request_id, principal_hash, portal_key, tool, method, operation_kind, target_alias, args_hash, outcome, error_code)
           VALUES (?, ?, ?, 'ph', 'k', 'crm_get', 'crm.deal.get', 'read', ?, ?, 'error', ?)`,
          trialTenant.tenantId,
          new Date(st.clock.t - 3600_000).toISOString(),
          randomUUID(),
          PLANTED.target,
          PLANTED.argsHash,
          codeName,
        );
      }
      await x.run(
        `INSERT INTO bitrix_tokens (tenant_id, user_id, access_encrypted, refresh_encrypted, access_expires_at, refresh_issued_at, client_endpoint, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'https://x.bitrix24.ru/rest/', ?)`,
        trialTenant.tenantId,
        user.userId,
        PLANTED.bitrixAccess,
        PLANTED.bitrixAccess,
        now().toISOString(),
        now().toISOString(),
        now().toISOString(),
      );
    });

    // Оплативший арендатор: первая оплата картой (mock ЮKassa) и счёт юрлицу.
    const paid = await newPortal(st, 1);
    paidTenant = { tenantId: paid.tenantId, domain: paid.domain };
    await subs.startTrial(paid.tenantId, trial, now());
    const checkout = await billing.checkout(paid.tenantId, {
      planCode: 'start',
      contact: { email: 'buh@example.ru' },
      savePaymentMethod: true,
    });
    paymentId = checkout.paymentId;
    const providerId = [...mock.payments.values()].at(-1)?.id ?? '';
    mock.complete(providerId, 'succeeded', true);
    await billing.handleNotification(mock.notification(providerId), YOOKASSA_IP);
    await s.db.run(
      'UPDATE subscriptions SET payment_method_title = ? WHERE tenant_id = ?',
      PLANTED.pmTitle,
      paid.tenantId,
    );
    invoiceId = (
      await billing.issueInvoice(paid.tenantId, 'team', { name: 'ООО «Покупатель»', inn: '7701234567' })
    ).id;

    accounts = new OwnerAccounts({ db: s.db, secrets: ownerSecretsBox(TEST_KEK), now: st.clock.now });
    for (const [email, role] of [
      [OWNER_EMAIL, 'service_owner'],
      [SUPPORT_EMAIL, 'support'],
      [LOCK_EMAIL, 'service_owner'],
    ] as const) {
      const r = await accounts.create({ email, role, password: PASSWORD });
      secrets[email] = r.secret;
    }
    registry = new MetricsRegistry();
    createSaasMetrics(registry).toolCall('crm_list', 'QUOTA_EXCEEDED', 0.01);

    deps = {
      db: s.db,
      ownerSecrets: ownerSecretsBox(TEST_KEK),
      tenants: st.tenants,
      plans,
      subscriptions: subs,
      billing,
      coordination: st.coordination,
      revokeTenant: (id) => st.as.revokeTenant(id),
      metrics: registry,
      logger: createSilentLogger(),
      publicOrigin: '',
      now: st.clock.now,
      loginLimits: { perIp: 1000, perAccount: 1000, windowMs: 15 * 60_000 },
    };
    panel = await startPanel();
  }, 60_000);

  afterAll(async () => {
    await panel.app.close();
  });

  it('заголовки безопасности: CSP default-src self, frame-ancestors none, без inline-стилей и скриптов', async () => {
    const r = await get(panel, '/owner/login');
    expect(r.status).toBe(200);
    const csp = r.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    const body = await r.text();
    expect(body).not.toMatch(/<script|style=|<style/i);
    expect(body).toContain('/owner/static/owner.css');
    const css = await get(panel, '/owner/static/owner.css');
    expect(css.headers.get('content-type')).toContain('text/css');
    // Без сессии страницы закрыты.
    const tenants = await get(panel, '/owner/tenants');
    expect(tenants.status).toBe(303);
    expect(tenants.headers.get('location')).toBe('/owner/login');
    const forged = await get(
      panel,
      '/owner/tenants',
      'mcp_owner=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    );
    expect(forged.status).toBe(303);
  });

  it('вход: неверный пароль / неверный или повторный TOTP → 401; верный → cookie HttpOnly Secure SameSite=Strict; журнал', async () => {
    st.clock.advance(31);
    const bad1 = await post(panel, '/owner/login', {
      email: OWNER_EMAIL,
      password: 'wrong password 123',
      code: code(OWNER_EMAIL),
    });
    expect(bad1.status).toBe(401);
    const wrong = code(OWNER_EMAIL) === '000000' ? '111111' : '000000';
    const bad2 = await post(panel, '/owner/login', { email: OWNER_EMAIL, password: PASSWORD, code: wrong });
    expect(bad2.status).toBe(401);
    const unknown = await post(panel, '/owner/login', {
      email: 'nobody@example.ru',
      password: PASSWORD,
      code: '123456',
    });
    expect(unknown.status).toBe(401);
    expect(await unknown.text()).toContain('Неверный email, пароль или код');

    const c = code(OWNER_EMAIL);
    const ok = await post(panel, '/owner/login', { email: OWNER_EMAIL, password: PASSWORD, code: c });
    expect(ok.status).toBe(303);
    const setCookie = ok.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^mcp_owner=[A-Za-z0-9_-]{40,}/);
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/owner'])
      expect(setCookie).toContain(attr);
    // Тот же код (тот же шаг) второй раз не принимается — защита от повтора.
    const replay = await post(panel, '/owner/login', { email: OWNER_EMAIL, password: PASSWORD, code: c });
    expect(replay.status).toBe(401);
    // Код предыдущего шага (в окне −1) тоже не принимается: его шаг меньше уже принятого.
    const prev = totp(secrets[OWNER_EMAIL] ?? Buffer.alloc(0), st.clock.t - 30_000);
    expect(
      (await post(panel, '/owner/login', { email: OWNER_EMAIL, password: PASSWORD, code: prev })).status,
    ).toBe(401);
    expect((await actions(null, 'owner.login')).some((a) => a.actor === OWNER_EMAIL)).toBe(true);
    // Не-JSON и без полей — 400.
    const empty = await post(panel, '/owner/login', { email: OWNER_EMAIL });
    expect(empty.status).toBe(400);
    // Чужой Origin — отказ ещё до проверки пароля.
    const cross = await post(
      panel,
      '/owner/login',
      { email: OWNER_EMAIL, password: PASSWORD, code: code(OWNER_EMAIL) },
      { origin: 'https://evil.example' },
    );
    expect(cross.status).toBe(403);
  });

  it('блокировка учётной записи после 5 неудач: верные данные не принимаются 15 минут, затем вход работает', async () => {
    for (let i = 0; i < 5; i += 1) {
      const r = await post(panel, '/owner/login', {
        email: LOCK_EMAIL,
        password: 'bad password 12345',
        code: '000000',
      });
      expect(r.status).toBe(401);
    }
    st.clock.advance(31);
    const locked = await post(panel, '/owner/login', {
      email: LOCK_EMAIL,
      password: PASSWORD,
      code: code(LOCK_EMAIL),
    });
    expect(locked.status).toBe(429);
    const row = await s.db.get<{ locked_until: string | null }>(
      'SELECT locked_until FROM owner_users WHERE name = ?',
      LOCK_EMAIL,
    );
    expect(Date.parse(row?.locked_until ?? '')).toBeGreaterThan(st.clock.t);
    st.clock.advance(16 * 60);
    const { cookie } = await login(LOCK_EMAIL);
    expect(cookie).toMatch(/^mcp_owner=/);
  });

  it('лимит попыток входа по IP (общий Coordination): лишние попытки → 429 даже для неизвестного email', async () => {
    const tight = await startPanel({
      loginLimits: { perIp: 3, perAccount: 100, windowMs: 60_000 },
      coordination: new InMemoryCoordination(st.clock.now),
    });
    try {
      for (let i = 0; i < 3; i += 1) {
        const r = await post(tight, '/owner/login', {
          email: `x${String(i)}@example.ru`,
          password: 'p'.repeat(20),
          code: '123456',
        });
        expect(r.status).toBe(401);
      }
      const r = await post(tight, '/owner/login', {
        email: OWNER_EMAIL,
        password: PASSWORD,
        code: code(OWNER_EMAIL),
      });
      expect(r.status).toBe(429);
    } finally {
      await tight.app.close();
    }
    // Окно прошло — снова можно (другие тесты используют основной экземпляр с широкими лимитами).
  });

  it('CSRF и Origin: без токена, с чужим токеном или с чужого сайта — 403 и ничего не меняется', async () => {
    const { cookie, csrf } = await login(OWNER_EMAIL);
    const path = `/owner/tenants/${trialTenant.tenantId}/extend-trial`;
    const before = await billing.invoices(trialTenant.tenantId);
    const sub0 = await deps.subscriptions.get(trialTenant.tenantId);
    const noToken = await post(panel, path, { days: '7', reason: 'клиент попросил' }, { cookie });
    expect(noToken.status).toBe(403);
    const badToken = await post(
      panel,
      path,
      { days: '7', reason: 'клиент попросил', _csrf: 'x'.repeat(43) },
      { cookie },
    );
    expect(badToken.status).toBe(403);
    const cross = await post(
      panel,
      path,
      { days: '7', reason: 'клиент попросил', _csrf: csrf },
      { cookie, origin: 'https://evil.example' },
    );
    expect(cross.status).toBe(403);
    const noCookie = await post(panel, path, { days: '7', reason: 'клиент попросил', _csrf: csrf });
    expect(noCookie.status).toBe(401);
    expect((await deps.subscriptions.get(trialTenant.tenantId))?.periodEnd).toBe(sub0?.periodEnd);
    expect(await actions(trialTenant.tenantId, 'trial.extend')).toHaveLength(0);
    expect(await billing.invoices(trialTenant.tenantId)).toEqual(before);
  });

  it('продление пробного периода → +N дней и запись support_actions; без основания — отказ', async () => {
    const { cookie, csrf } = await login(OWNER_EMAIL);
    const path = `/owner/tenants/${trialTenant.tenantId}/extend-trial`;
    const noReason = await post(panel, path, { days: '7', reason: ' ', _csrf: csrf }, { cookie });
    expect(noReason.status).toBe(400);
    const tooMany = await post(panel, path, { days: '365', reason: 'просьба', _csrf: csrf }, { cookie });
    expect(tooMany.status).toBe(400);
    const before = await deps.subscriptions.get(trialTenant.tenantId);
    const r = await post(
      panel,
      path,
      { days: '7', reason: 'пилот, письмо от 25.09', _csrf: csrf },
      { cookie },
    );
    expect(r.status).toBe(303);
    const after = await deps.subscriptions.get(trialTenant.tenantId);
    expect(Date.parse(after?.periodEnd ?? '') - Date.parse(before?.periodEnd ?? '')).toBe(7 * 86_400_000);
    const log = await actions(trialTenant.tenantId, 'trial.extend');
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actor: OWNER_EMAIL, reason: 'пилот, письмо от 25.09' });
    expect(JSON.parse(log[0]?.details_json ?? '{}')).toMatchObject({ days: 7, role: 'service_owner' });
    // Оплаченную подписку как пробную не продлить.
    const paidR = await post(
      panel,
      `/owner/tenants/${paidTenant.tenantId}/extend-trial`,
      { days: '3', reason: 'просьба клиента', _csrf: csrf },
      { cookie },
    );
    expect(paidR.status).toBe(409);
  });

  it('страницы не содержат токенов, секретов, способа оплаты и данных порталов; ошибки — только коды', async () => {
    const { cookie } = await login(OWNER_EMAIL);
    const pages = [
      '/owner/tenants',
      `/owner/tenants/${trialTenant.tenantId}`,
      `/owner/tenants/${paidTenant.tenantId}`,
      '/owner/payments',
      '/owner/plans',
      '/owner/announcements',
      '/owner/metrics',
      '/owner/journal',
    ];
    const pmEncrypted = await deps.subscriptions.paymentMethodEncrypted(paidTenant.tenantId);
    const forbidden = [
      trialTenant.access_token,
      trialTenant.refresh_token,
      PLANTED.bitrixAccess,
      PLANTED.target,
      PLANTED.argsHash,
      PLANTED.pmTitle,
      pmEncrypted ?? 'no-pm',
      TEST_KEK.toString('hex'),
      PASSWORD,
      ...Object.values(secrets).map((b) => base32Encode(b)),
      'buh@example.ru',
      'totp_secret',
      'password_hash',
      'idem',
    ];
    for (const p of pages) {
      const r = await get(panel, p, cookie);
      expect(r.status, p).toBe(200);
      const html = await r.text();
      for (const f of forbidden) expect(html.includes(f), `${p} содержит ${f.slice(0, 12)}`).toBe(false);
      expect(html).not.toMatch(/<script|style=/i);
    }
    const detail = await (await get(panel, `/owner/tenants/${trialTenant.tenantId}`, cookie)).text();
    expect(detail).toContain('BITRIX_ACCESS_DENIED</code>&nbsp;2');
    expect(detail).toContain('QUOTA_EXCEEDED</code>&nbsp;1');
    expect(detail).toContain(trialTenant.domain);
    const list = await (await get(panel, '/owner/tenants', cookie)).text();
    expect(list).toContain(trialTenant.domain);
    const metrics = await (await get(panel, '/owner/metrics', cookie)).text();
    expect(metrics).toContain('QUOTA_EXCEEDED');
    expect(metrics).toContain('990.00 ₽'); // MRR: одна подписка «Старт»
  });

  it('роль support: видит и продлевает пробный период, но не блокирует и не делает возвраты', async () => {
    const { cookie, csrf } = await login(SUPPORT_EMAIL);
    const page = await (await get(panel, `/owner/tenants/${trialTenant.tenantId}`, cookie)).text();
    expect(page).not.toContain('/block');
    const block = await post(
      panel,
      `/owner/tenants/${trialTenant.tenantId}/block`,
      { reason: 'злоупотребление', confirm: trialTenant.domain, _csrf: csrf },
      { cookie },
    );
    expect(block.status).toBe(403);
    const refund = await post(
      panel,
      `/owner/payments/${paymentId}/refund`,
      { amount: '1.00', reason: 'ошибка', _csrf: csrf },
      { cookie },
    );
    expect(refund.status).toBe(403);
    const ext = await post(
      panel,
      `/owner/tenants/${trialTenant.tenantId}/extend-trial`,
      { days: '1', reason: 'обращение в поддержку', _csrf: csrf },
      { cookie },
    );
    expect(ext.status).toBe(303);
    const log = await actions(trialTenant.tenantId, 'trial.extend');
    expect(log.at(-1)).toMatchObject({ actor: SUPPORT_EMAIL });
    expect((await st.tenants.get(trialTenant.tenantId))?.status).toBe('active');
  });

  it('блокировка: подтверждение доменом, статус suspended, отзыв MCP-токенов и операций, журнал; разблокировка', async () => {
    const { cookie, csrf } = await login(OWNER_EMAIL);
    const path = `/owner/tenants/${trialTenant.tenantId}/block`;
    // Access-токен живёт 10 минут, часы теста ушли вперёд: свежая пара через refresh (ротация).
    const fresh = parse(
      await st.as.token(
        tokenRequest({
          grant_type: 'refresh_token',
          refresh_token: trialTenant.refresh_token,
          client_id: trialTenant.clientId,
        }),
      ),
    ) as { access_token: string; refresh_token: string };
    trialTenant = { ...trialTenant, access_token: fresh.access_token, refresh_token: fresh.refresh_token };
    await st.verifier.verify(`Bearer ${trialTenant.access_token}`); // до блокировки токен действует
    const noConfirm = await post(
      panel,
      path,
      { reason: 'нарушение оферты п.5', confirm: 'wrong.bitrix24.ru', _csrf: csrf },
      { cookie },
    );
    expect(noConfirm.status).toBe(400);
    const r = await post(
      panel,
      path,
      { reason: 'нарушение оферты п.5', confirm: trialTenant.domain, _csrf: csrf },
      { cookie },
    );
    expect(r.status).toBe(303);
    expect((await st.tenants.get(trialTenant.tenantId))?.status).toBe('suspended');
    await expect(st.verifier.verify(`Bearer ${trialTenant.access_token}`)).rejects.toMatchObject({
      status: 401,
    });
    const refresh = await st.as.token(
      tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: trialTenant.refresh_token,
        client_id: trialTenant.clientId,
      }),
    );
    expect(parse(refresh)['error']).toBe('invalid_grant');
    const ops = await s.db.withTenant(trialTenant.tenantId, (x) =>
      x.all<{ status: string }>('SELECT status FROM operations WHERE tenant_id = ?', trialTenant.tenantId),
    );
    expect(ops.map((o) => o.status)).toEqual(['denied']);
    const log = await actions(trialTenant.tenantId, 'tenant.block');
    expect(log).toHaveLength(1);
    const det = JSON.parse(log[0]?.details_json ?? '{}') as {
      refreshRevoked: number;
      operationsDenied: number;
    };
    expect(det.operationsDenied).toBe(1);
    expect(det.refreshRevoked).toBeGreaterThanOrEqual(1);
    expect(log[0]?.reason).toBe('нарушение оферты п.5');
    // Повторная блокировка — конфликт, журнал не растёт.
    const again = await post(
      panel,
      path,
      { reason: 'повтор', confirm: trialTenant.domain, _csrf: csrf },
      { cookie },
    );
    expect(again.status).toBe(409);

    const un = await post(
      panel,
      `/owner/tenants/${trialTenant.tenantId}/unblock`,
      { reason: 'оплатил штраф', _csrf: csrf },
      { cookie },
    );
    expect(un.status).toBe(303);
    expect((await st.tenants.get(trialTenant.tenantId))?.status).toBe('active');
    expect(await actions(trialTenant.tenantId, 'tenant.unblock')).toHaveLength(1);
    // Отозванные токены не оживают после разблокировки (поколение увеличено).
    await expect(st.verifier.verify(`Bearer ${trialTenant.access_token}`)).rejects.toMatchObject({
      status: 401,
    });
  });

  it('отметка оплаты счёта и возврат — журнал support_actions; повторная отметка ничего не меняет', async () => {
    const { cookie, csrf } = await login(OWNER_EMAIL);
    const mark = await post(
      panel,
      `/owner/invoices/${invoiceId}/mark-paid`,
      { reason: 'п/п №15 от 02.10', _csrf: csrf },
      { cookie },
    );
    expect(mark.status).toBe(303);
    expect(mark.headers.get('location')).toBe('/owner/payments?ok=paid');
    const again = await post(
      panel,
      `/owner/invoices/${invoiceId}/mark-paid`,
      { reason: 'повтор', _csrf: csrf },
      { cookie },
    );
    expect(again.headers.get('location')).toBe('/owner/payments?ok=already');
    expect(await actions(paidTenant.tenantId, 'invoice.mark_paid')).toEqual([
      expect.objectContaining({ actor: OWNER_EMAIL, reason: 'п/п №15 от 02.10' }),
    ]);
    expect((await deps.subscriptions.get(paidTenant.tenantId))?.planCode).toBe('team');

    const tooMuch = await post(
      panel,
      `/owner/payments/${paymentId}/refund`,
      { amount: '5000', reason: 'ошибочная оплата', _csrf: csrf },
      { cookie },
    );
    expect(tooMuch.status).toBe(400);
    expect(await actions(paidTenant.tenantId, 'payment.refund_failed')).toHaveLength(1);
    const ok = await post(
      panel,
      `/owner/payments/${paymentId}/refund`,
      { amount: '100,50', reason: 'ошибочная оплата', _csrf: csrf },
      { cookie },
    );
    expect(ok.status).toBe(303);
    const refunds = await actions(paidTenant.tenantId, 'payment.refund');
    expect(refunds).toHaveLength(1);
    expect(JSON.parse(refunds[0]?.details_json ?? '{}')).toMatchObject({ amountKopecks: 10_050, paymentId });
    const refundReq = mock.requests.filter((q) => q.url.endsWith('/refunds'));
    expect(refundReq).toHaveLength(1);
  });

  it('тариф: правка цены/лимитов → plans и журнал (было/стало); некорректный модуль — отказ', async () => {
    const { cookie, csrf } = await login(OWNER_EMAIL);
    const base = {
      code: 'start',
      name: 'Старт',
      price: '1190.00',
      periodMonths: '1',
      trialDays: '0',
      users: '5',
      calls: '6000',
      writes: '400',
      modules: 'system,crm,tasks,calendar,chat,disk',
      public: '1',
      active: '1',
      sort: '10',
      reason: 'новые цены с 01.10',
      _csrf: csrf,
    };
    const bad = await post(panel, '/owner/plans', { ...base, modules: 'crm,unknown' }, { cookie });
    expect(bad.status).toBe(400);
    const r = await post(panel, '/owner/plans', base, { cookie });
    expect(r.status).toBe(303);
    const plan = await deps.plans.get('start');
    expect(plan).toMatchObject({
      priceKopecks: 119_000,
      limits: { users: 5, callsPerMonth: 6000, writesPerMonth: 400 },
    });
    const log = await actions(null, 'plan.update');
    expect(log).toHaveLength(1);
    const d = JSON.parse(log[0]?.details_json ?? '{}') as {
      before: { priceKopecks: number };
      after: { priceKopecks: number };
    };
    expect(d.before.priceKopecks).toBe(99_000);
    expect(d.after.priceKopecks).toBe(119_000);
  });

  it('объявления: публикация и снятие → журнал; кабинет получает действующие объявления арендатора', async () => {
    const { cookie, csrf } = await login(OWNER_EMAIL);
    const r = await post(
      panel,
      '/owner/announcements',
      {
        level: 'warning',
        title: 'Плановые работы',
        body: 'В субботу 02:00–03:00 МСК',
        tenantId: '',
        startsAt: '',
        endsAt: '',
        _csrf: csrf,
      },
      { cookie },
    );
    expect(r.status).toBe(303);
    const r2 = await post(
      panel,
      '/owner/announcements',
      {
        level: 'info',
        title: 'Лично вам',
        body: 'Продлили пробный период',
        tenantId: paidTenant.tenantId,
        _csrf: csrf,
      },
      { cookie },
    );
    expect(r2.status).toBe(303);
    const at = new Date(st.clock.t + 1000).toISOString();
    const forPaid = await Announcements.activeFor(s.db, paidTenant.tenantId, at);
    expect(forPaid.map((a) => a.title).sort()).toEqual(['Лично вам', 'Плановые работы']);
    const forTrial = await Announcements.activeFor(s.db, trialTenant.tenantId, at);
    expect(forTrial.map((a) => a.title)).toEqual(['Плановые работы']);
    expect(await actions(null, 'announcement.create')).toHaveLength(1);
    expect(await actions(paidTenant.tenantId, 'announcement.create')).toHaveLength(1);
    const id = forTrial[0]?.id ?? 0;
    const off = await post(
      panel,
      `/owner/announcements/${String(id)}/deactivate`,
      { _csrf: csrf },
      { cookie },
    );
    expect(off.status).toBe(303);
    expect(await Announcements.activeFor(s.db, trialTenant.tenantId, at)).toHaveLength(0);
    expect(await actions(null, 'announcement.deactivate')).toHaveLength(1);
    // Текст из формы экранируется на странице.
    await post(
      panel,
      '/owner/announcements',
      { level: 'info', title: '<img src=x onerror=alert(1)>', body: 'x', _csrf: csrf },
      { cookie },
    );
    const page = await (await get(panel, '/owner/announcements', cookie)).text();
    expect(page).not.toContain('<img src=x');
    expect(page).toContain('&lt;img src=x');
  });

  it('выход: сессия закрыта, cookie сброшен, запись в журнале; истёкшая по бездействию сессия не действует', async () => {
    const { cookie, csrf } = await login(OWNER_EMAIL);
    const out = await post(panel, '/owner/logout', { _csrf: csrf }, { cookie });
    expect(out.status).toBe(303);
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await get(panel, '/owner/tenants', cookie)).status).toBe(303);
    expect((await actions(null, 'owner.logout')).length).toBeGreaterThanOrEqual(1);

    const s2 = await login(OWNER_EMAIL);
    st.clock.advance(31 * 60); // 31 минута бездействия
    expect((await get(panel, '/owner/tenants', s2.cookie)).status).toBe(303);
  });

  it('секрет TOTP хранится только зашифрованным; пароль — scrypt', async () => {
    const row = await s.db.get<{ password_hash: string; totp_secret_encrypted: string }>(
      'SELECT password_hash, totp_secret_encrypted FROM owner_users WHERE name = ?',
      OWNER_EMAIL,
    );
    expect(row?.password_hash).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(row?.totp_secret_encrypted).not.toContain(base32Encode(secrets[OWNER_EMAIL] ?? Buffer.alloc(0)));
    expect(row?.totp_secret_encrypted).not.toContain(
      (secrets[OWNER_EMAIL] ?? Buffer.alloc(0)).toString('base64'),
    );
    // Повторное создание той же записи — конфликт, секрет не меняется.
    await expect(
      accounts.create({ email: OWNER_EMAIL, role: 'support', password: PASSWORD }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(
      accounts.create({ email: 'short@example.ru', role: 'support', password: 'short' }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });
});

describe.skipIf(!PG_AVAILABLE)('S9: CLI npm run owner (PostgreSQL)', () => {
  const run = (args: string[], cfg: string) =>
    spawnSync(
      process.execPath,
      ['--import', 'tsx', path.resolve('src/cli/owner.ts'), ...args, '--config', cfg],
      {
        cwd: path.resolve('.'),
        input: `${PASSWORD}\n`,
        timeout: 30_000,
        encoding: 'utf8',
        env: { ...process.env, LOG_LEVEL: 'silent' },
      },
    );

  it('list работает; create без терминала отказывает до создания записи и не печатает секрет', async () => {
    await new OwnerAccounts({ db: s.db, secrets: ownerSecretsBox(TEST_KEK) })
      .create({ email: 'cli-list@example.ru', role: 'service_owner', password: PASSWORD })
      .catch(() => undefined);
    const dir = mkdtempSync(path.join(tmpdir(), 's9-cli-'));
    writeFileSync(path.join(dir, 'kek'), `${TEST_KEK.toString('hex')}\n`, { mode: 0o600 });
    writeFileSync(path.join(dir, 'b24'), 'client-secret-for-cli-test\n', { mode: 0o600 });
    const cfg = path.join(dir, 'saas.env');
    writeFileSync(
      cfg,
      [
        'DEPLOYMENT_MODE=saas',
        'PUBLIC_BASE_URL=https://mcp.example.ru',
        'MCP_TRANSPORT=http',
        `DATABASE_URL=${s.server.url}`,
        'REDIS_URL=redis://127.0.0.1:6379',
        'KEK_FILE=./kek',
        'B24_APP_CLIENT_ID=app.test',
        'B24_APP_CLIENT_SECRET_FILE=./b24',
        `OAUTH_SIGNING_KEYS_DIR=${dir}`,
      ].join('\n'),
    );
    const list = run(['list'], cfg);
    expect(list.stderr).toBe('');
    expect(list.status).toBe(0);
    expect(list.stdout).toMatch(/cli-list@example\.ru\s+service_owner/);
    const create = run(['create', '--email', 'cli@example.ru'], cfg);
    expect(create.status).toBe(1);
    expect(create.stderr).toContain('ACCESS_DENIED');
    expect(create.stdout + create.stderr).not.toMatch(/otpauth:|ключ:/);
    const after = run(['list'], cfg);
    expect(after.stdout).not.toContain('cli@example.ru');

    // В терминале (псевдотерминал `script` из util-linux): пароль скрытым вводом дважды, секрет — один раз.
    if (spawnSync('script', ['--version']).status !== 0) return;
    const cmd = [
      process.execPath,
      '--import',
      'tsx',
      path.resolve('src/cli/owner.ts'),
      'create',
      '--email',
      'cli@example.ru',
      '--role',
      'support',
      '--config',
      cfg,
    ]
      .map((a) => `'${a.replace(/'/g, `'\\''`)}'`)
      .join(' ');
    const tty = await new Promise<{ status: number | null; stdout: string }>((resolve) => {
      const child = spawn('script', ['-qec', cmd, '/dev/null'], {
        cwd: path.resolve('.'),
        env: { ...process.env, LOG_LEVEL: 'silent' },
      });
      let stdout = '';
      let sent = 0;
      const timer = setTimeout(() => child.kill('SIGKILL'), 40_000);
      child.stdout.on('data', (d: Buffer) => {
        stdout += d.toString('utf8');
        // Ввод — только после приглашения (иначе терминал ещё в режиме эха).
        const prompts = (stdout.match(/ароль: /g) ?? []).length;
        while (sent < prompts) {
          child.stdin.write(`${PASSWORD}\r`);
          sent += 1;
        }
      });
      child.on('exit', (status) => {
        clearTimeout(timer);
        resolve({ status, stdout });
      });
    });
    expect(tty.status).toBe(0);
    expect(tty.stdout).not.toContain(PASSWORD);
    const uri = /otpauth:\/\/totp\/\S+/.exec(tty.stdout)?.[0] ?? '';
    const secret = new URL(uri).searchParams.get('secret') ?? '';
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    const list2 = run(['list'], cfg);
    expect(list2.stdout).toMatch(/cli@example\.ru\s+support/);
    expect(list2.stdout).not.toContain(secret);
  }, 60_000);
});

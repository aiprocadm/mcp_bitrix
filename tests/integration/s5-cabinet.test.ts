/**
 * SaaS-ТЗ S5 (§11.1, §11.2, §4 сценарии 1–3 и 7, §12 п.2 и п.5, §14): кабинет клиента `/app` на настоящем PostgreSQL,
 * имитации облака Bitrix24 (tests/helpers/s3-bitrix-cloud.ts — формы ответов по официальной документации) и настоящем
 * сервере авторизации MCP (S4: отзыв доступа), ApprovalService/MutationExecutor базового ТЗ (план под DEK арендатора).
 *
 * Проверяется: вход через Bitrix24 (state привязан к браузеру, одноразовый), заголовки безопасности и cookie, CSRF/Origin,
 * S12 (чужая/несуществующая операция — одинаковый 404, без входа — одинаковое перенаправление), подтверждение исполняется
 * настоящим сервисом (одна запись), свежий вход и слово ПОДТВЕРЖДАЮ для удалений, отключение пользователя (отзыв),
 * удаление всех данных (S13: криптоудаление, строки удалены, платежи сохранены), администрирование, файлы, оплата.
 * Без PostgreSQL набор помечается skip явно (describe.skipIf), а не «проходит» на подделке.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors/app-error.js';
import type { FileScanner } from '../../src/files/scanner.js';
import { FileStaging } from '../../src/files/staging.js';
import { AuditLog } from '../../src/logging/audit.js';
import { createSilentLogger } from '../../src/logging/logger.js';
import { ApprovalService } from '../../src/security/approval-service.js';
import { MutationExecutor, type MutationRequest } from '../../src/security/mutation-executor.js';
import { OperationsStore } from '../../src/storage/operations.js';
import { BitrixClient } from '../../src/bitrix/client.js';
import { RateLimiter } from '../../src/bitrix/rate-limiter.js';
import type { BitrixAuthProvider } from '../../src/auth/bitrix-auth-provider.js';
import { BILLING_DEFAULTS, type BillingSettings } from '../../src/saas/billing/settings.js';
import { NOOP_NOTIFIER } from '../../src/saas/billing/notifier.js';
import { SubscriptionService } from '../../src/saas/billing/subscription-service.js';
import { YooKassaProvider } from '../../src/saas/billing/yookassa.js';
import {
  BitrixEventsService,
  BitrixInstallService,
  BitrixLoginService,
  BitrixOAuthClient,
  BitrixTokenStore,
  bitrixAppUrls,
  portalKeyForMember,
  type PortalClientFactory,
} from '../../src/saas/bitrix/index.js';
import {
  approvalShortCode,
  registerCabinet,
  type Cabinet,
  type CabinetScope,
} from '../../src/saas/cabinet/index.js';
import { PlansRepo, SubscriptionsRepo } from '../../src/saas/repos/plans.js';
import { TenantSettingsRepo, TenantsRepo, TenantUsersRepo } from '../../src/saas/repos/tenants.js';
import { eventForm, FakeBitrixCloud, OAUTH_ORIGIN } from '../helpers/s3-bitrix-cloud.js';
import { makeStand, registerClient, RESOURCE, type OAuthStand } from '../helpers/s4-oauth.js';
import { YooKassaMock } from '../helpers/s6s7-yookassa-mock.js';
import { openSaasTestDb, PG_AVAILABLE, type SaasTestDb } from '../helpers/saas.js';

const PUBLIC = 'https://mcp.example.test';
const SESSION = '__Host-mcp_cab';
const BIND = '__Host-mcp_cab_bind';

let s: SaasTestDb;
let st: OAuthStand;
let cloud: FakeBitrixCloud;
let app: FastifyInstance;
let cabinet: Cabinet;
let clockOffset = 0;
let yk: YooKassaMock;
const logger = createSilentLogger();
const performed: string[] = [];
let staging: FileStaging;
let audit: AuditLog;
const executors = new Map<string, MutationExecutor>();

const BILLING: BillingSettings = {
  cabinetUrl: `${PUBLIC}/app`,
  returnUrl: `${PUBLIC}/app/admin/billing`,
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

const cleanScanner: FileScanner = {
  name: 'test-clean',
  scan: () => Promise.resolve({ status: 'clean' }),
  ping: () => Promise.resolve(),
};

function portalClient(auth: BitrixAuthProvider, hosts: readonly string[]): BitrixClient {
  return new BitrixClient({
    auth,
    fetch: cloud.fetch,
    limiter: new RateLimiter({ requestsPerSecond: 100, maxConcurrency: 4, maxQueueSize: 100 }),
    logger,
    allowedHosts: hosts,
    timeoutMs: 5000,
    uploadTimeoutMs: 5000,
    maxUpstreamResponseBytes: 1_000_000,
    maxReadRetries: 0,
    sleep: () => Promise.resolve(),
  });
}

/** Контекст пользователя как у сборки режима saas: планы под DEK арендатора, тот же ApprovalService для кабинета и MCP. */
async function scopeFor(
  tenantId: string,
  userId: string,
): Promise<CabinetScope & { mutations: MutationExecutor }> {
  const tenant = await new TenantsRepo(s.db, s.keys).get(tenantId);
  if (!tenant) throw new Error('нет арендатора');
  const box = await s.keys.boxFor(s.db, tenantId);
  const operations = new OperationsStore(s.db, tenantId);
  const approvals = new ApprovalService(operations, box, 3600, 'test-policy');
  const key = `${tenantId}:${userId}`;
  const mutations =
    executors.get(key) ??
    new MutationExecutor(operations, approvals, box, audit, logger, {
      idempotencyTtlHours: 24,
      policyVersion: 'test-policy',
      confirmAllWrites: true,
      maxPreparationsPerMinute: 100,
    });
  executors.set(key, mutations);
  return {
    tenantId,
    operations,
    approvals,
    files: staging.forTenant(tenantId),
    principal: { id: userId },
    auth: { portalKey: portalKeyForMember(tenant.memberId) },
    mutations,
  };
}

beforeAll(async () => {
  if (!PG_AVAILABLE) return;
  s = await openSaasTestDb();
  await new PlansRepo(s.db).seedDefaults();
  st = await makeStand(s);
  cloud = new FakeBitrixCloud();
  yk = new YooKassaMock();
  audit = new AuditLog(s.db, Buffer.alloc(32, 3), logger, true, 90);
  const dir = mkdtempSync(path.join(tmpdir(), 's5-files-'));
  staging = new FileStaging(
    s.db,
    {
      uploadRoot: path.join(dir, 'upload'),
      stagingDir: path.join(dir, 'staging'),
      maxUploadBytes: 1024 * 1024,
      maxInlineFileBytes: 1024,
      ttlSeconds: 3600,
      scanRequired: true,
      scanner: cleanScanner,
    },
    logger,
    'local',
  );
  const settings = {
    clientId: cloud.clientId,
    clientSecret: cloud.clientSecret,
    oauthServerUrl: OAUTH_ORIGIN,
    publicBaseUrl: PUBLIC,
  };
  const urls = bitrixAppUrls(settings);
  const tenants = new TenantsRepo(s.db, s.keys);
  const users = new TenantUsersRepo(s.db);
  const tenantSettings = new TenantSettingsRepo(s.db);
  const plans = new PlansRepo(s.db);
  const subscriptions = new SubscriptionsRepo(s.db);
  const tokens = new BitrixTokenStore(s.db, s.keys);
  const oauth = new BitrixOAuthClient({ settings, fetch: cloud.fetch, logger });
  const portal: PortalClientFactory = (auth, hosts) => portalClient(auth, hosts);
  const login = new BitrixLoginService({
    tenants,
    users,
    settings: tenantSettings,
    tokens,
    oauth,
    portal,
    coordination: st.coordination,
    logger,
    urls,
  });
  const billing = new SubscriptionService({
    db: s.db,
    keys: s.keys,
    plans,
    settings: BILLING,
    notifier: NOOP_NOTIFIER,
    logger,
    provider: new YooKassaProvider({
      settings: {
        shopId: yk.shopId,
        secretKey: yk.secretKey,
        apiUrl: 'https://api.yookassa.ru/v3',
        timeoutMs: 5000,
      },
      seller: BILLING.seller,
      fetch: yk.fetch,
      sleep: () => Promise.resolve(),
    }),
    users,
    coordination: st.coordination,
  });
  app = Fastify();
  cabinet = registerCabinet(app, {
    publicBaseUrl: PUBLIC,
    db: s.db,
    keys: s.keys,
    tenants,
    users,
    settings: tenantSettings,
    plans,
    subscriptions,
    login,
    scopeFor,
    audit,
    billing,
    revokeUser: (t, u) => st.as.revokeUser(t, u),
    revokeTenant: (t) => st.as.revokeTenant(t),
    fileStaging: staging,
    files: { maxUploadBytes: 1024 * 1024, uploadTtlSeconds: 3600, scanRequired: true },
    coordination: st.coordination,
    logger,
    now: () => Date.now() + clockOffset,
  });
  // Маршрут сборки режима saas: обратный вызов Bitrix24 с state кабинета.
  app.get('/b24/oauth/callback', (req, reply) => cabinet.replyBitrixCallback(req, reply));
  await app.ready();
}, 90_000);

afterAll(async () => {
  if (!PG_AVAILABLE) return;
  await app.close();
  await s.close();
});

// ───────────────────────────── помощники ─────────────────────────────

let ipSeq = 1;
const nextIp = () => `10.1.${String(Math.floor(ipSeq / 250))}.${String((ipSeq++ % 250) + 1)}`;

function setCookies(r: LightMyRequestResponse): string[] {
  const v = r.headers['set-cookie'];
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

function cookieValue(r: LightMyRequestResponse, name: string): string | undefined {
  for (const c of setCookies(r)) {
    const [pair] = c.split(';');
    if (pair?.startsWith(`${name}=`)) return pair.slice(name.length + 1);
  }
  return undefined;
}

interface Browser {
  cookie: string;
  csrf: string;
}

const form = (fields: Record<string, string | string[]>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) p.append(k, x);
  return p.toString();
};

const get = (url: string, b?: Browser) =>
  app.inject({ method: 'GET', url, headers: b ? { cookie: b.cookie } : {} });

const post = (url: string, fields: Record<string, string | string[]>, b?: Browser, origin = PUBLIC) =>
  app.inject({
    method: 'POST',
    url,
    remoteAddress: nextIp(),
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(origin ? { origin } : {}),
      ...(b ? { cookie: b.cookie } : {}),
    },
    payload: form(fields),
  });

const withCsrf = (b: Browser, fields: Record<string, string | string[]> = {}) => ({
  _csrf: b.csrf,
  ...fields,
});

/** Портал с администратором (1) и сотрудниками (7, 8); установка приложения событием ONAPPINSTALL. */
async function installPortal() {
  const memberId = `m${randomUUID().replaceAll('-', '')}`;
  const domain = `p${randomUUID().slice(0, 8)}.bitrix24.ru`;
  cloud.addPortal(memberId, domain, [
    { id: 1, admin: true, name: 'Анна', lastName: 'Админова' },
    { id: 7, admin: false, name: 'Иван', lastName: 'Тестов' },
    { id: 8, admin: false, name: 'Пётр', lastName: 'Соседов' },
  ]);
  const tenants = new TenantsRepo(s.db, s.keys);
  const users = new TenantUsersRepo(s.db);
  const settings = {
    clientId: cloud.clientId,
    clientSecret: cloud.clientSecret,
    oauthServerUrl: OAUTH_ORIGIN,
    publicBaseUrl: PUBLIC,
  };
  const oauth = new BitrixOAuthClient({ settings, fetch: cloud.fetch, logger });
  const install = new BitrixInstallService({
    tenants,
    users,
    plans: new PlansRepo(s.db),
    subscriptions: new SubscriptionsRepo(s.db),
    tokens: new BitrixTokenStore(s.db, s.keys),
    oauth,
    portal: (auth, hosts) => portalClient(auth, hosts),
    coordination: st.coordination,
    logger,
    urls: bitrixAppUrls(settings),
  });
  const events = new BitrixEventsService({
    db: s.db,
    tenants,
    install,
    coordination: st.coordination,
    logger,
  });
  const pair = cloud.issue(memberId, 1);
  const r = await events.handle(
    eventForm({
      event: 'ONAPPINSTALL',
      data: { VERSION: '1', ACTIVE: 'Y', INSTALLED: 'Y', LANGUAGE_ID: 'ru' },
      auth: {
        domain,
        access_token: pair.accessToken,
        refresh_token: pair.refreshToken,
        expires_in: 3600,
        server_endpoint: 'https://oauth.bitrix.info/rest/',
        status: 'F',
        client_endpoint: `https://${domain}/rest/`,
        member_id: memberId,
        application_token: randomUUID().replaceAll('-', ''),
      },
    }),
  );
  if (r.event !== 'ONAPPINSTALL' || !('install' in r)) throw new Error('не установлено');
  return { memberId, domain, tenantId: r.install.tenantId, adminUserId: r.install.userId };
}

/** Начало входа: POST /app/login → адрес авторизации портала (state) и cookie привязки браузера. */
async function startLogin(domain: string, next = '/app', ip = nextIp()) {
  const r = await app.inject({
    method: 'POST',
    url: '/app/login',
    remoteAddress: ip,
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: PUBLIC },
    payload: form({ portal: domain, next }),
  });
  return { r, bind: cookieValue(r, BIND) };
}

async function callback(query: Record<string, string>, cookie?: string) {
  return app.inject({
    method: 'GET',
    url: `/b24/oauth/callback?${new URLSearchParams(query).toString()}`,
    remoteAddress: nextIp(),
    headers: cookie ? { cookie } : {},
  });
}

/** Полный вход через Bitrix24 пользователем портала. */
async function login(
  p: { memberId: string; domain: string },
  bitrixUserId: number,
  next = '/app',
): Promise<Browser> {
  const { r, bind } = await startLogin(p.domain, next);
  expect(r.statusCode).toBe(303);
  const location = new URL(String(r.headers.location));
  const state = location.searchParams.get('state') ?? '';
  const cb = await callback(
    { code: cloud.issueCode(p.memberId, bitrixUserId), state, domain: p.domain, member_id: p.memberId },
    `${BIND}=${bind ?? ''}`,
  );
  expect(cb.statusCode).toBe(303);
  expect(cb.headers.location).toBe(next);
  const session = cookieValue(cb, SESSION);
  if (!session) throw new Error('нет cookie сессии');
  const cookie = `${SESSION}=${session}`;
  const home = await get('/app', { cookie, csrf: '' });
  expect(home.statusCode).toBe(200);
  const csrf = /name="_csrf" value="([^"]+)"/.exec(home.body)?.[1] ?? '';
  expect(csrf).not.toBe('');
  return { cookie, csrf };
}

async function userId(tenantId: string, bitrixUserId: number): Promise<string> {
  const u = (await new TenantUsersRepo(s.db).list(tenantId)).find((x) => x.bitrixUserId === bitrixUserId);
  if (!u) throw new Error('нет пользователя');
  return u.id;
}

/** Запись через настоящий MutationExecutor: без approvalId → APPROVAL_REQUIRED и план в ledger. */
function writeRequest(
  sc: CabinetScope,
  opts: { tool: string; kind: 'create' | 'update' | 'delete'; key: string; approvalId?: string },
): MutationRequest {
  return {
    requestId: randomUUID(),
    principal: { id: sc.principal.id, portalKey: sc.auth.portalKey, portalOrigin: 'https://portal.example' },
    tool: opts.tool,
    operationKind: opts.kind,
    args: {
      title: 'Сделка «Альфа»',
      idempotencyKey: opts.key,
      ...(opts.approvalId ? { approvalId: opts.approvalId } : {}),
    },
    summary: {
      action: opts.kind === 'delete' ? 'Удалить сделку 5' : 'Создать сделку',
      target: opts.kind === 'delete' ? 'crm.deal:5' : 'crm.deal',
      portalOrigin: 'https://portal.example',
      details: { TITLE: 'Сделка «Альфа»', SECRET_MARKER: 'plan-body-marker' },
      risks: ['Могут сработать роботы'],
    },
    perform: () => {
      performed.push(opts.key);
      return Promise.resolve({ id: 5, result: { id: 5 } });
    },
  };
}

async function prepareOp(
  tenantId: string,
  uid: string,
  tool = 'test_create',
  kind: 'create' | 'update' | 'delete' = 'create',
): Promise<{ operationId: string; key: string }> {
  const sc = await scopeFor(tenantId, uid);
  const key = randomUUID();
  try {
    await sc.mutations.execute(writeRequest(sc, { tool, kind, key }));
  } catch (e) {
    if (AppError.is(e) && e.code === 'APPROVAL_REQUIRED' && typeof e.details.operationId === 'string')
      return { operationId: e.details.operationId, key };
    throw e;
  }
  throw new Error('ожидался APPROVAL_REQUIRED');
}

async function opStatus(tenantId: string, id: string): Promise<string | undefined> {
  return (await new OperationsStore(s.db, tenantId).get(id))?.status;
}

// ───────────────────────────── тесты ─────────────────────────────

describe.skipIf(!PG_AVAILABLE)('S5: кабинет клиента /app', () => {
  it('вход через Bitrix24: state привязан к браузеру и одноразов; cookie HttpOnly/Secure/SameSite=Lax/__Host-; заголовки безопасности', async () => {
    const p = await installPortal();
    const page = await get('/app/login');
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-security-policy']).toContain("default-src 'self'");
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.body).not.toMatch(/<script/i);
    expect((await get('/app/static/cabinet.css')).headers['content-type']).toContain('text/css');

    // Начало входа: перенаправление только на установленный портал, state с префиксом кабинета.
    const { r, bind } = await startLogin(p.domain);
    expect(r.statusCode).toBe(303);
    const loc = new URL(String(r.headers.location));
    expect(loc.origin).toBe(`https://${p.domain}`);
    expect(loc.pathname).toBe('/oauth/authorize/');
    expect(loc.searchParams.get('client_id')).toBe(cloud.clientId);
    const state = loc.searchParams.get('state') ?? '';
    expect(cabinet.isCabinetState(state)).toBe(true);
    const bindCookie = setCookies(r).find((c) => c.startsWith(`${BIND}=`)) ?? '';
    expect(bindCookie).toMatch(/Path=\/; Max-Age=600; HttpOnly; SameSite=Lax; Secure/);

    // Обратный вызов в другом браузере (нет cookie привязки) — отказ; state при этом сгорает.
    const code = cloud.issueCode(p.memberId, 1);
    const foreign = await callback({ code, state, domain: p.domain, member_id: p.memberId });
    expect(foreign.statusCode).toBe(400);
    expect(cookieValue(foreign, SESSION)).toBeUndefined();
    const replay = await callback({ code, state }, `${BIND}=${bind ?? ''}`);
    expect(replay.statusCode).toBe(400);

    // Корректный вход.
    const b = await login(p, 1);
    expect(b.cookie.startsWith(`${SESSION}=${p.tenantId}.`)).toBe(true);
    const again = await startLogin(p.domain);
    const cb = await callback(
      {
        code: cloud.issueCode(p.memberId, 1),
        state: new URL(String(again.r.headers.location)).searchParams.get('state') ?? '',
      },
      `${BIND}=${again.bind ?? ''}`,
    );
    const sessionCookie = setCookies(cb).find((c) => c.startsWith(`${SESSION}=`)) ?? '';
    expect(sessionCookie).toMatch(/Path=\/; Max-Age=28800; HttpOnly; SameSite=Lax; Secure/);
    const home = await get('/app', b);
    expect(home.body).toContain('Анна Админова');
    expect(home.body).toContain('Пробный');
    // Токены Bitrix24 не попадают в страницы кабинета.
    expect(cloud.hasPlaintext(home.body)).toBeUndefined();

    // Неустановленный портал — страница «установите приложение», без перенаправления на произвольный адрес.
    const unknown = await startLogin('not-installed.bitrix24.ru');
    expect(unknown.r.statusCode).toBe(200);
    expect(unknown.r.body).toContain('Приложение не установлено');
    expect(unknown.r.headers.location).toBeUndefined();

    // Подделанная cookie сессии (чужой id арендатора + секрет) — как отсутствие сессии.
    const forged = b.cookie.replace(p.tenantId, randomUUID());
    expect((await get('/app', { cookie: forged, csrf: '' })).statusCode).toBe(303);

    // Выход закрывает сессию.
    const out = await post('/app/logout', withCsrf(b), b);
    expect(out.statusCode).toBe(303);
    expect((await get('/app', b)).statusCode).toBe(303);
  });

  it('RLS (S02) для сессий кабинета: без контекста арендатора и в чужом контексте — ноль строк; в БД только хеши', async () => {
    const p = await installPortal();
    const q = await installPortal();
    const b = await login(p, 1);
    const secret = b.cookie.slice(b.cookie.indexOf('.') + 1);
    expect(await s.db.all('SELECT * FROM cabinet_sessions')).toEqual([]);
    expect(
      await s.db.withTenant(q.tenantId, (x) =>
        x.all('SELECT * FROM cabinet_sessions WHERE tenant_id = ?', p.tenantId),
      ),
    ).toEqual([]);
    const own = await s.db.withTenant(p.tenantId, (x) =>
      x.all<Record<string, string>>('SELECT * FROM cabinet_sessions WHERE tenant_id = ?', p.tenantId),
    );
    expect(own.length).toBeGreaterThan(0);
    expect(JSON.stringify(own)).not.toContain(secret);
    expect(JSON.stringify(own)).not.toContain(b.csrf);
    // Вставка строки чужого арендатора из контекста другого — отказ политики WITH CHECK.
    await expect(
      s.db.withTenant(q.tenantId, (x) =>
        x.run(
          `INSERT INTO cabinet_sessions (id_hash, tenant_id, user_id, csrf, authenticated_at, created_at, expires_at)
           VALUES ('h', ?, ?, 'c', 'a', 'a', 'a')`,
          p.tenantId,
          p.adminUserId,
        ),
      ),
    ).rejects.toThrow();
  });

  it('лимит попыток входа с одного адреса; POST без Origin отклоняется', async () => {
    const p = await installPortal();
    const ip = '192.0.2.77';
    const codes: number[] = [];
    for (let i = 0; i < 11; i += 1) codes.push((await startLogin(p.domain, '/app', ip)).r.statusCode);
    expect(codes.slice(0, 10).every((c) => c === 303)).toBe(true);
    expect(codes[10]).toBe(429);
    const noOrigin = await app.inject({
      method: 'POST',
      url: '/app/login',
      remoteAddress: nextIp(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' },
      payload: form({ portal: p.domain }),
    });
    expect(noOrigin.statusCode).toBe(403);
  });

  it('без входа: любая страница → вход; ссылка на подтверждение не раскрывает существование операции; POST → 401', async () => {
    const p = await installPortal();
    const uid = await userId(p.tenantId, 1);
    const { operationId } = await prepareOp(p.tenantId, uid);
    const real = await get(`/app/approvals/${operationId}`);
    const fake = randomUUID();
    const missing = await get(`/app/approvals/${fake}`);
    expect(real.statusCode).toBe(303);
    expect(missing.statusCode).toBe(303);
    expect(real.headers.location).toBe(
      `/app/login?next=${encodeURIComponent(`/app/approvals/${operationId}`)}`,
    );
    expect(missing.headers.location).toBe(`/app/login?next=${encodeURIComponent(`/app/approvals/${fake}`)}`);
    expect(real.body).toBe(missing.body);
    const denied = await post(`/app/approvals/${operationId}`, { decision: 'approve' });
    expect(denied.statusCode).toBe(401);
    expect(denied.body).not.toContain('plan-body-marker');
    expect(await opStatus(p.tenantId, operationId)).toBe('prepared');
    for (const url of ['/app', '/app/history', '/app/admin', '/app/files', '/app/connect'])
      expect((await get(url)).statusCode).toBe(303);
  });

  it('CSRF и Origin: без токена, с чужим токеном и с чужого сайта — 403, ничего не меняется', async () => {
    const p = await installPortal();
    const admin = await login(p, 1);
    const other = await login(p, 1);
    const target = '/app/admin/settings';
    const fields = {
      modules: ['crm'],
      approvalPolicy: 'admin_for_high_risk',
      defaultRole: 'reader',
      userDailyCallLimit: '',
    };
    expect((await post(target, fields, admin)).statusCode).toBe(403);
    expect((await post(target, { ...fields, _csrf: other.csrf }, admin)).statusCode).toBe(403);
    expect((await post(target, withCsrf(admin, fields), admin, 'https://evil.example')).statusCode).toBe(403);
    expect((await post(target, withCsrf(admin, fields), admin, '')).statusCode).toBe(403);
    expect((await new TenantSettingsRepo(s.db).get(p.tenantId)).approvalPolicy).toBe('self');
    const ok = await post(target, withCsrf(admin, fields), admin);
    expect(ok.statusCode).toBe(303);
    expect(await new TenantSettingsRepo(s.db).get(p.tenantId)).toMatchObject({
      approvalPolicy: 'admin_for_high_risk',
      defaultRole: 'reader',
      userDailyCallLimit: null,
    });
  });

  it('подтверждение: план целиком, код сверки, решение исполняется настоящим сервисом — запись одна', async () => {
    const p = await installPortal();
    const ivan = await login(p, 7);
    const uid = await userId(p.tenantId, 7);
    const { operationId, key } = await prepareOp(p.tenantId, uid);
    const list = await get('/app/approvals', ivan);
    expect(list.body).toContain(`/app/approvals/${operationId}`);
    const view = await get(`/app/approvals/${operationId}`, ivan);
    expect(view.statusCode).toBe(200);
    expect(view.body).toContain('plan-body-marker');
    expect(view.body).toContain(approvalShortCode(operationId));
    expect(view.body).toContain('Создать сделку');
    expect(view.body).not.toContain('ПОДТВЕРЖДАЮ</code><br><input');

    // До подтверждения выполнить нельзя.
    const sc = await scopeFor(p.tenantId, uid);
    await expect(
      sc.mutations.execute(
        writeRequest(sc, { tool: 'test_create', kind: 'create', key, approvalId: operationId }),
      ),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(performed).not.toContain(key);

    const r = await post(`/app/approvals/${operationId}`, withCsrf(ivan, { decision: 'approve' }), ivan);
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe(`/app/approvals/${operationId}?done=approved`);
    expect(await opStatus(p.tenantId, operationId)).toBe('approved');
    const again = await post(`/app/approvals/${operationId}`, withCsrf(ivan, { decision: 'approve' }), ivan);
    expect(again.statusCode).toBe(409);

    // Модель повторяет вызов с approvalId: запись выполняется ровно один раз, повтор — replay.
    const done = await sc.mutations.execute(
      writeRequest(sc, { tool: 'test_create', kind: 'create', key, approvalId: operationId }),
    );
    expect(done).toMatchObject({ kind: 'executed', operationId, replayed: false });
    const replay = await sc.mutations.execute(
      writeRequest(sc, { tool: 'test_create', kind: 'create', key, approvalId: operationId }),
    );
    expect(replay).toMatchObject({ kind: 'executed', replayed: true });
    expect(performed.filter((k) => k === key)).toHaveLength(1);

    // Отказ: операция denied, выполнение запрещено.
    const second = await prepareOp(p.tenantId, uid);
    expect(
      (await post(`/app/approvals/${second.operationId}`, withCsrf(ivan, { decision: 'deny' }), ivan))
        .statusCode,
    ).toBe(303);
    expect(await opStatus(p.tenantId, second.operationId)).toBe('denied');
    await expect(
      sc.mutations.execute(
        writeRequest(sc, {
          tool: 'test_create',
          kind: 'create',
          key: second.key,
          approvalId: second.operationId,
        }),
      ),
    ).rejects.toMatchObject({ code: 'ACCESS_DENIED' });

    // История: статус, объект, время — без тела плана.
    const history = await get('/app/history', ivan);
    expect(history.body).toContain('выполнена');
    expect(history.body).toContain('отклонена');
    expect(history.body).toContain('crm.deal');
    expect(history.body).not.toContain('plan-body-marker');
  });

  it('S12: операция другого пользователя или арендатора — тот же 404, что и несуществующая; решение не принимается', async () => {
    const p = await installPortal();
    const q = await installPortal();
    await login(p, 7);
    const ivanId = await userId(p.tenantId, 7);
    const petr = await login(p, 8);
    const admin = await login(p, 1);
    const foreignAdmin = await login(q, 1);
    const { operationId } = await prepareOp(p.tenantId, ivanId);
    const del = await prepareOp(p.tenantId, ivanId, 'test_delete', 'delete');

    for (const b of [petr, admin, foreignAdmin]) {
      const nonexistent = await get(`/app/approvals/${randomUUID()}`, b);
      const malformed = await get('/app/approvals/not-a-uuid', b);
      for (const id of [operationId, del.operationId]) {
        const view = await get(`/app/approvals/${id}`, b);
        expect(view.statusCode).toBe(404);
        expect(view.body).toBe(nonexistent.body);
        const decide = await post(
          `/app/approvals/${id}`,
          withCsrf(b, { decision: 'approve', word: 'ПОДТВЕРЖДАЮ' }),
          b,
        );
        expect(decide.statusCode).toBe(404);
        expect(decide.body).not.toContain('plan-body-marker');
      }
      expect(malformed.body).toBe(nonexistent.body);
      expect((await get('/app/approvals', b)).body).not.toContain(operationId);
    }
    expect(await opStatus(p.tenantId, operationId)).toBe('prepared');
    expect(await opStatus(p.tenantId, del.operationId)).toBe('prepared');

    // Политика «удаления подтверждает администратор»: администратору арендатора видна только операция повышенного риска.
    const s1 = await new TenantSettingsRepo(s.db).get(p.tenantId);
    await new TenantSettingsRepo(s.db).save({ ...s1, approvalPolicy: 'admin_for_high_risk' });
    expect((await get(`/app/approvals/${operationId}`, admin)).statusCode).toBe(404);
    const adminList = await get('/app/approvals', admin);
    expect(adminList.body).toContain(del.operationId);
    expect(adminList.body).not.toContain(operationId);
    const adminView = await get(`/app/approvals/${del.operationId}`, admin);
    expect(adminView.statusCode).toBe(200);
    expect(adminView.body).toContain('повышенный риск');
    // Сам автор при этой политике операцию повышенного риска не подтверждает.
    const ivan = await login(p, 7);
    const own = await post(
      `/app/approvals/${del.operationId}`,
      withCsrf(ivan, { decision: 'approve', word: 'ПОДТВЕРЖДАЮ' }),
      ivan,
    );
    expect(own.statusCode).toBe(403);
    // Администратор другого арендатора по-прежнему не видит.
    expect((await get(`/app/approvals/${del.operationId}`, foreignAdmin)).statusCode).toBe(404);
    const byAdmin = await post(
      `/app/approvals/${del.operationId}`,
      withCsrf(admin, { decision: 'approve', word: 'ПОДТВЕРЖДАЮ' }),
      admin,
    );
    expect(byAdmin.statusCode).toBe(303);
    expect(await opStatus(p.tenantId, del.operationId)).toBe('approved');
    // Роль reader собственные планы не подтверждает.
    await new TenantUsersRepo(s.db).setRole(p.tenantId, ivanId, 'reader');
    const own2 = await prepareOp(p.tenantId, ivanId);
    expect(
      (await post(`/app/approvals/${own2.operationId}`, withCsrf(ivan, { decision: 'approve' }), ivan))
        .statusCode,
    ).toBe(403);
    expect(await opStatus(p.tenantId, own2.operationId)).toBe('prepared');
  });

  it('удаление и массовая замена: слово ПОДТВЕРЖДАЮ и свежий вход (не старше 15 минут)', async () => {
    const p = await installPortal();
    const ivan = await login(p, 7);
    const uid = await userId(p.tenantId, 7);
    const del = await prepareOp(p.tenantId, uid, 'test_delete', 'delete');
    const replace = await prepareOp(p.tenantId, uid, 'crm_deal_products_replace', 'update');

    const noWord = await post(
      `/app/approvals/${del.operationId}`,
      withCsrf(ivan, { decision: 'approve' }),
      ivan,
    );
    expect(noWord.statusCode).toBe(400);
    const wrongWord = await post(
      `/app/approvals/${replace.operationId}`,
      withCsrf(ivan, { decision: 'approve', word: 'подтверждаю' }),
      ivan,
    );
    expect(wrongWord.statusCode).toBe(400);
    expect(await opStatus(p.tenantId, del.operationId)).toBe('prepared');
    expect(await opStatus(p.tenantId, replace.operationId)).toBe('prepared');

    clockOffset = 16 * 60_000;
    try {
      const stale = await get(`/app/approvals/${del.operationId}`, ivan);
      expect(stale.body).toContain('нужен свежий вход');
      const staleApprove = await post(
        `/app/approvals/${del.operationId}`,
        withCsrf(ivan, { decision: 'approve', word: 'ПОДТВЕРЖДАЮ' }),
        ivan,
      );
      expect(staleApprove.statusCode).toBe(403);
      expect(await opStatus(p.tenantId, del.operationId)).toBe('prepared');
      // Обычная запись свежего входа не требует.
      const plain = await prepareOp(p.tenantId, uid);
      expect(
        (await post(`/app/approvals/${plain.operationId}`, withCsrf(ivan, { decision: 'approve' }), ivan))
          .statusCode,
      ).toBe(303);
      // Повторный вход через Bitrix24 → можно.
      const fresh = await login(p, 7, `/app/approvals/${del.operationId}`);
      const ok = await post(
        `/app/approvals/${del.operationId}`,
        withCsrf(fresh, { decision: 'approve', word: ' ПОДТВЕРЖДАЮ ' }),
        fresh,
      );
      expect(ok.statusCode).toBe(303);
      expect(await opStatus(p.tenantId, del.operationId)).toBe('approved');
      const ok2 = await post(
        `/app/approvals/${replace.operationId}`,
        withCsrf(fresh, { decision: 'approve', word: 'ПОДТВЕРЖДАЮ' }),
        fresh,
      );
      expect(ok2.statusCode).toBe(303);
    } finally {
      clockOffset = 0;
    }
  });

  it('§4.7: администратор отключает сотрудника — сессии, MCP-токены и неисполненные подтверждения аннулируются сразу', async () => {
    const p = await installPortal();
    const admin = await login(p, 1);
    const ivan = await login(p, 7);
    const uid = await userId(p.tenantId, 7);
    const adminId = await userId(p.tenantId, 1);
    const pending = await prepareOp(p.tenantId, uid);
    const clientId = await registerClient(st);
    await st.as.refreshTokens.issue(
      {
        familyId: randomUUID(),
        clientId,
        tenantId: p.tenantId,
        userId: uid,
        scope: 'mcp:read mcp:write',
        resource: RESOURCE,
        tokenGeneration: 0,
      },
      3600,
    );
    const genBefore = (await new TenantUsersRepo(s.db).get(p.tenantId, uid))?.tokenGeneration ?? -1;

    // Сотрудник не администратор: раздел недоступен.
    expect((await get('/app/admin', ivan)).statusCode).toBe(403);
    expect(
      (await post(`/app/admin/users/${adminId}/status`, withCsrf(ivan, { status: 'disabled' }), ivan))
        .statusCode,
    ).toBe(403);
    // Себя отключить нельзя.
    expect(
      (await post(`/app/admin/users/${adminId}/status`, withCsrf(admin, { status: 'disabled' }), admin))
        .statusCode,
    ).toBe(409);

    const r = await post(`/app/admin/users/${uid}/status`, withCsrf(admin, { status: 'disabled' }), admin);
    expect(r.statusCode).toBe(303);
    const user = await new TenantUsersRepo(s.db).get(p.tenantId, uid);
    expect(user?.status).toBe('disabled');
    expect(user?.tokenGeneration).toBeGreaterThan(genBefore);
    const tokens = await s.db.all<{ revoked_at: string | null }>(
      'SELECT revoked_at FROM mcp_refresh_tokens WHERE tenant_id = ? AND user_id = ?',
      p.tenantId,
      uid,
    );
    expect(tokens.length).toBe(1);
    expect(tokens.every((t) => t.revoked_at !== null)).toBe(true);
    expect(await opStatus(p.tenantId, pending.operationId)).toBe('denied');
    // Сессия сотрудника закрыта; повторный вход — отказ «доступ отключён».
    expect((await get('/app', ivan)).statusCode).toBe(303);
    const { r: start, bind } = await startLogin(p.domain);
    const cb = await callback(
      {
        code: cloud.issueCode(p.memberId, 7),
        state: new URL(String(start.headers.location)).searchParams.get('state') ?? '',
      },
      `${BIND}=${bind ?? ''}`,
    );
    expect(cb.statusCode).toBe(403);
    expect(cb.body).toContain('отключён');
    expect(cookieValue(cb, SESSION)).toBeUndefined();

    // Включение обратно; роль; последнего администратора не понизить.
    expect(
      (await post(`/app/admin/users/${uid}/status`, withCsrf(admin, { status: 'active' }), admin)).statusCode,
    ).toBe(303);
    expect(
      (await post(`/app/admin/users/${uid}/role`, withCsrf(admin, { role: 'reader' }), admin)).statusCode,
    ).toBe(303);
    expect((await new TenantUsersRepo(s.db).get(p.tenantId, uid))?.role).toBe('reader');
    expect(
      (await post(`/app/admin/users/${adminId}/role`, withCsrf(admin, { role: 'operator' }), admin))
        .statusCode,
    ).toBe(409);
    // Пользователь чужого арендатора — «не найден».
    const q = await installPortal();
    const foreign = await userId(q.tenantId, 1);
    expect(
      (await post(`/app/admin/users/${foreign}/status`, withCsrf(admin, { status: 'disabled' }), admin))
        .statusCode,
    ).toBe(404);
    expect((await new TenantUsersRepo(s.db).get(q.tenantId, foreign))?.status).toBe('active');
  });

  it('администрирование: модули, лимит на пользователя, output policy с проверкой', async () => {
    const p = await installPortal();
    const admin = await login(p, 1);
    const page = await get('/app/admin', admin);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Анна Админова');
    const saved = await post(
      '/app/admin/settings',
      withCsrf(admin, {
        modules: ['crm', 'tasks'],
        approvalPolicy: 'self',
        defaultRole: 'operator',
        userDailyCallLimit: '500',
      }),
      admin,
    );
    expect(saved.statusCode).toBe(303);
    expect(await new TenantSettingsRepo(s.db).get(p.tenantId)).toMatchObject({
      modules: ['system', 'crm', 'tasks'],
      userDailyCallLimit: 500,
    });
    for (const bad of [
      { modules: ['nope'], approvalPolicy: 'self', defaultRole: 'operator' },
      { modules: ['crm'], approvalPolicy: 'anyone', defaultRole: 'operator' },
      { modules: ['crm'], approvalPolicy: 'self', defaultRole: 'root' },
      { modules: ['crm'], approvalPolicy: 'self', defaultRole: 'operator', userDailyCallLimit: '-5' },
    ])
      expect((await post('/app/admin/settings', withCsrf(admin, bad), admin)).statusCode).toBe(400);

    const badJson = await post('/app/admin/output-policy', withCsrf(admin, { outputPolicy: '{nope' }), admin);
    expect(badJson.statusCode).toBe(400);
    const badRe = await post(
      '/app/admin/output-policy',
      withCsrf(admin, { outputPolicy: JSON.stringify({ version: '1', deniedFieldPatterns: ['('] }) }),
      admin,
    );
    expect(badRe.statusCode).toBe(400);
    const good = await post(
      '/app/admin/output-policy',
      withCsrf(admin, { outputPolicy: JSON.stringify({ version: 't1', deniedFieldPatterns: ['^PHONE$'] }) }),
      admin,
    );
    expect(good.statusCode).toBe(303);
    const stored = (await new TenantSettingsRepo(s.db).get(p.tenantId)).outputPolicyJson ?? '';
    expect(JSON.parse(stored)).toMatchObject({
      version: 't1',
      deniedFieldPatterns: ['^PHONE$'],
      profiles: {},
    });
    expect((await get('/app/admin', admin)).body).toContain('^PHONE$');
  });

  it('подключение: адрес MCP, инструкции, «Проверить подключение» — последний успешный вызов из аудита', async () => {
    const p = await installPortal();
    const ivan = await login(p, 7);
    const uid = await userId(p.tenantId, 7);
    const page = await get('/app/connect', ivan);
    expect(page.body).toContain(`${PUBLIC}/mcp`);
    expect(page.body).toContain('claude mcp add --transport http bitrix24');
    for (const client of ['Claude Desktop', 'Claude Code', 'claude.ai', 'ChatGPT'])
      expect(page.body).toContain(client);
    expect((await get('/app/connect?check=1', ivan)).body).toContain(
      'Успешных вызовов от вашего имени пока нет',
    );
    await audit.record({
      tenantId: p.tenantId,
      requestId: randomUUID(),
      principalId: uid,
      portalKey: portalKeyForMember(p.memberId),
      tool: 'crm_deal_list',
      operationKind: 'read',
      outcome: 'success',
    });
    const checked = await get('/app/connect?check=1', ivan);
    expect(checked.body).toContain('Подключение работает');
    expect(checked.body).toContain('crm_deal_list');
    // Вызов другого пользователя не засчитывается.
    const petr = await login(p, 8);
    expect((await get('/app/connect?check=1', petr)).body).toContain('пока нет');
  });

  it('загрузка файла для disk_upload_file: сканер обязателен, fileToken только владельцу, CSRF в multipart', async () => {
    const p = await installPortal();
    const ivan = await login(p, 7);
    const petr = await login(p, 8);
    const multipart = async (b: Browser, csrf: string) => {
      const fd = new FormData();
      fd.append('_csrf', csrf);
      fd.append('file', new Blob(['Отчёт за квартал\n'], { type: 'text/plain' }), 'report.txt');
      const req = new Request('http://x/', { method: 'POST', body: fd });
      return app.inject({
        method: 'POST',
        url: '/app/files',
        headers: { 'content-type': req.headers.get('content-type') ?? '', origin: PUBLIC, cookie: b.cookie },
        payload: Buffer.from(await req.arrayBuffer()),
      });
    };
    expect((await multipart(ivan, 'wrong')).statusCode).toBe(403);
    const r = await multipart(ivan, ivan.csrf);
    expect(r.statusCode).toBe(200);
    const token = /fileToken: <code>([^<]+)<\/code>/.exec(r.body)?.[1] ?? '';
    expect(token).not.toBe('');
    expect(r.body).toContain('сканер: clean');
    const uid = await userId(p.tenantId, 7);
    expect((await staging.forTenant(p.tenantId).resolve(token, uid)).originalName).toBe('report.txt');
    expect((await get('/app/files', ivan)).body).toContain(token);
    expect((await get('/app/files', petr)).body).not.toContain(token);
  });

  it('оплата: страница провайдера (https), счёт юрлицу; отмена неоплаченной — понятная ошибка', async () => {
    const p = await installPortal();
    const admin = await login(p, 1);
    const page = await get('/app/admin/billing', admin);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Команда');
    expect(page.headers['content-security-policy']).toContain("form-action 'self' https:");
    const checkout = await post(
      '/app/admin/billing/checkout',
      withCsrf(admin, { planCode: 'team', email: 'buh@example.ru', saveMethod: 'yes' }),
      admin,
    );
    expect(checkout.statusCode).toBe(303);
    expect(String(checkout.headers.location)).toMatch(/^https:\/\/yoomoney\.ru\//);
    const invoice = await post(
      '/app/admin/billing/invoice',
      withCsrf(admin, { planCode: 'team', name: 'ООО «Ромашка»', inn: '7707083893', kpp: '773601001' }),
      admin,
    );
    expect(invoice.statusCode).toBe(303);
    const inv = await get(String(invoice.headers.location), admin);
    expect(inv.body).toContain('ООО «Ромашка»');
    expect(inv.body).toContain('2 990,00 ₽');
    const cancel = await post('/app/admin/billing/cancel', withCsrf(admin), admin);
    expect(cancel.statusCode).toBe(400);
    // Счёт другого арендатора не открывается.
    const q = await installPortal();
    const qa = await login(q, 1);
    expect((await get(String(invoice.headers.location), qa)).statusCode).toBe(404);
  });

  it('S13: удаление всех данных — свежий вход и слово; токены отозваны, DEK уничтожен, строки удалены, платежи сохранены', async () => {
    const p = await installPortal();
    const neighbour = await installPortal();
    const neighbourAdmin = await login(neighbour, 1);
    const admin = await login(p, 1);
    const ivan = await login(p, 7);
    const uid = await userId(p.tenantId, 7);
    const pending = await prepareOp(p.tenantId, uid);
    const clientId = await registerClient(st);
    await st.as.refreshTokens.issue(
      {
        familyId: randomUUID(),
        clientId,
        tenantId: p.tenantId,
        userId: uid,
        scope: 'mcp:read',
        resource: RESOURCE,
        tokenGeneration: 0,
      },
      3600,
    );
    const staged = await staging.forTenant(p.tenantId).stageUpload(Buffer.from('данные'), 'a.txt', uid);
    expect(existsSync(staged.stagingPath)).toBe(true);
    await s.db.run(
      `INSERT INTO payments (id, tenant_id, provider, provider_payment_id, idempotence_key, purpose, plan_code, amount_kopecks, currency, status, description, created_at, updated_at)
       VALUES (?, ?, 'yookassa', NULL, ?, 'initial', 'team', 299000, 'RUB', 'succeeded', 'Подписка', ?, ?)`,
      randomUUID(),
      p.tenantId,
      randomUUID(),
      new Date().toISOString(),
      new Date().toISOString(),
    );

    // Не администратор — отказ; слово неверное — отказ; вход несвежий — отказ.
    expect((await post('/app/admin/delete', withCsrf(ivan, { word: 'ПОДТВЕРЖДАЮ' }), ivan)).statusCode).toBe(
      403,
    );
    expect((await post('/app/admin/delete', withCsrf(admin, { word: 'да' }), admin)).statusCode).toBe(400);
    clockOffset = 16 * 60_000;
    try {
      expect((await get('/app/admin/delete', admin)).body).toContain('Нужен свежий вход');
      expect(
        (await post('/app/admin/delete', withCsrf(admin, { word: 'ПОДТВЕРЖДАЮ' }), admin)).statusCode,
      ).toBe(403);
    } finally {
      clockOffset = 0;
    }
    expect((await new TenantsRepo(s.db, s.keys).get(p.tenantId))?.status).toBe('active');

    const r = await post('/app/admin/delete', withCsrf(admin, { word: 'ПОДТВЕРЖДАЮ' }), admin);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('удалены');
    expect(setCookies(r).some((c) => c.startsWith(`${SESSION}=;`) && c.includes('Max-Age=0'))).toBe(true);

    const tenant = await s.db.get<{ status: string; dek_encrypted: string | null }>(
      'SELECT status, dek_encrypted FROM tenants WHERE id = ?',
      p.tenantId,
    );
    expect(tenant).toEqual({ status: 'deleted', dek_encrypted: null });
    s.keys.forget(p.tenantId);
    await expect(s.keys.boxFor(s.db, p.tenantId)).rejects.toMatchObject({
      details: { reason: 'TENANT_KEY_DESTROYED' },
    });
    const count = async (table: string) =>
      Number(
        (
          await s.db.withTenant(p.tenantId, (x) =>
            x.get<{ n: unknown }>(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ?`, p.tenantId),
          )
        )?.n,
      );
    for (const t of [
      'tenant_users',
      'bitrix_tokens',
      'operations',
      'audit',
      'file_manifests',
      'cabinet_sessions',
      'tenant_settings',
      'mcp_refresh_tokens',
      'usage_counters',
    ])
      expect(await count(t)).toBe(0);
    expect(existsSync(staged.stagingPath)).toBe(false);
    expect(await count('payments')).toBe(1);
    expect((await new SubscriptionsRepo(s.db).get(p.tenantId))?.status).toBe('canceled');
    const log = await s.db.all<{ action: string; actor: string }>(
      'SELECT action, actor FROM support_actions WHERE tenant_id = ?',
      p.tenantId,
    );
    expect(log).toEqual([{ action: 'tenant_data_deleted', actor: 'tenant_admin' }]);
    // Сессии арендатора больше не действуют; операция недоступна.
    expect((await get('/app', admin)).statusCode).toBe(303);
    expect((await get('/app', ivan)).statusCode).toBe(303);
    expect(await opStatus(p.tenantId, pending.operationId)).toBeUndefined();
    // Соседний арендатор не затронут.
    expect((await get('/app', neighbourAdmin)).statusCode).toBe(200);
    expect((await new TenantsRepo(s.db, s.keys).get(neighbour.tenantId))?.status).toBe('active');
    await expect(s.keys.boxFor(s.db, neighbour.tenantId)).resolves.toBeDefined();
  });
});

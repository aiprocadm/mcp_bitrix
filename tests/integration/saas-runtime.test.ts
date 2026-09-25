/**
 * Сборка режима saas целиком (docs/saas/runtime.md): настоящий PostgreSQL 16 (роль без BYPASSRLS) и настоящий
 * redis-server; облако Bitrix24 (сервер авторизации + REST порталов) и API ЮKassa — имитации (tests/helpers/*).
 * Поток по HTTP через настоящее Fastify-приложение: установка (ONAPPINSTALL) → арендатор → DCR + PKCE со входом
 * через Bitrix24 → токен → MCP initialize/tools/list по тарифу → чтение до портала токеном пользователя → учёт →
 * запись → APPROVAL_REQUIRED + approvalUrl → изоляция двух арендаторов → отзыв → удаление приложения.
 * Без PostgreSQL или Redis тесты помечаются skip (явно), а не проходят на подделке.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { FetchLike } from '../../src/bitrix/client.js';
import { createSilentLogger } from '../../src/logging/logger.js';
import { pkceS256 } from '../../src/saas/oauth/crypto.js';
import { ENTITLEMENTS_CHANNEL } from '../../src/saas/billing/entitlements.js';
import { approvalShortCode } from '../../src/saas/dispatch-hooks.js';
import { startSaasHttp, type SaasHttpHandle } from '../../src/saas/http.js';
import { createSaasRuntime, type SaasRuntime } from '../../src/saas/runtime.js';
import { saasWebHttpOptions } from '../../src/saas/web.js';
import { createWorkerTasks, tenantsDueForDeletion } from '../../src/saas/worker-tasks.js';
import { startSaas } from '../../src/saas/main.js';
import { TASK_FIELDS, taskRecord } from '../helpers/mock-bitrix.js';
import { testConfig, structured } from '../helpers/app.js';
import { startTestPostgres, type TestPostgres } from '../helpers/postgres.js';
import { eventForm, FakeBitrixCloud, OAUTH_ORIGIN } from '../helpers/s3-bitrix-cloud.js';
import { hidden } from '../helpers/s4-oauth.js';
import { YooKassaMock, YOOKASSA_IP, FOREIGN_IP } from '../helpers/s6s7-yookassa-mock.js';
import { REDIS_AVAILABLE, startTestRedis, type TestRedis } from '../helpers/s8-redis.js';
import { PG_AVAILABLE } from '../helpers/saas.js';

const PUBLIC = 'https://mcp.example.ru';
const RESOURCE = `${PUBLIC}/mcp`;
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const METRICS_TOKEN = 'metrics-token-0123456789abcdef';

interface PortalInfo {
  memberId: string;
  domain: string;
  applicationToken: string;
  tenantId: string;
  userId: string;
}

describe.skipIf(!PG_AVAILABLE || !REDIS_AVAILABLE)(
  'Сборка режима saas (PostgreSQL + Redis, mock Bitrix24/ЮKassa)',
  () => {
    let pg: TestPostgres;
    let redis: TestRedis;
    let rt: SaasRuntime;
    let http: SaasHttpHandle;
    let saasEnv: Record<string, string> = {};
    let base: string;
    const cloud = new FakeBitrixCloud();
    const kassa = new YooKassaMock();
    const created: Record<string, unknown>[] = [];

    const fetchAll: FetchLike = (url, init) =>
      new URL(url).hostname === 'api.yookassa.ru' ? kassa.fetch(url, init) : cloud.fetch(url, init);

    beforeAll(async () => {
      const pgServer = await startTestPostgres();
      if (!pgServer) throw new Error('PostgreSQL недоступен');
      pg = pgServer;
      redis = await startTestRedis();
      const dir = mkdtempSync(path.join(tmpdir(), 'saas-rt-'));
      const file = (name: string, content: string) => {
        const p = path.join(dir, name);
        writeFileSync(p, content, { mode: 0o600 });
        return p;
      };
      saasEnv = {
        DEPLOYMENT_MODE: 'saas',
        PUBLIC_BASE_URL: PUBLIC,
        MCP_TRANSPORT: 'http',
        BITRIX_WEBHOOK_BASE_URL: '',
        BITRIX_PORTAL_URL: '',
        DATABASE_URL: pg.url,
        REDIS_URL: redis.url,
        KEK_FILE: file('kek', 'ab'.repeat(32)),
        B24_APP_CLIENT_ID: cloud.clientId,
        B24_APP_CLIENT_SECRET_FILE: file('b24', cloud.clientSecret),
        OAUTH_SIGNING_KEYS_DIR: path.join(dir, 'keys'),
        YOOKASSA_SHOP_ID: kassa.shopId,
        YOOKASSA_SECRET_KEY_FILE: file('yk', kassa.secretKey),
        SELLER_NAME: 'ООО Тест',
        SELLER_INN: '7707083893',
        SELLER_TAX_SYSTEM_CODE: '1',
        SELLER_VAT_CODE: '1',
        READ_ONLY_MODE: 'false',
        BITRIX_REQUESTS_PER_SECOND: '10',
        BITRIX_MAX_READ_RETRIES: '0',
        TRUSTED_PROXIES: '127.0.0.1',
        METRICS_TOKEN_FILE: file('metrics', METRICS_TOKEN),
        REDIS_NAMESPACE: `t${randomUUID().slice(0, 8)}:`,
        UPLOAD_ROOT: path.join(dir, 'inbox'),
        STAGING_DIR: path.join(dir, 'staging'),
      };
      const config = testConfig(saasEnv);
      rt = await createSaasRuntime(config, {
        fetch: fetchAll,
        logger: createSilentLogger(),
        startUsageFlush: false,
        resolveHost: () => Promise.resolve(['93.184.216.34']),
      });
      http = await startSaasHttp(rt, { ...saasWebHttpOptions(rt), host: '127.0.0.1', port: 0 });
      base = `http://127.0.0.1:${String(http.port)}`;

      cloud.extraMethods.set('tasks.task.getfields', () => ({ result: TASK_FIELDS }));
      cloud.extraMethods.set('tasks.task.list', () => ({
        result: { tasks: [taskRecord(1), taskRecord(2)] },
        total: 2,
      }));
      cloud.extraMethods.set('tasks.task.add', (body) => {
        created.push(body);
        return { result: { task: taskRecord(100) } };
      });
    }, 120_000);

    afterAll(async () => {
      await http?.close();
      await rt?.close();
      await redis?.stop();
      await pg?.stop();
    }, 60_000);

    // ------------------------------------------------------------------ помощники

    const post = (p: string, body: string, headers: Record<string, string> = {}) =>
      fetch(`${base}${p}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
        body,
      });

    /** Портал с администратором (1) и сотрудником (7), установленный событием ONAPPINSTALL по HTTP. */
    async function installPortal(): Promise<PortalInfo> {
      const memberId = `m${randomUUID().replaceAll('-', '')}`;
      const domain = `p${randomUUID().slice(0, 8)}.bitrix24.ru`;
      cloud.addPortal(memberId, domain, [
        { id: 1, admin: true, name: 'Анна', lastName: 'Админова' },
        { id: 7, admin: false, name: 'Иван', lastName: 'Тестов' },
      ]);
      const applicationToken = randomUUID().replaceAll('-', '');
      const pair = cloud.issue(memberId, 1);
      const res = await post(
        '/b24/events',
        eventForm({
          event: 'ONAPPINSTALL',
          data: { VERSION: '1', ACTIVE: 'Y', INSTALLED: 'Y', LANGUAGE_ID: 'ru' },
          auth: {
            domain,
            access_token: pair.accessToken,
            refresh_token: pair.refreshToken,
            expires_in: 3600,
            client_endpoint: `https://${domain}/rest/`,
            member_id: memberId,
            application_token: applicationToken,
          },
        }),
      );
      expect(res.status).toBe(200);
      const tenant = await rt.repos.tenants.getByMemberId(memberId);
      if (!tenant) throw new Error('арендатор не создан');
      const users = await rt.repos.users.list(tenant.id);
      const admin = users.find((u) => u.bitrixUserId === 1);
      if (!admin) throw new Error('нет установщика');
      return { memberId, domain, applicationToken, tenantId: tenant.id, userId: admin.id };
    }

    function cookies(res: Response, jar: Map<string, string>): void {
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';');
        const i = pair?.indexOf('=') ?? -1;
        if (pair && i > 0) jar.set(pair.slice(0, i), pair.slice(i + 1));
      }
    }
    const cookieHeader = (jar: Map<string, string>) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

    /** DCR + authorize (PKCE S256, resource) → вход через Bitrix24 → согласие → код → токен. */
    async function oauthToken(portal: PortalInfo, bitrixUserId = 1, scope?: string): Promise<string> {
      const reg = await fetch(`${base}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Claude',
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
        }),
      });
      expect(reg.status).toBe(201);
      const clientId = ((await reg.json()) as { client_id: string }).client_id;
      const verifier = `v${randomUUID().replaceAll('-', '')}${'x'.repeat(40)}`;
      const q = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: pkceS256(verifier),
        code_challenge_method: 'S256',
        resource: RESOURCE,
        state: 'client-state',
        ...(scope ? { scope } : {}),
      });
      const jar = new Map<string, string>();
      const page = await fetch(`${base}/oauth/authorize?${q.toString()}`, { redirect: 'manual' });
      expect(page.status).toBe(200);
      cookies(page, jar);
      const html = await page.text();
      const login = await post(
        '/oauth/login',
        new URLSearchParams({
          request: hidden(html, 'request'),
          csrf: hidden(html, 'csrf'),
          portal: portal.domain,
        }).toString(),
        { cookie: cookieHeader(jar) },
      );
      expect(login.status).toBe(303);
      const bitrixUrl = new URL(login.headers.get('location') ?? '');
      expect(bitrixUrl.host).toBe(portal.domain);
      expect(bitrixUrl.searchParams.get('client_id')).toBe(cloud.clientId);
      // Bitrix24 возвращает пользователя на redirect_uri приложения с кодом (живёт 30 с) и state без изменений.
      const code = cloud.issueCode(portal.memberId, bitrixUserId);
      const cbq = new URLSearchParams({
        code,
        state: bitrixUrl.searchParams.get('state') ?? '',
        domain: portal.domain,
        member_id: portal.memberId,
      });
      const cb = await fetch(`${base}/b24/oauth/callback?${cbq.toString()}`, {
        redirect: 'manual',
        headers: { cookie: cookieHeader(jar) },
      });
      cookies(cb, jar);
      let redirectTo: URL;
      if (cb.status === 302) {
        redirectTo = new URL(cb.headers.get('location') ?? '');
      } else {
        expect(cb.status).toBe(200);
        const consentHtml = await cb.text();
        const consent = await post(
          '/oauth/consent',
          new URLSearchParams({
            consent: hidden(consentHtml, 'consent'),
            csrf: hidden(consentHtml, 'csrf'),
            decision: 'approve',
          }).toString(),
          { cookie: cookieHeader(jar) },
        );
        expect(consent.status).toBe(303);
        redirectTo = new URL(consent.headers.get('location') ?? '');
      }
      expect(redirectTo.searchParams.get('iss')).toBe(PUBLIC);
      const tok = await post(
        '/oauth/token',
        new URLSearchParams({
          grant_type: 'authorization_code',
          code: redirectTo.searchParams.get('code') ?? '',
          redirect_uri: REDIRECT,
          code_verifier: verifier,
          client_id: clientId,
          resource: RESOURCE,
        }).toString(),
      );
      expect(tok.status).toBe(200);
      return ((await tok.json()) as { access_token: string }).access_token;
    }

    async function connect(token: string) {
      const client = new Client({ name: 'saas-e2e', version: '0.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        authProvider: { token: () => Promise.resolve(token) },
      });
      await client.connect(transport);
      return { client, transport };
    }

    interface Env {
      success: boolean;
      data?: Record<string, unknown>;
      error?: { code: string; details: Record<string, unknown> };
    }
    const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
      const r = await client.callTool({ name, arguments: args });
      return structured<Env>(r);
    };

    // ------------------------------------------------------------------ сценарий

    let a: PortalInfo;
    let b: PortalInfo;
    let tokenA: string;
    let tokenB: string;
    let operationIdA: string;
    let sessionA: { client: Client; transport: StreamableHTTPClientTransport };

    it('служебные маршруты: healthz, readyz (БД и Redis), метаданные AS/ресурса, /metrics только внутри', async () => {
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      const ready = await fetch(`${base}/readyz`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toMatchObject({ status: 'ready', database: 'ok', redis: 'ok' });
      const asMeta = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<
        string,
        unknown
      >;
      expect(asMeta['issuer']).toBe(PUBLIC);
      expect(asMeta['code_challenge_methods_supported']).toEqual(['S256']);
      const prm = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<
        string,
        unknown
      >;
      expect(prm['resource']).toBe(RESOURCE);
      expect(((await (await fetch(`${base}/oauth/jwks`)).json()) as { keys: unknown[] }).keys.length).toBe(1);
      // loopback без прокси — можно; через прокси без токена — 404; с токеном — можно.
      expect((await fetch(`${base}/metrics`)).status).toBe(200);
      expect((await fetch(`${base}/metrics`, { headers: { 'x-forwarded-for': '203.0.113.9' } })).status).toBe(
        404,
      );
      const withToken = await fetch(`${base}/metrics`, {
        headers: { 'x-forwarded-for': '203.0.113.9', authorization: `Bearer ${METRICS_TOKEN}` },
      });
      expect(withToken.status).toBe(200);
      expect(await withToken.text()).toContain('mcp_http_responses_total');
      // Чужой Host не принимается (защита от DNS rebinding).
      const evilStatus = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          { host: '127.0.0.1', port: http.port, path: '/healthz', headers: { host: 'evil.example.com' } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(evilStatus).toBe(403);
    });

    it('кабинет /app и панель /owner смонтированы; обратный вызов Bitrix24 с state кабинета уходит кабинету', async () => {
      const app = await fetch(`${base}/app/approvals/00000000-0000-4000-8000-000000000000`, {
        redirect: 'manual',
      });
      expect([302, 303]).toContain(app.status);
      expect(app.headers.get('location') ?? '').toContain('/app/login');
      const owner = await fetch(`${base}/owner/login`);
      expect(owner.status).toBe(200);
      expect(owner.headers.get('content-security-policy') ?? '').toContain("frame-ancestors 'none'");
      // state кабинета без cookie браузера — отказ кабинета (не 404 «нет обработчика») и без обращения к Bitrix24.
      const cb = await fetch(
        `${base}/b24/oauth/callback?state=cab.${'x'.repeat(40)}&code=c&domain=x.bitrix24.ru`,
        {
          redirect: 'manual',
        },
      );
      expect(cb.status).not.toBe(404);
      expect(cb.status).toBeLessThan(500);
    });

    it('/mcp без токена → 401 с WWW-Authenticate и resource_metadata', async () => {
      const r = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });
      expect(r.status).toBe(401);
      expect(r.headers.get('www-authenticate')).toContain(
        `resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/mcp"`,
      );
    });

    it('установка → арендатор с пробным периодом; поддельное ONAPPUNINSTALL отклоняется (403)', async () => {
      a = await installPortal();
      const sub = await rt.repos.subscriptions.get(a.tenantId);
      expect(sub).toMatchObject({ planCode: 'trial', status: 'trialing' });
      const forged = await post(
        '/b24/events',
        eventForm({
          event: 'ONAPPUNINSTALL',
          data: { CLEAN: 0 },
          auth: { member_id: a.memberId, application_token: 'forged-token-000' },
        }),
      );
      expect(forged.status).toBe(403);
      expect((await rt.repos.tenants.get(a.tenantId))?.status).toBe('active');
    });

    it('DCR + PKCE со входом через Bitrix24 → токен; MCP initialize и tools/list по тарифу', async () => {
      tokenA = await oauthToken(a);
      sessionA = await connect(tokenA);
      const names = (await sessionA.client.listTools()).tools.map((t) => t.name);
      // Пробный тариф: все модули; удаления тарифом не разрешены (и глобально выключены).
      expect(names).toContain('task_list');
      expect(names).toContain('task_create');
      expect(names).toContain('workgroups_list');
      expect(names).not.toContain('task_delete');
      expect(sessionA.transport.sessionId).toBeTruthy();
    });

    it('чтение доходит до портала токеном пользователя; вызов учтён (D11), диагностика тоже', async () => {
      const before = cloud.restCalls.length;
      const r = await call(sessionA.client, 'task_list', {});
      expect(r.success).toBe(true);
      expect(r.data?.['returnedCount']).toBe(2);
      const calls = cloud.restCalls.slice(before);
      expect(calls.map((c) => c.method)).toContain('tasks.task.list');
      // Только хост портала арендатора и токен его пользователя (не вебхук и не чужой портал).
      expect(calls.every((c) => c.host === a.domain && typeof c.auth === 'string')).toBe(true);
      const usage = await rt.billing.usage.monthUsage(a.tenantId);
      expect(usage.calls).toBe(1);
      // Ошибка валидации не считается вызовом.
      const bad = await sessionA.client.callTool({
        name: 'operation_status',
        arguments: { operationId: 'не-uuid' },
      });
      expect(bad.isError).toBe(true);
      expect((await rt.billing.usage.monthUsage(a.tenantId)).calls).toBe(1);
      // Сброс в PostgreSQL (как задача worker usage.flush).
      await rt.billing.usage.flush();
      const report = await rt.billing.usage.report(a.tenantId, new Date().toISOString().slice(0, 7));
      expect(report.byTool.find((t) => t.tool === 'task_list')?.calls).toBe(1);
    });

    it('запись → APPROVAL_REQUIRED с approvalUrl кабинета и кодом сверки; в Bitrix24 ничего не создано', async () => {
      const r = await call(sessionA.client, 'task_create', {
        title: 'Позвонить клиенту',
        responsibleId: 7,
        idempotencyKey: randomUUID(),
      });
      expect(r.success).toBe(false);
      expect(r.error?.code).toBe('APPROVAL_REQUIRED');
      operationIdA = String(r.error?.details['operationId']);
      expect(r.error?.details['approvalUrl']).toBe(`${PUBLIC}/app/approvals/${operationIdA}`);
      expect(r.error?.details['approvalCode']).toBe(approvalShortCode(operationIdA));
      expect(String(r.error?.details['nextAction'])).toContain('/app/approvals/');
      expect(created).toHaveLength(0);
      // Кабинет видит ожидающий план через хранилища арендатора; principal операции — tenant_users.id.
      const ap = await rt.tenantApprovals(a.tenantId);
      const pending = await ap.approvals.listPending(a.userId, ap.portalKey);
      expect(pending.map((p) => p.operationId)).toContain(operationIdA);
    });

    it('подтверждение (как в кабинете) → повтор с approvalId создаёт задачу один раз; запись учтена', async () => {
      const ap = await rt.tenantApprovals(a.tenantId);
      await ap.approvals.approve(operationIdA, a.userId, ap.portalKey);
      const row = await ap.operations.get(operationIdA);
      const args = {
        title: 'Позвонить клиенту',
        responsibleId: 7,
        idempotencyKey: row?.idempotency_key,
        approvalId: operationIdA,
      };
      cloud.extraMethods.set('tasks.task.get', () => ({
        result: { task: taskRecord(100, { title: 'Позвонить клиенту' }) },
      }));
      const r = await call(sessionA.client, 'task_create', args);
      expect(r.error?.code ?? 'ok').toBe('ok');
      expect(created).toHaveLength(1);
      expect((await rt.billing.usage.monthUsage(a.tenantId)).writes).toBe(1);
    });

    it('два арендатора изолированы: сессия, operationId, подтверждения и порталы не пересекаются', async () => {
      b = await installPortal();
      tokenB = await oauthToken(b);
      // Токен B с идентификатором сессии A → как несуществующая сессия.
      const hijack = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokenB}`,
          'mcp-session-id': sessionA.transport.sessionId ?? '',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }),
      });
      expect(hijack.status).toBe(404);
      const sessionB = await connect(tokenB);
      try {
        const before = cloud.restCalls.length;
        const st = await call(sessionB.client, 'operation_status', { operationId: operationIdA });
        expect(st.success).toBe(false);
        expect(st.error?.code).toBe('NOT_FOUND');
        await call(sessionB.client, 'task_list', {});
        expect(cloud.restCalls.slice(before).every((c) => c.host === b.domain)).toBe(true);
      } finally {
        await sessionB.client.close();
      }
      const apB = await rt.tenantApprovals(b.tenantId);
      expect(await apB.operations.get(operationIdA)).toBeUndefined();
      expect(await apB.approvals.listPending(a.userId, apB.portalKey)).toEqual([]);
      expect((await rt.billing.usage.monthUsage(b.tenantId)).writes).toBe(0);
    });

    it('тариф без модуля: скрыт в tools/list новой сессии; в открытой сессии прямой вызов → FEATURE_UNAVAILABLE', async () => {
      await rt.db.run(
        "UPDATE subscriptions SET plan_code = 'start', status = 'active', period_end = ? WHERE tenant_id = ?",
        new Date(Date.now() + 30 * 86_400_000).toISOString(),
        a.tenantId,
      );
      await rt.coordination.publish(ENTITLEMENTS_CHANNEL, a.tenantId);
      await new Promise((r) => setTimeout(r, 100));
      const r = await call(sessionA.client, 'workgroups_list', {});
      expect(r.error?.code).toBe('FEATURE_UNAVAILABLE');
      expect(r.error?.details['reason']).toBe('NOT_IN_PLAN');
      const fresh = await connect(tokenA);
      try {
        const names = (await fresh.client.listTools()).tools.map((t) => t.name);
        expect(names).toContain('task_list');
        expect(names).not.toContain('workgroups_list');
      } finally {
        await fresh.client.close();
      }
    });

    it('квота исчерпана → QUOTA_EXCEEDED, диагностика работает (S08)', async () => {
      await rt.db.run(
        "UPDATE subscriptions SET plan_code = 'trial', status = 'trialing' WHERE tenant_id = ?",
        b.tenantId,
      );
      await rt.coordination.publish(ENTITLEMENTS_CHANNEL, b.tenantId);
      const month = new Date().toISOString().slice(0, 7);
      await rt.coordination.incr(`usage:q:${b.tenantId}:${month}:calls`, 5000, 86_400_000);
      const s = await connect(tokenB);
      try {
        const r = await call(s.client, 'task_list', {});
        expect(r.error?.code).toBe('QUOTA_EXCEEDED');
        const diag = await call(s.client, 'bitrix_connection_info', {});
        expect(diag.success).toBe(true);
      } finally {
        await s.client.close();
      }
    });

    it('отзыв пользователя: следующий запрос с его токеном → 401, неисполненные планы → denied', async () => {
      const pending = await call(sessionA.client, 'task_create', {
        title: 'Ещё одна',
        responsibleId: 7,
        idempotencyKey: randomUUID(),
      });
      const opId = String(pending.error?.details['operationId']);
      await rt.oauth.server.revokeUser(a.tenantId, a.userId);
      await new Promise((r) => setTimeout(r, 100));
      const r = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokenA}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });
      expect(r.status).toBe(401);
      const ap = await rt.tenantApprovals(a.tenantId);
      expect((await ap.operations.get(opId))?.status).toBe('denied');
      await sessionA.client.close().catch(() => undefined);
    });

    it('уведомление ЮKassa: адрес — только через доверенный прокси; чужой адрес → 400', async () => {
      const body = JSON.stringify(kassa.notification('unknown-payment-id'));
      const foreign = await fetch(`${base}/billing/hooks/yookassa`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': FOREIGN_IP },
        body,
      });
      expect(foreign.status).toBe(400);
      const ok = await fetch(`${base}/billing/hooks/yookassa`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': YOOKASSA_IP },
        body,
      });
      expect(ok.status).toBe(200);
    });

    it('удаление приложения: доступ и биллинг остановлены, токены Bitrix24 удалены', async () => {
      await rt.db.run(
        "UPDATE subscriptions SET plan_code = 'start', status = 'active', period_end = ? WHERE tenant_id = ?",
        new Date(Date.now() + 30 * 86_400_000).toISOString(),
        b.tenantId,
      );
      const res = await post(
        '/b24/events',
        eventForm({
          event: 'ONAPPUNINSTALL',
          data: { CLEAN: 0 },
          auth: { member_id: b.memberId, application_token: b.applicationToken, domain: b.domain },
        }),
      );
      expect(res.status).toBe(200);
      expect((await rt.repos.tenants.get(b.tenantId))?.status).toBe('uninstalled');
      expect(await rt.bitrix.tokens.usersWithTokens(b.tenantId)).toEqual([]);
      const sub = await rt.repos.subscriptions.get(b.tenantId);
      expect(sub?.status).toBe('canceled');
      expect(sub?.suspendedAt).toBeTruthy();
      // Продления worker'а больше не трогают подписку.
      const renew = await rt.billing.subscriptions.renewDue(new Date(Date.now() + 60 * 86_400_000));
      expect(renew.charged).toBe(0);
      const r = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokenB}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      });
      expect(r.status).toBe(401);
      // Повтор события идемпотентен.
      const again = await post(
        '/b24/events',
        eventForm({
          event: 'ONAPPUNINSTALL',
          data: { CLEAN: 0 },
          auth: { member_id: b.memberId, application_token: b.applicationToken, domain: b.domain },
        }),
      );
      expect(again.status).toBe(200);
    });

    it('§6.3: через 30 дней после удаления приложения данные арендатора криптоудаляются задачей worker', async () => {
      // Путь «удалено приложение»: отметку биллинга (renewDue выше мог её поставить) снимаем.
      await rt.db.run(
        'UPDATE subscriptions SET deletion_requested_at = NULL WHERE tenant_id = ?',
        b.tenantId,
      );
      expect(await tenantsDueForDeletion(rt, Date.now())).not.toContain(b.tenantId);
      await rt.db.run(
        'UPDATE tenants SET uninstalled_at = ? WHERE id = ?',
        new Date(Date.now() - 31 * 86_400_000).toISOString(),
        b.tenantId,
      );
      expect(await tenantsDueForDeletion(rt, Date.now())).toEqual([b.tenantId]);
      const task = createWorkerTasks(rt).find((t) => t.name === 'retention.data_deletion');
      await task?.run(new AbortController().signal);
      expect((await rt.repos.tenants.get(b.tenantId))?.status).toBe('deleted');
      expect(await tenantsDueForDeletion(rt, Date.now())).toEqual([]);
      // Соседний арендатор не тронут.
      expect((await rt.repos.tenants.get(a.tenantId))?.status).toBe('active');
    });

    it('задачи worker выполняются на настоящих хранилищах', async () => {
      const tasks = createWorkerTasks(rt);
      expect(tasks.map((t) => t.name).sort()).toEqual(
        [
          'billing.renewals',
          'bitrix.app_info',
          'bitrix.token_refresh',
          'oauth.dcr_cleanup',
          'retention.cleanup',
          'retention.data_deletion',
          'usage.flush',
        ].sort(),
      );
      const signal = new AbortController().signal;
      for (const t of tasks) await t.run(signal);
      const status = await rt.bitrix.appStatus.lastStatus(a.tenantId);
      expect(status?.checkedAt).toBeTruthy();
    });

    it('процесс worker (startSaas, PROCESS_ROLE=worker): лидер по аренде в Redis, служебные /readyz и /metrics', async () => {
      const w = await startSaas(
        testConfig({ ...saasEnv, PROCESS_ROLE: 'worker', WORKER_TASKS: 'usage.flush' }),
        {
          fetch: fetchAll,
          logger: createSilentLogger(),
          startUsageFlush: false,
          host: '127.0.0.1',
          port: 0,
        },
      );
      try {
        for (let i = 0; i < 50 && !w.worker?.isLeader(); i += 1) await new Promise((r) => setTimeout(r, 50));
        expect(w.worker?.isLeader()).toBe(true);
        const ready = await fetch(`http://127.0.0.1:${String(w.port)}/readyz`);
        expect(await ready.json()).toMatchObject({ status: 'ready', leader: true });
        const m = await fetch(`http://127.0.0.1:${String(w.port)}/metrics`);
        expect(await m.text()).toContain('mcp_worker_leader 1');
      } finally {
        await w.close();
      }
    });

    it('секреты не попали в ответы: OAuth-токены Bitrix24 не видны в вызовах к ЮKassa и в URL, кроме сервера авторизации', () => {
      for (const u of cloud.urls) {
        if (new URL(u).origin === OAUTH_ORIGIN) continue;
        expect(cloud.hasPlaintext(u)).toBeUndefined();
      }
    });
  },
);

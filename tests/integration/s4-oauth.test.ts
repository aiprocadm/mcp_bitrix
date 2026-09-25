/**
 * SaaS-ТЗ S4 (§7.1, §7.2, §7.4): сервер авторизации MCP на настоящем PostgreSQL.
 * S05 — DCR + authorize (вход через тестовый BitrixLoginGateway) + согласие + code + token с PKCE и resource,
 * негативы; S06 — повтор ротированного refresh отзывает семью; S07 — отключение пользователя отклоняет старый
 * access по поколению; изоляция клиентов и арендаторов; ротация ключей и JWKS; метаданные; CIMD; отзыв RFC 7009.
 */
import { decodeJwt, decodeProtectedHeader, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpAuthError } from '../../src/auth/mcp-auth.js';
import { OperationsStore } from '../../src/storage/operations.js';
import { pkceS256 } from '../../src/saas/oauth/crypto.js';
import { REVOCATION_CHANNEL } from '../../src/saas/oauth/index.js';
import { openSaasTestDb, PG_AVAILABLE, type SaasTestDb } from '../helpers/saas.js';
import {
  authorizeToRedirect,
  BASE,
  cookieHeader,
  cookiesOf,
  hidden,
  makeStand,
  newPortal,
  parse,
  registerClient,
  RESOURCE,
  tokenRequest,
  verifierFor,
  type OAuthStand,
} from '../helpers/s4-oauth.js';

let s: SaasTestDb;
beforeAll(async () => {
  if (PG_AVAILABLE) s = await openSaasTestDb();
}, 60_000);
afterAll(async () => {
  if (PG_AVAILABLE) await s.close();
});

const CB = 'https://claude.ai/api/mcp/auth_callback';

/** Claims токена без exp/iat (их выставляет подпись заново). */
function claimsOf(token: string): JWTPayload {
  const { exp: _exp, iat: _iat, ...rest } = decodeJwt(token);
  return rest;
}

async function fullTokens(st: OAuthStand, opts: { bitrixUserId?: number; scope?: string } = {}) {
  const portal = await newPortal(st, opts.bitrixUserId ?? 1);
  const clientId = await registerClient(st);
  const verifier = verifierFor('main');
  const back = await authorizeToRedirect(st, {
    clientId,
    verifier,
    portal: portal.domain,
    loginCode: portal.loginCode,
    ...(opts.scope ? { scope: opts.scope } : {}),
  });
  const code = back.searchParams.get('code') ?? '';
  const res = await st.as.token(
    tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: CB,
      code_verifier: verifier,
      client_id: clientId,
      resource: RESOURCE,
    }),
  );
  expect(res.status).toBe(200);
  const body = parse(res) as {
    access_token: string;
    refresh_token: string;
    scope: string;
    expires_in: number;
  };
  return { ...portal, clientId, ...body };
}

describe.skipIf(!PG_AVAILABLE)('S4: сервер авторизации MCP (PostgreSQL)', () => {
  it('метаданные RFC 8414 / RFC 9728 соответствуют спецификации MCP 2026-07-28; JWKS без закрытых частей', async () => {
    const st = await makeStand(s);
    const as = st.as.authorizationServerMetadata();
    expect(as).toMatchObject({
      issuer: BASE,
      authorization_endpoint: `${BASE}/oauth/authorize`,
      token_endpoint: `${BASE}/oauth/token`,
      registration_endpoint: `${BASE}/oauth/register`,
      revocation_endpoint: `${BASE}/oauth/revoke`,
      jwks_uri: `${BASE}/oauth/jwks`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
    });
    const prm = st.as.protectedResourceMetadata();
    expect(prm).toMatchObject({
      resource: RESOURCE,
      authorization_servers: [BASE],
      scopes_supported: ['mcp:read', 'mcp:write'],
      bearer_methods_supported: ['header'],
    });
    expect(prm['scopes_supported']).not.toContain('offline_access');
    expect(st.as.resourceMetadataUrl()).toBe(`${BASE}/.well-known/oauth-protected-resource/mcp`);
    const jwks = JSON.parse(st.as.jwksResponse().body) as { keys: Record<string, unknown>[] };
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
    expect(jwks.keys[0]).not.toHaveProperty('d');
  });

  it('S05: полный поток DCR → authorize → вход Bitrix24 → согласие → code → token (PKCE S256 + resource)', async () => {
    const st = await makeStand(s);
    const portal = await newPortal(st, 7);
    const clientId = await registerClient(st);
    const jar = new Map<string, string>();
    const verifier = verifierFor('s05');

    const page = await st.as.authorize({
      query: {
        response_type: 'code',
        client_id: clientId,
        redirect_uri: CB,
        code_challenge: pkceS256(verifier),
        code_challenge_method: 'S256',
        resource: RESOURCE,
        scope: 'mcp:read mcp:write',
        state: 'xyz',
      },
    });
    expect(page.status).toBe(200);
    expect(page.headers['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(page.headers['X-Frame-Options']).toBe('DENY');
    expect(page.setCookies[0]).toMatch(/^__Host-mcp_as_bind=.+; Path=\/; .*HttpOnly; SameSite=Lax; Secure$/);
    cookiesOf(page, jar);

    const login = await st.as.login({
      body: { request: hidden(page.body, 'request'), csrf: hidden(page.body, 'csrf'), portal: portal.domain },
      headers: { cookie: cookieHeader(jar) },
    });
    expect(login.status).toBe(303);
    const bitrix = new URL(login.headers['Location'] ?? '');
    expect(bitrix.host).toBe(portal.domain);
    expect(st.gateway.started.at(-1)?.portal).toBe(portal.domain);

    const cb = await st.as.bitrixCallback({
      query: { code: portal.loginCode, state: bitrix.searchParams.get('state') ?? '' },
      headers: { cookie: cookieHeader(jar) },
    });
    expect(cb.status).toBe(200);
    expect(cb.body).toContain('Claude');
    expect(cb.body).toContain('mcp:read');
    expect(cb.body).toContain('mcp:write');
    expect(cb.body).toContain(portal.domain);
    expect(cb.body).toContain('claude.ai');
    expect(cb.body).not.toMatch(/<script/i);

    const consent = await st.as.consent({
      body: { consent: hidden(cb.body, 'consent'), csrf: hidden(cb.body, 'csrf'), decision: 'approve' },
      headers: { cookie: cookieHeader(jar) },
    });
    expect(consent.status).toBe(303);
    const back = new URL(consent.headers['Location'] ?? '');
    expect(`${back.origin}${back.pathname}`).toBe(CB);
    expect(back.searchParams.get('state')).toBe('xyz');
    expect(back.searchParams.get('iss')).toBe(BASE);
    const code = back.searchParams.get('code') ?? '';
    expect(code.length).toBeGreaterThan(30);
    // В БД — только хеш кода.
    const raw = await s.db.get<{ n: string }>(
      'SELECT COUNT(*) AS n FROM mcp_auth_codes WHERE code_hash = ?',
      code,
    );
    expect(Number(raw?.n)).toBe(0);

    const res = await st.as.token(
      tokenRequest({
        grant_type: 'authorization_code',
        code,
        redirect_uri: CB,
        code_verifier: verifier,
        client_id: clientId,
        resource: RESOURCE,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers['Cache-Control']).toBe('no-store');
    const body = parse(res);
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 600, scope: 'mcp:read mcp:write' });
    const access = body['access_token'] as string;
    expect(String(body['refresh_token'])).toMatch(/^mcpr_/);
    const header = decodeProtectedHeader(access);
    expect(header).toMatchObject({ alg: 'ES256', typ: 'at+jwt', kid: st.keys.activeKid() });
    const claims = decodeJwt(access);
    expect(claims).toMatchObject({
      iss: BASE,
      aud: RESOURCE,
      tid: portal.tenantId,
      scope: 'mcp:read mcp:write',
      gen: 0,
      client_id: clientId,
    });
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(600);
    expect(typeof claims.jti).toBe('string');

    const p = await st.verifier.verify(`Bearer ${access}`);
    expect(p).toMatchObject({ tenantId: portal.tenantId, bitrixUserId: 7, role: 'operator', clientId });
    expect(p.userId).toBe(claims.sub);
    expect(p.scopes).toEqual(['mcp:read', 'mcp:write']);
  });

  it('S05: только mcp:read → роль reader; согласие запоминается для пары пользователь–клиент', async () => {
    const st = await makeStand(s);
    const portal = await newPortal(st, 3);
    const clientId = await registerClient(st);
    const first = await authorizeToRedirect(st, {
      clientId,
      portal: portal.domain,
      loginCode: portal.loginCode,
      scope: 'mcp:read',
    });
    expect(first.searchParams.get('code')).toBeTruthy();
    // Повторный вход: экрана согласия нет — обратный вызов сразу перенаправляет с кодом.
    const verifier = verifierFor('again');
    const again = await authorizeToRedirect(st, {
      clientId,
      verifier,
      portal: portal.domain,
      loginCode: portal.loginCode,
      scope: 'mcp:read',
    });
    const res = await st.as.token(
      tokenRequest({
        grant_type: 'authorization_code',
        code: again.searchParams.get('code') ?? '',
        redirect_uri: CB,
        code_verifier: verifier,
        client_id: clientId,
        resource: RESOURCE,
      }),
    );
    const p = await st.verifier.verify(`Bearer ${String(parse(res)['access_token'])}`);
    expect(p.role).toBe('reader');
    expect(p.scopes).toEqual(['mcp:read']);
  });

  it('S05 негативы authorize: чужой redirect_uri — страница без редиректа; plain/нет PKCE, нет/чужой resource, неизвестный scope — ошибка по RFC', async () => {
    const st = await makeStand(s);
    const clientId = await registerClient(st);
    const base = {
      response_type: 'code',
      client_id: clientId,
      redirect_uri: CB,
      code_challenge: pkceS256(verifierFor('neg')),
      code_challenge_method: 'S256',
      resource: RESOURCE,
      state: 's',
    };
    const foreign = await st.as.authorize({ query: { ...base, redirect_uri: 'https://evil.example/cb' } });
    expect(foreign.status).toBe(400);
    expect(foreign.headers['Location']).toBeUndefined();
    const unknown = await st.as.authorize({ query: { ...base, client_id: 'mcp_unknown' } });
    expect(unknown.status).toBe(400);
    expect(unknown.headers['Location']).toBeUndefined();

    const errorOf = async (query: Record<string, string | undefined>) => {
      const res = await st.as.authorize({ query });
      expect(res.status).toBe(302);
      const loc = new URL(res.headers['Location'] ?? '');
      expect(`${loc.origin}${loc.pathname}`).toBe(CB);
      expect(loc.searchParams.get('iss')).toBe(BASE);
      expect(loc.searchParams.get('state')).toBe('s');
      expect(loc.searchParams.get('code')).toBeNull();
      return loc.searchParams.get('error');
    };
    expect(await errorOf({ ...base, code_challenge_method: 'plain' })).toBe('invalid_request');
    expect(await errorOf({ ...base, code_challenge_method: undefined })).toBe('invalid_request');
    expect(await errorOf({ ...base, code_challenge: undefined })).toBe('invalid_request');
    expect(await errorOf({ ...base, resource: undefined })).toBe('invalid_request');
    expect(await errorOf({ ...base, resource: 'https://other.example/mcp' })).toBe('invalid_target');
    expect(await errorOf({ ...base, resource: `${BASE}/other` })).toBe('invalid_target');
    expect(await errorOf({ ...base, scope: 'mcp:admin' })).toBe('invalid_scope');
    expect(await errorOf({ ...base, response_type: 'token' })).toBe('unsupported_response_type');
    // Регистр схемы/хоста и завершающий «/» в resource допустимы (спецификация: SHOULD accept uppercase).
    const ok = await st.as.authorize({ query: { ...base, resource: 'HTTPS://MCP.EXAMPLE.RU/mcp/' } });
    expect(ok.status).toBe(200);
  });

  it('S05 негативы token: неверный verifier (код сгорает), чужой redirect_uri, нет/чужой resource, повтор и истечение кода', async () => {
    const st = await makeStand(s);
    const portal = await newPortal(st);
    const clientId = await registerClient(st);
    const verifier = verifierFor('tok');
    const getCode = async () =>
      (
        await authorizeToRedirect(st, {
          clientId,
          verifier,
          portal: portal.domain,
          loginCode: portal.loginCode,
        })
      ).searchParams.get('code') ?? '';
    const req = (code: string, over: Record<string, string | undefined> = {}) => {
      const body: Record<string, string> = {};
      for (const [k, v] of Object.entries({
        grant_type: 'authorization_code',
        code,
        redirect_uri: CB,
        code_verifier: verifier,
        client_id: clientId,
        resource: RESOURCE,
        ...over,
      }))
        if (v !== undefined) body[k] = v;
      return st.as.token(tokenRequest(body));
    };
    const err = async (p: Promise<{ status: number; body: string }>) => {
      const r = await p;
      expect(r.status).toBe(400);
      return (JSON.parse(r.body) as { error: string }).error;
    };

    const c1 = await getCode();
    expect(await err(req(c1, { code_verifier: verifierFor('wrong') }))).toBe('invalid_grant');
    expect(await err(req(c1))).toBe('invalid_grant'); // код одноразовый даже после ошибки

    expect(await err(req(await getCode(), { redirect_uri: 'https://claude.ai/other' }))).toBe(
      'invalid_grant',
    );
    expect(await err(req(await getCode(), { resource: undefined }))).toBe('invalid_request');
    expect(await err(req(await getCode(), { resource: 'https://other.example/mcp' }))).toBe('invalid_target');
    expect(await err(req(await getCode(), { code_verifier: undefined }))).toBe('invalid_request');

    // Повтор кода: второй обмен отклонён, refresh от первого обмена отозван (OAuth 2.1 §4.1.3).
    const c2 = await getCode();
    const first = await req(c2);
    expect(first.status).toBe(200);
    const refresh = String(parse(first)['refresh_token']);
    expect(await err(req(c2))).toBe('invalid_grant');
    expect(
      await err(
        st.as.token(
          tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId }),
        ),
      ),
    ).toBe('invalid_grant');

    // Истечение: TTL кода 60 с.
    const c3 = await getCode();
    st.clock.advance(61);
    expect(await err(req(c3))).toBe('invalid_grant');

    expect(await err(st.as.token(tokenRequest({ grant_type: 'password', client_id: clientId })))).toBe(
      'unsupported_grant_type',
    );
  });

  it('S06: повтор уже ротированного refresh-токена отзывает всю семью', async () => {
    const st = await makeStand(s);
    const t = await fullTokens(st);
    const refresh = (token: string) =>
      st.as.token(tokenRequest({ grant_type: 'refresh_token', refresh_token: token, client_id: t.clientId }));
    const r1 = await refresh(t.refresh_token);
    expect(r1.status).toBe(200);
    const b1 = parse(r1) as { refresh_token: string; access_token: string };
    expect(b1.refresh_token).not.toBe(t.refresh_token);
    const r2 = await refresh(b1.refresh_token);
    expect(r2.status).toBe(200);
    const b2 = parse(r2) as { refresh_token: string };

    // Атакующий (или клиент) повторяет старый токен → invalid_grant и отзыв семьи.
    const replay = await refresh(t.refresh_token);
    expect(replay.status).toBe(400);
    expect(parse(replay)['error']).toBe('invalid_grant');
    const afterReplay = await refresh(b2.refresh_token);
    expect(parse(afterReplay)['error']).toBe('invalid_grant');
    const fam = await s.db.get<{ family_id: string }>(
      'SELECT family_id FROM mcp_refresh_tokens WHERE tenant_id = ? LIMIT 1',
      t.tenantId,
    );
    expect(await st.as.refreshTokens.activeInFamily(fam?.family_id ?? '')).toBe(0);

    // Сужение scope при обновлении допустимо, расширение — нет.
    const t2 = await fullTokens(st);
    const narrow = await st.as.token(
      tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: t2.refresh_token,
        client_id: t2.clientId,
        scope: 'mcp:read',
      }),
    );
    expect(parse(narrow)['scope']).toBe('mcp:read');
    const widen = await st.as.token(
      tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: String(parse(narrow)['refresh_token']),
        client_id: t2.clientId,
        scope: 'mcp:read mcp:write',
      }),
    );
    expect(parse(widen)['error']).toBe('invalid_scope');
  });

  it('S07: отключение пользователя — старый access отклоняется по поколению (401), refresh отозван, операции denied', async () => {
    const st = await makeStand(s);
    const t = await fullTokens(st);
    const p = await st.verifier.verify(`Bearer ${t.access_token}`);
    const ops = new OperationsStore(s.db, t.tenantId);
    await ops.createPrepared({
      id: `op-${t.clientId}`,
      principalId: p.userId,
      portalKey: 'k',
      tool: 'task_create',
      operationKind: 'create',
      argsHash: 'h',
      target: null,
      expectedStateHash: null,
      fileHash: null,
      policyVersion: '1',
      planEncrypted: 'x',
      idempotencyKey: null,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    const events: string[] = [];
    await st.coordination.subscribe(REVOCATION_CHANNEL, (m) => events.push(m));

    const result = await st.as.revokeUser(t.tenantId, p.userId);
    expect(result).toEqual({ refreshRevoked: 1, operationsDenied: 1 });
    expect((await ops.get(`op-${t.clientId}`))?.status).toBe('denied');
    expect(JSON.parse(events[0] ?? '{}')).toEqual({ tenantId: t.tenantId, userId: p.userId });

    const rejected = await st.verifier.verify(`Bearer ${t.access_token}`).catch((e: unknown) => e);
    expect(rejected).toBeInstanceOf(McpAuthError);
    expect(rejected).toMatchObject({
      status: 401,
      code: 'invalid_token',
      asciiDescription: 'token generation revoked',
    });
    const refresh = await st.as.token(
      tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.clientId }),
    );
    expect(parse(refresh)['error']).toBe('invalid_grant');

    // Отключение администратором (статус disabled) тоже отклоняет токен и не даёт войти снова.
    const t2 = await fullTokens(st, { bitrixUserId: 2 });
    const p2 = await st.verifier.verify(`Bearer ${t2.access_token}`);
    await st.users.setStatus(t2.tenantId, p2.userId, 'disabled');
    await expect(st.verifier.verify(`Bearer ${t2.access_token}`)).rejects.toMatchObject({ status: 401 });
    const again = await authorizeToRedirect(st, {
      clientId: t2.clientId,
      portal: t2.domain,
      loginCode: t2.loginCode,
    });
    expect(again.searchParams.get('error')).toBe('access_denied');
    expect(again.searchParams.get('code')).toBeNull();
  });

  it('отзыв арендатора: все пользователи портала, операции, refresh; заблокированный портал не принимается', async () => {
    const st = await makeStand(s);
    const t = await fullTokens(st);
    const r = await st.as.revokeTenant(t.tenantId);
    expect(r.refreshRevoked).toBe(1);
    await expect(st.verifier.verify(`Bearer ${t.access_token}`)).rejects.toMatchObject({ status: 401 });
    const t2 = await fullTokens(st);
    await st.tenants.setStatus(t2.tenantId, 'suspended');
    await expect(st.verifier.verify(`Bearer ${t2.access_token}`)).rejects.toMatchObject({
      status: 401,
      asciiDescription: 'tenant inactive',
    });
  });

  it('изоляция: код и refresh одного клиента не работают для другого; токен арендатора A не даёт доступа к B', async () => {
    const st = await makeStand(s);
    const a = await newPortal(st, 1);
    const b = await newPortal(st, 1);
    const clientA = await registerClient(st);
    const clientB = await registerClient(st);
    const verifier = verifierFor('iso');
    const back = await authorizeToRedirect(st, {
      clientId: clientA,
      verifier,
      portal: a.domain,
      loginCode: a.loginCode,
    });
    const stolen = await st.as.token(
      tokenRequest({
        grant_type: 'authorization_code',
        code: back.searchParams.get('code') ?? '',
        redirect_uri: CB,
        code_verifier: verifier,
        client_id: clientB,
        resource: RESOURCE,
      }),
    );
    expect(parse(stolen)['error']).toBe('invalid_grant');

    const tA = await fullTokens(st);
    const crossRefresh = await st.as.token(
      tokenRequest({ grant_type: 'refresh_token', refresh_token: tA.refresh_token, client_id: clientB }),
    );
    expect(parse(crossRefresh)['error']).toBe('invalid_grant');
    // Отказ чужому клиенту не сжигает токен законного владельца.
    const own = await st.as.token(
      tokenRequest({ grant_type: 'refresh_token', refresh_token: tA.refresh_token, client_id: tA.clientId }),
    );
    expect(own.status).toBe(200);

    // Портал, выбранный на шаге входа, должен совпасть с порталом, в который вошёл пользователь.
    const pA = await st.verifier.verify(`Bearer ${tA.access_token}`);
    expect(pA.tenantId).toBe(tA.tenantId);
    // Подписанный нашим ключом токен с tid=B и sub пользователя A: пользователя в B нет → 401.
    const forged = await st.keys.sign({ ...claimsOf(tA.access_token), tid: b.tenantId }, 600);
    await expect(st.verifier.verify(`Bearer ${forged}`)).rejects.toMatchObject({ status: 401 });
    // Токен, подписанный чужим ключом с верными claims, — 401.
    const { privateKey } = await generateKeyPair('ES256');
    const foreign = await new SignJWT(decodeJwt(tA.access_token))
      .setProtectedHeader({ alg: 'ES256', kid: st.keys.activeKid() ?? 'x', typ: 'at+jwt' })
      .sign(privateKey);
    await expect(st.verifier.verify(`Bearer ${foreign}`)).rejects.toMatchObject({ status: 401 });
    // aud чужого ресурса — 401.
    const otherAud = await st.keys.sign(
      { ...claimsOf(tA.access_token), aud: 'https://other.example/mcp' },
      600,
    );
    await expect(st.verifier.verify(`Bearer ${otherAud}`)).rejects.toMatchObject({ status: 401 });
    await expect(st.verifier.verify(undefined)).rejects.toMatchObject({ status: 401 });
    await expect(st.verifier.verify('Basic abc')).rejects.toMatchObject({ status: 400 });
    expect((await exportJWK((await generateKeyPair('ES256')).publicKey)).d).toBeUndefined();
  });

  it('вход: CSRF и привязка к браузеру; неустановленный портал; отказ в согласии', async () => {
    const st = await makeStand(s);
    const portal = await newPortal(st);
    const clientId = await registerClient(st);
    const jar = new Map<string, string>();
    const page = await st.as.authorize({
      query: {
        response_type: 'code',
        client_id: clientId,
        redirect_uri: CB,
        code_challenge: pkceS256(verifierFor('csrf')),
        code_challenge_method: 'S256',
        resource: RESOURCE,
      },
    });
    cookiesOf(page, jar);
    const request = hidden(page.body, 'request');
    const csrf = hidden(page.body, 'csrf');
    // Без cookie привязки и с чужим CSRF — отказ.
    expect((await st.as.login({ body: { request, csrf, portal: portal.domain } })).status).toBe(400);
    expect(
      (
        await st.as.login({
          body: { request, csrf: 'x'.repeat(43), portal: portal.domain },
          headers: { cookie: cookieHeader(jar) },
        })
      ).status,
    ).toBe(400);
    // Портал без установленного приложения — страница «установите приложение».
    const notInstalled = await st.as.login({
      body: { request, csrf, portal: 'unknown-portal.bitrix24.ru' },
      headers: { cookie: cookieHeader(jar) },
    });
    expect(notInstalled.status).toBe(200);
    expect(notInstalled.body).toContain('не установлено');

    const login = await st.as.login({
      body: { request, csrf, portal: portal.domain },
      headers: { cookie: cookieHeader(jar) },
    });
    const state = new URL(login.headers['Location'] ?? '').searchParams.get('state') ?? '';
    // Обратный вызов в другом браузере (без cookie) — отказ.
    expect((await st.as.bitrixCallback({ query: { code: portal.loginCode, state } })).status).toBe(400);
    // Приложение удалено с портала на стороне Bitrix24.
    const removed = await st.as.bitrixCallback({
      query: { code: 'not-installed', state },
      headers: { cookie: cookieHeader(jar) },
    });
    expect(removed.body).toContain('не установлено');

    const cb = await st.as.bitrixCallback({
      query: { code: portal.loginCode, state },
      headers: { cookie: cookieHeader(jar) },
    });
    const consentSealed = hidden(cb.body, 'consent');
    // Состояние входа нельзя подставить как состояние согласия (назначение в AAD).
    expect(
      (
        await st.as.consent({
          body: { consent: state.slice(6), csrf: hidden(cb.body, 'csrf'), decision: 'approve' },
          headers: { cookie: cookieHeader(jar) },
        })
      ).status,
    ).toBe(400);
    const deny = await st.as.consent({
      body: { consent: consentSealed, csrf: hidden(cb.body, 'csrf'), decision: 'deny' },
      headers: { cookie: cookieHeader(jar) },
    });
    expect(deny.status).toBe(303);
    const loc = new URL(deny.headers['Location'] ?? '');
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('code')).toBeNull();
    // Истечение состояния авторизации (10 минут).
    st.clock.advance(601);
    const late = await st.as.consent({
      body: { consent: consentSealed, csrf: hidden(cb.body, 'csrf'), decision: 'approve' },
      headers: { cookie: cookieHeader(jar) },
    });
    expect(late.status).toBe(400);
  });

  it('JWKS и ротация ключей: старый ключ живёт до истечения выданных токенов, затем удаляется', async () => {
    const st = await makeStand(s);
    const t = await fullTokens(st);
    const oldKid = st.keys.activeKid();
    const newKid = await st.keys.rotate();
    expect(newKid).not.toBe(oldKid);
    const kids = (JSON.parse(st.as.jwksResponse().body) as { keys: { kid: string }[] }).keys.map(
      (k) => k.kid,
    );
    expect(kids).toEqual(expect.arrayContaining([oldKid, newKid]));
    await expect(st.verifier.verify(`Bearer ${t.access_token}`)).resolves.toMatchObject({
      tenantId: t.tenantId,
    });
    const r = await st.as.token(
      tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.clientId }),
    );
    expect(decodeProtectedHeader(String(parse(r)['access_token'])).kid).toBe(newKid);
    st.clock.advance(600 + 61);
    await st.keys.reload();
    const after = (JSON.parse(st.as.jwksResponse().body) as { keys: { kid: string }[] }).keys.map(
      (k) => k.kid,
    );
    expect(after).toEqual([newKid]);
    await expect(st.verifier.verify(`Bearer ${t.access_token}`)).rejects.toMatchObject({ status: 401 });
    // Автоматическая ротация по возрасту (runMaintenance у worker).
    st.clock.advance(31 * 86_400);
    const m = await st.as.runMaintenance();
    expect(m.rotated).toBe(true);
    expect(st.keys.activeKid()).not.toBe(newKid);
  });

  it('DCR: лимит регистраций с IP; неиспользуемые клиенты удаляются через 30 дней вместе с согласиями', async () => {
    const st = await makeStand(s, { settings: { registrationRateLimit: { limit: 3, windowSec: 3600 } } });
    for (let i = 0; i < 3; i += 1) await registerClient(st, {}, '198.51.100.9');
    const limited = await st.as.register({
      ip: '198.51.100.9',
      body: { redirect_uris: [CB], token_endpoint_auth_method: 'none' },
    });
    expect(limited.status).toBe(429);
    expect(limited.headers['Retry-After']).toBe('3600');
    await registerClient(st, {}, '198.51.100.10');

    const bad = await st.as.register({ ip: '1.1.1.1', body: { redirect_uris: ['javascript:alert(1)'] } });
    expect(parse(bad)['error']).toBe('invalid_redirect_uri');
    const badGrant = await st.as.register({
      ip: '1.1.1.1',
      body: { redirect_uris: [CB], grant_types: ['client_credentials'] },
    });
    expect(parse(badGrant)['error']).toBe('invalid_client_metadata');

    const t = await fullTokens(st);
    st.clock.advance(31 * 86_400);
    const m = await st.as.runMaintenance();
    expect(m.clients).toBeGreaterThanOrEqual(5);
    expect(await st.as.clients.get(t.clientId)).toBeUndefined();
    const consents = await st.as.consents.get(t.tenantId, decodeJwt(t.access_token).sub ?? '', t.clientId);
    expect(consents).toBeUndefined();
  });

  it('конфиденциальный клиент (client_secret_basic по умолчанию RFC 7591): без секрета — invalid_client 401', async () => {
    const st = await makeStand(s);
    const portal = await newPortal(st);
    const reg = await st.as.register({
      ip: '1.2.3.4',
      body: { client_name: 'ChatGPT', redirect_uris: [CB] },
    });
    const client = parse(reg) as {
      client_id: string;
      client_secret: string;
      token_endpoint_auth_method: string;
    };
    expect(client.token_endpoint_auth_method).toBe('client_secret_basic');
    expect(client.client_secret).toMatch(/^mcps_/);
    const verifier = verifierFor('conf');
    const code = async () =>
      (
        await authorizeToRedirect(st, {
          clientId: client.client_id,
          verifier,
          portal: portal.domain,
          loginCode: portal.loginCode,
        })
      ).searchParams.get('code') ?? '';
    const body = (c: string) => ({
      grant_type: 'authorization_code',
      code: c,
      redirect_uri: CB,
      code_verifier: verifier,
      resource: RESOURCE,
    });
    const noSecret = await st.as.token(tokenRequest({ ...body(await code()), client_id: client.client_id }));
    expect(noSecret.status).toBe(401);
    expect(parse(noSecret)['error']).toBe('invalid_client');
    const basic = `Basic ${Buffer.from(`${client.client_id}:wrong`).toString('base64')}`;
    const wrong = await st.as.token(tokenRequest(body(await code()), { authorization: basic }));
    expect(wrong.status).toBe(401);
    expect(wrong.headers['WWW-Authenticate']).toContain('Basic');
    const good = `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64')}`;
    const ok = await st.as.token(tokenRequest(body(await code()), { authorization: good }));
    expect(ok.status).toBe(200);
  });

  it('redirect_uri: loopback IP — любой порт (OAuth 2.1 §8.4.2); localhost и https — точное совпадение', async () => {
    const st = await makeStand(s);
    const portal = await newPortal(st);
    const clientId = await registerClient(st, {
      redirect_uris: ['http://127.0.0.1:3000/callback', 'http://localhost:4000/callback'],
      application_type: 'native',
    });
    const q = (redirect: string) => ({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirect,
      code_challenge: pkceS256(verifierFor('lb')),
      code_challenge_method: 'S256',
      resource: RESOURCE,
    });
    expect((await st.as.authorize({ query: q('http://127.0.0.1:51234/callback') })).status).toBe(200);
    expect((await st.as.authorize({ query: q('http://127.0.0.1:51234/other') })).status).toBe(400);
    expect((await st.as.authorize({ query: q('http://localhost:4000/callback') })).status).toBe(200);
    expect((await st.as.authorize({ query: q('http://localhost:4001/callback') })).status).toBe(400);
    const verifier = verifierFor('lb2');
    const back = await authorizeToRedirect(st, {
      clientId,
      verifier,
      redirectUri: 'http://127.0.0.1:61000/callback',
      portal: portal.domain,
      loginCode: portal.loginCode,
    });
    expect(back.port).toBe('61000');
    const ok = await st.as.token(
      tokenRequest({
        grant_type: 'authorization_code',
        code: back.searchParams.get('code') ?? '',
        redirect_uri: 'http://127.0.0.1:61000/callback',
        code_verifier: verifier,
        client_id: clientId,
        resource: RESOURCE,
      }),
    );
    expect(ok.status).toBe(200);
  });

  it('Client ID Metadata Document: загрузка, сверка client_id, кэш; подмена и частный адрес отклоняются', async () => {
    const docUrl = 'https://client.example.com/oauth/metadata.json';
    let calls = 0;
    let doc: Record<string, unknown> = {
      client_id: docUrl,
      client_name: 'Example MCP Client',
      redirect_uris: ['http://127.0.0.1:3000/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
    const fetchFn = (url: string, init: RequestInit) => {
      calls += 1;
      expect(url).toBe(docUrl);
      expect(init.redirect).toBe('manual');
      return Promise.resolve(
        new Response(JSON.stringify(doc), { status: 200, headers: { 'cache-control': 'max-age=600' } }),
      );
    };
    const st = await makeStand(s, { fetch: fetchFn });
    const portal = await newPortal(st);
    const verifier = verifierFor('cimd');
    const back = await authorizeToRedirect(st, {
      clientId: docUrl,
      verifier,
      redirectUri: 'http://127.0.0.1:3000/callback',
      portal: portal.domain,
      loginCode: portal.loginCode,
    });
    const res = await st.as.token(
      tokenRequest({
        grant_type: 'authorization_code',
        code: back.searchParams.get('code') ?? '',
        redirect_uri: 'http://127.0.0.1:3000/callback',
        code_verifier: verifier,
        client_id: docUrl,
        resource: RESOURCE,
      }),
    );
    expect(res.status).toBe(200);
    expect(calls).toBe(1); // дальше — из кэша (max-age=600)

    st.clock.advance(601);
    doc = { ...doc, client_id: 'https://attacker.example/metadata.json' };
    const mismatch = await st.as.authorize({
      query: {
        response_type: 'code',
        client_id: docUrl,
        redirect_uri: 'http://127.0.0.1:3000/callback',
        code_challenge: pkceS256(verifier),
        code_challenge_method: 'S256',
        resource: RESOURCE,
      },
    });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body).toContain('не совпадает');

    const privateStand = await makeStand(s, { fetch: fetchFn });
    const privRes = await privateStand.as.authorize({
      query: { client_id: 'https://10.0.0.1/metadata.json', response_type: 'code' },
    });
    expect(privRes.status).toBe(400);
  });

  it('отзыв RFC 7009: refresh — вся семья; access — по jti; чужой клиент ничего не отзывает', async () => {
    const st = await makeStand(s);
    const t = await fullTokens(st);
    const other = await registerClient(st);
    const foreignRevoke = await st.as.revoke(tokenRequest({ token: t.refresh_token, client_id: other }));
    expect(foreignRevoke.status).toBe(200);
    const stillOk = await st.as.token(
      tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.clientId }),
    );
    expect(stillOk.status).toBe(200);
    const b = parse(stillOk) as { refresh_token: string; access_token: string };

    expect((await st.as.revoke(tokenRequest({ token: b.access_token, client_id: t.clientId }))).status).toBe(
      200,
    );
    await expect(st.verifier.verify(`Bearer ${b.access_token}`)).rejects.toMatchObject({
      status: 401,
      asciiDescription: 'token revoked',
    });
    expect((await st.as.revoke(tokenRequest({ token: b.refresh_token, client_id: t.clientId }))).status).toBe(
      200,
    );
    const after = await st.as.token(
      tokenRequest({ grant_type: 'refresh_token', refresh_token: b.refresh_token, client_id: t.clientId }),
    );
    expect(parse(after)['error']).toBe('invalid_grant');
    expect((await st.as.revoke(tokenRequest({ token: 'garbage', client_id: t.clientId }))).status).toBe(200);
  });
});

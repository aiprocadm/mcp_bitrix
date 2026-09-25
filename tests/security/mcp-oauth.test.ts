/**
 * T39 (HTTP без/с просроченным токеном), T40 (чужой Origin/сессия) в режиме MCP_AUTH_MODE=oauth —
 * спецификация MCP Authorization (S25): токен на каждом запросе, aud/iss/exp/подпись, allowlist субъектов,
 * scope → роль, WWW-Authenticate с resource_metadata, документ RFC 9728, привязка сессии к субъекту.
 * Издатель — локальная пара ключей; JWKS отдаётся либо напрямую (createLocalJWKSet), либо настоящим
 * HTTP-сервером на loopback (путь createRemoteJWKSet).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
import { McpTokenVerifier } from '../../src/auth/mcp-auth.js';
import { startHttp, type HttpHandle } from '../../src/mcp/http.js';
import { createTestApp, type TestApp } from '../helpers/app.js';

const ISSUER = 'https://issuer.test/realms/mcp';
const PUBLIC_URL = 'http://127.0.0.1/mcp';
const AUDIENCE = 'http://127.0.0.1/mcp';

interface Issuer {
  privateKey: PrivateKey;
  jwk: JWK;
  jwks: { keys: JWK[] };
}

async function makeIssuer(kid: string): Promise<Issuer> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  return { privateKey, jwk, jwks: { keys: [jwk] } };
}

interface MintOptions {
  sub: string;
  scope?: string;
  aud?: string;
  iss?: string;
  expiresIn?: string;
  issuer?: Issuer;
  kid?: string;
}

const INIT_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
});

describe('OAuth-защита MCP (HTTP)', () => {
  let issuer: Issuer;
  let other: Issuer;
  let t: TestApp;
  let handle: HttpHandle;
  let base: string;
  let policyDir: string;

  const mint = async (o: MintOptions): Promise<string> => {
    const iss = o.issuer ?? issuer;
    const jwt = new SignJWT({ ...(o.scope !== undefined ? { scope: o.scope } : {}) })
      .setProtectedHeader({ alg: 'RS256', kid: o.kid ?? iss.jwk.kid ?? 'k' })
      .setSubject(o.sub)
      .setIssuedAt()
      .setIssuer(o.iss ?? ISSUER)
      .setAudience(o.aud ?? AUDIENCE)
      .setExpirationTime(o.expiresIn ?? '5m');
    return jwt.sign(iss.privateKey);
  };

  const post = (headers: Record<string, string>, body = INIT_BODY, url = `${base}/mcp`) =>
    fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body,
    });

  const connect = async (token: string) => {
    const client = new Client({ name: 'oauth-test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      authProvider: { token: () => Promise.resolve(token) },
    });
    await client.connect(transport);
    return { client, transport };
  };

  beforeAll(async () => {
    issuer = await makeIssuer('main');
    other = await makeIssuer('other');
    policyDir = mkdtempSync(path.join(tmpdir(), 'mcp-oauth-'));
    const accessFile = path.join(policyDir, 'access.json');
    writeFileSync(
      accessFile,
      JSON.stringify({
        version: 'test',
        principals: { owner: { role: 'administrator' }, alice: { role: 'administrator' } },
        deniedTools: {},
      }),
    );
    t = createTestApp({
      MCP_TRANSPORT: 'http',
      MCP_HOST: '127.0.0.1',
      MCP_AUTH_MODE: 'oauth',
      MCP_PUBLIC_URL: PUBLIC_URL,
      MCP_AUTH_ISSUER: ISSUER,
      MCP_AUTH_JWKS_URI: 'http://127.0.0.1:1/never-fetched',
      MCP_AUTH_ALLOWED_SUBJECTS: 'alice,bob',
      MCP_ALLOWED_ORIGINS: 'https://app.allowed.test',
      ACCESS_POLICY_FILE: accessFile,
      READ_ONLY_MODE: 'false',
      CONFIRM_ALL_WRITES: 'true',
    });
    const auth = t.config.server.auth;
    if (!auth) throw new Error('auth settings missing');
    const verifier = new McpTokenVerifier(auth, t.app.policies.access, createLocalJWKSet(issuer.jwks));
    handle = await startHttp(t.app, { host: '127.0.0.1', port: 0, verifier });
    base = `http://127.0.0.1:${String(handle.port)}`;
  });
  afterAll(async () => {
    await handle.close();
    t.app.close();
    rmSync(policyDir, { recursive: true, force: true });
  });

  it('конфигурация: канонический resource, metadata URL, Host из публичного адреса', () => {
    expect(t.config.server.auth).toMatchObject({
      resource: 'http://127.0.0.1/mcp',
      audience: 'http://127.0.0.1/mcp',
      issuer: ISSUER,
      metadataUrl: 'http://127.0.0.1/.well-known/oauth-protected-resource/mcp',
    });
    expect(t.config.server.allowedHosts).toEqual(['127.0.0.1']);
  });

  it('T39: без токена — 401 с WWW-Authenticate (resource_metadata, scope), сессия не создаётся', async () => {
    const r = await post({});
    expect(r.status).toBe(401);
    const www = r.headers.get('www-authenticate') ?? '';
    expect(www).toContain('resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource/mcp"');
    expect(www).toContain('scope="read"');
    expect(r.headers.get('mcp-session-id')).toBeNull();
    expect(await r.json()).toMatchObject({ error: 'invalid_token' });
    // GET /mcp и DELETE /mcp тоже требуют токен
    expect((await fetch(`${base}/mcp`, { headers: { accept: 'text/event-stream' } })).status).toBe(401);
    expect((await fetch(`${base}/mcp`, { method: 'DELETE' })).status).toBe(401);
  });

  it('RFC 9728: документ метаданных публичен на обоих путях, без секретов', async () => {
    for (const p of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const r = await fetch(`${base}${p}`);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({
        resource: 'http://127.0.0.1/mcp',
        authorization_servers: [ISSUER],
        scopes_supported: ['read', 'write', 'admin'],
        bearer_methods_supported: ['header'],
        resource_name: 'bitrix24-mcp-server',
      });
    }
  });

  it('T39: просроченный, чужая aud, чужой iss, чужой ключ — 401 invalid_token; токен в query — 400', async () => {
    const cases: [string, Promise<string>][] = [
      ['expired', mint({ sub: 'alice', scope: 'read', expiresIn: '-1m' })],
      ['aud', mint({ sub: 'alice', scope: 'read', aud: 'https://other.example/mcp' })],
      ['iss', mint({ sub: 'alice', scope: 'read', iss: 'https://evil.test' })],
      ['key', mint({ sub: 'alice', scope: 'read', issuer: other, kid: 'main' })],
    ];
    for (const [label, tokenP] of cases) {
      const r = await post({ authorization: `Bearer ${await tokenP}` });
      expect(r.status, label).toBe(401);
      expect(r.headers.get('www-authenticate') ?? '', label).toContain('error="invalid_token"');
      expect(r.headers.get('mcp-session-id'), label).toBeNull();
    }
    const garbage = await post({ authorization: 'Bearer not.a.jwt' });
    expect(garbage.status).toBe(401);
    const basic = await post({ authorization: 'Basic abc' });
    expect(basic.status).toBe(400);
    const q = await post(
      {},
      INIT_BODY,
      `${base}/mcp?access_token=${await mint({ sub: 'alice', scope: 'read' })}`,
    );
    expect(q.status).toBe(400);
    expect(t.app.audit.status().available).toBe(true);
  });

  it('allowlist и scope: чужой субъект — 403 access_denied; без scope — 403 insufficient_scope', async () => {
    const stranger = await post({
      authorization: `Bearer ${await mint({ sub: 'mallory', scope: 'read write admin' })}`,
    });
    expect(stranger.status).toBe(403);
    expect(await stranger.json()).toMatchObject({ error: 'access_denied' });
    const noScope = await post({ authorization: `Bearer ${await mint({ sub: 'alice' })}` });
    expect(noScope.status).toBe(403);
    expect(noScope.headers.get('www-authenticate') ?? '').toContain('error="insufficient_scope"');
    expect(noScope.headers.get('www-authenticate') ?? '').toContain('scope="read"');
  });

  it('роль = min(access policy, scope): alice/read → reader без инструментов записи; alice/write → operator; bob не в policy → reader', async () => {
    const aliceRead = await connect(await mint({ sub: 'alice', scope: 'read' }));
    try {
      const names = (await aliceRead.client.listTools()).tools.map((x) => x.name);
      expect(names).toContain('crm_list_records');
      expect(names).not.toContain('crm_create_record');
    } finally {
      await aliceRead.client.close();
    }
    const aliceWrite = await connect(await mint({ sub: 'alice', scope: 'read write' }));
    try {
      const names = (await aliceWrite.client.listTools()).tools.map((x) => x.name);
      expect(names).toContain('crm_create_record');
      const info = await aliceWrite.client.callTool({ name: 'bitrix_server_version', arguments: {} });
      expect(info.isError).toBeFalsy();
    } finally {
      await aliceWrite.client.close();
    }
    const bob = await connect(await mint({ sub: 'bob', scope: 'read write admin' }));
    try {
      const names = (await bob.client.listTools()).tools.map((x) => x.name);
      expect(names).not.toContain('crm_create_record');
    } finally {
      await bob.client.close();
    }
  });

  it('T40: сессия привязана к субъекту — токен bob к сессии alice → 403; чужой Origin → 403; разрешённый Origin → проходит', async () => {
    const alice = await connect(await mint({ sub: 'alice', scope: 'read' }));
    try {
      const sid = alice.transport.sessionId;
      expect(sid).toBeTruthy();
      const hijack = await post(
        { authorization: `Bearer ${await mint({ sub: 'bob', scope: 'read' })}`, 'mcp-session-id': sid ?? '' },
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      );
      expect(hijack.status).toBe(403);
      expect(await hijack.json()).toMatchObject({ error: 'access_denied' });
    } finally {
      await alice.client.close();
    }
    const token = await mint({ sub: 'alice', scope: 'read' });
    const evil = await post({ authorization: `Bearer ${token}`, origin: 'https://evil.example' });
    expect(evil.status).toBe(403);
    const nullOrigin = await post({ authorization: `Bearer ${token}`, origin: 'null' });
    expect(nullOrigin.status).toBe(403);
    const ok = await post({ authorization: `Bearer ${token}`, origin: 'https://app.allowed.test' });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('mcp-session-id')).toBeTruthy();
    await fetch(`${base}/mcp`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}`, 'mcp-session-id': ok.headers.get('mcp-session-id') ?? '' },
    });
  });

  it('readyz под авторизацией, healthz открыт; аудит различает субъектов по псевдониму', async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/readyz`)).status).toBe(401);
    const r = await fetch(`${base}/readyz`, {
      headers: { authorization: `Bearer ${await mint({ sub: 'alice', scope: 'read' })}` },
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: 'ready', authMode: 'oauth' });
    const bob = await connect(await mint({ sub: 'bob', scope: 'read' }));
    try {
      await bob.client.callTool({ name: 'bitrix_server_version', arguments: {} });
    } finally {
      await bob.client.close();
    }
    // ТЗ §8.1: в журнале — HMAC-псевдоним субъекта, не сырой идентификатор; alice и bob различимы
    const rows = await t.app.db.all<{ principal_hash: string }>(
      "SELECT DISTINCT principal_hash FROM audit WHERE tool = 'bitrix_server_version'",
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.map((x) => x.principal_hash)).not.toContain('alice');
  });
});

describe('OAuth-защита MCP: JWKS по сети', () => {
  let issuer: Issuer;
  let jwksServer: Server;
  let jwksPort: number;

  beforeAll(async () => {
    issuer = await makeIssuer('net');
    jwksServer = createServer((req, res) => {
      if (req.url === '/jwks') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(issuer.jwks));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
    const addr = jwksServer.address();
    jwksPort = typeof addr === 'object' && addr ? addr.port : 0;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
  });

  const mint = (o: { sub: string; scope: string }, iss: Issuer) =>
    new SignJWT({ scope: o.scope })
      .setProtectedHeader({ alg: 'RS256', kid: iss.jwk.kid ?? 'k' })
      .setSubject(o.sub)
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('5m')
      .sign(iss.privateKey);

  const startWith = async (jwksUri: string) => {
    const t = createTestApp({
      MCP_TRANSPORT: 'http',
      MCP_HOST: '127.0.0.1',
      MCP_AUTH_MODE: 'oauth',
      MCP_PUBLIC_URL: PUBLIC_URL,
      MCP_AUTH_ISSUER: ISSUER,
      MCP_AUTH_JWKS_URI: jwksUri,
      MCP_AUTH_ALLOWED_SUBJECTS: 'alice',
    });
    const handle = await startHttp(t.app, { host: '127.0.0.1', port: 0 });
    return { t, handle, base: `http://127.0.0.1:${String(handle.port)}` };
  };

  it('ключи издателя забираются с настроенного JWKS URI; валидный токен открывает сессию', async () => {
    const s = await startWith(`http://127.0.0.1:${String(jwksPort)}/jwks`);
    try {
      const client = new Client({ name: 'net', version: '0.0.0' });
      const token = await mint({ sub: 'alice', scope: 'read' }, issuer);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${s.base}/mcp`), {
          authProvider: { token: () => Promise.resolve(token) },
        }),
      );
      try {
        expect((await client.listTools()).tools.length).toBeGreaterThan(0);
      } finally {
        await client.close();
      }
    } finally {
      await s.handle.close();
      s.t.app.close();
    }
  });

  it('JWKS недоступен — 503 server_error без WWW-Authenticate, сессия не создаётся', async () => {
    const s = await startWith('http://127.0.0.1:1/jwks');
    try {
      const r = await fetch(`${s.base}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${await mint({ sub: 'alice', scope: 'read' }, issuer)}`,
        },
        body: INIT_BODY,
      });
      expect(r.status).toBe(503);
      expect(r.headers.get('www-authenticate')).toBeNull();
      expect(await r.json()).toMatchObject({ error: 'server_error' });
    } finally {
      await s.handle.close();
      s.t.app.close();
    }
  });
});

/**
 * S4, модульные проверки без БД: правила redirect_uri, метаданные клиента (RFC 7591 / CIMD), защита загрузки
 * документа CIMD от SSRF, запечатанное состояние, настройки, ключи подписи EdDSA, WWW-Authenticate.
 */
import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { McpAuthError } from '../../src/auth/mcp-auth.js';
import {
  cimdClientIdUrl,
  validateClientMetadata,
  ClientMetadataError,
} from '../../src/saas/oauth/clients.js';
import { fetchClientMetadataDocument, isPublicAddress } from '../../src/saas/oauth/cimd-fetch.js';
import { pkceMatches, pkceS256, StateSealer } from '../../src/saas/oauth/crypto.js';
import { redirectUriMatches, redirectUriProblem } from '../../src/saas/oauth/redirect-uri.js';
import { resolveOAuthSettings, saasWwwAuthenticate, SigningKeyStore } from '../../src/saas/oauth/index.js';

describe('S4: redirect_uri', () => {
  it('регистрация: https или http на loopback; опасные схемы и fragment — отказ', () => {
    expect(redirectUriProblem('https://claude.ai/api/mcp/auth_callback')).toBeUndefined();
    expect(redirectUriProblem('http://localhost:3000/cb')).toBeUndefined();
    expect(redirectUriProblem('http://127.0.0.1/cb')).toBeUndefined();
    expect(redirectUriProblem('http://[::1]:5000/cb')).toBeUndefined();
    for (const bad of [
      'http://example.com/cb',
      'javascript:alert(1)',
      'data:text/html,x',
      'com.example.app:/cb',
      'https://a.example/cb#frag',
      'https://user:pw@a.example/cb',
      'relative/path',
    ])
      expect(redirectUriProblem(bad)).toBeDefined();
  });

  it('сверка: точное совпадение; порт свободен только для loopback IP', () => {
    const reg = ['https://a.example/cb', 'http://127.0.0.1:3000/cb?x=1', 'http://localhost:4000/cb'];
    expect(redirectUriMatches('https://a.example/cb', reg)).toBe(true);
    expect(redirectUriMatches('https://a.example/cb/', reg)).toBe(false);
    expect(redirectUriMatches('https://A.example/cb', reg)).toBe(false);
    expect(redirectUriMatches('http://127.0.0.1:9999/cb?x=1', reg)).toBe(true);
    expect(redirectUriMatches('http://127.0.0.1:9999/cb', reg)).toBe(false);
    expect(redirectUriMatches('http://127.0.0.1:9999/cb?x=1#f', reg)).toBe(false);
    expect(redirectUriMatches('http://localhost:4001/cb', reg)).toBe(false);
  });
});

describe('S4: метаданные клиента', () => {
  it('DCR: значения по умолчанию RFC 7591 и ограничения', () => {
    const v = validateClientMetadata({ redirect_uris: ['https://a.example/cb'] }, 'dcr');
    expect(v.metadata.token_endpoint_auth_method).toBe('client_secret_basic');
    expect(v.metadata.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(v.clientName).toBe('Клиент без названия');
    const named = validateClientMetadata(
      {
        redirect_uris: ['https://a.example/cb'],
        client_name: 'Имя\u0000‮ клиента',
        token_endpoint_auth_method: 'none',
      },
      'dcr',
    );
    expect(named.clientName).toBe('Имя клиента');
    for (const bad of [
      null,
      [],
      { redirect_uris: [] },
      { redirect_uris: ['https://a.example/cb'], response_types: ['token'] },
      { redirect_uris: ['https://a.example/cb'], grant_types: ['refresh_token'] },
      { redirect_uris: ['https://a.example/cb'], token_endpoint_auth_method: 'private_key_jwt' },
      { redirect_uris: Array.from({ length: 11 }, (_, i) => `https://a.example/${String(i)}`) },
    ])
      expect(() => validateClientMetadata(bad, 'dcr')).toThrow(ClientMetadataError);
  });

  it('CIMD: client_name обязателен, секреты запрещены, публичный клиент по умолчанию', () => {
    const ok = validateClientMetadata(
      {
        client_id: 'https://c.example/m.json',
        client_name: 'C',
        redirect_uris: ['http://localhost:3000/cb'],
      },
      'cimd',
    );
    expect(ok.metadata.token_endpoint_auth_method).toBe('none');
    expect(() => validateClientMetadata({ redirect_uris: ['https://a.example/cb'] }, 'cimd')).toThrow();
    expect(() =>
      validateClientMetadata(
        {
          client_name: 'C',
          redirect_uris: ['https://a.example/cb'],
          token_endpoint_auth_method: 'client_secret_post',
        },
        'cimd',
      ),
    ).toThrow();
    expect(() =>
      validateClientMetadata(
        { client_name: 'C', redirect_uris: ['https://a.example/cb'], client_secret: 'x' },
        'cimd',
      ),
    ).toThrow();
  });

  it('CIMD: форма client_id — https с путём, без query/fragment/точечных сегментов, в нормальной форме', () => {
    expect(cimdClientIdUrl('https://app.example.com/oauth/client-metadata.json')).toBeDefined();
    for (const bad of [
      'mcp_abc',
      'http://app.example.com/m.json',
      'https://app.example.com/',
      'https://app.example.com',
      'https://app.example.com/m.json?x=1',
      'https://app.example.com/m.json#f',
      'https://app.example.com/a/../m.json',
      'https://APP.example.com/m.json',
      'https://u:p@app.example.com/m.json',
    ])
      expect(cimdClientIdUrl(bad)).toBeUndefined();
  });
});

describe('S4: загрузка документа CIMD (SSRF)', () => {
  const opts = (fetch: (u: string, i: RequestInit) => Promise<Response>, ips = ['93.184.216.34']) => ({
    fetch,
    resolve: () => Promise.resolve(ips),
    timeoutMs: 1000,
    maxBytes: 100,
  });
  const ok = () => Promise.resolve(new Response('{"a":1}', { status: 200 }));

  it('частные, loopback, link-local, CGNAT и IPv4-mapped адреса считаются непубличными', () => {
    for (const ip of [
      '10.1.2.3',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '192.168.1.1',
      '100.64.0.1',
      '::1',
      'fe80::1',
      'fd00::1',
      '::ffff:10.0.0.1',
      '0.0.0.0',
    ])
      expect(isPublicAddress(ip)).toBe(false);
    expect(isPublicAddress('93.184.216.34')).toBe(true);
    expect(isPublicAddress('2606:2800:220:1::1')).toBe(true);
  });

  it('отказ: IP-литерал, частный адрес имени, редирект, превышение размера, нестандартный порт', async () => {
    const url = new URL('https://client.example.com/m.json');
    await expect(fetchClientMetadataDocument(url, opts(ok))).resolves.toMatchObject({ body: '{"a":1}' });
    await expect(fetchClientMetadataDocument(new URL('https://10.0.0.1/m.json'), opts(ok))).rejects.toThrow();
    await expect(fetchClientMetadataDocument(url, opts(ok, ['93.184.216.34', '10.0.0.1']))).rejects.toThrow(
      'непубличный',
    );
    await expect(
      fetchClientMetadataDocument(
        url,
        opts(() =>
          Promise.resolve(
            new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }),
          ),
        ),
      ),
    ).rejects.toThrow('HTTP 302');
    await expect(
      fetchClientMetadataDocument(
        url,
        opts(() => Promise.resolve(new Response('x'.repeat(500), { status: 200 }))),
      ),
    ).rejects.toThrow('размер');
    await expect(
      fetchClientMetadataDocument(new URL('https://client.example.com:8443/m.json'), opts(ok)),
    ).rejects.toThrow();
  });
});

describe('S4: PKCE, состояние, настройки, ключи', () => {
  it('PKCE S256 (RFC 7636 приложение B)', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(pkceS256(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    expect(pkceMatches(verifier, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBe(true);
    expect(pkceMatches('short', pkceS256('short'))).toBe(false);
  });

  it('запечатанное состояние: назначение, срок, подделка', () => {
    const s = new StateSealer(Buffer.alloc(32, 1));
    const sealed = s.seal('login', { a: 1 }, 2000);
    expect(s.open<{ a: number }>('login', sealed, 1000)?.a).toBe(1);
    expect(s.open('consent', sealed, 1000)).toBeUndefined();
    expect(s.open('login', sealed, 2000)).toBeUndefined();
    // Портим символ в середине: последние символы base64url могут нести только незначащие биты,
    // и замена «хвоста» изредка не меняла данные (тест падал случайно).
    const mid = Math.floor(sealed.length / 2);
    const tampered = sealed.slice(0, mid) + (sealed[mid] === 'A' ? 'B' : 'A') + sealed.slice(mid + 1);
    expect(s.open('login', tampered, 1000)).toBeUndefined();
    expect(new StateSealer(Buffer.alloc(32, 2)).open('login', sealed, 1000)).toBeUndefined();
    expect(s.csrf('b1', sealed)).not.toBe(s.csrf('b2', sealed));
  });

  it('настройки: TTL кода ≤ 60 с, https-адрес, origin без пути', () => {
    const base = { publicBaseUrl: 'https://mcp.example.ru', signingKeysDir: '/tmp/x' };
    expect(resolveOAuthSettings(base)).toMatchObject({ accessTokenTtlSec: 600, authCodeTtlSec: 60 });
    expect(() => resolveOAuthSettings({ ...base, authCodeTtlSec: 61 })).toThrow();
    expect(() => resolveOAuthSettings({ ...base, publicBaseUrl: 'http://mcp.example.ru' })).toThrow();
    expect(() => resolveOAuthSettings({ ...base, publicBaseUrl: 'https://mcp.example.ru/sub' })).toThrow();
    expect(resolveOAuthSettings({ ...base, publicBaseUrl: 'http://localhost:8080' }).publicBaseUrl).toBe(
      'http://localhost:8080',
    );
  });

  it('ключи EdDSA: файлы 0600, JWKS с OKP/Ed25519, ключ состояния сохраняется между открытиями', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 's4-ed-'));
    const settings = resolveOAuthSettings({
      publicBaseUrl: 'https://mcp.example.ru',
      signingKeysDir: dir,
      signingAlg: 'EdDSA',
    });
    const a = await SigningKeyStore.open(settings);
    const jwks = a.jwks();
    expect(jwks.keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA' });
    expect(jwks.keys[0]).not.toHaveProperty('d');
    const b = await SigningKeyStore.open(settings);
    expect(b.activeKid()).toBe(a.activeKid());
    expect(b.stateSecret().equals(a.stateSecret())).toBe(true);
    if (process.platform !== 'win32')
      for (const f of readdirSync(dir)) expect(statSync(path.join(dir, f)).mode & 0o077).toBe(0);
  });

  it('WWW-Authenticate: resource_metadata всегда, scope при первом вызове и insufficient_scope', () => {
    const settings = resolveOAuthSettings({
      publicBaseUrl: 'https://mcp.example.ru',
      signingKeysDir: '/tmp/x',
    });
    const meta = 'resource_metadata="https://mcp.example.ru/.well-known/oauth-protected-resource/mcp"';
    expect(saasWwwAuthenticate(settings)).toBe(`Bearer scope="mcp:read mcp:write", ${meta}`);
    expect(
      saasWwwAuthenticate(settings, new McpAuthError(401, 'invalid_token', 'x', undefined, 'token expired')),
    ).toBe(`Bearer error="invalid_token", error_description="token expired", ${meta}`);
    expect(
      saasWwwAuthenticate(settings, new McpAuthError(403, 'insufficient_scope', 'x'), ['mcp:write']),
    ).toBe(`Bearer error="insufficient_scope", scope="mcp:write", ${meta}`);
  });
});

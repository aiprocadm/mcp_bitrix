/**
 * SaaS-ТЗ S3: клиент сервера авторизации Bitrix24 (settings/oauth/*), разбор запросов обработчиков событий,
 * проверка application_token, настройки приложения. Без сети и без БД.
 */
import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../../src/bitrix/client.js';
import { AppError } from '../../src/errors/app-error.js';
import { createSilentLogger } from '../../src/logging/logger.js';
import { redactString } from '../../src/security/redaction.js';
import {
  appTokenHash,
  appTokenMatches,
  BitrixOAuthClient,
  handlerHttpStatus,
  normalizeClientEndpoint,
  parseBracketForm,
  parseEventPayload,
  parseLaunchParams,
  validateBitrixAppSettings,
} from '../../src/saas/bitrix/index.js';

const SECRET = 'UnitTestClientSecret-0123456789';
const settings = {
  clientId: 'app.573ad8a0346747.09223434',
  clientSecret: SECRET,
  oauthServerUrl: 'https://oauth.bitrix.info',
  publicBaseUrl: 'https://mcp.example.test',
};

function oauthWith(respond: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const seen: string[] = [];
  const fetch: FetchLike = async (u, init) => {
    seen.push(u);
    return respond(new URL(u), init);
  };
  return { client: new BitrixOAuthClient({ settings, fetch, logger: createSilentLogger() }), seen };
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

const TOKENS = {
  access_token: 's1morf609228iwyjjpvfv6wsvuja4p8u',
  client_endpoint: 'https://portal.bitrix24.com/rest/',
  domain: 'oauth.bitrix.info',
  expires_in: 3600,
  member_id: 'a223c6b3710f85df22e9377d6c4f7553',
  refresh_token: '4f9k4jpmg13usmybzuqknt2v9fh0q6rl',
  scope: 'crm,entity,im,task',
  server_endpoint: 'https://oauth.bitrix.info/rest/',
  status: 'F',
};

describe('BitrixOAuthClient (settings/oauth/index.md, auto-renewal.md, error-codes.md)', () => {
  it('обмен кода: GET /oauth/token/ с grant_type, client_id, client_secret, code; разбор ответа документации', async () => {
    const { client, seen } = oauthWith(() => Response.json(TOKENS));
    const t = await client.exchangeCode('avmocpghblyi01m3h42bljvqtyd19sw1');
    const u = new URL(seen[0] ?? '');
    expect(u.origin + u.pathname).toBe('https://oauth.bitrix.info/oauth/token/');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      grant_type: 'authorization_code',
      client_id: settings.clientId,
      client_secret: SECRET,
      code: 'avmocpghblyi01m3h42bljvqtyd19sw1',
    });
    expect(t).toMatchObject({
      accessToken: TOKENS.access_token,
      refreshToken: TOKENS.refresh_token,
      expiresIn: 3600,
      clientEndpoint: 'https://portal.bitrix24.com/rest/',
      memberId: TOKENS.member_id,
      scope: 'crm,entity,im,task',
      userId: undefined,
      status: 'F',
    });
  });

  it('обновление: grant_type=refresh_token; user_id из ответа', async () => {
    const { client, seen } = oauthWith(() => Response.json({ ...TOKENS, expires: 1780319382, user_id: 67 }));
    const t = await client.refresh('3s6lr4kr3cv2od4v853gvrchb875bwxb');
    expect(new URL(seen[0] ?? '').searchParams.get('grant_type')).toBe('refresh_token');
    expect(new URL(seen[0] ?? '').searchParams.get('refresh_token')).toBe('3s6lr4kr3cv2od4v853gvrchb875bwxb');
    expect(t.userId).toBe(67);
  });

  it('ошибка сервера авторизации: код в details, без error_description и без секрета', async () => {
    const { client } = oauthWith(() =>
      Response.json(
        { error: 'PAYMENT_REQUIRED', error_description: `Payment required ${SECRET}` },
        { status: 400 },
      ),
    );
    const e = await catchApp(client.refresh('4f9k4jpmg13usmybzuqknt2v9fh0q6rl'));
    expect(e).toMatchObject({
      code: 'BITRIX_AUTH_FAILED',
      details: { upstreamCode: 'PAYMENT_REQUIRED', reason: 'OAUTH_PAYMENT_REQUIRED' },
    });
    expect(JSON.stringify(e.toJSON())).not.toContain(SECRET);
  });

  it('перенаправление, сбой сети, неполный ответ, небезопасный client_endpoint — ошибки без секрета', async () => {
    const redirect = oauthWith(
      () => new Response(null, { status: 302, headers: { location: 'https://evil/' } }),
    );
    expect(await catchApp(redirect.client.refresh('4f9k4jpmg13usmybzuqknt2v9fh0q6rl'))).toMatchObject({
      code: 'BITRIX_UPSTREAM_ERROR',
    });
    const net = oauthWith(() => {
      throw new TypeError(`fetch failed for ${SECRET}`);
    });
    const ne = await catchApp(net.client.refresh('4f9k4jpmg13usmybzuqknt2v9fh0q6rl'));
    expect(ne).toMatchObject({ code: 'BITRIX_UPSTREAM_ERROR', details: { retryable: true } });
    expect(JSON.stringify(ne.toJSON())).not.toContain(SECRET);
    const partial = oauthWith(() => Response.json({ access_token: 'x' }));
    expect(await catchApp(partial.client.refresh('4f9k4jpmg13usmybzuqknt2v9fh0q6rl'))).toMatchObject({
      details: { reason: 'OAUTH_BAD_RESPONSE' },
    });
    const http = oauthWith(() =>
      Response.json({ ...TOKENS, client_endpoint: 'http://portal.bitrix24.com/rest/' }),
    );
    expect(await catchApp(http.client.refresh('4f9k4jpmg13usmybzuqknt2v9fh0q6rl'))).toMatchObject({
      details: { reason: 'OAUTH_BAD_RESPONSE' },
    });
    expect(normalizeClientEndpoint('https://portal.bitrix24.com/rest')).toBe(
      'https://portal.bitrix24.com/rest/',
    );
    expect(normalizeClientEndpoint('https://u:p@portal.bitrix24.com/rest/')).toBeUndefined();
    expect(normalizeClientEndpoint('https://portal.bitrix24.com/other/')).toBeUndefined();
  });

  it('некорректный код не отправляется; настройки: только https-origin, секрет регистрируется в редакторе логов', async () => {
    const { client, seen } = oauthWith(() => Response.json(TOKENS));
    expect(await catchApp(client.exchangeCode('bad code/../'))).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(seen).toEqual([]);
    expect(redactString(`url ${SECRET}`)).not.toContain(SECRET);
    expect(() =>
      validateBitrixAppSettings({ ...settings, oauthServerUrl: 'http://oauth.bitrix.info' }),
    ).toThrow(AppError);
    expect(() =>
      validateBitrixAppSettings({ ...settings, oauthServerUrl: 'https://oauth.bitrix.info/x' }),
    ).toThrow(AppError);
    expect(() => validateBitrixAppSettings({ ...settings, clientSecret: 'short' })).toThrow(AppError);
    expect(
      validateBitrixAppSettings({ ...settings, publicBaseUrl: 'http://localhost:3000' }).publicBaseUrl,
    ).toBe('http://localhost:3000');
  });
});

describe('разбор запросов Bitrix24 к обработчикам', () => {
  it('поля формы PHP → вложенный объект; __proto__ и лишняя глубина игнорируются', () => {
    const f = parseBracketForm(
      new URLSearchParams(
        'event=ONAPPINSTALL&auth[member_id]=m1&data[VERSION]=1&__proto__[x]=1&a[b][c][d][e]=1',
      ),
    );
    expect(f['event']).toBe('ONAPPINSTALL');
    expect(f['auth']).toEqual({ member_id: 'm1' });
    expect(f['data']).toEqual({ VERSION: '1' });
    expect(({} as Record<string, unknown>)['x']).toBeUndefined();
    expect(f['a']).toBeUndefined();
  });

  it('событие: код в верхнем регистре, форма и JSON; без application_token/member_id — отказ 403', () => {
    const p = parseEventPayload(
      'event=onappuninstall&data[CLEAN]=1&auth[member_id]=a223c6b3710f85df22e9377d6c4f7553&auth[application_token]=51856fefc120afa4b628cc82d3935cce',
    );
    expect(p).toMatchObject({ event: 'ONAPPUNINSTALL', data: { CLEAN: '1' } });
    expect(p.auth.accessToken).toBeUndefined();
    const j = parseEventPayload(
      JSON.stringify({
        event: 'ONAPPUNINSTALL',
        data: { CLEAN: 0 },
        auth: { member_id: 'm1', application_token: '51856fefc120afa4b628cc82d3935cce' },
      }),
    );
    expect(j.auth.memberId).toBe('m1');
    let err: unknown;
    try {
      parseEventPayload('event=ONAPPUNINSTALL&auth[member_id]=m1');
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: 'ACCESS_DENIED' });
    expect(handlerHttpStatus(err as AppError)).toBe(403);
    expect(() => parseLaunchParams('DOMAIN=x.bitrix24.ru&member_id=m1')).toThrow(AppError);
  });

  it('application_token: сравнение хеша в постоянное время; пустой/битый хеш — не совпадение', () => {
    const t = '51856fefc120afa4b628cc82d3935cce';
    expect(appTokenHash(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(appTokenMatches(appTokenHash(t), t)).toBe(true);
    expect(appTokenMatches(appTokenHash(t), `${t}x`)).toBe(false);
    expect(appTokenMatches(null, t)).toBe(false);
    expect(appTokenMatches('', t)).toBe(false);
    expect(appTokenMatches('zz', t)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { WebhookAuthProvider } from '../../src/auth/webhook-provider.js';
import { mapUpstreamError } from '../../src/bitrix/errors.js';
import { buildLegacyRequest, parseLegacyResponse } from '../../src/bitrix/legacy-adapter.js';
import {
  findMethod,
  isValidMethodName,
  listMethods,
  requireMethod,
} from '../../src/bitrix/method-registry.js';
import { buildV3Request, parseV3Response } from '../../src/bitrix/v3-adapter.js';
import { AppError } from '../../src/errors/app-error.js';

const creds = {
  kind: 'webhook' as const,
  baseUrl: 'https://mock.bitrix24.invalid/rest/7/mocksecret0123456789/',
  userId: 7,
  secret: 'mocksecret0123456789',
};

describe('адаптеры legacy / v3 (T03, ТЗ §14.1)', () => {
  const auth = new WebhookAuthProvider(creds);

  it('одноимённые методы legacy и v3 дают разные URL и не смешиваются', () => {
    const legacy = requireMethod('legacy', 'scope');
    const v3 = requireMethod('v3', 'rest.scope.list');
    const r1 = buildLegacyRequest(auth.getAuth('legacy').baseUrl, legacy, {}, {});
    const r2 = buildV3Request(auth.getAuth('v3').baseUrl, v3, {}, {});
    expect(r1.url).toBe('https://mock.bitrix24.invalid/rest/7/mocksecret0123456789/scope.json');
    expect(r2.url).toBe('https://mock.bitrix24.invalid/rest/api/7/mocksecret0123456789/rest.scope.list');
    expect(r1.method).toBe('POST');
    expect(r2.method).toBe('POST');
  });

  it('portalKey не содержит секрета, origin без пути', () => {
    expect(auth.portalOrigin).toBe('https://mock.bitrix24.invalid');
    expect(auth.portalKey).not.toContain('mocksecret');
    expect(auth.portalKey).toHaveLength(16);
  });

  it('параметры управления авторизацией/транспортом запрещены', () => {
    const d = requireMethod('legacy', 'profile');
    for (const key of ['auth', 'AUTH', 'access_token', 'client_endpoint', 'domain']) {
      expect(() => buildLegacyRequest(auth.getAuth('legacy').baseUrl, d, { [key]: 'x' }, {})).toThrow(
        AppError,
      );
    }
  });

  it('Idempotency-Key передаётся только методам с подтверждённой поддержкой', () => {
    const d = requireMethod('v3', 'rest.scope.list');
    expect(() =>
      buildV3Request('https://x.invalid/rest/api/1/s/', d, {}, {}, '11111111-1111-4111-8111-111111111111'),
    ).toThrow(AppError);
  });

  it('T04: HTTP 200 с error в теле — ошибка, а не успех; описание не утекает', () => {
    const d = requireMethod('legacy', 'crm.deal.get');
    let err: AppError | undefined;
    try {
      parseLegacyResponse(
        200,
        JSON.stringify({
          error: 'ACCESS_DENIED',
          error_description: 'secret https://p.invalid/rest/1/abcdefghijk/',
        }),
        undefined,
        d,
      );
    } catch (e) {
      err = e as AppError;
    }
    expect(err?.code).toBe('BITRIX_ACCESS_DENIED');
    expect(err?.details.upstreamCode).toBe('ACCESS_DENIED');
    expect(JSON.stringify(err)).not.toContain('abcdefghijk');
    expect(JSON.stringify(err)).not.toContain('error_description');
  });

  it('legacy: числовой код ошибки каталога → BITRIX_ACCESS_DENIED, описание не утекает', () => {
    const d = requireMethod('legacy', 'catalog.catalog.list');
    let caught: unknown;
    try {
      parseLegacyResponse(
        400,
        JSON.stringify({ error: 200040300010, error_description: 'Access Denied' }),
        undefined,
        d,
      );
    } catch (e) {
      caught = e;
    }
    expect((caught as AppError).code).toBe('BITRIX_ACCESS_DENIED');
    expect((caught as AppError).details.upstreamCode).toBe('200040300010');
    expect(JSON.stringify(caught)).not.toContain('Access Denied');
  });

  it('legacy: next/total/time разбираются, отсутствие result — ошибка', () => {
    const d = requireMethod('legacy', 'crm.deal.list');
    const r = parseLegacyResponse(
      200,
      JSON.stringify({ result: [1, 2], next: 50, total: 120, time: { duration: 0.25 } }),
      undefined,
      d,
    );
    expect(r.next).toBe(50);
    expect(r.total).toBe(120);
    expect(r.timeMs).toBe(250);
    expect(() => parseLegacyResponse(200, JSON.stringify({ foo: 1 }), undefined, d)).toThrow(AppError);
    expect(() => parseLegacyResponse(200, 'not json', undefined, d)).toThrow(AppError);
  });

  it('v3: разбирает {error:{code}} и {errors:[...]} и nextCursor', () => {
    const d = requireMethod('v3', 'rest.scope.list');
    expect(() =>
      parseV3Response(200, JSON.stringify({ error: { code: 'ACCESS_DENIED', message: 'x' } }), undefined, d),
    ).toThrow(AppError);
    expect(() =>
      parseV3Response(400, JSON.stringify({ errors: [{ code: 'INVALID_ARG_VALUE' }] }), undefined, d),
    ).toThrow(AppError);
    const r = parseV3Response(
      200,
      JSON.stringify({ result: { items: [] }, nextCursor: 'abc' }),
      undefined,
      d,
    );
    expect(r.nextCursor).toBe('abc');
  });
});

describe('реестр методов', () => {
  it('точный поиск без нормализации регистра и без path-символов', () => {
    expect(findMethod('legacy', 'profile')).toBeDefined();
    expect(findMethod('legacy', 'Profile')).toBeUndefined();
    expect(findMethod('legacy', 'profile.json')).toBeUndefined();
    expect(findMethod('legacy', '../profile')).toBeUndefined();
    expect(findMethod('v3', 'profile')).toBeUndefined();
    expect(isValidMethodName('crm.deal.list')).toBe(true);
    for (const bad of ['crm/deal', 'a?b', 'a#b', 'a%20b', 'a..b', '.a', 'A.B'])
      expect(isValidMethodName(bad)).toBe(false);
  });

  it('каждая запись имеет источник в apidocs и непротиворечивые флаги', () => {
    for (const d of listMethods()) {
      expect(d.source.startsWith('https://apidocs.bitrix24.ru/')).toBe(true);
      if (d.rawCallable) expect(['read', 'admin/diagnostic']).toContain(d.operation);
      if (
        d.operation === 'create' ||
        d.operation === 'update' ||
        d.operation === 'delete' ||
        d.operation === 'upload'
      )
        expect(d.rawCallable).toBe(false);
    }
  });
});

describe('нормализация ошибок (ТЗ §14.5)', () => {
  const cases: [string, number, string][] = [
    ['expired_token', 401, 'BITRIX_AUTH_FAILED'],
    ['insufficient_scope', 403, 'BITRIX_SCOPE_MISSING'],
    ['ACCESS_DENIED', 200, 'BITRIX_ACCESS_DENIED'],
    ['WRONG_AUTH_TYPE', 200, 'BITRIX_APP_CONTEXT_REQUIRED'],
    ['ERROR_METHOD_NOT_FOUND', 404, 'FEATURE_UNAVAILABLE'],
    ['QUERY_LIMIT_EXCEEDED', 503, 'BITRIX_RATE_LIMITED'],
    ['OPERATION_TIME_LIMIT', 200, 'BITRIX_RESOURCE_LIMITED'],
    ['ERROR_NOT_FOUND', 400, 'NOT_FOUND'],
    ['ERROR_ARGUMENT', 400, 'VALIDATION_ERROR'],
    ['SOMETHING_WEIRD', 500, 'BITRIX_UPSTREAM_ERROR'],
    ['BITRIX_REST_V3_EXCEPTION_ENTITYNOTFOUNDEXCEPTION', 400, 'NOT_FOUND'],
    ['200040300010', 400, 'BITRIX_ACCESS_DENIED'],
    ['200040300050', 400, 'BITRIX_ACCESS_DENIED'],
    ['200040300000', 400, 'NOT_FOUND'],
  ];
  it.each(cases)('%s / HTTP %d → %s', (code, status, expected) => {
    const err = mapUpstreamError(
      { httpStatus: status, upstreamCode: code, retryAfterMs: undefined },
      'crm.deal.get',
      'legacy',
      'crm',
    );
    expect(err.code).toBe(expected);
    expect(err.details.method).toBe('crm.deal.get');
    expect(err.details.nextAction).toBeTruthy();
  });

  it('без кода: 401/403/404/429/5xx по HTTP-статусу', () => {
    const m = (s: number) =>
      mapUpstreamError(
        { httpStatus: s, upstreamCode: undefined, retryAfterMs: undefined },
        'profile',
        'legacy',
      ).code;
    expect(m(401)).toBe('BITRIX_AUTH_FAILED');
    expect(m(403)).toBe('BITRIX_ACCESS_DENIED');
    expect(m(404)).toBe('FEATURE_UNAVAILABLE');
    expect(m(429)).toBe('BITRIX_RATE_LIMITED');
    expect(m(502)).toBe('BITRIX_UPSTREAM_ERROR');
  });
});

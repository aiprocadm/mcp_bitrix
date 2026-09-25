import { describe, expect, it } from 'vitest';
import { WebhookAuthProvider } from '../../src/auth/webhook-provider.js';
import { BitrixClient } from '../../src/bitrix/client.js';
import { RateLimiter } from '../../src/bitrix/rate-limiter.js';
import { AppError } from '../../src/errors/app-error.js';
import { createSilentLogger } from '../../src/logging/logger.js';
import { legacyError, legacyOk, MockBitrix, PROFILE_RESULT } from '../helpers/mock-bitrix.js';

const creds = {
  kind: 'webhook' as const,
  baseUrl: 'https://mock.bitrix24.invalid/rest/7/mocksecret0123456789/',
  userId: 7,
  secret: 'mocksecret0123456789',
};

function makeClient(
  mock: MockBitrix,
  opts: {
    allowedHosts?: string[];
    timeoutMs?: number;
    maxUpstreamResponseBytes?: number;
    tryRefresh?: () => Promise<boolean>;
  } = {},
) {
  const sleeps: number[] = [];
  const auth = new WebhookAuthProvider(creds);
  if (opts.tryRefresh) auth.tryRefresh = opts.tryRefresh;
  const client = new BitrixClient({
    auth,
    fetch: mock.fetch,
    limiter: new RateLimiter({ requestsPerSecond: 10, maxConcurrency: 2, maxQueueSize: 100 }),
    logger: createSilentLogger(),
    allowedHosts: opts.allowedHosts ?? ['mock.bitrix24.invalid'],
    timeoutMs: opts.timeoutMs ?? 5000,
    uploadTimeoutMs: 5000,
    maxUpstreamResponseBytes: opts.maxUpstreamResponseBytes ?? 1_000_000,
    maxReadRetries: 3,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  return { client, sleeps };
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

describe('BitrixClient (ТЗ §14)', () => {
  it('успешный profile: JSON POST, x-request-id, meta', async () => {
    const mock = new MockBitrix().on('profile', legacyOk(PROFILE_RESULT));
    const { client } = makeClient(mock);
    const r = await client.call('legacy', 'profile', {}, { requestId: 'req-1' });
    expect((r.result as { ID: string }).ID).toBe('7');
    expect(r.meta).toMatchObject({
      requestId: 'req-1',
      method: 'profile',
      apiVersion: 'legacy',
      attempts: 1,
      httpStatus: 200,
    });
    const call = mock.calls[0];
    expect(call?.method).toBe('POST');
    expect(call?.headers['x-request-id']).toBe('req-1');
    expect(call?.headers['content-type']).toBe('application/json');
  });

  it('метод вне реестра → METHOD_NOT_ALLOWED без обращения к сети', async () => {
    const mock = new MockBitrix();
    const { client } = makeClient(mock);
    const err = await catchApp(client.call('legacy', 'crm.deal.contact.items.delete', { id: 1 }));
    expect(err.code).toBe('METHOD_NOT_ALLOWED');
    expect(mock.calls).toHaveLength(0);
  });

  it('T04: HTTP 200 с error → нормализованная ошибка', async () => {
    const mock = new MockBitrix().on('crm.deal.get', legacyError('ACCESS_DENIED'));
    const { client } = makeClient(mock);
    const err = await catchApp(client.call('legacy', 'crm.deal.get', { id: 1 }));
    expect(err.code).toBe('BITRIX_ACCESS_DENIED');
    expect(mock.calls).toHaveLength(1);
  });

  it('T06: 429 → 503 → 200 на чтении: три попытки с задержками и Retry-After', async () => {
    const mock = new MockBitrix().onSequence('crm.deal.list', [
      { status: 429, body: {}, headers: { 'retry-after': '2' } },
      { status: 503, body: { error: 'QUERY_LIMIT_EXCEEDED', error_description: 'limit' } },
      legacyOk([]),
    ]);
    const { client, sleeps } = makeClient(mock);
    const r = await client.call('legacy', 'crm.deal.list', {});
    expect(r.meta.attempts).toBe(3);
    expect(mock.calls).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(2000);
  });

  it('после исчерпания повторов ошибка возвращается, всего 4 попытки', async () => {
    const mock = new MockBitrix().on('crm.deal.list', { status: 503, body: {} });
    const { client } = makeClient(mock);
    const err = await catchApp(client.call('legacy', 'crm.deal.list', {}));
    expect(err.code).toBe('BITRIX_RATE_LIMITED');
    expect(mock.calls).toHaveLength(4);
  });

  it('ошибки прав/валидации не повторяются', async () => {
    const mock = new MockBitrix().on('crm.deal.list', legacyError('ERROR_ARGUMENT', 400));
    const { client } = makeClient(mock);
    const err = await catchApp(client.call('legacy', 'crm.deal.list', {}));
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(mock.calls).toHaveLength(1);
  });

  it('T07: мутация, ответ потерян → OPERATION_OUTCOME_UNKNOWN, ровно одна отправка', async () => {
    const mock = new MockBitrix().on('crm.deal.add', { networkError: 'socket hang up' });
    const { client } = makeClient(mock);
    const err = await catchApp(client.call('legacy', 'crm.deal.add', { fields: { TITLE: 'x' } }));
    expect(err.code).toBe('OPERATION_OUTCOME_UNKNOWN');
    expect(err.details.retryable).toBe(false);
    expect(mock.calls).toHaveLength(1);
  });

  it('мутация при 503 не повторяется автоматически', async () => {
    const mock = new MockBitrix().on('crm.deal.add', { status: 503, body: {} });
    const { client } = makeClient(mock);
    const err = await catchApp(client.call('legacy', 'crm.deal.add', { fields: { TITLE: 'x' } }));
    expect(err.code).toBe('BITRIX_RATE_LIMITED');
    expect(mock.calls).toHaveLength(1);
  });

  it('таймаут чтения → BITRIX_TIMEOUT, затем повтор в бюджете', async () => {
    const mock = new MockBitrix().onSequence('profile', [
      { delayMs: 500, body: {} },
      legacyOk(PROFILE_RESULT),
    ]);
    const { client } = makeClient(mock, { timeoutMs: 50 });
    const r = await client.call('legacy', 'profile', {}, { budgetMs: 5000 });
    expect(r.meta.attempts).toBe(2);
  });

  it('host вне allowlist → CONFIG_INVALID до сети (SSRF-защита)', async () => {
    const mock = new MockBitrix();
    const { client } = makeClient(mock, { allowedHosts: ['other.invalid'] });
    const err = await catchApp(client.call('legacy', 'profile', {}));
    expect(err.code).toBe('CONFIG_INVALID');
    expect(mock.calls).toHaveLength(0);
  });

  it('перенаправления запрещены', async () => {
    const mock = new MockBitrix().on('profile', {
      status: 302,
      headers: { location: 'https://evil.invalid/' },
      body: {},
    });
    const { client } = makeClient(mock);
    const err = await catchApp(client.call('legacy', 'profile', {}));
    expect(err.code).toBe('BITRIX_UPSTREAM_ERROR');
    expect(err.details.httpStatus).toBe(302);
  });

  it('слишком большой ответ отвергается; для мутации — исход неизвестен', async () => {
    const big = 'x'.repeat(2000);
    const mock = new MockBitrix().on('profile', legacyOk({ big })).on('crm.deal.add', legacyOk({ big }));
    const { client } = makeClient(mock, { maxUpstreamResponseBytes: 500 });
    expect((await catchApp(client.call('legacy', 'profile', {}))).code).toBe('BITRIX_UPSTREAM_ERROR');
    expect((await catchApp(client.call('legacy', 'crm.deal.add', { fields: {} }))).code).toBe(
      'OPERATION_OUTCOME_UNKNOWN',
    );
  });

  it('T17-подготовка: при отказе авторизации один refresh и повтор', async () => {
    const mock = new MockBitrix().onSequence('profile', [
      legacyError('expired_token', 401),
      legacyOk(PROFILE_RESULT),
    ]);
    let refreshes = 0;
    const { client } = makeClient(mock, {
      tryRefresh: () => {
        refreshes += 1;
        return Promise.resolve(true);
      },
    });
    const r = await client.call('legacy', 'profile', {});
    expect(refreshes).toBe(1);
    expect(r.meta.attempts).toBe(2);
    // повторный отказ после refresh → ошибка, второго refresh нет
    const mock2 = new MockBitrix().on('profile', legacyError('expired_token', 401));
    let refreshes2 = 0;
    const { client: client2 } = makeClient(mock2, {
      tryRefresh: () => {
        refreshes2 += 1;
        return Promise.resolve(true);
      },
    });
    expect((await catchApp(client2.call('legacy', 'profile', {}))).code).toBe('BITRIX_AUTH_FAILED');
    expect(refreshes2).toBe(1);
    expect(mock2.calls).toHaveLength(2);
  });

  it('webhook-провайдер не умеет refresh: BITRIX_AUTH_FAILED сразу', async () => {
    const mock = new MockBitrix().on('profile', legacyError('invalid_token', 401));
    const { client } = makeClient(mock);
    expect((await catchApp(client.call('legacy', 'profile', {}))).code).toBe('BITRIX_AUTH_FAILED');
    expect(mock.calls).toHaveLength(1);
  });
});

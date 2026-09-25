/**
 * Сборка режима saas — модульные проверки без БД: конфигурация saas (OAUTH_*, WORKER_*, TRUSTED_PROXIES),
 * точки расширения диспетчера (single без хуков — как прежде), approvalUrl, адрес клиента за прокси, формат KEK.
 */
import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors/app-error.js';
import { dispatch, hiddenReason, type DispatchHooks } from '../../src/mcp/register-tools.js';
import { fail, type Envelope } from '../../src/mcp/result.js';
import { approvalShortCode, approvalUrl, withApprovalUrl } from '../../src/saas/dispatch-hooks.js';
import { clientIp } from '../../src/saas/http.js';
import { parseKek } from '../../src/saas/runtime.js';
import { BlockList } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ALL_MODULES } from '../../src/config/modules.js';
import { loadConfig } from '../../src/config/env.js';
import { createTestApp, FIXTURES_DIR, testConfig } from '../helpers/app.js';

const SAAS = {
  DEPLOYMENT_MODE: 'saas',
  PUBLIC_BASE_URL: 'https://mcp.example.ru',
  MCP_TRANSPORT: 'http',
  BITRIX_WEBHOOK_BASE_URL: '',
  DATABASE_URL: 'postgres://mcp:pw-secret-1@db.internal:5432/mcp',
  REDIS_URL: 'redis://:rd-secret-2@cache.internal:6379/0',
  KEK_FILE: './secrets/kek',
  B24_APP_CLIENT_ID: 'local.test.app',
  B24_APP_CLIENT_SECRET_FILE: './secrets/b24',
  OAUTH_SIGNING_KEYS_DIR: './secrets/keys',
};

function configField(overrides: Record<string, string>): string | undefined {
  try {
    testConfig(overrides);
  } catch (e) {
    expect((e as AppError).code).toBe('CONFIG_INVALID');
    return (e as AppError).details.field;
  }
  return undefined;
}

describe('конфигурация saas (сборка)', () => {
  it('READ_ONLY_MODE — аварийный выключатель: в saas по умолчанию false, в single по умолчанию true', () => {
    // Файл .env без READ_ONLY_MODE и ENABLED_MODULES (mock.env задаёт их явно).
    const dir = mkdtempSync(path.join(tmpdir(), 'saas-cfg-'));
    const envFile = path.join(dir, '.env');
    const policies = path.join(FIXTURES_DIR, '..', '..', 'policies');
    writeFileSync(
      envFile,
      [
        ...Object.entries(SAAS).map(([k, v]) => `${k}=${v}`),
        `METHOD_POLICY_FILE=${path.join(policies, 'methods.example.json')}`,
        `ACCESS_POLICY_FILE=${path.join(policies, 'access.example.json')}`,
        `OUTPUT_POLICY_FILE=${path.join(policies, 'output.example.json')}`,
      ].join('\n'),
    );
    const saas = loadConfig({ configPath: envFile, processEnv: {} });
    expect(saas.policy.readOnlyMode).toBe(false);
    expect(saas.policy.enabledModules.size).toBe(ALL_MODULES.length);
    expect(
      loadConfig({
        configPath: envFile,
        processEnv: { DEPLOYMENT_MODE: 'single', DATABASE_URL: 'file:./x.sqlite' },
      }).policy.readOnlyMode,
    ).toBe(true);
    const explicit = testConfig({ ...SAAS, READ_ONLY_MODE: 'true' });
    expect(explicit.policy.readOnlyMode).toBe(true);
    expect(testConfig().policy.readOnlyMode).toBe(true);
  });

  it('OAUTH_*, WORKER_*, TRUSTED_PROXIES, METRICS_TOKEN_FILE разбираются в deployment', () => {
    const c = testConfig({
      ...SAAS,
      OAUTH_ACCESS_TOKEN_TTL_SEC: '300',
      OAUTH_DCR_LIMIT: '5',
      OAUTH_CIMD_ENABLED: 'false',
      WORKER_TASKS: 'usage.flush,billing.renewals',
      WORKER_TASK_INTERVALS: 'usage.flush=30000',
      TRUSTED_PROXIES: '172.16.0.0/12,10.0.0.5',
      METRICS_TOKEN_FILE: './secrets/metrics',
    });
    expect(c.deployment.oauth).toMatchObject({
      accessTokenTtlSec: 300,
      registrationRateLimit: { limit: 5, windowSec: 3600 },
      cimd: { enabled: false },
    });
    expect([...(c.deployment.ops?.enabledTasks ?? [])]).toEqual(['usage.flush', 'billing.renewals']);
    expect(c.deployment.ops?.taskIntervals.get('usage.flush')).toBe(30_000);
    expect(c.deployment.http.trustedProxies).toEqual(['172.16.0.0/12', '10.0.0.5']);
    expect(c.deployment.http.metricsTokenFile?.endsWith('/secrets/metrics')).toBe(true);
    expect(testConfig().deployment.ops).toBeUndefined();
  });

  it.each([
    ['MCP_AUTH_MODE', { MCP_AUTH_MODE: 'oauth' }],
    ['ADMIN_PANEL_ENABLED', { ADMIN_PANEL_ENABLED: 'true' }],
    ['TRUSTED_PROXIES', { TRUSTED_PROXIES: 'not-an-ip' }],
    ['OAUTH_CODE_TTL_SEC', { OAUTH_CODE_TTL_SEC: '120' }],
    ['OAUTH_CIMD_ENABLED', { OAUTH_CIMD_ENABLED: 'yes' }],
    ['WORKER_RENEW_INTERVAL_MS', { WORKER_LEASE_TTL_MS: '5000', WORKER_RENEW_INTERVAL_MS: '6000' }],
  ])('saas: неверное %s → CONFIG_INVALID', (field, extra) => {
    expect(configField({ ...SAAS, ...extra })).toBe(field);
  });

  it('saas разрешает внешний MCP_HOST (каждый /mcp под токеном сервиса); single — нет', () => {
    expect(configField({ ...SAAS, MCP_HOST: '0.0.0.0' })).toBeUndefined();
    expect(configField({ MCP_TRANSPORT: 'http', MCP_HOST: '0.0.0.0' })).toBe('MCP_HOST');
  });
});

describe('точки расширения диспетчера', () => {
  it('без хуков (single): путь вызова прежний, скрытия по тарифу нет', async () => {
    const { app } = createTestApp({ READ_ONLY_MODE: 'false' });
    try {
      const def = app.tools.find((t) => t.name === 'bitrix_server_version');
      if (!def) throw new Error('нет инструмента');
      const env = await dispatch(def, {}, app);
      expect(env.success).toBe(true);
      expect(hiddenReason(def, app)).toBeUndefined();
    } finally {
      app.close();
    }
  });

  it('хуки: скрытие по тарифу, отказ до handler, обёртка вызова', async () => {
    const { app } = createTestApp();
    try {
      const def = app.tools.find((t) => t.name === 'bitrix_server_version');
      if (!def) throw new Error('нет инструмента');
      const seen: string[] = [];
      const hooks: DispatchHooks = {
        hiddenReason: (d) => (d.name === def.name ? 'тариф арендатора: NOT_IN_PLAN' : undefined),
        beforeHandler: () => Promise.reject(new AppError('QUOTA_EXCEEDED', 'квота')),
        around: async (call, next) => {
          seen.push(call.def.name);
          return next();
        },
      };
      expect(hiddenReason(def, app, app.principal, hooks)).toContain('NOT_IN_PLAN');
      const env = await dispatch(def, {}, app, undefined, app.principal, hooks);
      expect(env.success).toBe(false);
      expect(!env.success && env.error.code).toBe('QUOTA_EXCEEDED');
      expect(seen).toEqual(['bitrix_server_version']);
      const thrower: DispatchHooks = {
        around: () => Promise.reject(new AppError('SUBSCRIPTION_INACTIVE', 'нет')),
      };
      const env2 = await dispatch(def, {}, app, undefined, app.principal, thrower);
      expect(!env2.success && env2.error.code).toBe('SUBSCRIPTION_INACTIVE');
    } finally {
      app.close();
    }
  });
});

describe('approvalUrl (§11.2)', () => {
  it('APPROVAL_REQUIRED дополняется ссылкой кабинета и кодом; прочие ответы не меняются', () => {
    const id = '0b6f3c1e-2a55-4b1b-9c1e-4f8f7d0c1a22';
    const env = fail(
      new AppError('APPROVAL_REQUIRED', 'нужно подтверждение', {
        operationId: id,
        status: 'prepared',
        nextAction: 'npm run approval:review',
      }),
      { requestId: 'r', durationMs: 1 },
    );
    const out = withApprovalUrl(env, 'https://mcp.example.ru/');
    expect(!out.success && out.error.details.approvalUrl).toBe(`https://mcp.example.ru/app/approvals/${id}`);
    expect(!out.success && out.error.details.approvalCode).toBe(approvalShortCode(id));
    expect(!out.success && out.error.details.nextAction).not.toContain('npm run');
    expect(approvalShortCode(id)).toMatch(/^[0-9A-F]{6}$/);
    expect(approvalUrl('https://x.ru', 'a/b')).toBe('https://x.ru/app/approvals/a%2Fb');
    const other: Envelope = fail(new AppError('NOT_FOUND', 'нет'), { requestId: 'r', durationMs: 1 });
    expect(withApprovalUrl(other, 'https://x.ru')).toBe(other);
  });
});

describe('адрес клиента за доверенным прокси', () => {
  const req = (remote: string, xff?: string) =>
    ({
      socket: { remoteAddress: remote },
      headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
    }) as unknown as FastifyRequest;
  const trusted = new BlockList();
  trusted.addSubnet('172.16.0.0', 12, 'ipv4');

  it('без доверенного прокси заголовок игнорируется', () => {
    expect(clientIp(req('203.0.113.1', '185.71.76.5'), undefined)).toBe('203.0.113.1');
    expect(clientIp(req('::ffff:203.0.113.1', '185.71.76.5'), trusted)).toBe('203.0.113.1');
  });

  it('от прокси — самый правый недоверенный адрес (подделка левее не помогает)', () => {
    expect(clientIp(req('172.18.0.2', '185.71.76.5'), trusted)).toBe('185.71.76.5');
    expect(clientIp(req('172.18.0.2', '185.71.76.5, 203.0.113.9'), trusted)).toBe('203.0.113.9');
    expect(clientIp(req('172.18.0.2', '203.0.113.9, 172.18.0.3'), trusted)).toBe('203.0.113.9');
  });
});

describe('KEK', () => {
  it('hex, base64 и двоичный файл; иное — CONFIG_INVALID', () => {
    const key = Buffer.alloc(32, 5);
    expect(parseKek(Buffer.from(key.toString('hex') + '\n'))).toEqual(key);
    expect(parseKek(Buffer.from(key.toString('base64')))).toEqual(key);
    expect(parseKek(key)).toEqual(key);
    expect(() => parseKek(Buffer.from('short'))).toThrow(AppError);
  });
});

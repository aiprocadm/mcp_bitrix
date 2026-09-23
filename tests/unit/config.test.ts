import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app/container.js';
import { loadConfig, parseWebhookBaseUrl } from '../../src/config/env.js';
import { AppError } from '../../src/errors/app-error.js';
import { createSilentLogger } from '../../src/logging/logger.js';
import { MOCK_ENV, TEST_KEY, testConfig } from '../helpers/app.js';

const SECRET = 'mocksecret0123456789';

function expectConfigError(fn: () => unknown, field: string): AppError {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(AppError.is(caught)).toBe(true);
  const err = caught as AppError;
  expect(err.code).toBe('CONFIG_INVALID');
  expect(err.details.field).toBe(field);
  return err;
}

describe('config (ТЗ §13, T01, T02)', () => {
  it('загружает mock.env и разрешает относительные пути от каталога .env', () => {
    const c = testConfig();
    expect(c.bitrix.portalOrigin).toBe('https://mock.bitrix24.invalid');
    expect(c.bitrix.webhook?.userId).toBe(7);
    expect(c.policy.methodPolicyFile.endsWith('/policies/methods.example.json')).toBe(true);
    expect(c.storage.databasePath.includes('/data/test/mcp.sqlite')).toBe(true);
    expect(c.policy.enabledModules.has('system')).toBe(true);
  });

  it('T01: без BITRIX_WEBHOOK_BASE_URL старт сервера блокируется CONFIG_INVALID', () => {
    const c = testConfig({ BITRIX_WEBHOOK_BASE_URL: '' });
    expect(c.bitrix.webhook).toBeUndefined();
    const err = expectConfigError(
      () => createApp(c, { logger: createSilentLogger(), inMemoryDatabase: true, masterKey: TEST_KEY }),
      'BITRIX_WEBHOOK_BASE_URL',
    );
    expect(err.message).not.toContain(SECRET);
  });

  it('T01: origin вебхука не совпадает с BITRIX_PORTAL_URL → CONFIG_INVALID без печати секрета', () => {
    const err = expectConfigError(
      () => testConfig({ BITRIX_WEBHOOK_BASE_URL: `https://other.bitrix24.invalid/rest/7/${SECRET}/` }),
      'BITRIX_WEBHOOK_BASE_URL',
    );
    expect(JSON.stringify(err)).not.toContain(SECRET);
  });

  it('вебхук: только https, без query, с завершающим слэшем и без имени метода', () => {
    expect(() => parseWebhookBaseUrl(`http://mock.bitrix24.invalid/rest/7/${SECRET}/`, undefined)).toThrow(
      AppError,
    );
    expect(() =>
      parseWebhookBaseUrl(`https://mock.bitrix24.invalid/rest/7/${SECRET}/profile.json`, undefined),
    ).toThrow(AppError);
    expect(() =>
      parseWebhookBaseUrl(`https://mock.bitrix24.invalid/rest/7/${SECRET}/?x=1`, undefined),
    ).toThrow(AppError);
    expect(() => parseWebhookBaseUrl(`https://mock.bitrix24.invalid/rest/7/${SECRET}`, undefined)).toThrow(
      AppError,
    );
    const ok = parseWebhookBaseUrl(
      `https://mock.bitrix24.invalid/rest/7/${SECRET}/`,
      'https://mock.bitrix24.invalid',
    );
    expect(ok.userId).toBe(7);
    expect(ok.secret).toBe(SECRET);
  });

  it('T02: строка "false" в READ_ONLY_MODE — это false, а не truthy строка', () => {
    const c = testConfig({ READ_ONLY_MODE: 'false' });
    expect(c.policy.readOnlyMode).toBe(false);
    expect(testConfig({ READ_ONLY_MODE: 'TRUE' }).policy.readOnlyMode).toBe(true);
  });

  it('T02: булево принимает только true/false', () => {
    expectConfigError(() => testConfig({ READ_ONLY_MODE: 'yes' }), 'READ_ONLY_MODE');
    expectConfigError(() => testConfig({ READ_ONLY_MODE: '1' }), 'READ_ONLY_MODE');
  });

  it('опасные сочетания блокируются', () => {
    expectConfigError(
      () => testConfig({ MCP_TRANSPORT: 'http', MCP_HOST: '0.0.0.0', MCP_AUTH_MODE: 'local' }),
      'MCP_HOST',
    );
    expectConfigError(
      () => testConfig({ READ_ONLY_MODE: 'false', CONFIRM_ALL_WRITES: 'false' }),
      'CONFIRM_ALL_WRITES',
    );
    expectConfigError(
      () => testConfig({ CONFIRM_DESTRUCTIVE_ACTIONS: 'false' }),
      'CONFIRM_DESTRUCTIVE_ACTIONS',
    );
    expectConfigError(() => testConfig({ ALLOW_REMOTE_FILE_URLS: 'true' }), 'ALLOW_REMOTE_FILE_URLS');
    expectConfigError(() => testConfig({ UPLOAD_SCAN_REQUIRED: 'true' }), 'UPLOAD_SCANNER_URL');
    expectConfigError(
      () => testConfig({ DEFAULT_PAGE_SIZE: '50', MAX_PAGE_SIZE: '20' }),
      'DEFAULT_PAGE_SIZE',
    );
    expectConfigError(() => testConfig({ ENABLED_MODULES: 'crm,unknownmodule' }), 'ENABLED_MODULES');
  });

  it('loopback http + local разрешён', () => {
    const c = testConfig({ MCP_TRANSPORT: 'http', MCP_HOST: '127.0.0.1' });
    expect(c.server.transport).toBe('http');
  });

  it('CONFIG_PATH на несуществующий файл → CONFIG_INVALID', () => {
    expectConfigError(() => loadConfig({ configPath: MOCK_ENV + '.missing', processEnv: {} }), 'CONFIG_PATH');
  });

  it('переменные процесса имеют приоритет над файлом', () => {
    const c = loadConfig({ configPath: MOCK_ENV, processEnv: { DEFAULT_TIMEZONE: 'Asia/Yekaterinburg' } });
    expect(c.bitrix.timezone).toBe('Asia/Yekaterinburg');
  });
});

/**
 * SaaS-ТЗ S1 срез 1 (D14, §5.3, §15): режим развёртывания и опасные сочетания.
 * single — поведение базового ТЗ; saas — только с HTTPS-адресом, HTTP-транспортом, PostgreSQL, Redis и без вебхука.
 */
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app/container.js';
import { describeConfig } from '../../src/config/env.js';
import { AppError } from '../../src/errors/app-error.js';
import { createSilentLogger } from '../../src/logging/logger.js';
import { redactString } from '../../src/security/redaction.js';
import { TEST_KEY, testConfig } from '../helpers/app.js';

const SAAS = {
  DEPLOYMENT_MODE: 'saas',
  PUBLIC_BASE_URL: 'https://mcp.example.ru',
  MCP_TRANSPORT: 'http',
  BITRIX_WEBHOOK_BASE_URL: '',
  DATABASE_URL: 'postgres://mcp:pg-Pa55word-xyz@db.internal:5432/mcp',
  REDIS_URL: 'rediss://:redis-Pa55-abc@cache.internal:6380/0',
};

function configError(overrides: Record<string, string>): AppError {
  try {
    testConfig(overrides);
  } catch (e) {
    expect(AppError.is(e)).toBe(true);
    expect((e as AppError).code).toBe('CONFIG_INVALID');
    return e as AppError;
  }
  throw new Error('ожидалась ошибка конфигурации');
}

describe('DEPLOYMENT_MODE', () => {
  it('по умолчанию single: поведение и описание конфигурации как раньше', () => {
    const c = testConfig();
    expect(c.deployment).toEqual({
      mode: 'single',
      publicBaseUrl: undefined,
      redisUrl: undefined,
      postgresUrl: undefined,
      processRole: 'web',
    });
    const d = describeConfig(c);
    expect(d['deploymentMode']).toBe('single');
    expect(d['databasePath']).toBeDefined();
  });

  it('single с PostgreSQL в DATABASE_URL → CONFIG_INVALID', () => {
    expect(configError({ DATABASE_URL: 'postgres://u:p@h/db' }).details.field).toBe('DATABASE_URL');
  });

  it('корректный saas разбирается; пароли PostgreSQL/Redis не печатаются и зарегистрированы как секреты', () => {
    const c = testConfig(SAAS);
    expect(c.deployment.mode).toBe('saas');
    expect(c.deployment.publicBaseUrl).toBe('https://mcp.example.ru');
    expect(c.deployment.processRole).toBe('web');
    const printed = JSON.stringify(describeConfig(c));
    expect(printed).not.toContain('pg-Pa55word-xyz');
    expect(printed).not.toContain('redis-Pa55-abc');
    expect(printed).not.toContain('databasePath');
    expect(redactString('connect failed: pg-Pa55word-xyz / redis-Pa55-abc')).not.toMatch(/Pa55/);
  });

  it.each([
    ['PUBLIC_BASE_URL', { PUBLIC_BASE_URL: '' }],
    ['PUBLIC_BASE_URL', { PUBLIC_BASE_URL: 'http://mcp.example.ru' }],
    ['PUBLIC_BASE_URL', { PUBLIC_BASE_URL: 'https://mcp.example.ru/mcp' }],
    [
      'BITRIX_WEBHOOK_BASE_URL',
      { BITRIX_WEBHOOK_BASE_URL: 'https://mock.bitrix24.invalid/rest/7/mocksecret0123456789/' },
    ],
    ['MCP_TRANSPORT', { MCP_TRANSPORT: 'stdio' }],
    ['DATABASE_URL', { DATABASE_URL: 'file:./data/mcp.sqlite' }],
    ['REDIS_URL', { REDIS_URL: '' }],
    ['REDIS_URL', { REDIS_URL: 'http://cache.internal' }],
  ])('saas: опасное сочетание → CONFIG_INVALID по полю %s', (field, extra) => {
    const err = configError({ ...SAAS, ...extra });
    expect(err.details.field).toBe(field);
    expect(err.message).not.toContain('mocksecret0123456789');
  });

  it('createApp в режиме saas честно отказывает (компоненты по этапам), БД не открывается', () => {
    let caught: unknown;
    try {
      createApp(testConfig(SAAS), {
        logger: createSilentLogger(),
        inMemoryDatabase: true,
        masterKey: TEST_KEY,
      });
    } catch (e) {
      caught = e;
    }
    expect((caught as AppError).code).toBe('CONFIG_INVALID');
    expect((caught as AppError).details.field).toBe('DEPLOYMENT_MODE');
  });
});

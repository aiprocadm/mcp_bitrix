/** Конфигурация удалённого профиля (ТЗ §13 п.4, §8.1): oauth требует https/публичный адрес/allowlist. */
import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors/app-error.js';
import { InboundLimiter } from '../../src/security/inbound-limiter.js';
import { testConfig } from '../helpers/app.js';

function expectConfigError(fn: () => unknown, field: string): void {
  try {
    fn();
  } catch (e) {
    expect(AppError.is(e)).toBe(true);
    if (AppError.is(e)) {
      expect(e.code).toBe('CONFIG_INVALID');
      expect(e.details.field).toBe(field);
    }
    return;
  }
  throw new Error(`ожидалась ошибка конфигурации ${field}`);
}

const OK = {
  MCP_TRANSPORT: 'http',
  MCP_HOST: '0.0.0.0',
  MCP_AUTH_MODE: 'oauth',
  MCP_PUBLIC_URL: 'https://mcp.example.com/mcp/',
  MCP_AUTH_ISSUER: 'https://auth.example.com/realms/mcp',
  MCP_AUTH_JWKS_URI: 'https://auth.example.com/realms/mcp/protocol/openid-connect/certs',
  MCP_AUTH_ALLOWED_SUBJECTS: 'alice, bob',
};

describe('MCP_AUTH_MODE=oauth', () => {
  it('внешний интерфейс разрешён только с oauth; resource канонический (без /), Host из публичного адреса', () => {
    const c = testConfig(OK);
    expect(c.server.auth).toMatchObject({
      resource: 'https://mcp.example.com/mcp',
      audience: 'https://mcp.example.com/mcp',
      issuer: 'https://auth.example.com/realms/mcp',
      metadataUrl: 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp',
      publicOrigin: 'https://mcp.example.com',
      allowedSubjects: ['alice', 'bob'],
    });
    expect(c.server.allowedHosts).toEqual(['mcp.example.com']);
    expect(c.server.inboundReadPerMinute).toBe(100_000); // из mock.env; по умолчанию 60
    expect(testConfig({ ...OK, MCP_AUTH_AUDIENCE: 'urn:mcp:bitrix' }).server.auth?.audience).toBe(
      'urn:mcp:bitrix',
    );
    expect(testConfig({ ...OK, MCP_ALLOWED_HOSTS: 'a.example,b.example' }).server.allowedHosts).toEqual([
      'a.example',
      'b.example',
    ]);
  });

  it('обязательные поля и https', () => {
    expectConfigError(() => testConfig({ ...OK, MCP_PUBLIC_URL: '' }), 'MCP_PUBLIC_URL');
    expectConfigError(
      () => testConfig({ ...OK, MCP_PUBLIC_URL: 'http://mcp.example.com/mcp' }),
      'MCP_PUBLIC_URL',
    );
    expectConfigError(
      () => testConfig({ ...OK, MCP_PUBLIC_URL: 'https://u:p@mcp.example.com/mcp' }),
      'MCP_PUBLIC_URL',
    );
    expectConfigError(
      () => testConfig({ ...OK, MCP_PUBLIC_URL: 'https://mcp.example.com/mcp#x' }),
      'MCP_PUBLIC_URL',
    );
    expectConfigError(() => testConfig({ ...OK, MCP_AUTH_ISSUER: '' }), 'MCP_AUTH_ISSUER');
    expectConfigError(() => testConfig({ ...OK, MCP_AUTH_ISSUER: 'auth.example.com' }), 'MCP_AUTH_ISSUER');
    expectConfigError(() => testConfig({ ...OK, MCP_AUTH_JWKS_URI: '' }), 'MCP_AUTH_JWKS_URI');
    expectConfigError(
      () => testConfig({ ...OK, MCP_AUTH_JWKS_URI: 'http://auth.example.com/jwks' }),
      'MCP_AUTH_JWKS_URI',
    );
    expectConfigError(
      () => testConfig({ ...OK, MCP_AUTH_ALLOWED_SUBJECTS: '' }),
      'MCP_AUTH_ALLOWED_SUBJECTS',
    );
    expectConfigError(() => testConfig({ ...OK, MCP_TRANSPORT: 'stdio' }), 'MCP_AUTH_MODE');
    // local на внешнем интерфейсе по-прежнему запрещён
    expectConfigError(
      () => testConfig({ MCP_TRANSPORT: 'http', MCP_HOST: '0.0.0.0', MCP_AUTH_MODE: 'local' }),
      'MCP_HOST',
    );
  });

  it('loopback http допустим для локальных проверок', () => {
    const c = testConfig({
      ...OK,
      MCP_HOST: '127.0.0.1',
      MCP_PUBLIC_URL: 'http://127.0.0.1:3000/mcp',
      MCP_AUTH_ISSUER: 'http://127.0.0.1:4000/issuer',
      MCP_AUTH_JWKS_URI: 'http://localhost:4000/jwks',
    });
    expect(c.server.auth?.resource).toBe('http://127.0.0.1:3000/mcp');
    expect(c.server.allowedHosts).toEqual(['127.0.0.1']);
  });
});

describe('InboundLimiter (ТЗ §8.6)', () => {
  it('скользящее окно на ключ: превышение → RATE_LIMITED, через минуту снова можно', () => {
    let now = 1_000_000;
    const l = new InboundLimiter(3, () => now);
    l.take('a');
    l.take('a');
    l.take('a');
    l.take('b'); // другой оператор не мешает
    expect(() => l.take('a')).toThrow(/лимит/);
    try {
      l.take('a');
    } catch (e) {
      expect(AppError.is(e) && e.code).toBe('RATE_LIMITED');
    }
    now += 60_001;
    expect(() => l.take('a')).not.toThrow();
  });
});

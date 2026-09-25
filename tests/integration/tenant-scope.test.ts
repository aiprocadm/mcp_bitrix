/**
 * SaaS-ТЗ S1 срез 1 (§5.1–5.2, §16): Platform + TenantScope.
 * Single собирает ровно один арендатор `local`; на одной платформе можно собрать несколько арендаторов —
 * у каждого свой провайдер авторизации, клиент, лимитер и список разрешённых хостов (портал чужого арендатора недоступен).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiVersion } from '../../src/bitrix/method-registry.js';
import type { BitrixAuthProvider } from '../../src/auth/bitrix-auth-provider.js';
import {
  createPlatform,
  createTenantScope,
  LOCAL_TENANT_ID,
  type Platform,
} from '../../src/app/container.js';
import { createSilentLogger } from '../../src/logging/logger.js';
import { createTestApp, TEST_KEY, testConfig, type TestApp } from '../helpers/app.js';
import { legacyOk, MockBitrix, PROFILE_RESULT } from '../helpers/mock-bitrix.js';

/** Тестовый провайдер портала: секрет в пути, как у вебхука, но для произвольного хоста. */
function portalAuth(host: string, userId: number): BitrixAuthProvider {
  const origin = `https://${host}`;
  return {
    mode: 'webhook',
    portalOrigin: origin,
    portalKey: `key-${host}`,
    identityUserId: userId,
    getAuth: (apiVersion: ApiVersion) => ({
      baseUrl:
        apiVersion === 'v3'
          ? `${origin}/rest/api/${String(userId)}/s/`
          : `${origin}/rest/${String(userId)}/s/`,
      bodyFields: {},
    }),
    tryRefresh: () => Promise.resolve(false),
  };
}

let t: TestApp | undefined;
let platform: Platform | undefined;
afterEach(() => {
  t?.app.close();
  platform?.close();
  t = undefined;
  platform = undefined;
});

describe('Platform и TenantScope', () => {
  it('single: AppContainer = платформа + единственный арендатор local; поля совпадают', () => {
    t = createTestApp();
    const { app } = t;
    expect(app.tenantId).toBe(LOCAL_TENANT_ID);
    expect(app.scope.tenantId).toBe(LOCAL_TENANT_ID);
    expect(app.bitrix).toBe(app.scope.bitrix);
    expect(app.operations).toBe(app.scope.operations);
    expect(app.db).toBe(app.platform.db);
    expect(app.audit).toBe(app.platform.audit);
    expect(app.auth.portalOrigin).toBe('https://mock.bitrix24.invalid');
  });

  it('два арендатора на одной платформе: запросы уходят каждый в свой портал; чужой хост отклоняется до сети', async () => {
    const bitrix = new MockBitrix();
    bitrix.on('profile', legacyOk(PROFILE_RESULT));
    platform = createPlatform(testConfig(), {
      fetch: bitrix.fetch,
      logger: createSilentLogger(),
      inMemoryDatabase: true,
      masterKey: TEST_KEY,
    });
    const principal = { id: 'owner', role: 'administrator' as const, source: 'local' as const };
    const a = createTenantScope(platform, {
      tenantId: 'tenant-a',
      auth: portalAuth('a.bitrix24.invalid', 1),
      principal,
      allowedHosts: ['a.bitrix24.invalid'],
    });
    const b = createTenantScope(platform, {
      tenantId: 'tenant-b',
      auth: portalAuth('b.bitrix24.invalid', 2),
      principal,
      allowedHosts: ['b.bitrix24.invalid'],
    });
    expect(a.bitrix).not.toBe(b.bitrix);
    expect(a.limiter).not.toBe(b.limiter);
    await a.bitrix.call('legacy', 'profile');
    await b.bitrix.call('legacy', 'profile');
    const hosts = bitrix.calls.map((c) => new URL(c.url).host);
    expect(hosts).toEqual(['a.bitrix24.invalid', 'b.bitrix24.invalid']);

    // Арендатор A с провайдером, указывающим на портал B, не выходит за свой allowlist.
    const confused = createTenantScope(platform, {
      tenantId: 'tenant-a',
      auth: portalAuth('b.bitrix24.invalid', 1),
      principal,
      allowedHosts: ['a.bitrix24.invalid'],
    });
    await expect(confused.bitrix.call('legacy', 'profile')).rejects.toThrow();
    expect(bitrix.calls).toHaveLength(2);
  });
});

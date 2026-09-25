/**
 * SaaS-ТЗ S01 (§12 п.1–2) на SQLite: два арендатора на одной платформе и одной БД.
 * Операции, подтверждения, idempotency, курсоры, fileToken и аудит одного арендатора
 * недоступны другому и выглядят как несуществующие.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assembleApp,
  createPlatform,
  createTenantScope,
  type AppContainer,
  type Platform,
} from '../../src/app/container.js';
import type { BitrixAuthProvider } from '../../src/auth/bitrix-auth-provider.js';
import type { ApiVersion } from '../../src/bitrix/method-registry.js';
import { createSilentLogger } from '../../src/logging/logger.js';
import { dispatch } from '../../src/mcp/register-tools.js';
import type { Envelope } from '../../src/mcp/result.js';
import { makeFakeCreateTool, type FakeWriteHooks } from '../helpers/fake-write-tool.js';
import { TEST_KEY, testConfig } from '../helpers/app.js';
import { deals, legacyListPage, legacyOk, MockBitrix, DEAL_FIELDS } from '../helpers/mock-bitrix.js';

function portalAuth(host: string): BitrixAuthProvider {
  const origin = `https://${host}`;
  return {
    mode: 'webhook',
    portalOrigin: origin,
    portalKey: `key-${host}`,
    identityUserId: 7,
    getAuth: (v: ApiVersion) => ({
      baseUrl: `${origin}/rest/${v === 'v3' ? 'api/' : ''}7/s/`,
      bodyFields: {},
    }),
    tryRefresh: () => Promise.resolve(false),
  };
}

let platform: Platform;
let a: AppContainer;
let b: AppContainer;
let hooks: FakeWriteHooks;

beforeEach(async () => {
  const bitrix = new MockBitrix();
  const all = deals(1, 60);
  bitrix
    .on('crm.deal.fields', legacyOk(DEAL_FIELDS))
    .on('crm.deal.list', (c) => legacyListPage(all, Number(c.body['start'] ?? 0), 50))
    .on('crm.deal.add', legacyOk(101));
  platform = createPlatform(testConfig({ READ_ONLY_MODE: 'false' }), {
    fetch: bitrix.fetch,
    logger: createSilentLogger(),
    inMemoryDatabase: true,
    masterKey: TEST_KEY,
  });
  hooks = { performCalls: 0, verifyCalls: 0, precheckCalls: 0 };
  const principal = { id: 'owner', role: 'administrator' as const, source: 'local' as const };
  const scope = (tenantId: string, host: string) => {
    const s = createTenantScope(platform, {
      tenantId,
      auth: portalAuth(host),
      principal,
      allowedHosts: [host],
    });
    return assembleApp(platform, { ...s, tools: [...s.tools, makeFakeCreateTool(hooks)] });
  };
  a = scope('tenant-a', 'a.bitrix24.invalid');
  b = scope('tenant-b', 'b.bitrix24.invalid');
  await a.ready;
  await b.ready;
});
afterEach(() => platform.close());

const tool = (app: AppContainer, name: string) => {
  const def = app.tools.find((t) => t.name === name);
  if (!def) throw new Error(name);
  return def;
};
const run = (app: AppContainer, name: string, args: Record<string, unknown>) =>
  dispatch(tool(app, name), args, app);
const err = (env: Envelope) => (env.success ? undefined : env.error);

describe('S01: изоляция арендаторов на одной БД', () => {
  it('операция и подтверждение арендатора A не видны B: operation_status/approve/approvalId → как несуществующие', async () => {
    const key = randomUUID();
    const prep = await run(a, 'test_create', { title: 'x', idempotencyKey: key });
    const operationId = String(err(prep)?.details['operationId']);
    expect(operationId).toBeTruthy();

    expect(await b.operations.get(operationId)).toBeUndefined();
    await expect(b.approvals.approve(operationId, 'owner', b.auth.portalKey)).rejects.toThrow(/не найдена/);
    const status = await run(b, 'operation_status', { operationId });
    expect(err(status)?.code).toBe('NOT_FOUND');

    // Подтверждение A нельзя «исполнить» в B тем же approvalId и ключом
    await a.approvals.approve(operationId, 'owner', a.auth.portalKey);
    const foreign = await run(b, 'test_create', { title: 'x', idempotencyKey: key, approvalId: operationId });
    expect(err(foreign)?.code).toBe('APPROVAL_MISMATCH');
    expect(hooks.performCalls).toBe(0);
    const own = await run(a, 'test_create', { title: 'x', idempotencyKey: key, approvalId: operationId });
    expect(own.success).toBe(true);
    expect(hooks.performCalls).toBe(1);
  });

  it('один и тот же idempotencyKey у двух арендаторов — две независимые операции', async () => {
    const key = randomUUID();
    const pa = await run(a, 'test_create', { title: 'x', idempotencyKey: key });
    const pb = await run(b, 'test_create', { title: 'другое', idempotencyKey: key });
    expect(err(pb)?.code).toBe('APPROVAL_REQUIRED');
    expect(err(pb)?.details['operationId']).not.toBe(err(pa)?.details['operationId']);
    expect(await a.operations.countByStatus()).toEqual({ prepared: 1 });
    expect(await b.operations.countByStatus()).toEqual({ prepared: 1 });
  });

  it('курсор арендатора A в B → недействителен, без чтения чужого состояния', async () => {
    const pageA = await run(a, 'crm_list_records', { entityType: 'deal', pageSize: 20 });
    const cursor = pageA.success ? pageA.meta.page?.nextCursor : undefined;
    expect(cursor).toBeTruthy();
    const inB = await run(b, 'crm_list_records', { entityType: 'deal', pageSize: 20, cursor });
    expect(err(inB)?.code).toBe('VALIDATION_ERROR');
    expect(err(inB)?.details['field']).toBe('cursor');
    // Курсор A остаётся рабочим для A
    const nextA = await run(a, 'crm_list_records', { entityType: 'deal', pageSize: 20, cursor });
    expect(nextA.success).toBe(true);
  });

  it('fileToken арендатора A не находится в B; аудит помечен арендатором', async () => {
    const m = await a.files.stageInline(Buffer.from('секрет A').toString('base64'), 'a.txt', 'owner');
    await expect(b.files.resolve(m.token, 'owner')).rejects.toThrow(/не найден/);
    expect((await a.files.resolve(m.token, 'owner')).sha256).toBe(m.sha256);
    expect(await b.files.listOwn('owner')).toEqual([]);

    await run(a, 'crm_list_records', { entityType: 'deal', pageSize: 5 });
    await run(b, 'crm_list_records', { entityType: 'deal', pageSize: 5 });
    const rows = await platform.db.all<{ tenant_id: string }>('SELECT tenant_id FROM audit ORDER BY id');
    expect(rows.map((r) => r.tenant_id)).toEqual(['tenant-a', 'tenant-b']);
  });
});

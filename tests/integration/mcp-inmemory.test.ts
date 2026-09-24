/**
 * T41 (in-memory): официальный MCP client → наш McpServer → мок Bitrix → SQLite в памяти.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { connectInMemory, createTestApp, structured, type TestApp } from '../helpers/app.js';
import { legacyError, legacyOk, PROFILE_RESULT } from '../helpers/mock-bitrix.js';

interface Envelope {
  success: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; details: Record<string, unknown> };
  meta: Record<string, unknown>;
}

describe('MCP через InMemoryTransport (T41)', () => {
  let t: TestApp;
  let client: Client;
  let close: () => Promise<void>;

  beforeEach(async () => {
    t = createTestApp();
    t.bitrix
      .on('profile', legacyOk(PROFILE_RESULT))
      .on('scope', legacyOk(['crm', 'task', 'im', 'disk', 'calendar']))
      .on('method.get', (call) =>
        legacyOk({
          isExisting: call.body['name'] !== 'calendar.event.add',
          isAvailable: call.body['name'] !== 'im.message.add',
        }),
      );
    const c = await connectInMemory(t.app);
    client = c.client;
    close = () => c.close();
  });
  afterEach(async () => {
    await close();
    t.app.close();
  });

  it('tools/list: в read-only видны только читающие инструменты, верные annotations и строгие схемы', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((x) => x.name).sort();
    expect(names).toEqual([
      'bitrix_capabilities',
      'bitrix_connection_info',
      'bitrix_rest_call',
      'bitrix_server_version',
      'crm_activities_list',
      'crm_deal_products_get',
      'crm_fields_get',
      'crm_get_record',
      'crm_list_records',
      'crm_pipeline_summary',
      'crm_search_records',
      'crm_stage_history',
      'crm_stages_and_statuses',
      'crm_timeline_comments_list',
      'crm_userfields_list',
      'operation_status',
      'task_get',
      'task_list',
    ]);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
      expect((tool.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
      expect(tool.outputSchema).toBeDefined();
      expect(tool.description).toMatch(/[а-яА-Я]/);
    }
  });

  it('bitrix_server_version без обращения к Bitrix', async () => {
    const r = await client.callTool({ name: 'bitrix_server_version', arguments: {} });
    const env = structured<Envelope>(r);
    expect(r.isError).toBeFalsy();
    expect(env.success).toBe(true);
    expect(env.data).toMatchObject({
      name: 'bitrix24-mcp-server',
      mcpSdkVersion: '2.0.0',
      readOnlyMode: true,
    });
    expect(t.bitrix.calls).toHaveLength(0);
    expect(r.content[0]).toMatchObject({ type: 'text' });
  });

  it('bitrix_connection_info: домен без секрета, пользователь, scope; e-mail и телефон не возвращаются', async () => {
    const r = await client.callTool({ name: 'bitrix_connection_info', arguments: {} });
    const env = structured<Envelope>(r);
    expect(env.success).toBe(true);
    expect(env.data).toMatchObject({
      portalOrigin: 'https://mock.bitrix24.invalid',
      authMode: 'webhook',
      bitrixUser: { id: 7, name: 'Иван', lastName: 'Тестов', isAdmin: true, timeZone: 'Europe/Moscow' },
      readOnlyMode: true,
      scopes: ['crm', 'task', 'im', 'disk', 'calendar'],
      scopesSource: 'portal',
    });
    const text = JSON.stringify(r);
    expect(text).not.toContain('mocksecret');
    expect(text).not.toContain('example.com');
    expect(text).not.toContain('123-45-67');
    expect(env.meta['method']).toBe('profile');
  });

  it('bitrix_connection_info при отказе авторизации: isError и BITRIX_AUTH_FAILED без секрета', async () => {
    t.bitrix.on('profile', legacyError('expired_token', 401));
    const r = await client.callTool({ name: 'bitrix_connection_info', arguments: {} });
    expect(r.isError).toBe(true);
    const env = structured<Envelope>(r);
    expect(env.success).toBe(false);
    expect(env.error?.code).toBe('BITRIX_AUTH_FAILED');
    expect(JSON.stringify(r)).not.toContain('supersecretcode');
  });

  it('bitrix_capabilities: supported/unavailable по method.get, модуль вне ENABLED_MODULES помечен политикой', async () => {
    const r = await client.callTool({ name: 'bitrix_capabilities', arguments: { module: 'calendar' } });
    const env = structured<Envelope>(r);
    expect(env.success).toBe(true);
    const items = env.data?.['items'] as { method: string; status: string }[];
    expect(items.find((i) => i.method === 'calendar.event.add')?.status).toBe('unavailable');
    expect(items.find((i) => i.method === 'calendar.section.get')?.status).toBe('supported');
    const r2 = await client.callTool({ name: 'bitrix_capabilities', arguments: { module: 'chat' } });
    const items2 = structured<Envelope>(r2).data?.['items'] as { method: string; status: string }[];
    expect(items2.find((i) => i.method === 'im.message.add')?.status).toBe('unavailable');
    expect(items2.find((i) => i.method === 'im.recent.list')?.status).toBe('supported');
  });

  it('bitrix_capabilities кэширует method.get на 5 минут, refresh обновляет', async () => {
    await client.callTool({ name: 'bitrix_capabilities', arguments: { module: 'chat' } });
    const n = t.bitrix.callsTo('method.get').length;
    await client.callTool({ name: 'bitrix_capabilities', arguments: { module: 'chat' } });
    expect(t.bitrix.callsTo('method.get')).toHaveLength(n);
    await client.callTool({ name: 'bitrix_capabilities', arguments: { module: 'chat', refresh: true } });
    expect(t.bitrix.callsTo('method.get').length).toBeGreaterThan(n);
  });

  it('operation_status: неизвестный id → NOT_FOUND, невалидный uuid → VALIDATION_ERROR', async () => {
    const r = await client.callTool({
      name: 'operation_status',
      arguments: { operationId: '11111111-1111-4111-8111-111111111111' },
    });
    expect(structured<Envelope>(r).error?.code).toBe('NOT_FOUND');
    const bad = await client.callTool({ name: 'operation_status', arguments: { operationId: 'nope' } });
    expect(bad.isError).toBe(true);
  });

  it('лишний корневой параметр отклоняется (additionalProperties:false)', async () => {
    const r = await client.callTool({ name: 'bitrix_server_version', arguments: { extra: 1 } });
    expect(r.isError).toBe(true);
  });
});

describe('bitrix_rest_call (T11, T47, ТЗ §8.3)', () => {
  let t: TestApp;
  let client: Client;
  let close: () => Promise<void>;

  beforeEach(async () => {
    t = createTestApp();
    t.bitrix
      .on('profile', legacyOk(PROFILE_RESULT))
      .on(
        'crm.deal.list',
        legacyOk([{ ID: '1', TITLE: 'x', UF_CRM_PASSPORT: '1234' }], { next: 50, total: 120 }),
      );
    const c = await connectInMemory(t.app);
    client = c.client;
    close = () => c.close();
  });
  afterEach(async () => {
    await close();
    t.app.close();
  });

  const call = async (args: Record<string, unknown>) =>
    structured<Envelope>(await client.callTool({ name: 'bitrix_rest_call', arguments: args }));

  it('profile из allowlist проходит', async () => {
    const env = await call({ method: 'profile' });
    expect(env.success).toBe(true);
    expect((env.data?.['result'] as { ID: string }).ID).toBe('7');
    expect(env.meta['apiVersion']).toBe('legacy');
  });

  it('T47: output policy убирает запрещённые поля и из raw-ответа', async () => {
    const env = await call({ method: 'profile' });
    const result = env.data?.['result'] as Record<string, unknown>;
    expect(result['PERSONAL_PHONE']).toBeUndefined();
    expect(result['NAME']).toBe('Иван');
    const deals = await call({ method: 'crm.deal.list', params: { select: ['ID', 'TITLE'] } });
    const first = (deals.data?.['result'] as Record<string, unknown>[])[0];
    expect(first?.['UF_CRM_PASSPORT']).toBeUndefined();
    expect(deals.meta['completeness']).toBe('partial');
    expect(deals.data?.['next']).toBe(50);
  });

  it('T11: запись, неизвестный метод, batch, casing, path-обход — отказ до API', async () => {
    const before = t.bitrix.calls.length;
    for (const args of [
      { method: 'crm.deal.add', params: { fields: { TITLE: 'x' } } },
      { method: 'batch', params: { cmd: { a: 'profile' } } },
      { method: 'Profile' },
      { method: 'profile/../crm.deal.add' },
      { method: 'crm.deal.get', apiVersion: 'v3' },
      { method: 'im.message.add' },
      { method: 'app.info' },
      { method: 'user.get' },
      { method: 'profile', params: { cmd: { a: 'x' } } },
      { method: 'profile', params: { auth: 'stolen' } },
    ]) {
      const env = await call(args);
      expect(env.success, JSON.stringify(args)).toBe(false);
      expect(['METHOD_NOT_ALLOWED', 'VALIDATION_ERROR']).toContain(env.error?.code);
    }
    expect(t.bitrix.calls).toHaveLength(before);
  });

  it('метод из реестра, но не из allowlist политики — отказ', async () => {
    const env = await call({ method: 'user.search', params: { FILTER: { NAME: 'Иван' } } });
    expect(env.error?.code).toBe('METHOD_NOT_ALLOWED');
    expect(t.bitrix.calls).toHaveLength(0);
  });

  it('при ENABLE_RAW_REST=false инструмент скрыт и прямой вызов отказывает', async () => {
    const t2 = createTestApp({ ENABLE_RAW_REST: 'false' });
    const c2 = await connectInMemory(t2.app);
    const names = (await c2.client.listTools()).tools.map((x) => x.name);
    expect(names).not.toContain('bitrix_rest_call');
    const r = await c2.client
      .callTool({ name: 'bitrix_rest_call', arguments: { method: 'profile' } })
      .catch((e: unknown) => e);
    const ok = r instanceof Error || (r as { isError?: boolean }).isError === true;
    expect(ok).toBe(true);
    expect(t2.bitrix.calls).toHaveLength(0);
    await c2.close();
    t2.app.close();
  });
});

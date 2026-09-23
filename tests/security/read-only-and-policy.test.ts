/**
 * T10: запись в read-only напрямую через tools/call не доходит до handler и до Bitrix,
 * даже если инструмент скрыт из tools/list. Инструмент записи здесь тестовый — MVP-записи
 * появятся на этапах 7–9 и пройдут через тот же диспетчер.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { dispatch } from '../../src/mcp/register-tools.js';
import { ok } from '../../src/mcp/result.js';
import {
  CREATE_ANNOTATIONS,
  DESTRUCTIVE_ANNOTATIONS,
  defineTool,
  type ToolDefinition,
} from '../../src/tools/types.js';
import { connectInMemory, createTestApp } from '../helpers/app.js';
import { legacyOk } from '../helpers/mock-bitrix.js';

let handlerCalls = 0;
const fakeCreate: ToolDefinition = defineTool({
  name: 'test_fake_create',
  module: 'crm',
  title: 'тестовая запись',
  description: 'только для тестов',
  operation: 'create',
  annotations: CREATE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z.object({ title: z.string() }).strict(),
  outputDataSchema: z.object({ id: z.number() }),
  handler: async (_args, ctx) => {
    handlerCalls += 1;
    await ctx.bitrix.call('legacy', 'crm.deal.add', { fields: { TITLE: 'x' } }, { requestId: ctx.requestId });
    return ok({ id: 1 }, { requestId: ctx.requestId, durationMs: 0 });
  },
});
const fakeDelete: ToolDefinition = defineTool({
  ...fakeCreate,
  name: 'test_fake_delete',
  operation: 'delete',
  annotations: DESTRUCTIVE_ANNOTATIONS,
});

describe('политика вызова (T10, роли, модули)', () => {
  it('READ_ONLY_MODE: инструмент записи скрыт и прямой вызов даёт READ_ONLY_MODE, handler не вызван', async () => {
    const t = createTestApp({}, [fakeCreate]);
    t.bitrix.on('crm.deal.add', legacyOk(1));
    const env = await dispatch(fakeCreate, { title: 'x' }, t.app);
    expect(env.success).toBe(false);
    if (!env.success) expect(env.error.code).toBe('READ_ONLY_MODE');
    expect(handlerCalls).toBe(0);
    expect(t.bitrix.calls).toHaveLength(0);

    const c = await connectInMemory(t.app);
    const names = (await c.client.listTools()).tools.map((x) => x.name);
    expect(names).not.toContain('test_fake_create');
    const r = await c.client
      .callTool({ name: 'test_fake_create', arguments: { title: 'x' } })
      .catch((e: unknown) => e);
    expect(r instanceof Error || (r as { isError?: boolean }).isError === true).toBe(true);
    expect(handlerCalls).toBe(0);
    expect(t.bitrix.calls).toHaveLength(0);
    await c.close();
    t.app.close();
  });

  it('с выключенным read-only запись доходит до handler (полный контур подтверждений — этап 6)', async () => {
    const t = createTestApp({ READ_ONLY_MODE: 'false' }, [fakeCreate]);
    t.bitrix.on('crm.deal.add', legacyOk(1));
    const env = await dispatch(fakeCreate, { title: 'x' }, t.app);
    expect(env.success).toBe(true);
    expect(handlerCalls).toBe(1);
    handlerCalls = 0;
    t.app.close();
  });

  it('удаления требуют ENABLE_DESTRUCTIVE_TOOLS и роль administrator', async () => {
    const t = createTestApp({ READ_ONLY_MODE: 'false' }, [fakeDelete]);
    const env = await dispatch(fakeDelete, { title: 'x' }, t.app);
    expect(env.success).toBe(false);
    if (!env.success) expect(env.error.code).toBe('METHOD_NOT_ALLOWED');
    expect(handlerCalls).toBe(0);
    t.app.close();
  });

  it('модуль вне ENABLED_MODULES: инструмент не регистрируется, прямой dispatch → FEATURE_UNAVAILABLE', async () => {
    const t = createTestApp({ ENABLED_MODULES: 'system', READ_ONLY_MODE: 'false' }, [fakeCreate]);
    const env = await dispatch(fakeCreate, { title: 'x' }, t.app);
    expect(env.success).toBe(false);
    if (!env.success) expect(env.error.code).toBe('FEATURE_UNAVAILABLE');
    expect(handlerCalls).toBe(0);
    t.app.close();
  });

  it('аудит фиксирует каждый вызов с исходом denied/success', async () => {
    const t = createTestApp({}, [fakeCreate]);
    await dispatch(fakeCreate, { title: 'x' }, t.app);
    const rows = t.app.db.all<{ tool: string; outcome: string; error_code: string | null }>(
      'SELECT tool, outcome, error_code FROM audit',
    );
    expect(rows).toEqual([{ tool: 'test_fake_create', outcome: 'denied', error_code: 'READ_ONLY_MODE' }]);
    t.app.close();
  });
});

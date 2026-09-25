/** MVP задачи (ТЗ §10.1, §9.8, §15.3): task_list, task_get, task_create через MCP-клиент и мок Bitrix. */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { connectInMemory, createTestApp, structured, type TestApp } from '../helpers/app.js';
import { legacyError, legacyOk, TASK_FIELDS, taskRecord, tasks } from '../helpers/mock-bitrix.js';

interface Env {
  success: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; details: Record<string, unknown> };
  meta: Record<string, unknown> & { warnings?: string[] };
}

let t: TestApp;
let client: Client;
let close: () => Promise<void>;
const call = async (name: string, args: Record<string, unknown>) =>
  structured<Env>(await client.callTool({ name, arguments: args }));

const ALL = tasks(1, 50);
const FUTURE = '2030-10-01T18:00:00+03:00';

/** Созданные в тесте задачи: портал «помнит» их для последующего tasks.task.get. */
let created: Map<number, Record<string, unknown>>;

function setup(overrides: Record<string, string> = {}) {
  t = createTestApp(overrides);
  created = new Map();
  t.bitrix
    .on('tasks.task.getfields', legacyOk(TASK_FIELDS))
    .on('tasks.task.list', (c) => {
      const start = Number(c.body['start'] ?? 0);
      const page = ALL.slice(start, start + 50);
      return legacyOk(
        { tasks: page },
        { total: ALL.length, ...(start + 50 < ALL.length ? { next: start + 50 } : {}) },
      );
    })
    .on('tasks.task.get', (c) => {
      const id = Number(c.body['taskId']);
      const fromCreated = created.get(id);
      if (fromCreated) return legacyOk({ task: fromCreated });
      return id >= 1 && id <= 50
        ? legacyOk({ task: ALL[id - 1] })
        : legacyError('ERROR_NOT_FOUND', 400, 'Task not found');
    })
    .on('tasks.task.add', (c) => {
      const f = c.body['fields'] as Record<string, unknown>;
      const task = taskRecord(555, {
        title: String(f['TITLE']),
        responsibleId: String(f['RESPONSIBLE_ID']),
        deadline: f['DEADLINE'] ?? null,
      });
      created.set(555, task);
      return legacyOk({ task });
    });
}

async function connect() {
  const c = await connectInMemory(t.app);
  client = c.client;
  close = () => c.close();
}

beforeEach(async () => {
  setup();
  await connect();
});
afterEach(async () => {
  await close();
  t.app.close();
});

describe('task_list', () => {
  it('фильтр по ответственному и статусу → UPPER_CASE в запросе, camelCase + statusName в ответе, страницы по cursor', async () => {
    const p1 = await call('task_list', { responsibleId: 7, status: 'pending', pageSize: 20 });
    expect(p1.success).toBe(true);
    expect(p1.data?.['returnedCount']).toBe(20);
    expect(p1.data?.['upstreamTotal']).toBe(50);
    expect((p1.data?.['items'] as Record<string, unknown>[])[0]).toMatchObject({
      id: '1',
      statusName: 'pending',
    });
    const sent = t.bitrix.callsTo('tasks.task.list')[0]?.body;
    expect(sent).toMatchObject({ filter: { RESPONSIBLE_ID: 7, STATUS: 2 }, order: { ID: 'desc' }, start: 0 });
    expect(sent?.['select']).toContain('DEADLINE');
    const p2 = await call('task_list', {
      responsibleId: 7,
      status: 'pending',
      pageSize: 20,
      cursor: (p1.meta['page'] as { nextCursor: string }).nextCursor,
    });
    const p3 = await call('task_list', {
      responsibleId: 7,
      status: 'pending',
      pageSize: 20,
      cursor: (p2.meta['page'] as { nextCursor: string }).nextCursor,
    });
    expect(p3.data?.['returnedCount']).toBe(10);
    expect((p3.meta['page'] as { hasMore: boolean }).hasMore).toBe(false);
    expect(t.bitrix.callsTo('tasks.task.list')).toHaveLength(1);
  });

  it('неизвестный статус, поле в camelCase и инъекция — отказ до портала', async () => {
    for (const args of [
      { status: 'done' },
      { filter: { responsibleId: 7 } },
      { filter: { 'TITLE; DROP': 'x' } },
      { order: { NOPE: 'asc' } },
    ]) {
      const r = await client.callTool({ name: 'task_list', arguments: args });
      expect(r.isError, JSON.stringify(args)).toBe(true);
    }
    expect(t.bitrix.callsTo('tasks.task.list')).toHaveLength(0);
  });
});

describe('task_get', () => {
  it('задача по ID с кратким описанием; отсутствующая → NOT_FOUND', async () => {
    const env = await call('task_get', { taskId: 3 });
    expect(env.success).toBe(true);
    expect(env.data?.['brief']).toMatchObject({
      id: 3,
      title: '[MCP TEST] Задача 3',
      statusName: 'pending',
      responsibleId: '7',
    });
    expect(env.data?.['task']).toMatchObject({ id: '3' });
    const missing = await call('task_get', { taskId: 999 });
    expect(missing.error?.code).toBe('NOT_FOUND');
    const badSelect = await client.callTool({
      name: 'task_get',
      arguments: { taskId: 3, select: ['title'] },
    });
    expect(badSelect.isError).toBe(true);
  });
});

describe('task_create', () => {
  it('скрыт в read-only; прямой вызов не создаёт задачу', async () => {
    expect((await client.listTools()).tools.map((x) => x.name)).not.toContain('task_create');
    const r = await client
      .callTool({
        name: 'task_create',
        arguments: { title: 'x', responsibleId: 7, idempotencyKey: randomUUID() },
      })
      .catch((e: unknown) => e);
    expect(r instanceof Error || (r as { isError?: boolean }).isError === true).toBe(true);
    expect(t.bitrix.callsTo('tasks.task.add')).toHaveLength(0);
  });

  describe('с включённой записью', () => {
    beforeEach(async () => {
      await close();
      t.app.close();
      setup({ READ_ONLY_MODE: 'false' });
      await connect();
    });

    it('срок без зоны, срок в прошлом, ответственный-строка, плохая привязка CRM — VALIDATION_ERROR до плана', async () => {
      const cases: Record<string, unknown>[] = [
        { title: 'x', responsibleId: 7, deadline: '2030-10-01T18:00:00', idempotencyKey: randomUUID() },
        { title: 'x', responsibleId: 7, deadline: '2020-01-01T10:00:00+03:00', idempotencyKey: randomUUID() },
        { title: 'x', responsibleId: 'Иван', idempotencyKey: randomUUID() },
        { title: 'x', responsibleId: 7, crmBindings: ['deal_5'], idempotencyKey: randomUUID() },
        { title: 'x', responsibleId: 7, customFields: { UF_NOPE: 1 }, idempotencyKey: randomUUID() },
        { title: 'x', responsibleId: 7 },
      ];
      for (const args of cases) {
        const r = await client.callTool({ name: 'task_create', arguments: args });
        expect(r.isError, JSON.stringify(args)).toBe(true);
      }
      expect(await t.app.operations.countByStatus()).toEqual({});
      const noZone = await call('task_create', cases[0] ?? {});
      expect(noZone.error?.details['reason']).toBe('TIMEZONE_REQUIRED');
    });

    it('dryRun: план с полями UPPER_CASE, зоной и рисками; ledger пуст', async () => {
      const env = await call('task_create', {
        title: '[MCP TEST] план',
        responsibleId: 7,
        deadline: FUTURE,
        auditorIds: [8],
        crmBindings: ['D_5'],
        dryRun: true,
      });
      expect(env.success).toBe(true);
      expect(env.data?.['plan']).toMatchObject({
        target: 'task',
        details: {
          method: 'tasks.task.add',
          timezone: 'Europe/Moscow',
          fields: {
            TITLE: '[MCP TEST] план',
            RESPONSIBLE_ID: 7,
            DEADLINE: FUTURE,
            AUDITORS: [8],
            UF_CRM_TASK: ['D_5'],
          },
        },
      });
      expect((env.data?.['plan'] as { risks: string[] }).risks.join(' ')).toContain('уведомления');
      expect(await t.app.operations.countByStatus()).toEqual({});
    });

    it('полный путь: APPROVAL_REQUIRED → подтверждение → одна задача → сверка ответственного и срока → replay', async () => {
      const key = randomUUID();
      const args = {
        title: '[MCP TEST] Задача из MCP',
        responsibleId: 7,
        deadline: FUTURE,
        description: 'подробности',
        idempotencyKey: key,
      };
      const prep = await call('task_create', args);
      expect(prep.error?.code).toBe('APPROVAL_REQUIRED');
      const operationId = prep.error?.details['operationId'] as string;
      expect(t.bitrix.callsTo('tasks.task.add')).toHaveLength(0);

      await t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
      const done = await call('task_create', { ...args, approvalId: operationId });
      expect(done.success).toBe(true);
      expect(done.data).toMatchObject({
        id: 555,
        operationId,
        verified: true,
        replayed: false,
        task: { id: 555, title: '[MCP TEST] Задача из MCP', responsibleId: '7' },
      });
      expect(t.bitrix.callsTo('tasks.task.add')).toHaveLength(1);
      expect(t.bitrix.callsTo('tasks.task.add')[0]?.body).toEqual({
        fields: {
          TITLE: '[MCP TEST] Задача из MCP',
          RESPONSIBLE_ID: 7,
          DESCRIPTION: 'подробности',
          DEADLINE: FUTURE,
        },
      });
      // верификация читала задачу по ID с select
      const verifyCall = t.bitrix.callsTo('tasks.task.get').find((c) => Number(c.body['taskId']) === 555);
      expect(verifyCall?.body['select']).toContain('RESPONSIBLE_ID');

      const again = await call('task_create', { ...args, approvalId: operationId });
      expect(again.data).toMatchObject({ id: 555, replayed: true });
      expect(t.bitrix.callsTo('tasks.task.add')).toHaveLength(1);
    });

    it('портал подменил ответственного → success, verified=false, warning', async () => {
      t.bitrix.on('tasks.task.add', (c) => {
        const task = taskRecord(556, {
          title: String((c.body['fields'] as Record<string, unknown>)['TITLE']),
          responsibleId: '9',
          deadline: null,
        });
        created.set(556, task);
        return legacyOk({ task });
      });
      const key = randomUUID();
      const args = { title: 'x', responsibleId: 7, idempotencyKey: key };
      const prep = await call('task_create', args);
      const operationId = prep.error?.details['operationId'] as string;
      await t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
      const done = await call('task_create', { ...args, approvalId: operationId });
      expect(done.success).toBe(true);
      expect(done.data?.['verified']).toBe(false);
      expect((done.meta.warnings ?? []).join(' ')).toContain('Ответственный');
      expect(done.meta['completeness']).toBe('unknown');
    });

    it('ответ без task.id → OPERATION_OUTCOME_UNKNOWN без повтора', async () => {
      t.bitrix.on('tasks.task.add', legacyOk({ task: {} }));
      const key = randomUUID();
      const args = { title: 'x', responsibleId: 7, idempotencyKey: key };
      const prep = await call('task_create', args);
      const operationId = prep.error?.details['operationId'] as string;
      await t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
      const done = await call('task_create', { ...args, approvalId: operationId });
      expect(done.error?.code).toBe('OPERATION_OUTCOME_UNKNOWN');
      const retry = await call('task_create', { ...args, approvalId: operationId });
      expect(retry.error?.code).toBe('OPERATION_OUTCOME_UNKNOWN');
      expect(t.bitrix.callsTo('tasks.task.add')).toHaveLength(1);
    });
  });
});

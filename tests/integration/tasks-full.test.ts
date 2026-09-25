/**
 * Этап 13/14 (ТЗ §9.8, §11 п.3 и п.8): задачи полной версии на mock —
 * task_update (CONFLICT, diff, verify), task_complete (T30: результат/контроль, фактический статус),
 * task_delete (скрыт/не-админ/impact/verify NOT_FOUND), чек-листы (позиционные параметры, иерархия),
 * обсуждение обеих карточек (T29: chatId → im / v3 send, без дублирования в старый комментарий).
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { findMethod } from '../../src/bitrix/method-registry.js';
import { dispatch } from '../../src/mcp/register-tools.js';
import { taskChecklistDeleteTool } from '../../src/tools/tasks/task-checklist.js';
import { taskDeleteTool } from '../../src/tools/tasks/task-delete.js';
import { connectInMemory, createTestApp, structured, type TestApp } from '../helpers/app.js';
import { legacyOk } from '../helpers/mock-bitrix.js';
import { TasksPortal } from '../helpers/mock-tasks.js';

interface Env {
  success: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; details: Record<string, unknown> };
  meta: Record<string, unknown> & { warnings?: string[] };
}

let t: TestApp;
let portal: TasksPortal;
let client: Client;
let close: (() => Promise<void>) | undefined;
const call = async (name: string, args: Record<string, unknown>) =>
  structured<Env>(await client.callTool({ name, arguments: args }));

async function start(overrides: Record<string, string> = {}) {
  t = createTestApp({ READ_ONLY_MODE: 'false', BITRIX_REQUESTS_PER_SECOND: '10', ...overrides });
  portal = new TasksPortal();
  portal.install(t.bitrix);
  const c = await connectInMemory(t.app);
  client = c.client;
  close = () => c.close();
}

afterEach(async () => {
  await close?.();
  close = undefined;
  t.app.close();
});

/** Подготовить план, подтвердить от имени человека и выполнить тот же вызов с approvalId. */
async function approveAndRun(name: string, args: Record<string, unknown>) {
  const prep = await call(name, args);
  expect(prep.error?.code).toBe('APPROVAL_REQUIRED');
  const operationId = prep.error?.details['operationId'] as string;
  t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
  const done = await call(name, { ...args, approvalId: operationId });
  return { prep, done, operationId };
}

const bodyKeys = (method: string, i = 0) => Object.keys(t.bitrix.callsTo(method)[i]?.body ?? {});

describe('реестр методов задач', () => {
  it('T03: legacy и REST 3.0 tasks.task.get — разные записи (scope task / tasks), запросы по разным URL', async () => {
    expect(findMethod('legacy', 'tasks.task.get')?.scope).toBe('task');
    expect(findMethod('v3', 'tasks.task.get')?.scope).toBe('tasks');
    expect(findMethod('v3', 'tasks.task.get')?.source).toContain('tasks-task-get-rest-v3.html');
    await start();
    await call('task_complete', { taskId: 200, dryRun: true });
    const urls = t.bitrix.callsTo('tasks.task.get').map((c) => c.url);
    expect(urls.some((u) => u.includes('/rest/api/') && !u.endsWith('.json'))).toBe(true);
    expect(urls.some((u) => !u.includes('/rest/api/') && u.endsWith('tasks.task.get.json'))).toBe(true);
  });
});

describe('task_update', () => {
  it('полный путь: diff «было → станет», одна запись tasks.task.update, сверка полей, replay без второй записи; stateHash как у task_get', async () => {
    await start();
    const got = await call('task_get', { taskId: 100 });
    const stateHash = got.data?.['stateHash'] as string;
    expect(stateHash).toMatch(/^[a-f0-9]{64}$/);
    const dry = await call('task_update', {
      taskId: 100,
      patch: { DEADLINE: '2030-11-01T18:00:00+03:00', RESPONSIBLE_ID: 12 },
      dryRun: true,
    });
    expect(dry.data?.['stateHash']).toBe(stateHash);
    const plan = dry.data?.['plan'] as { details: Record<string, unknown>; risks: string[] };
    expect(plan.details['changes']).toEqual({
      DEADLINE: { from: '2026-10-01T18:00:00+03:00', to: '2030-11-01T18:00:00+03:00' },
      RESPONSIBLE_ID: { from: '7', to: 12 },
    });
    expect(plan.risks.join(' ')).toContain('Смена ответственного');

    const args = {
      taskId: 100,
      patch: { DEADLINE: '2030-11-01T18:00:00+03:00', RESPONSIBLE_ID: 12 },
      expectedStateHash: stateHash,
      idempotencyKey: randomUUID(),
    };
    const { done } = await approveAndRun('task_update', args);
    expect(done.data).toMatchObject({
      taskId: 100,
      verified: true,
      replayed: false,
      changedFields: ['DEADLINE', 'RESPONSIBLE_ID'],
    });
    expect(t.bitrix.callsTo('tasks.task.update')[0]?.body).toEqual({
      taskId: 100,
      fields: { DEADLINE: '2030-11-01T18:00:00+03:00', RESPONSIBLE_ID: 12 },
    });
    expect(done.data?.['stateHash']).not.toBe(stateHash);
    const again = await call('task_update', { ...args, approvalId: done.data?.['operationId'] });
    expect(again.data?.['replayed']).toBe(true);
    expect(t.bitrix.callsTo('tasks.task.update')).toHaveLength(1);
  });

  it('проверки до плана: неизвестное поле, серверное поле, STATUS, срок без зоны, «нечего менять» — без операций и записи', async () => {
    await start();
    const cases: [Record<string, unknown>, string][] = [
      [{ NOT_A_FIELD: 'x' }, 'UNKNOWN_FIELD'],
      [{ CREATED_DATE: '2030-01-01T00:00:00Z' }, 'READ_ONLY_FIELD'],
      [{ STATUS: 5 }, 'USE_DEDICATED_TOOL'],
      [{ DEADLINE: '2030-11-01T18:00:00' }, 'TIMEZONE_REQUIRED'],
      [{ TITLE: '' }, 'REQUIRED_FIELD_MISSING'],
      [{ TITLE: '[MCP TEST] Задача 100' }, 'NO_CHANGES'],
    ];
    for (const [patch, reason] of cases) {
      const env = await call('task_update', { taskId: 100, patch, idempotencyKey: randomUUID() });
      expect(env.error?.code, reason).toBe('VALIDATION_ERROR');
      expect(env.error?.details['reason']).toBe(reason);
    }
    expect(t.app.operations.countByStatus()).toEqual({});
    expect(t.bitrix.callsTo('tasks.task.update')).toHaveLength(0);
  });

  it('T15: CONFLICT до плана по устаревшему expectedStateHash и в precheck после подтверждения — записи нет', async () => {
    await start();
    const hash = (await call('task_get', { taskId: 100 })).data?.['stateHash'] as string;
    portal.touch(100); // задачу изменили в портале
    const stale = await call('task_update', {
      taskId: 100,
      patch: { TITLE: 'Новое' },
      expectedStateHash: hash,
      idempotencyKey: randomUUID(),
    });
    expect(stale.error?.code).toBe('CONFLICT');
    expect(t.app.operations.countByStatus()).toEqual({});

    const fresh = (await call('task_get', { taskId: 100 })).data?.['stateHash'] as string;
    const args = {
      taskId: 100,
      patch: { TITLE: 'Новое' },
      expectedStateHash: fresh,
      idempotencyKey: randomUUID(),
    };
    const prep = await call('task_update', args);
    const operationId = prep.error?.details['operationId'] as string;
    t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
    portal.touch(100); // изменение между подтверждением и записью
    const raced = await call('task_update', { ...args, approvalId: operationId });
    expect(raced.error?.code).toBe('CONFLICT');
    expect(t.bitrix.callsTo('tasks.task.update')).toHaveLength(0);
    expect((await call('operation_status', { operationId })).data?.['status']).toBe('failed');
  });

  it('ответ без result.task → OPERATION_OUTCOME_UNKNOWN, повтор не пишет второй раз', async () => {
    await start();
    t.bitrix.on('tasks.task.update', legacyOk(true));
    const args = { taskId: 100, patch: { TITLE: 'Иначе' }, idempotencyKey: randomUUID() };
    const { done, operationId } = await approveAndRun('task_update', args);
    expect(done.error?.code).toBe('OPERATION_OUTCOME_UNKNOWN');
    const retry = await call('task_update', { ...args, approvalId: operationId });
    expect(retry.error?.code).toBe('OPERATION_OUTCOME_UNKNOWN');
    expect(t.bitrix.callsTo('tasks.task.update')).toHaveLength(1);
  });

  it('action.edit=false → отказ до плана', async () => {
    await start();
    portal.addTask(300, { action: { edit: false, complete: false, remove: false } });
    const env = await call('task_update', {
      taskId: 300,
      patch: { TITLE: 'x' },
      idempotencyKey: randomUUID(),
    });
    expect(env.error?.code).toBe('BITRIX_ACCESS_DENIED');
    expect(env.error?.details['reason']).toBe('ACTION_NOT_ALLOWED');
  });
});

describe('task_complete (T30)', () => {
  it('требуется результат, а его нет → RESULT_REQUIRED до плана: ни операции, ни tasks.task.complete', async () => {
    await start();
    portal.flags.set(200, { requireResult: true, containsResults: false, needsControl: false });
    const env = await call('task_complete', { taskId: 200, idempotencyKey: randomUUID() });
    expect(env.success).toBe(false);
    expect(env.error?.code).toBe('VALIDATION_ERROR');
    expect(env.error?.details['reason']).toBe('RESULT_REQUIRED');
    expect(t.app.operations.countByStatus()).toEqual({});
    expect(t.bitrix.callsTo('tasks.task.complete')).toHaveLength(0);
    // v3-запрос по документации: id + select нужных признаков
    const v3 = t.bitrix.callsTo('tasks.task.get').find((c) => c.url.includes('/rest/api/'));
    expect(v3?.body).toMatchObject({
      id: 200,
      select: expect.arrayContaining(['requireResult', 'containsResults']) as unknown,
    });
  });

  it('требование результата появилось после подтверждения → RESULT_REQUIRED в precheck, записи нет', async () => {
    await start();
    const args = { taskId: 200, idempotencyKey: randomUUID() };
    const prep = await call('task_complete', args);
    const operationId = prep.error?.details['operationId'] as string;
    t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
    portal.flags.set(200, { requireResult: true, containsResults: false, needsControl: false });
    const done = await call('task_complete', { ...args, approvalId: operationId });
    expect(done.error?.details['reason']).toBe('RESULT_REQUIRED');
    expect(t.bitrix.callsTo('tasks.task.complete')).toHaveLength(0);
  });

  it('контроль постановщика: фактический статус «Ждёт контроля», completed=false, нет ложного «завершена»', async () => {
    await start();
    portal.addTask(300, { taskControl: 'Y' });
    const args = { taskId: 300, idempotencyKey: randomUUID() };
    const { prep, done } = await approveAndRun('task_complete', args);
    const plan = prep.error?.details['plan'] as { risks: string[]; details: Record<string, unknown> };
    expect(plan.details['taskControl']).toBe(true);
    expect(plan.risks.join(' ')).toContain('«Ждёт контроля»');
    expect(done.success).toBe(true);
    expect(done.data).toMatchObject({
      status: '4',
      statusName: 'awaitingControl',
      completed: false,
      awaitingControl: true,
    });
    expect(done.meta.warnings?.join(' ')).toContain('НЕ завершена');
    expect(t.bitrix.callsTo('tasks.task.complete')[0]?.body).toEqual({ taskId: 300 });
  });

  it('обычная задача: status 5, completed=true; replay без второго вызова; повторное завершение → ALREADY_COMPLETED', async () => {
    await start();
    const args = { taskId: 200, idempotencyKey: randomUUID() };
    const { done, operationId } = await approveAndRun('task_complete', args);
    expect(done.data).toMatchObject({ status: '5', completed: true, verified: true, replayed: false });
    const again = await call('task_complete', { ...args, approvalId: operationId });
    expect(again.data).toMatchObject({ replayed: true, completed: true });
    expect(t.bitrix.callsTo('tasks.task.complete')).toHaveLength(1);
    const twice = await call('task_complete', { taskId: 200, idempotencyKey: randomUUID() });
    expect(twice.error?.details['reason']).toBe('ALREADY_COMPLETED');
  });

  it('REST 3.0 недоступен: план честно пишет, что требование результата не проверено (validationLevel=local)', async () => {
    await start();
    portal.v3Available = false;
    const dry = await call('task_complete', { taskId: 100, dryRun: true });
    expect(dry.data?.['validationLevel']).toBe('local');
    expect((dry.data?.['plan'] as { risks: string[] }).risks.join(' ')).toContain(
      'Требование результата не проверено',
    );
  });
});

describe('task_delete (этап 14)', () => {
  it('скрыт без ENABLE_DESTRUCTIVE_TOOLS (tools/list и прямой вызов); с флагом — отказ не-админу до handler', async () => {
    await start();
    const names = (await client.listTools()).tools.map((x) => x.name);
    expect(names).not.toContain('task_delete');
    expect(names).not.toContain('task_checklist_delete');
    expect(names).toContain('task_update');
    await expect(client.callTool({ name: 'task_delete', arguments: { taskId: 100 } })).rejects.toThrow(
      /disabled/,
    );
    const env = await dispatch(taskDeleteTool, { taskId: 100, idempotencyKey: randomUUID() }, t.app);
    expect(env.success).toBe(false);
    if (!env.success) expect(env.error.code).toBe('METHOD_NOT_ALLOWED');
    expect(t.bitrix.calls).toHaveLength(0);
    await close?.();
    t.app.close();

    await start({ ENABLE_DESTRUCTIVE_TOOLS: 'true' });
    expect((await client.listTools()).tools.map((x) => x.name)).toContain('task_delete');
    const denied = await dispatch(
      taskDeleteTool,
      { taskId: 100, idempotencyKey: randomUUID() },
      t.app,
      undefined,
      {
        id: 'op',
        role: 'operator',
        source: 'local',
      },
    );
    expect(denied.success).toBe(false);
    if (!denied.success) expect(denied.error.code).toBe('ACCESS_DENIED');
    expect(t.bitrix.calls).toHaveLength(0);
  });

  it('админ: NOT_FOUND без плана; план с impact; удаление один раз; verify NOT_FOUND; replay после удаления', async () => {
    await start({ ENABLE_DESTRUCTIVE_TOOLS: 'true' });
    const missing = await call('task_delete', { taskId: 999, idempotencyKey: randomUUID() });
    expect(missing.error?.code).toBe('NOT_FOUND');
    expect(t.app.operations.countByStatus()).toEqual({});

    portal.addTask(101, { parentId: '100' });
    portal.addTask(102, { parentId: '100' });
    const hash = (await call('task_get', { taskId: 100 })).data?.['stateHash'] as string;
    const args = { taskId: 100, expectedStateHash: hash, idempotencyKey: randomUUID() };
    const { prep, done, operationId } = await approveAndRun('task_delete', args);
    const plan = prep.error?.details['plan'] as { details: Record<string, unknown>; risks: string[] };
    expect(plan.details['task']).toMatchObject({
      id: 100,
      title: '[MCP TEST] Задача 100',
      responsibleId: '7',
    });
    expect(plan.details['impact']).toMatchObject({
      subtasksCount: 2,
      checklistItemsCount: 5,
      commentsCount: 2,
    });
    expect(plan.risks.join(' ')).toContain('подзадач');
    expect(done.data).toMatchObject({ taskId: 100, deleted: true, verified: true, replayed: false });
    expect(t.bitrix.callsTo('tasks.task.delete')[0]?.body).toEqual({ taskId: 100 });
    const again = await call('task_delete', { ...args, approvalId: operationId });
    expect(again.data).toMatchObject({ replayed: true, deleted: true });
    expect(t.bitrix.callsTo('tasks.task.delete')).toHaveLength(1);
  });

  it('CONFLICT: задача изменилась после подтверждения — удаления нет', async () => {
    await start({ ENABLE_DESTRUCTIVE_TOOLS: 'true' });
    const hash = (await call('task_get', { taskId: 100 })).data?.['stateHash'] as string;
    const args = { taskId: 100, expectedStateHash: hash, idempotencyKey: randomUUID() };
    const prep = await call('task_delete', args);
    const operationId = prep.error?.details['operationId'] as string;
    t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
    portal.touch(100);
    const raced = await call('task_delete', { ...args, approvalId: operationId });
    expect(raced.error?.code).toBe('CONFLICT');
    expect(t.bitrix.callsTo('tasks.task.delete')).toHaveLength(0);
  });
});

describe('чек-листы (позиционные параметры старого API)', () => {
  it('task_checklist_get: тело {TASKID, ORDER} в этом порядке; дерево по PARENT_ID/SORT_INDEX с depth и IS_COMPLETE; курсор без пропусков', async () => {
    await start();
    const p1 = await call('task_checklist_get', { taskId: 100, pageSize: 3 });
    expect(p1.success).toBe(true);
    expect(bodyKeys('task.checklistitem.getlist')).toEqual(['TASKID', 'ORDER']);
    expect(p1.data?.['summary']).toEqual({ total: 5, completed: 1, checklists: 2 });
    const items1 = p1.data?.['items'] as Record<string, unknown>[];
    expect(items1.map((i) => [i['id'], i['depth'], i['isComplete']])).toEqual([
      [431, 0, false],
      [433, 1, true],
      [447, 1, false],
    ]);
    expect(items1[0]?.['members']).toEqual([{ id: '12', type: 'A' }]);
    expect(JSON.stringify(items1)).not.toContain('IMAGE');
    const cursor = (p1.meta['page'] as { nextCursor: string }).nextCursor;
    const p2 = await call('task_checklist_get', { taskId: 100, pageSize: 3, cursor });
    const items2 = p2.data?.['items'] as Record<string, unknown>[];
    expect(items2.map((i) => [i['id'], i['depth']])).toEqual([
      [469, 2],
      [600, 0],
    ]);
    expect((p2.meta['page'] as { hasMore: boolean }).hasMore).toBe(false);
  });

  it('task_checklist_add: тело {TASKID, FIELDS}; несуществующий parentId → PARENT_NOT_FOUND до плана; полный путь и сверка', async () => {
    await start();
    const bad = await call('task_checklist_add', {
      taskId: 100,
      title: 'x',
      parentId: 12345,
      idempotencyKey: randomUUID(),
    });
    expect(bad.error?.details['reason']).toBe('PARENT_NOT_FOUND');
    const foreign = await call('task_checklist_add', {
      taskId: 100,
      title: 'x',
      parentId: 900,
      idempotencyKey: randomUUID(),
    });
    expect(foreign.error?.details['reason']).toBe('PARENT_NOT_FOUND');
    expect(t.app.operations.countByStatus()).toEqual({});

    const args = { taskId: 100, title: 'Подписать договор', parentId: 431, idempotencyKey: randomUUID() };
    const { done } = await approveAndRun('task_checklist_add', args);
    expect(done.data).toMatchObject({ itemId: 1000, verified: true });
    expect(bodyKeys('task.checklistitem.add')).toEqual(['TASKID', 'FIELDS']);
    expect(t.bitrix.callsTo('task.checklistitem.add')[0]?.body).toEqual({
      TASKID: 100,
      FIELDS: { TITLE: 'Подписать договор', PARENT_ID: 431 },
    });
  });

  it('ревью: родителя удалили между подтверждением и записью → CONFLICT PARENT_NOT_FOUND в precheck, пункт не создан', async () => {
    await start();
    const args = { taskId: 100, title: 'Подписать договор', parentId: 431, idempotencyKey: randomUUID() };
    const prep = await call('task_checklist_add', args);
    const operationId = prep.error?.details['operationId'] as string;
    t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
    // Обработчик при повторе ещё видит родителя; удаление приходится на окно перед записью (чтение в precheck).
    const reads = t.bitrix.callsTo('task.checklistitem.getlist').length;
    t.bitrix.on('task.checklistitem.getlist', (c) => {
      const [taskId] = Object.values(c.body);
      if (t.bitrix.callsTo('task.checklistitem.getlist').length > reads + 1)
        portal.checklist = portal.checklist.filter((i) => Number(i['ID']) !== 431);
      return legacyOk(portal.checklist.filter((i) => String(i['TASK_ID']) === String(taskId)));
    });
    const done = await call('task_checklist_add', { ...args, approvalId: operationId });
    expect(done.error?.code).toBe('CONFLICT');
    expect(done.error?.details['reason']).toBe('PARENT_NOT_FOUND');
    expect(t.bitrix.callsTo('task.checklistitem.add')).toHaveLength(0);
  });

  it('task_checklist_update: тело {TASKID, ITEMID, FIELDS}; CONFLICT по stateHash пункта; result=null — успех', async () => {
    await start();
    const list = await call('task_checklist_get', { taskId: 100 });
    const item = (list.data?.['items'] as Record<string, unknown>[]).find((i) => i['id'] === 447);
    const hash = item?.['stateHash'] as string;
    const stale = await call('task_checklist_update', {
      taskId: 100,
      itemId: 447,
      title: 'Новый текст',
      expectedStateHash: 'a'.repeat(64),
      idempotencyKey: randomUUID(),
    });
    expect(stale.error?.code).toBe('CONFLICT');
    const args = {
      taskId: 100,
      itemId: 447,
      title: 'Новый текст',
      sortIndex: 5,
      expectedStateHash: hash,
      idempotencyKey: randomUUID(),
    };
    const { prep, done } = await approveAndRun('task_checklist_update', args);
    expect((prep.error?.details['plan'] as { details: Record<string, unknown> }).details['changes']).toEqual({
      TITLE: { from: 'Согласовать детали', to: 'Новый текст' },
      SORT_INDEX: { from: 1, to: 5 },
    });
    expect(done.data).toMatchObject({ itemId: 447, verified: true });
    expect(bodyKeys('task.checklistitem.update')).toEqual(['TASKID', 'ITEMID', 'FIELDS']);
  });

  it('task_checklist_set_complete: complete/renew с телом {TASKID, ITEMID}; уже выполнен → без записи; пункт чужой задачи → NOT_FOUND', async () => {
    await start();
    const same = await call('task_checklist_set_complete', {
      taskId: 100,
      itemId: 433,
      completed: true,
      idempotencyKey: randomUUID(),
    });
    expect(same.data).toMatchObject({ changed: false, isComplete: true });
    // Портал не проверяет принадлежность пункта задаче — проверяет сервер до плана.
    const foreign = await call('task_checklist_set_complete', {
      taskId: 100,
      itemId: 900,
      completed: true,
      idempotencyKey: randomUUID(),
    });
    expect(foreign.error?.code).toBe('NOT_FOUND');
    expect(t.app.operations.countByStatus()).toEqual({});

    const { done } = await approveAndRun('task_checklist_set_complete', {
      taskId: 100,
      itemId: 469,
      completed: true,
      idempotencyKey: randomUUID(),
    });
    expect(done.data).toMatchObject({ itemId: 469, isComplete: true, changed: true, verified: true });
    expect(t.bitrix.callsTo('task.checklistitem.complete')[0]?.body).toEqual({ TASKID: 100, ITEMID: 469 });
    expect(bodyKeys('task.checklistitem.complete')).toEqual(['TASKID', 'ITEMID']);
    const { done: renewed } = await approveAndRun('task_checklist_set_complete', {
      taskId: 100,
      itemId: 433,
      completed: false,
      idempotencyKey: randomUUID(),
    });
    expect(renewed.data).toMatchObject({ isComplete: false, verified: true });
    expect(t.bitrix.callsTo('task.checklistitem.renew')).toHaveLength(1);
  });

  it('complete вернул false (портал не нашёл пункт) → ошибка, а не «выполнено»', async () => {
    await start();
    t.bitrix.on('task.checklistitem.complete', legacyOk(false));
    const { done } = await approveAndRun('task_checklist_set_complete', {
      taskId: 100,
      itemId: 469,
      completed: true,
      idempotencyKey: randomUUID(),
    });
    expect(done.success).toBe(false);
    expect(done.error?.details['reason']).toBe('RESULT_FALSE');
  });

  it('task_checklist_delete: скрыт без флага; impact — вложенные подпункты; verify по getlist', async () => {
    await start();
    const hidden = await dispatch(
      taskChecklistDeleteTool,
      { taskId: 100, itemId: 447, idempotencyKey: randomUUID() },
      t.app,
    );
    expect(hidden.success).toBe(false);
    if (!hidden.success) expect(hidden.error.code).toBe('METHOD_NOT_ALLOWED');
    await close?.();
    t.app.close();
    await start({ ENABLE_DESTRUCTIVE_TOOLS: 'true' });
    const args = { taskId: 100, itemId: 447, idempotencyKey: randomUUID() };
    const { prep, done, operationId } = await approveAndRun('task_checklist_delete', args);
    const plan = prep.error?.details['plan'] as { details: Record<string, unknown>; risks: string[] };
    expect(plan.details['impact']).toMatchObject({ descendantsCount: 1 });
    expect(plan.risks[0]).toContain('подпункты: 1');
    expect(done.data).toMatchObject({ deleted: true, verified: true });
    expect(bodyKeys('task.checklistitem.delete')).toEqual(['TASKID', 'ITEMID']);
    // replay после удаления: пункта уже нет, но исполнитель возвращает сохранённый результат без второй записи
    const again = await call('task_checklist_delete', { ...args, approvalId: operationId });
    expect(again.data).toMatchObject({ replayed: true, deleted: true });
    expect(t.bitrix.callsTo('task.checklistitem.delete')).toHaveLength(1);
  });
});

describe('обсуждение задачи (T29)', () => {
  it('новая карточка: чтение через chatId → im.dialog.messages.get chat58 с LAST_ID-курсором; старый getlist не вызывается', async () => {
    await start();
    const p1 = await call('task_comments_list', { taskId: 200, pageSize: 2 });
    expect(p1.data).toMatchObject({ backend: 'chat', chatId: 58, returnedCount: 2 });
    expect((p1.data?.['items'] as Record<string, unknown>[]).map((m) => m['id'])).toEqual([503, 502]);
    expect((p1.data?.['items'] as Record<string, unknown>[])[1]).toMatchObject({ system: true });
    expect(t.bitrix.callsTo('im.dialog.messages.get')[0]?.body).toEqual({ DIALOG_ID: 'chat58', LIMIT: 2 });
    const cursor = (p1.meta['page'] as { nextCursor: string }).nextCursor;
    const p2 = await call('task_comments_list', { taskId: 200, pageSize: 2, cursor });
    expect((p2.data?.['items'] as Record<string, unknown>[]).map((m) => m['id'])).toEqual([501]);
    expect(t.bitrix.callsTo('im.dialog.messages.get')[1]?.body).toEqual({
      DIALOG_ID: 'chat58',
      LIMIT: 2,
      LAST_ID: 502,
    });
    expect((p2.meta['page'] as { hasMore: boolean }).hasMore).toBe(false);
    expect(t.bitrix.callsTo('task.commentitem.getlist')).toHaveLength(0);
    // отметка о прочтении не вызывается
    expect(t.bitrix.calls.some((c) => /im\.dialog\.read|im\.chat\.read/.test(c.url))).toBe(false);
  });

  it('нет доступа к чату → BITRIX_ACCESS_DENIED с reason CHAT_ACCESS_DENIED', async () => {
    await start();
    portal.chatAccessDenied = true;
    const env = await call('task_comments_list', { taskId: 200 });
    expect(env.error?.code).toBe('BITRIX_ACCESS_DENIED');
    expect(env.error?.details['reason']).toBe('CHAT_ACCESS_DENIED');
  });

  it('новая карточка: отправка через v3 tasks.task.chat.message.send, messageId найден чтением чата, в старый комментарий не дублируется; replay', async () => {
    await start();
    const args = { taskId: 200, text: 'Готово, проверьте', idempotencyKey: randomUUID() };
    const { prep, done, operationId } = await approveAndRun('task_comment_add', args);
    expect((prep.error?.details['plan'] as { details: Record<string, unknown> }).details).toMatchObject({
      backend: 'chat',
      apiVersion: 'v3',
      chatId: 58,
      text: 'Готово, проверьте',
    });
    expect(done.data).toMatchObject({ backend: 'chat', chatId: 58, messageId: 603, verified: true });
    const send = t.bitrix.callsTo('tasks.task.chat.message.send');
    expect(send).toHaveLength(1);
    expect(send[0]?.url).toContain('/rest/api/');
    expect(send[0]?.body).toEqual({ fields: { taskId: 200, text: 'Готово, проверьте' } });
    expect(t.bitrix.callsTo('task.commentitem.add')).toHaveLength(0);
    const again = await call('task_comment_add', { ...args, approvalId: operationId });
    expect(again.data).toMatchObject({ replayed: true, messageId: 603 });
    expect(t.bitrix.callsTo('tasks.task.chat.message.send')).toHaveLength(1);
  });

  it('ревью: такой же текст от другого участника новее нашего — messageId только собственного сообщения', async () => {
    await start();
    t.bitrix.on('im.dialog.messages.get', (c) => {
      const chatId = Number(String(c.body['DIALOG_ID']).replace(/^chat/, ''));
      const list = [...(portal.chats.get(chatId) ?? [])];
      list.push(portal.msg(chatId, 999, 9, 'Готово, проверьте'));
      return legacyOk({ chat_id: chatId, messages: list.sort((a, b) => b.id - a.id), users: [], files: [] });
    });
    const { done } = await approveAndRun('task_comment_add', {
      taskId: 200,
      text: 'Готово, проверьте',
      idempotencyKey: randomUUID(),
    });
    expect(done.data).toMatchObject({ backend: 'chat', messageId: 603 });
  });

  it('новая карточка, v3 отказал при отправке → ошибка без отправки в старый комментарий (нет дубля)', async () => {
    await start();
    const args = { taskId: 200, text: 'Текст', idempotencyKey: randomUUID() };
    const prep = await call('task_comment_add', args);
    const operationId = prep.error?.details['operationId'] as string;
    t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
    t.bitrix.on('tasks.task.chat.message.send', {
      status: 404,
      body: { error: { code: 'METHOD_NOT_FOUND', message: 'Method not found' } },
    });
    const done = await call('task_comment_add', { ...args, approvalId: operationId });
    expect(done.error?.code).toBe('FEATURE_UNAVAILABLE');
    expect(t.bitrix.callsTo('task.commentitem.add')).toHaveLength(0);
  });

  it('новая карточка без REST 3.0: план явно выбирает task.commentitem.add (документированно работает в новой карточке)', async () => {
    await start();
    portal.v3Available = false;
    const dry = await call('task_comment_add', { taskId: 200, text: 'x', dryRun: true });
    expect(dry.data).toMatchObject({ backend: 'comments', chatId: 58 });
    expect((dry.data?.['plan'] as { risks: string[] }).risks.join(' ')).toContain('REST 3.0 недоступен');
  });

  it('старая карточка: чтение task.commentitem.getlist {TASKID, ORDER, FILTER} без e-mail и ссылок; добавление commentitem.add → commentId', async () => {
    await start();
    const list = await call('task_comments_list', { taskId: 100, pageSize: 1 });
    expect(list.data).toMatchObject({ backend: 'comments', chatId: null, returnedCount: 1 });
    expect(bodyKeys('task.commentitem.getlist')).toEqual(['TASKID', 'ORDER', 'FILTER']);
    expect((list.data?.['items'] as Record<string, unknown>[])[0]).toMatchObject({
      id: 3157,
      filesCount: 1,
      authorName: 'Пётр',
    });
    const s = JSON.stringify(list.data);
    expect(s).not.toContain('example.com');
    expect(s).not.toContain('uf.php');
    const cursor = (list.meta['page'] as { nextCursor: string }).nextCursor;
    const p2 = await call('task_comments_list', { taskId: 100, pageSize: 1, cursor });
    expect((p2.data?.['items'] as Record<string, unknown>[])[0]?.['id']).toBe(3155);
    expect(t.bitrix.callsTo('task.commentitem.getlist')[1]?.body['FILTER']).toEqual({ '<ID': 3157 });

    const { done } = await approveAndRun('task_comment_add', {
      taskId: 100,
      text: 'Комментарий',
      idempotencyKey: randomUUID(),
    });
    expect(done.data).toMatchObject({ backend: 'comments', commentId: 1000, verified: true });
    expect(t.bitrix.callsTo('task.commentitem.add')[0]?.body).toEqual({
      TASKID: 100,
      FIELDS: { POST_MESSAGE: 'Комментарий' },
    });
    expect(bodyKeys('task.commentitem.add')).toEqual(['TASKID', 'FIELDS']);
    expect(t.bitrix.callsTo('tasks.task.chat.message.send')).toHaveLength(0);
  });
});

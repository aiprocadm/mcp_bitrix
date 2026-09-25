/**
 * Этап 13/14, группа company-chat (ТЗ §9.2): сотрудники и оргструктура на mock.
 * T24 (однофамильцы — без автовыбора), INVALID_PARENT, INVALID_HEAD, HIERARCHY_CYCLE, CONFLICT,
 * DEPARTMENT_NOT_EMPTY до плана, diff отделов сотрудника, FEATURE_UNAVAILABLE, полный путь approve/replay,
 * удаление скрыто без ENABLE_DESTRUCTIVE_TOOLS и запрещено не-админу.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { dispatch } from '../../src/mcp/register-tools.js';
import { companyDepartmentDeleteTool } from '../../src/tools/company/department-write.js';
import { connectInMemory, createTestApp, structured, type TestApp } from '../helpers/app.js';
import { legacyOk } from '../helpers/mock-bitrix.js';
import { companyState, installCompanyMock, user, type CompanyState } from '../helpers/mock-company.js';

interface Env {
  success: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; details: Record<string, unknown> };
  meta: Record<string, unknown> & {
    warnings?: string[];
    page?: { nextCursor: string | null; hasMore: boolean };
  };
}

let t: TestApp;
let s: CompanyState;
let client: Client;
let close: () => Promise<void>;
const call = async (name: string, args: Record<string, unknown>) =>
  structured<Env>(await client.callTool({ name, arguments: args }));

async function reconnect(
  overrides: Record<string, string> = {},
  extraUsers = [] as ReturnType<typeof user>[],
) {
  s = companyState(extraUsers);
  t = createTestApp({ ENABLED_MODULES: 'system,company', BITRIX_REQUESTS_PER_SECOND: '10', ...overrides });
  installCompanyMock(t.bitrix, s);
  const c = await connectInMemory(t.app);
  client = c.client;
  close = () => c.close();
}

async function restart(overrides: Record<string, string> = {}, extraUsers = [] as ReturnType<typeof user>[]) {
  await close();
  t.app.close();
  await reconnect(overrides, extraUsers);
}

const approve = (env: Env) => {
  const operationId = env.error?.details['operationId'] as string;
  t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
  return operationId;
};

beforeEach(async () => {
  await reconnect();
});
afterEach(async () => {
  await close();
  t.app.close();
});

describe('employee_search', () => {
  it('T24: два «Иванов Иван» — оба кандидата, ambiguous/selectionRequired, без автовыбора и без контактов', async () => {
    const env = await call('employee_search', { query: 'Иванов' });
    expect(env.success).toBe(true);
    const items = env.data?.['items'] as { id: number; departments: unknown[] }[];
    expect(items.map((i) => i.id)).toEqual([10, 11]);
    expect(env.data).toMatchObject({ ambiguous: true, selectionRequired: true, sameNameGroups: [[10, 11]] });
    expect(items[0]).toMatchObject({
      fullName: 'Иванов Иван',
      position: 'Руководитель продаж',
      active: true,
      departments: [{ id: 2, name: 'Продажи' }],
    });
    expect(env.meta.warnings?.join(' ')).toContain('автоматический выбор не выполняется');
    const text = JSON.stringify(env);
    expect(text).not.toContain('secret.invalid');
    expect(text).not.toContain('+7999');
    expect(text).not.toContain('1990-01-01');
    const sent = t.bitrix.callsTo('user.search')[0]?.body;
    expect(sent?.['FILTER']).toEqual({ FIND: 'Иванов', ACTIVE: true });
    expect(sent?.['select'] as string[]).not.toContain('EMAIL');
    expect(sent?.['select'] as string[]).not.toContain('PERSONAL_MOBILE');
  });

  it('один кандидат — ambiguous=false; уволенные скрыты по умолчанию и видны с activeOnly=false; фильтр по отделу', async () => {
    const one = await call('employee_search', { query: 'Сидорова' });
    expect(one.data).toMatchObject({ ambiguous: false, returnedCount: 1 });
    expect((await call('employee_search', { query: 'Петров' })).data?.['returnedCount']).toBe(0);
    const fired = await call('employee_search', { query: 'Петров', activeOnly: false });
    expect(fired.data?.['items']).toMatchObject([{ id: 12, active: false }]);
    const inDept = await call('employee_search', { query: 'Иванов', departmentId: 3 });
    expect((inDept.data?.['items'] as { id: number }[]).map((i) => i.id)).toEqual([11]);
    expect(t.bitrix.callsTo('user.search').at(-1)?.body['FILTER']).toEqual({
      FIND: 'Иванов',
      ACTIVE: true,
      UF_DEPARTMENT: 3,
    });
  });

  it('T20-класс: 60 совпадений при pageSize=25 — три страницы без пропусков и повторов', async () => {
    const many = Array.from({ length: 60 }, (_, i) => user(200 + i, `Тест${String(i)}`, 'Массовый', [4]));
    await restart({}, many);
    const ids: number[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const env = await call('employee_search', {
        query: 'Массовый',
        pageSize: 25,
        ...(cursor ? { cursor } : {}),
      });
      ids.push(...(env.data?.['items'] as { id: number }[]).map((x) => x.id));
      cursor = env.meta.page?.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(ids).toEqual(Array.from({ length: 60 }, (_, i) => 200 + i));
  });
});

describe('company_departments_list', () => {
  it('подотделы по PARENT, START в запросе, руководитель с именем, stateHash', async () => {
    const env = await call('company_departments_list', { parentId: 1 });
    expect(env.success).toBe(true);
    const items = env.data?.['items'] as Record<string, unknown>[];
    expect(items.map((d) => d['id'])).toEqual([2, 4, 5]);
    expect(items[0]).toMatchObject({ name: 'Продажи', parentId: 1, headId: 10, headName: 'Иванов Иван' });
    expect(items[0]?.['stateHash']).toMatch(/^[a-f0-9]{64}$/);
    expect(t.bitrix.callsTo('department.get')[0]?.body).toMatchObject({ PARENT: 1, START: 0 });
  });
});

describe('запись оргструктуры', () => {
  beforeEach(async () => {
    await restart({ READ_ONLY_MODE: 'false' });
  });

  it('create: INVALID_PARENT и INVALID_HEAD до плана — ни операции, ни department.add', async () => {
    const bad = await call('company_department_create', {
      name: 'X',
      parentId: 999,
      idempotencyKey: randomUUID(),
    });
    expect(bad.error?.code).toBe('VALIDATION_ERROR');
    expect(bad.error?.details['reason']).toBe('INVALID_PARENT');
    const fired = await call('company_department_create', {
      name: 'X',
      parentId: 1,
      headId: 12,
      idempotencyKey: randomUUID(),
    });
    expect(fired.error?.details['reason']).toBe('INVALID_HEAD');
    expect(t.app.operations.countByStatus()).toEqual({});
    expect(t.bitrix.callsTo('department.add')).toHaveLength(0);
  });

  it('create: без parentId — корень в плане; APPROVAL_REQUIRED → approve → одна запись и сверка → replay', async () => {
    const args = { name: 'Маркетинг', headId: 13, idempotencyKey: randomUUID() };
    const prep = await call('company_department_create', args);
    expect(prep.error?.code).toBe('APPROVAL_REQUIRED');
    const plan = prep.error?.details['plan'] as { details: Record<string, unknown>; risks: string[] };
    expect(plan.details).toMatchObject({
      name: 'Маркетинг',
      parent: { id: 1, name: 'Компания' },
      parentDefaulted: true,
      head: { id: 13, fullName: 'Сидорова Анна Павловна' },
    });
    expect(plan.risks.join(' ')).toContain('в корне');
    expect(t.bitrix.callsTo('department.add')).toHaveLength(0);
    const operationId = approve(prep);
    const done = await call('company_department_create', { ...args, approvalId: operationId });
    expect(done.data).toMatchObject({ departmentId: 100, verified: true, replayed: false });
    expect(t.bitrix.callsTo('department.add')[0]?.body).toEqual({
      NAME: 'Маркетинг',
      PARENT: 1,
      UF_HEAD: 13,
    });
    const again = await call('company_department_create', { ...args, approvalId: operationId });
    expect(again.data).toMatchObject({ departmentId: 100, replayed: true });
    expect(t.bitrix.callsTo('department.add')).toHaveLength(1);
  });

  it('create: ответ без ID → OPERATION_OUTCOME_UNKNOWN, повтор не создаёт второй отдел', async () => {
    t.bitrix.on('department.add', legacyOk(null));
    const args = { name: 'Юристы', parentId: 1, idempotencyKey: randomUUID() };
    const operationId = approve(await call('company_department_create', args));
    const done = await call('company_department_create', { ...args, approvalId: operationId });
    expect(done.error?.code).toBe('OPERATION_OUTCOME_UNKNOWN');
    const retry = await call('company_department_create', { ...args, approvalId: operationId });
    expect(retry.error?.code).toBe('OPERATION_OUTCOME_UNKNOWN');
    expect(t.bitrix.callsTo('department.add')).toHaveLength(1);
  });

  it('update: HIERARCHY_CYCLE — перенос в собственный подотдел или в себя отклоняется до плана', async () => {
    const intoChild = await call('company_department_update', {
      id: 2,
      patch: { parentId: 3 },
      idempotencyKey: randomUUID(),
    });
    expect(intoChild.error?.code).toBe('VALIDATION_ERROR');
    expect(intoChild.error?.details['reason']).toBe('HIERARCHY_CYCLE');
    const self = await call('company_department_update', { id: 2, patch: { parentId: 2 }, dryRun: true });
    expect(self.error?.details['reason']).toBe('HIERARCHY_CYCLE');
    const missing = await call('company_department_update', {
      id: 3,
      patch: { parentId: 999 },
      dryRun: true,
    });
    expect(missing.error?.details['reason']).toBe('INVALID_PARENT');
    const root = await call('company_department_update', { id: 1, patch: { parentId: 4 }, dryRun: true });
    expect(root.error?.details['reason']).toBe('ROOT_DEPARTMENT');
    expect(t.app.operations.countByStatus()).toEqual({});
    expect(t.bitrix.callsTo('department.update')).toHaveLength(0);
  });

  it('update: diff «было → станет», CONFLICT по expectedStateHash до плана и в precheck, успешный путь с новым stateHash', async () => {
    const list = await call('company_departments_list', { id: 3 });
    const hash = (list.data?.['items'] as { stateHash: string }[])[0]?.stateHash ?? '';
    const dry = await call('company_department_update', {
      id: 3,
      patch: { name: 'Продажи СПб', parentId: 4, headId: 11 },
      dryRun: true,
    });
    expect(dry.data?.['stateHash']).toBe(hash);
    expect((dry.data?.['plan'] as { details: Record<string, unknown> }).details['changes']).toEqual({
      name: { from: 'Продажи Москва', to: 'Продажи СПб' },
      parent: { from: { id: 2, name: 'Продажи' }, to: { id: 4, name: 'Пустой отдел' } },
      head: { from: null, to: { id: 11, fullName: 'Иванов Иван', position: 'Менеджер' } },
    });

    // Кто-то переименовал отдел после чтения → CONFLICT до плана
    (s.departments.get(3) as { NAME: string }).NAME = 'Продажи Мск';
    const stale = await call('company_department_update', {
      id: 3,
      patch: { name: 'Продажи СПб' },
      expectedStateHash: hash,
      idempotencyKey: randomUUID(),
    });
    expect(stale.error?.code).toBe('CONFLICT');

    const fresh =
      ((await call('company_departments_list', { id: 3 })).data?.['items'] as { stateHash: string }[])[0]
        ?.stateHash ?? '';
    const args = {
      id: 3,
      patch: { name: 'Продажи СПб' },
      expectedStateHash: fresh,
      idempotencyKey: randomUUID(),
    };
    const raceOp = approve(await call('company_department_update', args));
    (s.departments.get(3) as { NAME: string }).NAME = 'Изменено вручную';
    const raced = await call('company_department_update', { ...args, approvalId: raceOp });
    expect(raced.error?.code).toBe('CONFLICT');
    expect(t.bitrix.callsTo('department.update')).toHaveLength(0);
    expect((await call('operation_status', { operationId: raceOp })).data?.['status']).toBe('failed');

    const cur =
      ((await call('company_departments_list', { id: 3 })).data?.['items'] as { stateHash: string }[])[0]
        ?.stateHash ?? '';
    const okArgs = {
      id: 3,
      patch: { name: 'Продажи СПб', parentId: 4 },
      expectedStateHash: cur,
      idempotencyKey: randomUUID(),
    };
    const opId = approve(await call('company_department_update', okArgs));
    const done = await call('company_department_update', { ...okArgs, approvalId: opId });
    expect(done.data).toMatchObject({ id: 3, verified: true, replayed: false });
    expect(done.data?.['stateHash']).toMatch(/^[a-f0-9]{64}$/);
    expect(t.bitrix.callsTo('department.update')[0]?.body).toEqual({ ID: 3, NAME: 'Продажи СПб', PARENT: 4 });
    const again = await call('company_department_update', { ...okArgs, approvalId: opId });
    expect(again.data?.['replayed']).toBe(true);
    expect(t.bitrix.callsTo('department.update')).toHaveLength(1);
  });

  it('update: без изменений → NO_CHANGES до плана', async () => {
    const env = await call('company_department_update', {
      id: 2,
      patch: { name: 'Продажи' },
      idempotencyKey: randomUUID(),
    });
    expect(env.error?.details['reason']).toBe('NO_CHANGES');
  });
});

describe('company_department_delete (этап 14)', () => {
  it('скрыт без ENABLE_DESTRUCTIVE_TOOLS; прямой вызов → METHOD_NOT_ALLOWED', async () => {
    await restart({ READ_ONLY_MODE: 'false' });
    const names = (await client.listTools()).tools.map((x) => x.name);
    expect(names).toContain('company_department_update');
    expect(names).not.toContain('company_department_delete');
    const env = await dispatch(companyDepartmentDeleteTool, { id: 4, dryRun: true }, t.app);
    expect(env.success).toBe(false);
    if (!env.success) expect(env.error.code).toBe('METHOD_NOT_ALLOWED');
  });

  it('не-админ (operator) получает ACCESS_DENIED даже при включённых удалениях', async () => {
    await restart({ READ_ONLY_MODE: 'false', ENABLE_DESTRUCTIVE_TOOLS: 'true' });
    const env = await dispatch(companyDepartmentDeleteTool, { id: 4, dryRun: true }, t.app, undefined, {
      id: 'op',
      role: 'operator',
      source: 'local',
    });
    expect(env.success).toBe(false);
    if (!env.success) expect(env.error.code).toBe('ACCESS_DENIED');
    expect(t.bitrix.callsTo('department.get')).toHaveLength(0);
  });

  it('DEPARTMENT_NOT_EMPTY до плана: подотделы; только уволенный сотрудник; корень — ROOT_DEPARTMENT', async () => {
    await restart({ READ_ONLY_MODE: 'false', ENABLE_DESTRUCTIVE_TOOLS: 'true' });
    const withChildren = await call('company_department_delete', { id: 2, idempotencyKey: randomUUID() });
    expect(withChildren.error?.code).toBe('VALIDATION_ERROR');
    expect(withChildren.error?.details['reason']).toBe('DEPARTMENT_NOT_EMPTY');
    expect(withChildren.error?.message).toContain('подотделов: 1');
    const withFired = await call('company_department_delete', { id: 5, idempotencyKey: randomUUID() });
    expect(withFired.error?.details['reason']).toBe('DEPARTMENT_NOT_EMPTY');
    expect(withFired.error?.message).toContain('сотрудников (включая уволенных): 1');
    const root = await call('company_department_delete', { id: 1, idempotencyKey: randomUUID() });
    expect(root.error?.details['reason']).toBe('ROOT_DEPARTMENT');
    const missing = await call('company_department_delete', { id: 999, idempotencyKey: randomUUID() });
    expect(missing.error?.code).toBe('NOT_FOUND');
    expect(t.app.operations.countByStatus()).toEqual({});
    expect(t.bitrix.callsTo('department.delete')).toHaveLength(0);
  });

  it('пустой отдел: план с impact → approve → одно удаление, сверка отсутствия, replay; сотрудник добавлен после подтверждения → отказ', async () => {
    await restart({ READ_ONLY_MODE: 'false', ENABLE_DESTRUCTIVE_TOOLS: 'true' });
    // гонка: после подтверждения в отдел 4 добавили сотрудника
    const raceArgs = { id: 4, idempotencyKey: randomUUID() };
    const raceOp = approve(await call('company_department_delete', raceArgs));
    s.users.set(300, user(300, 'Новый', 'Сотрудник', [4]));
    const raced = await call('company_department_delete', { ...raceArgs, approvalId: raceOp });
    expect(raced.error?.details['reason']).toBe('DEPARTMENT_NOT_EMPTY');
    expect(t.bitrix.callsTo('department.delete')).toHaveLength(0);
    s.users.delete(300);

    const dry = await call('company_department_delete', { id: 4, dryRun: true });
    const hash = dry.data?.['stateHash'] as string;
    const args = { id: 4, expectedStateHash: hash, idempotencyKey: randomUUID() };
    const prep = await call('company_department_delete', args);
    expect(prep.error?.code).toBe('APPROVAL_REQUIRED');
    expect(prep.error?.details['plan']).toMatchObject({
      target: 'department:4',
      details: { department: { id: 4, name: 'Пустой отдел' }, impact: { childDepartments: 0, members: 0 } },
    });
    const operationId = approve(prep);
    const done = await call('company_department_delete', { ...args, approvalId: operationId });
    expect(done.data).toMatchObject({ id: 4, deleted: true, verified: true, replayed: false });
    expect(t.bitrix.callsTo('department.delete')[0]?.body).toEqual({ ID: 4 });
    expect(s.departments.has(4)).toBe(false);
    const again = await call('company_department_delete', { ...args, approvalId: operationId });
    expect(again.data).toMatchObject({ deleted: true, replayed: true });
    expect(t.bitrix.callsTo('department.delete')).toHaveLength(1);
  });
});

describe('company_employee_departments_set', () => {
  beforeEach(async () => {
    await restart({ READ_ONLY_MODE: 'false' });
  });

  it('diff прежний/новый состав, риск руководителя, approve → user.update UF_DEPARTMENT → сверка → replay', async () => {
    const dry = await call('company_employee_departments_set', {
      userId: 10,
      departmentIds: [4, 3],
      dryRun: true,
    });
    const plan = dry.data?.['plan'] as { details: Record<string, unknown>; risks: string[] };
    expect(plan.details).toMatchObject({
      before: [{ id: 2, name: 'Продажи' }],
      after: [
        { id: 3, name: 'Продажи Москва' },
        { id: 4, name: 'Пустой отдел' },
      ],
      added: [
        { id: 3, name: 'Продажи Москва' },
        { id: 4, name: 'Пустой отдел' },
      ],
      removed: [{ id: 2, name: 'Продажи' }],
    });
    expect(plan.risks.join(' ')).toContain('руководитель покидаемых отделов #2');
    const args = {
      userId: 10,
      departmentIds: [4, 3],
      expectedStateHash: dry.data?.['stateHash'] as string,
      idempotencyKey: randomUUID(),
    };
    const operationId = approve(await call('company_employee_departments_set', args));
    const done = await call('company_employee_departments_set', { ...args, approvalId: operationId });
    expect(done.data).toMatchObject({ userId: 10, departmentIds: [3, 4], verified: true, replayed: false });
    expect(t.bitrix.callsTo('user.update')[0]?.body).toEqual({ ID: 10, UF_DEPARTMENT: [3, 4] });
    const again = await call('company_employee_departments_set', { ...args, approvalId: operationId });
    expect(again.data?.['replayed']).toBe(true);
    expect(t.bitrix.callsTo('user.update')).toHaveLength(1);
  });

  it('CONFLICT: состав изменился после чтения; несуществующий отдел — INVALID_DEPARTMENT; тот же состав — NO_CHANGES', async () => {
    const dry = await call('company_employee_departments_set', {
      userId: 11,
      departmentIds: [4],
      dryRun: true,
    });
    (s.users.get(11) as { UF_DEPARTMENT: number[] }).UF_DEPARTMENT = [2];
    const stale = await call('company_employee_departments_set', {
      userId: 11,
      departmentIds: [4],
      expectedStateHash: dry.data?.['stateHash'],
      idempotencyKey: randomUUID(),
    });
    expect(stale.error?.code).toBe('CONFLICT');
    const bad = await call('company_employee_departments_set', {
      userId: 11,
      departmentIds: [999],
      dryRun: true,
    });
    expect(bad.error?.details['reason']).toBe('INVALID_DEPARTMENT');
    const same = await call('company_employee_departments_set', {
      userId: 11,
      departmentIds: [2],
      dryRun: true,
    });
    expect(same.error?.details['reason']).toBe('NO_CHANGES');
    const empty = await client.callTool({
      name: 'company_employee_departments_set',
      arguments: { userId: 11, departmentIds: [], dryRun: true },
    });
    expect(empty.isError).toBe(true);
    expect(t.bitrix.callsTo('user.update')).toHaveLength(0);
  });

  it('FEATURE_UNAVAILABLE, если method.get сообщает, что user.update недоступен', async () => {
    s.methodAvailable['user.update'] = { isExisting: true, isAvailable: false };
    const env = await call('company_employee_departments_set', {
      userId: 10,
      departmentIds: [4],
      dryRun: true,
    });
    expect(env.error?.code).toBe('FEATURE_UNAVAILABLE');
    expect(env.error?.details['requiredScope']).toBe('user');
    expect(t.bitrix.callsTo('user.get')).toHaveLength(0);
  });
});

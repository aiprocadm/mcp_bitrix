/**
 * Этап 13/14 (ТЗ §9.4, §9.5, §9.7, §10.2): универсальный CRM-адаптер crm.item.* на mock —
 * смарт-процессы (id типа ≠ entityTypeId, поля по crm.item.fields, стадии DYNAMIC_*), счета (entityTypeId=31,
 * T34 PARTIAL_SUCCESS без второго счёта), маршрутизация crm_* для smart/invoice, include в crm_get_record,
 * crm_delete_record (скрыт без ENABLE_DESTRUCTIVE_TOOLS, только administrator, NOT_FOUND без плана, CONFLICT, verify).
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { dispatch } from '../../src/mcp/register-tools.js';
import { connectInMemory, createTestApp, structured, type TestApp } from '../helpers/app.js';
import { DEAL_FIELDS, dealRecord, legacyError, legacyOk } from '../helpers/mock-bitrix.js';
import { COMPANY_FIELDS } from '../helpers/mock-crm.js';
import { mockCrmItems, type ItemsStore } from '../helpers/mock-crm-items.js';

interface Env {
  success: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; details: Record<string, unknown> };
  meta: Record<string, unknown> & { warnings?: string[] };
}

let t: TestApp;
let client: Client;
let close: () => Promise<void>;
let store: ItemsStore;
let deals: Map<number, Record<string, unknown>>;
const call = async (name: string, args: Record<string, unknown>) =>
  structured<Env>(await client.callTool({ name, arguments: args }));

async function start(overrides: Record<string, string> = {}) {
  t = createTestApp({
    READ_ONLY_MODE: 'false',
    ENABLED_MODULES: 'system,crm,smartProcesses,invoices',
    BITRIX_REQUESTS_PER_SECOND: '10',
    ...overrides,
  });
  store = mockCrmItems(t.bitrix);
  deals = new Map([
    [5, dealRecord(5, { OPPORTUNITY: '52400.00' })],
    [6, dealRecord(6)],
  ]);
  t.bitrix
    .on('crm.deal.fields', legacyOk(DEAL_FIELDS))
    .on('crm.deal.get', (c) => {
      const d = deals.get(Number(c.body['id']));
      return d ? legacyOk(d) : legacyError('NOT_FOUND', 400, 'Not found');
    })
    .on('crm.deal.delete', (c) => {
      deals.delete(Number(c.body['id']));
      return legacyOk(true);
    })
    .on('crm.company.fields', legacyOk(COMPANY_FIELDS))
    .on('crm.company.get', (c) =>
      Number(c.body['id']) === 9
        ? legacyOk({ ID: '9', TITLE: 'ООО Тест', ASSIGNED_BY_ID: '7', DATE_MODIFY: '2026-09-01' })
        : legacyError('NOT_FOUND', 400, 'Not found'),
    )
    .on('crm.deal.list', legacyOk([{ ID: '5' }, { ID: '6' }], { total: 2 }))
    .on('crm.contact.list', legacyOk([], { total: 0 }))
    .on('crm.timeline.comment.list', legacyOk([], { total: 0 }));
  const c = await connectInMemory(t.app);
  client = c.client;
  close = () => c.close();
}

afterEach(async () => {
  await close();
  t.app.close();
});

async function approveAndRun(name: string, args: Record<string, unknown>) {
  const prep = await call(name, args);
  expect(prep.error?.code, JSON.stringify(prep.error)).toBe('APPROVAL_REQUIRED');
  const operationId = prep.error?.details['operationId'] as string;
  await t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
  const done = await call(name, { ...args, approvalId: operationId });
  return { prep, done, operationId };
}

describe('смарт-процессы: типы и entityTypeId', () => {
  it('smart_process_types_list: typeId и entityTypeId раздельно, флаги Y/N → boolean, метод crm.type.list', async () => {
    await start();
    const env = await call('smart_process_types_list', { title: 'Про' });
    expect(env.success).toBe(true);
    const items = env.data?.['items'] as Record<string, unknown>[];
    expect(items[0]).toMatchObject({
      typeId: 37,
      entityTypeId: 1256,
      title: 'Проекты',
      isStagesEnabled: true,
      isCategoriesEnabled: true,
      isBizProcEnabled: false,
    });
    expect(items[1]).toMatchObject({ typeId: 32, entityTypeId: 1246, isRecyclebinEnabled: false });
    expect(t.bitrix.callsTo('crm.type.list')[0]?.body['filter']).toEqual({ '%title': 'Про' });
    expect(env.meta['completeness']).toBe('complete');
  });

  it('id типа вместо entityTypeId, системные типы и 31 отклоняются до чтения элементов; проверка кэшируется', async () => {
    await start();
    const byTypeId = await call('smart_process_items_list', { entityTypeId: 37 });
    expect(byTypeId.error?.code).toBe('VALIDATION_ERROR');
    expect(byTypeId.error?.details['reason']).toBe('NOT_SMART_PROCESS');
    expect(byTypeId.error?.message).toContain('id типа');
    for (const system of [1, 2, 3, 4, 31]) {
      const r = await call('smart_process_item_get', { entityTypeId: system, id: 1 });
      expect(r.error?.details['reason'], String(system)).toBe('NOT_SMART_PROCESS');
    }
    expect(t.bitrix.callsTo('crm.type.getbyentitytypeid')).toHaveLength(1);
    expect(t.bitrix.callsTo('crm.item.list')).toHaveLength(0);
    expect(t.bitrix.callsTo('crm.item.get')).toHaveLength(0);

    await call('smart_process_items_list', { entityTypeId: 1256 });
    await call('smart_process_items_list', { entityTypeId: 1256, pageSize: 5 });
    expect(t.bitrix.callsTo('crm.type.getbyentitytypeid')).toHaveLength(2);
    expect(t.bitrix.callsTo('crm.item.fields')).toHaveLength(1);
  });
});

describe('смарт-процессы: чтение', () => {
  it('smart_process_items_list: camelCase-фильтр, поля по умолчанию, result.items, курсор без пропусков', async () => {
    await start();
    const p1 = await call('smart_process_items_list', {
      entityTypeId: 1256,
      filter: { '%title': 'MCP TEST', '>=createdTime': '2026-09-01' },
      pageSize: 40,
    });
    expect(p1.success).toBe(true);
    expect(p1.data?.['returnedCount']).toBe(40);
    expect(p1.data?.['upstreamTotal']).toBe(60);
    const req = t.bitrix.callsTo('crm.item.list')[0]?.body ?? {};
    expect(req['entityTypeId']).toBe(1256);
    expect(req['filter']).toEqual({ '%title': 'MCP TEST', '>=createdTime': '2026-09-01' });
    expect(req['order']).toEqual({ id: 'DESC' });
    expect(req['select']).toEqual([
      'id',
      'title',
      'categoryId',
      'stageId',
      'assignedById',
      'opportunity',
      'currencyId',
      'companyId',
      'createdTime',
      'updatedTime',
    ]);
    const cursor = (p1.meta['page'] as { nextCursor: string }).nextCursor;
    const p2 = await call('smart_process_items_list', {
      entityTypeId: 1256,
      filter: { '%title': 'MCP TEST', '>=createdTime': '2026-09-01' },
      pageSize: 40,
      cursor,
    });
    expect(p2.data?.['returnedCount']).toBe(20);
    expect(p2.meta['completeness']).toBe('complete');
    const ids = [
      ...(p1.data?.['items'] as { id: number }[]),
      ...(p2.data?.['items'] as { id: number }[]),
    ].map((x) => x.id);
    expect(new Set(ids).size).toBe(60);
  });

  it('фильтр/select с UPPER_CASE не «переводится»: UNKNOWN_FIELD / недопустимый ключ, без crm.item.list', async () => {
    await start();
    const upper = await call('smart_process_items_list', { entityTypeId: 1256, filter: { TITLE: 'x' } });
    expect(upper.error?.code).toBe('VALIDATION_ERROR');
    const sel = await call('smart_process_items_list', { entityTypeId: 1256, select: ['STAGE_ID'] });
    expect(sel.error?.details['reason']).toBe('UNKNOWN_FIELD');
    expect(t.bitrix.callsTo('crm.item.list')).toHaveLength(0);
  });

  it('smart_process_item_get: запись, stateHash, select; NOT_FOUND', async () => {
    await start();
    const env = await call('smart_process_item_get', { entityTypeId: 1256, id: 3, select: ['id', 'title'] });
    expect(env.data).toMatchObject({
      entityTypeId: 1256,
      id: 3,
      title: '[MCP TEST] Проект 3',
      record: { id: 3, title: '[MCP TEST] Проект 3' },
    });
    expect(env.data?.['stateHash']).toMatch(/^[a-f0-9]{64}$/);
    expect(t.bitrix.callsTo('crm.item.get')[0]?.body).toEqual({ entityTypeId: 1256, id: 3 });
    const missing = await call('smart_process_item_get', { entityTypeId: 1256, id: 999 });
    expect(missing.error?.code).toBe('NOT_FOUND');
  });
});

describe('смарт-процессы: запись', () => {
  const key = () => randomUUID();

  it('неизвестное поле, read-only, обязательное, INVALID_STAGE — отказ до плана, без записи', async () => {
    await start();
    const base = { entityTypeId: 1256, idempotencyKey: key() };
    const unknown = await call('smart_process_item_create', {
      ...base,
      fields: { TITLE: 'x', ufCrm5_1700000000: 'P' },
    });
    expect(unknown.error?.details['reason']).toBe('UNKNOWN_FIELD');
    expect(unknown.error?.message).toContain('camelCase');
    const ro = await call('smart_process_item_create', {
      ...base,
      fields: { title: 'x', ufCrm5_1700000000: 'P', createdTime: '2026-09-01' },
    });
    expect(ro.error?.details['reason']).toBe('READ_ONLY_FIELD');
    const req = await call('smart_process_item_create', { ...base, fields: { title: 'x' } });
    expect(req.error?.details).toMatchObject({
      reason: 'REQUIRED_FIELD_MISSING',
      field: 'ufCrm5_1700000000',
    });
    const stage = await call('smart_process_item_create', {
      ...base,
      fields: { title: 'x', ufCrm5_1700000000: 'P', stageId: 'DT1256_8:NEW' },
    });
    expect(stage.error?.details['reason']).toBe('INVALID_STAGE');
    expect(stage.error?.message).toContain('DYNAMIC_1256_STAGE_7');
    // У типа 1246 стадии выключены
    const noStages = await call('smart_process_item_create', {
      entityTypeId: 1246,
      idempotencyKey: key(),
      fields: { title: 'x', ufCrm5_1700000000: 'P', stageId: 'NEW' },
    });
    expect(noStages.error?.details['reason']).toBe('INVALID_STAGE');
    expect(t.bitrix.callsTo('crm.item.add')).toHaveLength(0);
    expect(t.bitrix.callsTo('crm.item.fields')).toHaveLength(2);
    expect(t.bitrix.callsTo('crm.status.list')[0]?.body['filter']).toEqual({
      ENTITY_ID: 'DYNAMIC_1256_STAGE_7',
    });
  });

  it('create: APPROVAL_REQUIRED → approve → одна запись, сверка → replay без второго crm.item.add', async () => {
    await start();
    const args = {
      entityTypeId: 1256,
      fields: {
        title: 'Новый проект',
        ufCrm5_1700000000: 'P-9',
        categoryId: 8,
        stageId: 'DT1256_8:NEW',
        opportunity: '1500,50',
        contactIds: [3, '4'],
      },
      idempotencyKey: key(),
    };
    const { prep, done } = await approveAndRun('smart_process_item_create', args);
    expect(prep.error?.details['plan']).toMatchObject({
      action: 'Создать элемент смарт-процесса «Проекты» «Новый проект»',
      target: 'crm.item:1256',
    });
    expect(done.data).toMatchObject({ entityTypeId: 1256, id: 500, verified: true, replayed: false });
    expect(t.bitrix.callsTo('crm.item.add')[0]?.body).toEqual({
      entityTypeId: 1256,
      fields: {
        title: 'Новый проект',
        ufCrm5_1700000000: 'P-9',
        categoryId: 8,
        stageId: 'DT1256_8:NEW',
        opportunity: 1500.5,
        contactIds: [3, 4],
      },
    });
    const again = await call('smart_process_item_create', {
      ...args,
      approvalId: done.data?.['operationId'],
    });
    expect(again.data).toMatchObject({ id: 500, replayed: true });
    expect(t.bitrix.callsTo('crm.item.add')).toHaveLength(1);
  });

  it('update: immutable отклоняется; diff в плане; устаревший stateHash → CONFLICT; одна запись; replay', async () => {
    await start();
    const imm = await call('smart_process_item_update', {
      entityTypeId: 1256,
      id: 2,
      fields: { xmlId: 'NEW' },
      dryRun: true,
    });
    expect(imm.error?.details['reason']).toBe('IMMUTABLE_FIELD');

    const got = await call('smart_process_item_get', { entityTypeId: 1256, id: 2 });
    const hash = got.data?.['stateHash'] as string;
    const args = {
      entityTypeId: 1256,
      id: 2,
      fields: { stageId: 'DT1256_7:WORK', assignedById: 9 },
      expectedStateHash: hash,
      idempotencyKey: key(),
    };
    const dry = await call('smart_process_item_update', { ...args, dryRun: true });
    expect(dry.data?.['plan']).toMatchObject({
      details: {
        changes: {
          stageId: { from: 'DT1256_7:NEW', to: 'DT1256_7:WORK' },
          assignedById: { from: 7, to: 9 },
        },
      },
    });
    const risks = (dry.data?.['plan'] as { risks: string[] }).risks.join(' ');
    expect(risks).toContain('stageId');
    expect(risks).toContain('ответственного');

    const stale = await call('smart_process_item_update', { ...args, expectedStateHash: 'a'.repeat(64) });
    expect(stale.error?.code).toBe('CONFLICT');

    const { done } = await approveAndRun('smart_process_item_update', args);
    expect(done.data).toMatchObject({ id: 2, verified: true, changedFields: ['stageId', 'assignedById'] });
    expect(done.data?.['stateHash']).not.toBe(hash);
    expect(t.bitrix.callsTo('crm.item.update')[0]?.body).toEqual({
      entityTypeId: 1256,
      id: 2,
      fields: { stageId: 'DT1256_7:WORK', assignedById: 9 },
    });
    const again = await call('smart_process_item_update', {
      ...args,
      approvalId: done.data?.['operationId'],
    });
    expect(again.data?.['replayed']).toBe(true);
    expect(t.bitrix.callsTo('crm.item.update')).toHaveLength(1);
  });

  it('update: изменение между подтверждением и записью → CONFLICT в precheck, crm.item.update не вызывается', async () => {
    await start();
    const got = await call('smart_process_item_get', { entityTypeId: 1256, id: 4 });
    const args = {
      entityTypeId: 1256,
      id: 4,
      fields: { title: 'Переименован' },
      expectedStateHash: got.data?.['stateHash'],
      idempotencyKey: key(),
    };
    const prep = await call('smart_process_item_update', args);
    const operationId = prep.error?.details['operationId'] as string;
    await t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
    store.items[1256]?.set(4, { ...store.items[1256]?.get(4), opportunity: 7777 });
    const done = await call('smart_process_item_update', { ...args, approvalId: operationId });
    expect(done.error?.code).toBe('CONFLICT');
    expect(t.bitrix.callsTo('crm.item.update')).toHaveLength(0);
  });

  it('crm.item.add без item.id → OPERATION_OUTCOME_UNKNOWN, повтор не создаёт запись', async () => {
    await start();
    t.bitrix.on('crm.item.add', legacyOk({}));
    const args = {
      entityTypeId: 1256,
      fields: { title: 'x', ufCrm5_1700000000: 'P' },
      idempotencyKey: key(),
    };
    const { done, operationId } = await approveAndRun('smart_process_item_create', args);
    expect(done.error?.code).toBe('OPERATION_OUTCOME_UNKNOWN');
    const again = await call('smart_process_item_create', { ...args, approvalId: operationId });
    expect(again.error?.code).toBe('OPERATION_OUTCOME_UNKNOWN');
    expect(t.bitrix.callsTo('crm.item.add')).toHaveLength(1);
  });
});

describe('crm_* для smart/invoice (универсальный адаптер)', () => {
  it('smart без entityTypeId → VALIDATION_ERROR; классика с entityTypeId → VALIDATION_ERROR; invoice без crm.type.*', async () => {
    await start();
    const noId = await call('crm_list_records', { entityType: 'smart' });
    expect(noId.error?.details['reason']).toBe('ENTITY_TYPE_ID_REQUIRED');
    const classic = await call('crm_list_records', { entityType: 'deal', entityTypeId: 1256 });
    expect(classic.error?.details['reason']).toBe('UNEXPECTED_ENTITY_TYPE_ID');
    const inv = await call('crm_list_records', { entityType: 'invoice', filter: { companyId: 5 } });
    expect(inv.success).toBe(true);
    expect(inv.data).toMatchObject({ entityType: 'invoice', entityTypeId: 31, returnedCount: 1 });
    const fields = await call('crm_fields_get', { entityType: 'invoice' });
    expect(fields.meta['method']).toBe('crm.item.fields');
    expect(fields.data?.['required']).toEqual([]);
    expect((fields.data?.['fields'] as { name: string }[]).map((f) => f.name)).toContain('accountNumber');
    const smartFields = await call('crm_fields_get', { entityType: 'smart', entityTypeId: 1256 });
    expect(smartFields.data?.['required']).toEqual(['ufCrm5_1700000000']);
    expect(
      t.bitrix.calls.filter((c) => c.url.includes('crm.type.') && c.body['entityTypeId'] === 31),
    ).toHaveLength(0);
  });

  it('crm_get_record smart + include products (ownerType T4e8) и activities с отдельной полнотой', async () => {
    await start();
    store.rows.set('T4e8:3', [{ id: 1, productName: 'Работа', price: 100, quantity: 2, taxIncluded: 'N' }]);
    const env = await call('crm_get_record', {
      entityType: 'smart',
      entityTypeId: 1256,
      id: 3,
      include: ['products', 'activities'],
    });
    expect(env.success).toBe(true);
    expect(env.meta['method']).toBe('crm.item.get');
    const related = env.data?.['related'] as Record<string, { returnedCount: number; completeness: string }>;
    expect(related['products']).toMatchObject({ returnedCount: 1, completeness: 'complete' });
    expect(related['activities']).toMatchObject({ returnedCount: 0, completeness: 'complete' });
    expect(t.bitrix.callsTo('crm.item.productrow.list')[0]?.body['filter']).toEqual({
      '=ownerType': 'T4e8',
      '=ownerId': 3,
    });
    expect(t.bitrix.callsTo('crm.activity.list')[0]?.body['filter']).toEqual({
      OWNER_TYPE_ID: 1256,
      OWNER_ID: 3,
    });
    const comments = await call('crm_get_record', {
      entityType: 'smart',
      entityTypeId: 1256,
      id: 3,
      include: ['comments'],
    });
    expect(comments.error?.details['reason']).toBe('UNSUPPORTED_INCLUDE');
  });

  it('crm_get_record deal + include: блоки с лимитами; поля сделки не меняются; компания без товаров', async () => {
    await start();
    const env = await call('crm_get_record', {
      entityType: 'deal',
      id: 5,
      include: ['comments', 'products'],
    });
    expect(env.data).toMatchObject({
      entityType: 'deal',
      id: 5,
      record: { ID: '5', OPPORTUNITY: '52400.00' },
    });
    expect(Object.keys(env.data?.['related'] as object).sort()).toEqual(['comments', 'products']);
    expect(t.bitrix.callsTo('crm.item.productrow.list')[0]?.body['filter']).toEqual({
      '=ownerType': 'D',
      '=ownerId': 5,
    });
    const company = await call('crm_get_record', { entityType: 'company', id: 9, include: ['products'] });
    expect(company.error?.details['reason']).toBe('UNSUPPORTED_INCLUDE');
  });

  it('crm_create_record invoice → crm.item.add entityTypeId=31 с camelCase-полями; crm_update_record smart с CONFLICT', async () => {
    await start();
    const args = {
      entityType: 'invoice',
      fields: { title: 'Счёт на внедрение', companyId: 5, stageId: 'DT31_2:N' },
      idempotencyKey: randomUUID(),
    };
    const { done } = await approveAndRun('crm_create_record', args);
    expect(done.data).toMatchObject({ entityType: 'invoice', entityTypeId: 31, id: 500, verified: true });
    expect(t.bitrix.callsTo('crm.item.add')[0]?.body).toEqual({
      entityTypeId: 31,
      fields: { title: 'Счёт на внедрение', companyId: 5, stageId: 'DT31_2:N' },
    });
    const upper = await call('crm_create_record', {
      entityType: 'invoice',
      fields: { TITLE: 'x' },
      dryRun: true,
    });
    expect(upper.error?.details['reason']).toBe('UNKNOWN_FIELD');

    const stale = await call('crm_update_record', {
      entityType: 'smart',
      entityTypeId: 1256,
      id: 1,
      fields: { title: 'y' },
      expectedStateHash: 'b'.repeat(64),
      idempotencyKey: randomUUID(),
    });
    expect(stale.error?.code).toBe('CONFLICT');
  });
});

describe('счета (§9.5)', () => {
  it('invoice_stages_list: воронки crm.category.list(31) и стадии SMART_INVOICE_STAGE_{id}; crm.type.* не вызывается', async () => {
    await start();
    const env = await call('invoice_stages_list', {});
    expect(env.data?.['categories']).toEqual([
      {
        id: 2,
        name: 'Счета',
        isDefault: true,
        sort: 100,
        statusEntityId: 'SMART_INVOICE_STAGE_2',
        stages: [
          { statusId: 'DT31_2:N', name: 'Новый', sort: 10 },
          { statusId: 'DT31_2:S', name: 'Отправлен', sort: 20 },
          { statusId: 'DT31_2:P', name: 'Оплачен', sort: 30, semantics: 'S' },
        ],
      },
    ]);
    expect(t.bitrix.callsTo('crm.category.list')[0]?.body).toEqual({ entityTypeId: 31 });
    const missing = await call('invoice_stages_list', { categoryId: 99 });
    expect(missing.error?.code).toBe('NOT_FOUND');
    expect(t.bitrix.calls.filter((c) => c.url.includes('crm.type.'))).toHaveLength(0);
  });

  it('invoice_list: crm.item.list entityTypeId=31', async () => {
    await start();
    const env = await call('invoice_list', {});
    expect(env.data?.['returnedCount']).toBe(1);
    expect(t.bitrix.callsTo('crm.item.list')[0]?.body['entityTypeId']).toBe(31);
  });

  it('invoice_create с товарами: план с шагами и итогом, счёт и товары (ownerType SI), сверка состава', async () => {
    await start();
    const args = {
      fields: { title: 'Счёт 1', companyId: 5 },
      productRows: [
        { productName: 'Лицензия', price: 1200, quantity: 2 },
        { productId: 10, price: 500 },
      ],
      idempotencyKey: randomUUID(),
    };
    const { prep, done } = await approveAndRun('invoice_create', args);
    const plan = prep.error?.details['plan'] as { details: Record<string, unknown>; risks: string[] };
    expect(plan.details['productRowsTotal']).toBe(2900);
    expect(plan.risks.join(' ')).toContain('PDF');
    expect(done.data).toMatchObject({
      id: 500,
      verified: true,
      productRows: { status: 'saved', requested: 2, saved: 2 },
    });
    expect(t.bitrix.callsTo('crm.item.productrow.set')[0]?.body).toMatchObject({
      ownerType: 'SI',
      ownerId: 500,
    });
  });

  it('T34: счёт создан, товары не записались → PARTIAL_SUCCESS с ID; повтор не создаёт второй счёт', async () => {
    await start();
    store.rowsSetFailure = legacyError('ACCESS_DENIED', 400, 'Access denied');
    const args = {
      fields: { title: 'Счёт T34' },
      productRows: [{ productName: 'Услуга', price: 100 }],
      idempotencyKey: randomUUID(),
    };
    const { done, operationId } = await approveAndRun('invoice_create', args);
    expect(done.error?.code).toBe('PARTIAL_SUCCESS');
    expect(done.error?.message).toContain('Счёт #500 создан');
    expect(done.error?.details).toMatchObject({
      operationId,
      reason: 'PRODUCT_ROWS_FAILED',
      field: 'productRows',
    });
    expect(store.items[31]?.has(500)).toBe(true);

    const again = await call('invoice_create', { ...args, approvalId: operationId });
    expect(again.error?.code).toBe('PARTIAL_SUCCESS');
    expect(again.error?.message).toContain('#500');
    const noApproval = await call('invoice_create', args);
    expect(noApproval.error?.code).toBe('PARTIAL_SUCCESS');
    expect(t.bitrix.callsTo('crm.item.add')).toHaveLength(1);
    expect(t.bitrix.callsTo('crm.item.productrow.set')).toHaveLength(1);
    const op = await t.app.operations.get(operationId);
    expect(op?.status).toBe('succeeded');
  });

  it('invoice_update: CONFLICT по stateHash; INVALID_STAGE; одна запись после подтверждения', async () => {
    await start();
    const got = await call('crm_get_record', { entityType: 'invoice', id: 40 });
    const hash = got.data?.['stateHash'] as string;
    const badStage = await call('invoice_update', {
      invoiceId: 40,
      fields: { stageId: 'DT1256_7:NEW' },
      dryRun: true,
    });
    expect(badStage.error?.details['reason']).toBe('INVALID_STAGE');
    const stale = await call('invoice_update', {
      invoiceId: 40,
      fields: { stageId: 'DT31_2:S' },
      expectedStateHash: 'c'.repeat(64),
      idempotencyKey: randomUUID(),
    });
    expect(stale.error?.code).toBe('CONFLICT');
    const { done } = await approveAndRun('invoice_update', {
      invoiceId: 40,
      fields: { stageId: 'DT31_2:S' },
      expectedStateHash: hash,
      idempotencyKey: randomUUID(),
    });
    expect(done.data).toMatchObject({ invoiceId: 40, id: 40, verified: true });
    expect(t.bitrix.callsTo('crm.item.update')).toHaveLength(1);
  });
});

describe('crm_delete_record (этап 14)', () => {
  it('скрыт без ENABLE_DESTRUCTIVE_TOOLS; вызов → METHOD_NOT_ALLOWED', async () => {
    await start();
    const names = (await client.listTools()).tools.map((x) => x.name);
    expect(names).not.toContain('crm_delete_record');
    expect(names).toContain('smart_process_types_list');
    const def = t.app.tools.find((x) => x.name === 'crm_delete_record');
    expect(def).toBeDefined();
    if (!def) return;
    const env = await dispatch(def, { entityType: 'deal', id: 5, dryRun: true }, t.app);
    expect(env.success).toBe(false);
    if (!env.success) expect(env.error.code).toBe('METHOD_NOT_ALLOWED');
    expect(t.bitrix.callsTo('crm.deal.get')).toHaveLength(0);
  });

  it('с ENABLE_DESTRUCTIVE_TOOLS: виден администратору; operator получает ACCESS_DENIED без обращения к порталу', async () => {
    await start({ ENABLE_DESTRUCTIVE_TOOLS: 'true' });
    const names = (await client.listTools()).tools.map((x) => x.name);
    expect(names).toContain('crm_delete_record');
    const def = t.app.tools.find((x) => x.name === 'crm_delete_record');
    if (!def) throw new Error('нет инструмента');
    const env = await dispatch(def, { entityType: 'deal', id: 5, dryRun: true }, t.app, undefined, {
      id: 'op',
      role: 'operator',
      source: 'local',
    });
    expect(env.success).toBe(false);
    if (!env.success) expect(env.error.code).toBe('ACCESS_DENIED');
    expect(t.bitrix.calls).toHaveLength(0);
  });

  it('NOT_FOUND до плана: подтверждение не создаётся', async () => {
    await start({ ENABLE_DESTRUCTIVE_TOOLS: 'true' });
    const env = await call('crm_delete_record', {
      entityType: 'deal',
      id: 404,
      idempotencyKey: randomUUID(),
    });
    expect(env.error?.code).toBe('NOT_FOUND');
    expect(await t.app.db.all('SELECT id FROM operations')).toHaveLength(0);
  });

  it('сделка: план (название, стадия, сумма, ответственный, impact) → approve → одно удаление → verified (NOT_FOUND) → replay', async () => {
    await start({ ENABLE_DESTRUCTIVE_TOOLS: 'true' });
    const got = await call('crm_get_record', { entityType: 'deal', id: 5 });
    const hash = got.data?.['stateHash'] as string;
    const stale = await call('crm_delete_record', {
      entityType: 'deal',
      id: 5,
      expectedStateHash: 'd'.repeat(64),
      idempotencyKey: randomUUID(),
    });
    expect(stale.error?.code).toBe('CONFLICT');

    const args = { entityType: 'deal', id: 5, expectedStateHash: hash, idempotencyKey: randomUUID() };
    const { prep, done, operationId } = await approveAndRun('crm_delete_record', args);
    const plan = prep.error?.details['plan'] as {
      action: string;
      details: Record<string, unknown>;
      risks: string[];
    };
    expect(plan.action).toContain('УДАЛИТЬ сделку #5');
    expect(plan.details).toMatchObject({
      stage: 'NEW',
      amount: '52400.00',
      currency: 'RUB',
      assignedById: '7',
      impact: { activities: 0, timelineComments: 0, productRows: 0 },
    });
    expect(plan.risks.join(' ')).toContain('Необратимое');
    expect(done.data).toMatchObject({
      entityType: 'deal',
      id: 5,
      deleted: true,
      verified: true,
      replayed: false,
    });
    expect(t.bitrix.callsTo('crm.deal.delete')).toHaveLength(1);
    expect(t.bitrix.callsTo('crm.deal.delete')[0]?.body).toEqual({ id: 5 });
    const again = await call('crm_delete_record', { ...args, approvalId: operationId });
    expect(again.data?.['replayed']).toBe(true);
    expect(t.bitrix.callsTo('crm.deal.delete')).toHaveLength(1);
  });

  it('компания: impact показывает связанные сделки и контакты', async () => {
    await start({ ENABLE_DESTRUCTIVE_TOOLS: 'true' });
    const dry = await call('crm_delete_record', { entityType: 'company', id: 9, dryRun: true });
    expect(dry.data?.['plan']).toMatchObject({
      details: { title: 'ООО Тест', impact: { linkedDeals: 2, linkedContacts: 0 } },
    });
    expect((dry.data?.['plan'] as { risks: string[] }).risks.join(' ')).toContain('Связанные сделки (2)');
    expect(t.bitrix.callsTo('crm.deal.list')[0]?.body['filter']).toEqual({ COMPANY_ID: 9 });
    expect(t.bitrix.callsTo('crm.company.delete')).toHaveLength(0);
  });

  it('смарт-элемент: crm.item.delete, verify NOT_FOUND; изменение после подтверждения → CONFLICT без удаления', async () => {
    await start({ ENABLE_DESTRUCTIVE_TOOLS: 'true' });
    const { done } = await approveAndRun('crm_delete_record', {
      entityType: 'smart',
      entityTypeId: 1256,
      id: 7,
      idempotencyKey: randomUUID(),
    });
    expect(done.data).toMatchObject({ entityTypeId: 1256, id: 7, verified: true });
    expect(t.bitrix.callsTo('crm.item.delete')[0]?.body).toEqual({ entityTypeId: 1256, id: 7 });
    expect(store.items[1256]?.has(7)).toBe(false);

    const got = await call('crm_get_record', { entityType: 'smart', entityTypeId: 1256, id: 8 });
    const args = {
      entityType: 'smart',
      entityTypeId: 1256,
      id: 8,
      expectedStateHash: got.data?.['stateHash'],
      idempotencyKey: randomUUID(),
    };
    const prep = await call('crm_delete_record', args);
    const operationId = prep.error?.details['operationId'] as string;
    await t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
    store.items[1256]?.set(8, { ...store.items[1256]?.get(8), title: 'Изменён' });
    const res = await call('crm_delete_record', { ...args, approvalId: operationId });
    expect(res.error?.code).toBe('CONFLICT');
    expect(t.bitrix.callsTo('crm.item.delete')).toHaveLength(1);
  });

  it('crm.deal.delete без true → OPERATION_OUTCOME_UNKNOWN', async () => {
    await start({ ENABLE_DESTRUCTIVE_TOOLS: 'true' });
    t.bitrix.on('crm.deal.delete', legacyOk(false));
    const { done } = await approveAndRun('crm_delete_record', {
      entityType: 'deal',
      id: 6,
      idempotencyKey: randomUUID(),
    });
    expect(done.error?.code).toBe('OPERATION_OUTCOME_UNKNOWN');
  });
});

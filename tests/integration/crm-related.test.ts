/**
 * Этап 13, срез 11 (ТЗ §9.4, §11 п.2): связанные данные CRM на mock —
 * пользовательские поля, история стадий, дела, комментарии таймлайна (чтение и запись),
 * товары сделки (чтение и полная замена, T32), сводка воронки (T33: лимит, валюты раздельно).
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { scanDeals } from '../../src/tools/crm/related-service.js';
import type { ToolContext } from '../../src/tools/types.js';
import { connectInMemory, createTestApp, structured, type TestApp } from '../helpers/app.js';
import {
  DEAL_FIELDS,
  dealRecord,
  legacyError,
  legacyListPage,
  legacyOk,
  type RecordedCall,
} from '../helpers/mock-bitrix.js';
import { DEAL_CATEGORIES, STATUS_LISTS } from '../helpers/mock-crm.js';

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

const USERFIELDS = [
  {
    ID: '11',
    ENTITY_ID: 'CRM_DEAL',
    FIELD_NAME: 'UF_CRM_PRIORITY',
    USER_TYPE_ID: 'enumeration',
    MULTIPLE: 'N',
    MANDATORY: 'Y',
    SORT: '100',
    EDIT_FORM_LABEL: 'Приоритет',
    LIST: [
      { ID: '1', VALUE: 'Высокий' },
      { ID: '2', VALUE: 'Низкий' },
    ],
  },
  {
    ID: '12',
    ENTITY_ID: 'CRM_DEAL',
    FIELD_NAME: 'UF_CRM_CONTRACT',
    USER_TYPE_ID: 'string',
    MULTIPLE: 'N',
    MANDATORY: 'N',
    SORT: '200',
    EDIT_FORM_LABEL: { ru: 'Договор', en: 'Contract' },
  },
];

const HISTORY = [
  {
    ID: 1,
    TYPE_ID: 1,
    OWNER_ID: 5,
    CREATED_TIME: '2026-09-01T10:00:00+03:00',
    CATEGORY_ID: 0,
    STAGE_SEMANTIC_ID: 'P',
    STAGE_ID: 'NEW',
  },
  {
    ID: 2,
    TYPE_ID: 2,
    OWNER_ID: 5,
    CREATED_TIME: '2026-09-05T10:00:00+03:00',
    CATEGORY_ID: 0,
    STAGE_SEMANTIC_ID: 'P',
    STAGE_ID: 'PREPARATION',
  },
  {
    ID: 3,
    TYPE_ID: 3,
    OWNER_ID: 5,
    CREATED_TIME: '2026-09-10T10:00:00+03:00',
    CATEGORY_ID: 0,
    STAGE_SEMANTIC_ID: 'S',
    STAGE_ID: 'WON',
  },
];

const ACTIVITIES = [1, 2, 3].map((i) => ({
  ID: String(100 + i),
  OWNER_ID: '5',
  OWNER_TYPE_ID: '2',
  TYPE_ID: '2',
  PROVIDER_ID: 'VOXIMPLANT_CALL',
  SUBJECT: `Звонок ${String(i)}`,
  COMPLETED: i === 1 ? 'Y' : 'N',
  RESPONSIBLE_ID: '7',
}));

let comments: Record<number, Record<string, unknown>>;
let rows: Record<string, unknown>[];
const ROW = (
  id: number,
  productId: number,
  productName: string,
  price: number,
  quantity: number,
  extra: Record<string, unknown> = {},
) => ({
  id,
  ownerId: 5,
  ownerType: 'D',
  productId,
  productName,
  price,
  quantity,
  discountTypeId: 2,
  discountRate: 0,
  taxRate: 20,
  taxIncluded: 'Y',
  measureName: 'шт',
  sort: id * 10,
  ...extra,
});

/** 120 сделок: стадии NEW/PREPARATION/WON по кругу, каждая четвёртая в USD. */
const ALL_DEALS = Array.from({ length: 120 }, (_, i) =>
  dealRecord(i + 1, {
    STAGE_ID: ['NEW', 'PREPARATION', 'WON'][i % 3],
    OPPORTUNITY: '100.10',
    CURRENCY_ID: i % 4 === 3 ? 'USD' : 'RUB',
  }),
);

function setup(overrides: Record<string, string> = {}) {
  comments = {
    900: {
      ID: '900',
      ENTITY_ID: '5',
      ENTITY_TYPE: 'deal',
      CREATED: '2026-09-20T12:00:00+03:00',
      AUTHOR_ID: '7',
      COMMENT: 'Клиент просит скидку',
    },
  };
  rows = [ROW(1, 10, 'Лицензия', 1200, 2), ROW(2, 0, 'Внедрение', 50000, 1)];
  t = createTestApp({ BITRIX_REQUESTS_PER_SECOND: '10', ...overrides });
  t.bitrix
    .on('crm.deal.fields', legacyOk(DEAL_FIELDS))
    .on('crm.deal.get', (c) =>
      Number(c.body['id']) === 5
        ? legacyOk(dealRecord(5, { OPPORTUNITY: '52400.00' }))
        : legacyError('NOT_FOUND', 400, 'Not found'),
    )
    .on('crm.category.list', legacyOk(DEAL_CATEGORIES))
    .on('crm.status.list', (c) => {
      const entityId = ((c.body['filter'] ?? {}) as Record<string, unknown>)['ENTITY_ID'];
      return legacyOk(typeof entityId === 'string' ? (STATUS_LISTS[entityId] ?? []) : []);
    })
    .on('crm.deal.userfield.list', legacyOk(USERFIELDS, { total: 2 }))
    // Форма из документации crm.stagehistory.list: result.items, total на верхнем уровне
    .on('crm.stagehistory.list', legacyOk({ items: HISTORY }, { total: HISTORY.length }))
    .on('crm.activity.list', (c) => {
      const filter = (c.body['filter'] ?? {}) as Record<string, unknown>;
      const items = ACTIVITIES.filter(
        (a) => filter['COMPLETED'] === undefined || a.COMPLETED === filter['COMPLETED'],
      );
      return legacyListPage(items, Number(c.body['start'] ?? 0), 50);
    })
    .on('crm.timeline.comment.list', (c) =>
      legacyListPage(Object.values(comments), Number(c.body['start'] ?? 0), 50),
    )
    .on('crm.timeline.comment.add', (c) => {
      const fields = c.body['fields'] as Record<string, unknown>;
      comments[901] = {
        ID: '901',
        ENTITY_ID: String(fields['ENTITY_ID']),
        ENTITY_TYPE: fields['ENTITY_TYPE'],
        COMMENT: fields['COMMENT'],
        AUTHOR_ID: '7',
        CREATED: '2026-09-24T12:00:00+03:00',
      };
      return legacyOk(901);
    })
    .on('crm.timeline.comment.get', (c) => {
      const row = comments[Number(c.body['id'])];
      return row ? legacyOk(row) : legacyError('NOT_FOUND', 400, 'Not found.');
    })
    .on('crm.item.productrow.list', () => legacyOk({ productRows: rows }, { total: rows.length }))
    .on('crm.item.productrow.set', (c: RecordedCall) => {
      const input = c.body['productRows'] as Record<string, unknown>[];
      rows = input.map((r, i) => ({
        ...ROW(100 + i, 0, '', 0, 1),
        ...r,
        taxIncluded: r['taxIncluded'] ?? 'N',
      }));
      return legacyOk({ productRows: rows });
    })
    .on('crm.deal.list', (c) => legacyListPage(ALL_DEALS, Number(c.body['start'] ?? 0), 50));
}

async function reconnect(overrides: Record<string, string> = {}) {
  setup(overrides);
  const c = await connectInMemory(t.app);
  client = c.client;
  close = () => c.close();
}

beforeEach(async () => {
  await reconnect();
});
afterEach(async () => {
  await close();
  t.app.close();
});

describe('чтение связанных данных', () => {
  it('crm_userfields_list: подписи строкой и из объекта ru, обязательность, варианты списков, LANG=ru в запросе', async () => {
    const env = await call('crm_userfields_list', { entityType: 'deal' });
    expect(env.success).toBe(true);
    expect(env.data?.['fields']).toEqual([
      {
        fieldName: 'UF_CRM_PRIORITY',
        type: 'enumeration',
        label: 'Приоритет',
        multiple: false,
        mandatory: true,
        sort: 100,
        items: [
          { ID: '1', VALUE: 'Высокий' },
          { ID: '2', VALUE: 'Низкий' },
        ],
      },
      {
        fieldName: 'UF_CRM_CONTRACT',
        type: 'string',
        label: 'Договор',
        multiple: false,
        mandatory: false,
        sort: 200,
      },
    ]);
    expect(t.bitrix.callsTo('crm.deal.userfield.list')[0]?.body['filter']).toEqual({ LANG: 'ru' });
  });

  it('crm_stage_history: переходы по порядку с видом, названием стадии и семантикой; период в фильтре; контакт отклоняется', async () => {
    const env = await call('crm_stage_history', {
      entityType: 'deal',
      recordId: 5,
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(env.success).toBe(true);
    expect(env.data?.['items']).toEqual([
      {
        id: 1,
        kind: 'created',
        createdTime: '2026-09-01T10:00:00+03:00',
        categoryId: 0,
        stageId: 'NEW',
        stageName: 'Новая',
        semantic: 'P',
      },
      {
        id: 2,
        kind: 'intermediate',
        createdTime: '2026-09-05T10:00:00+03:00',
        categoryId: 0,
        stageId: 'PREPARATION',
        stageName: 'Подготовка документов',
        semantic: 'P',
      },
      {
        id: 3,
        kind: 'final',
        createdTime: '2026-09-10T10:00:00+03:00',
        categoryId: 0,
        stageId: 'WON',
        stageName: 'Сделка успешна',
        semantic: 'S',
      },
    ]);
    expect(t.bitrix.callsTo('crm.stagehistory.list')[0]?.body).toMatchObject({
      entityTypeId: 2,
      filter: { OWNER_ID: 5, '>=CREATED_TIME': '2026-09-01', '<=CREATED_TIME': '2026-09-30' },
    });
    const bad = await client.callTool({
      name: 'crm_stage_history',
      arguments: { entityType: 'contact', recordId: 1 },
    });
    expect(bad.isError).toBe(true);
  });

  it('crm_activities_list: владелец по OWNER_TYPE_ID, фильтр выполненных, без COMMUNICATIONS/FILES; описание только по запросу', async () => {
    const open = await call('crm_activities_list', { entityType: 'deal', recordId: 5, completed: false });
    expect((open.data?.['items'] as { ID: string }[]).map((a) => a.ID)).toEqual(['102', '103']);
    const sent = t.bitrix.callsTo('crm.activity.list')[0]?.body;
    expect(sent?.['filter']).toEqual({ OWNER_TYPE_ID: 2, OWNER_ID: 5, COMPLETED: 'N' });
    expect(sent?.['select'] as string[]).not.toContain('COMMUNICATIONS');
    expect(sent?.['select'] as string[]).not.toContain('DESCRIPTION');
    await call('crm_activities_list', { entityType: 'lead', recordId: 5, includeDescription: true });
    expect(t.bitrix.callsTo('crm.activity.list')[1]?.body['select'] as string[]).toContain('DESCRIPTION');
    expect(t.bitrix.callsTo('crm.activity.list')[1]?.body['filter']).toEqual({
      OWNER_TYPE_ID: 1,
      OWNER_ID: 5,
    });
  });

  it('crm_timeline_comments_list: строковый ENTITY_TYPE, без FILES, нормализованные поля', async () => {
    const env = await call('crm_timeline_comments_list', { entityType: 'deal', recordId: 5 });
    expect(env.data?.['items']).toEqual([
      { id: 900, created: '2026-09-20T12:00:00+03:00', authorId: 7, comment: 'Клиент просит скидку' },
    ]);
    const sent = t.bitrix.callsTo('crm.timeline.comment.list')[0]?.body;
    expect(sent?.['filter']).toEqual({ ENTITY_ID: 5, ENTITY_TYPE: 'deal' });
    expect(sent?.['select'] as string[]).not.toContain('FILES');
  });

  it('crm_deal_products_get: строки, итог по строкам рядом с суммой сделки, stateHash полного состава; чужая сделка → NOT_FOUND', async () => {
    const env = await call('crm_deal_products_get', { dealId: 5 });
    expect(env.success).toBe(true);
    expect(env.data).toMatchObject({
      dealId: 5,
      currency: 'RUB',
      dealOpportunity: 52400,
      returnedCount: 2,
      pageTotal: 52400,
    });
    expect((env.data?.['items'] as { productName: string; taxIncluded: boolean }[])[0]).toMatchObject({
      productName: 'Лицензия',
      taxIncluded: true,
      measureName: 'шт',
    });
    expect(env.data?.['stateHash']).toMatch(/^[a-f0-9]{64}$/);
    expect(t.bitrix.callsTo('crm.item.productrow.list')[0]?.body['filter']).toEqual({
      '=ownerType': 'D',
      '=ownerId': 5,
    });
    const missing = await call('crm_deal_products_get', { dealId: 999 });
    expect(missing.error?.code).toBe('NOT_FOUND');
  });
});

describe('crm_pipeline_summary (T33)', () => {
  it('полный проход: счёт по стадиям в порядке воронки, суммы раздельно по валютам в копейках, фильтр периода', async () => {
    const env = await call('crm_pipeline_summary', {
      categoryId: 0,
      dateField: 'DATE_CREATE',
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(env.success).toBe(true);
    expect(env.data).toMatchObject({
      categoryName: 'Общая',
      scannedCount: 120,
      hasMore: false,
      stoppedBy: 'complete',
    });
    const stages = env.data?.['stages'] as {
      stageId: string;
      count: number;
      sums: { currency: string; amount: number }[];
      semantics: string;
    }[];
    expect(stages.map((s) => `${s.stageId}:${String(s.count)}`)).toEqual([
      'NEW:40',
      'PREPARATION:40',
      'WON:40',
      'LOSE:0',
    ]);
    expect(stages.find((s) => s.stageId === 'WON')?.semantics).toBe('S');
    // 120 сделок по 100.10: 90 в RUB, 30 в USD — без смешения валют и без ошибки плавающей точки
    expect(env.data?.['totals']).toEqual({
      count: 120,
      sums: [
        { currency: 'RUB', amount: 9009 },
        { currency: 'USD', amount: 3003 },
      ],
    });
    expect((env.meta.warnings ?? []).join(' ')).toContain('не складываются');
    expect(t.bitrix.callsTo('crm.deal.list')[0]?.body).toMatchObject({
      filter: { CATEGORY_ID: 0, '>=DATE_CREATE': '2026-09-01', '<=DATE_CREATE': '2026-09-30' },
      select: ['ID', 'STAGE_ID', 'OPPORTUNITY', 'CURRENCY_ID'],
    });
    expect(t.bitrix.callsTo('crm.deal.list')).toHaveLength(3);
  });

  it('остановка на maxRecords → partial, scannedCount ровно по лимиту, hasMore; maxRecords выше серверного предела и from>to отклоняются', async () => {
    const env = await call('crm_pipeline_summary', {
      categoryId: 0,
      dateField: 'CLOSEDATE',
      from: '2026-01-01',
      to: '2026-12-31',
      maxRecords: 60,
      assignedById: 7,
    });
    expect(env.data).toMatchObject({
      scannedCount: 60,
      hasMore: true,
      stoppedBy: 'maxRecords',
      assignedById: 7,
    });
    expect(env.meta['completeness']).toBe('partial');
    expect((env.meta.warnings ?? []).join(' ')).toContain('maxRecords=60');
    expect(t.bitrix.callsTo('crm.deal.list')).toHaveLength(2);
    expect(t.bitrix.callsTo('crm.deal.list')[0]?.body['filter']).toMatchObject({ ASSIGNED_BY_ID: 7 });
    const tooMany = await call('crm_pipeline_summary', {
      categoryId: 0,
      dateField: 'CLOSEDATE',
      from: '2026-01-01',
      to: '2026-12-31',
      maxRecords: 6000,
    });
    expect(tooMany.error?.details['field']).toBe('maxRecords');
    const inverted = await call('crm_pipeline_summary', {
      categoryId: 0,
      dateField: 'CLOSEDATE',
      from: '2026-12-31',
      to: '2026-01-01',
    });
    expect(inverted.error?.code).toBe('VALIDATION_ERROR');
  });

  it('scanDeals: лимит времени останавливает проход с stoppedBy=timeLimit', async () => {
    let clock = 0;
    let calls = 0;
    const ctx = {
      requestId: 'r',
      signal: undefined,
      bitrix: {
        call: () => {
          calls += 1;
          clock += 20_000; // каждая страница «занимает» 20 секунд
          return Promise.resolve({
            result: ALL_DEALS.slice(0, 50),
            next: 50 * calls,
            total: 1000,
            nextCursor: undefined,
          });
        },
      },
    } as unknown as ToolContext;
    const r = await scanDeals(ctx, {}, 5000, 30, () => clock);
    expect(r).toMatchObject({ stoppedBy: 'timeLimit', hasMore: true, scannedCount: 100 });
    expect(calls).toBe(2);
  });
});

describe('запись: комментарий и замена товаров', () => {
  beforeEach(async () => {
    await close();
    t.app.close();
    await reconnect({ READ_ONLY_MODE: 'false' });
  });

  it('crm_timeline_comment_add: план с полным текстом, запись существует до плана, одна запись и сверка через comment.get', async () => {
    const missing = await call('crm_timeline_comment_add', {
      entityType: 'deal',
      recordId: 999,
      text: 'x',
      idempotencyKey: randomUUID(),
    });
    expect(missing.error?.code).toBe('NOT_FOUND');
    expect(await t.app.operations.countByStatus()).toEqual({});
    const args = {
      entityType: 'deal',
      recordId: 5,
      text: 'Согласовали скидку 5%',
      idempotencyKey: randomUUID(),
    };
    const prep = await call('crm_timeline_comment_add', args);
    expect(prep.error?.code).toBe('APPROVAL_REQUIRED');
    expect(prep.error?.details['plan']).toMatchObject({
      target: 'crm.deal:5',
      details: { text: 'Согласовали скидку 5%' },
    });
    const operationId = prep.error?.details['operationId'] as string;
    await t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
    const done = await call('crm_timeline_comment_add', { ...args, approvalId: operationId });
    expect(done.data).toMatchObject({ commentId: 901, verified: true, replayed: false });
    expect(t.bitrix.callsTo('crm.timeline.comment.add')[0]?.body).toEqual({
      fields: { ENTITY_ID: 5, ENTITY_TYPE: 'deal', COMMENT: 'Согласовали скидку 5%' },
    });
    const again = await call('crm_timeline_comment_add', { ...args, approvalId: operationId });
    expect(again.data?.['replayed']).toBe(true);
    expect(t.bitrix.callsTo('crm.timeline.comment.add')).toHaveLength(1);
  });

  it('T32: пустой список без allowEmpty → EMPTY_REPLACEMENT_BLOCKED до плана; с allowEmpty — отдельный план «сделка останется без товаров» и новое подтверждение', async () => {
    const blocked = await call('crm_deal_products_replace', {
      dealId: 5,
      productRows: [],
      idempotencyKey: randomUUID(),
    });
    expect(blocked.error?.code).toBe('VALIDATION_ERROR');
    expect(blocked.error?.details['reason']).toBe('EMPTY_REPLACEMENT_BLOCKED');
    expect(await t.app.operations.countByStatus()).toEqual({});
    expect(t.bitrix.callsTo('crm.item.productrow.set')).toHaveLength(0);

    const key = randomUUID();
    const prep = await call('crm_deal_products_replace', {
      dealId: 5,
      productRows: [],
      allowEmpty: true,
      idempotencyKey: key,
    });
    expect(prep.error?.code).toBe('APPROVAL_REQUIRED');
    const plan = prep.error?.details['plan'] as { risks: string[]; details: Record<string, unknown> };
    expect(plan.risks[0]).toContain('СДЕЛКА ОСТАНЕТСЯ БЕЗ ТОВАРОВ');
    expect(plan.details).toMatchObject({ total: { before: 52400, after: 0 }, added: [] });
    expect((plan.details['removed'] as unknown[]).length).toBe(2);
    // Подтверждение пустой замены нельзя «перенести» на вызов без allowEmpty: другие аргументы → другой хеш
    const operationId = prep.error?.details['operationId'] as string;
    await t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
    const mismatch = await call('crm_deal_products_replace', {
      dealId: 5,
      productRows: [],
      idempotencyKey: key,
      approvalId: operationId,
    });
    expect(mismatch.error?.details['reason']).toBe('EMPTY_REPLACEMENT_BLOCKED');
    const done = await call('crm_deal_products_replace', {
      dealId: 5,
      productRows: [],
      allowEmpty: true,
      idempotencyKey: key,
      approvalId: operationId,
    });
    expect(done.data).toMatchObject({ verified: true, savedCount: 0 });
    expect(t.bitrix.callsTo('crm.item.productrow.set')[0]?.body).toEqual({
      ownerType: 'D',
      ownerId: 5,
      productRows: [],
    });
  });

  it('замена: план с удаляемыми/добавляемыми строками и итогом; stateHash из dryRun защищает от гонки (CONFLICT до плана и в precheck)', async () => {
    const newRows = [
      { productId: 10, productName: 'Лицензия', price: 1200, quantity: 2, taxRate: 20, taxIncluded: true },
      { productName: 'Обучение', price: 15000, quantity: 1, discountTypeId: 2, discountRate: 10 },
    ];
    const dry = await call('crm_deal_products_replace', { dealId: 5, productRows: newRows, dryRun: true });
    expect(dry.success).toBe(true);
    const stateHash = dry.data?.['stateHash'] as string;
    const details = (dry.data?.['plan'] as { details: Record<string, unknown>; risks: string[] }).details;
    expect(details).toMatchObject({
      total: { before: 52400, after: 17400 },
      removed: [{ productName: 'Внедрение', price: 50000, quantity: 1 }],
      added: [{ productName: 'Обучение', price: 15000, quantity: 1, discountRate: 10 }],
      unchangedCount: 1,
    });
    // stateHash совпадает с тем, что даёт crm_deal_products_get
    const got = await call('crm_deal_products_get', { dealId: 5 });
    expect(got.data?.['stateHash']).toBe(stateHash);

    // кто-то поменял товары после чтения
    rows = [...rows, ROW(3, 0, 'Доставка', 500, 1)];
    const stale = await call('crm_deal_products_replace', {
      dealId: 5,
      productRows: newRows,
      expectedStateHash: stateHash,
      idempotencyKey: randomUUID(),
    });
    expect(stale.error?.code).toBe('CONFLICT');

    const fresh = (await call('crm_deal_products_get', { dealId: 5 })).data?.['stateHash'] as string;
    const args = { dealId: 5, productRows: newRows, expectedStateHash: fresh, idempotencyKey: randomUUID() };
    const prep = await call('crm_deal_products_replace', args);
    const operationId = prep.error?.details['operationId'] as string;
    await t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
    rows = rows.slice(0, 2); // изменение между подтверждением и записью
    const raced = await call('crm_deal_products_replace', { ...args, approvalId: operationId });
    expect(raced.error?.code).toBe('CONFLICT');
    expect(t.bitrix.callsTo('crm.item.productrow.set')).toHaveLength(0);
    expect((await call('operation_status', { operationId })).data?.['status']).toBe('failed');
  });

  it('замена: полный путь — одна запись crm.item.productrow.set с Y/N налогом, сверка состава, replay без второй записи; строка без товара и названия отклоняется схемой', async () => {
    const args = {
      dealId: 5,
      productRows: [{ productId: 10, price: 1200, quantity: 3, taxRate: 20, taxIncluded: true }],
      idempotencyKey: randomUUID(),
    };
    const prep = await call('crm_deal_products_replace', args);
    expect((prep.error?.details['plan'] as { risks: string[] }).risks.join(' ')).toContain(
      'expectedStateHash не передан',
    );
    const operationId = prep.error?.details['operationId'] as string;
    await t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
    const done = await call('crm_deal_products_replace', { ...args, approvalId: operationId });
    expect(done.data).toMatchObject({ verified: true, replayed: false, savedCount: 1 });
    expect(t.bitrix.callsTo('crm.item.productrow.set')[0]?.body).toEqual({
      ownerType: 'D',
      ownerId: 5,
      productRows: [{ productId: 10, price: 1200, quantity: 3, taxRate: 20, taxIncluded: 'Y' }],
    });
    const again = await call('crm_deal_products_replace', { ...args, approvalId: operationId });
    expect(again.data?.['replayed']).toBe(true);
    expect(t.bitrix.callsTo('crm.item.productrow.set')).toHaveLength(1);
    const bad = await client.callTool({
      name: 'crm_deal_products_replace',
      arguments: { dealId: 5, productRows: [{ price: 1 }], idempotencyKey: randomUUID() },
    });
    expect(bad.isError).toBe(true);
  });

  it('set без productRows в ответе → OPERATION_OUTCOME_UNKNOWN, повтор не пишет второй раз', async () => {
    t.bitrix.on('crm.item.productrow.set', legacyOk(true));
    const args = {
      dealId: 5,
      productRows: [{ productName: 'Услуга', price: 1, quantity: 1 }],
      idempotencyKey: randomUUID(),
    };
    const prep = await call('crm_deal_products_replace', args);
    const operationId = prep.error?.details['operationId'] as string;
    await t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
    const done = await call('crm_deal_products_replace', { ...args, approvalId: operationId });
    expect(done.error?.code).toBe('OPERATION_OUTCOME_UNKNOWN');
    const retry = await call('crm_deal_products_replace', { ...args, approvalId: operationId });
    expect(retry.error?.code).toBe('OPERATION_OUTCOME_UNKNOWN');
    expect(t.bitrix.callsTo('crm.item.productrow.set')).toHaveLength(1);
  });
});

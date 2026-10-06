/**
 * Открытые линии, генератор документов CRM и универсальные списки (2026-10-06).
 * Формы ответов — с официальных страниц методов; шаблоны документов — как на живом портале: result.templates —
 * объект по ID, и в нём поле downloadMachine с КОДОМ ВЕБХУКА в адресе. Ни одна ссылка не должна выйти наружу.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { findMethod } from '../../src/bitrix/method-registry.js';
import { connectInMemory, createTestApp, structured, type TestApp } from '../helpers/app.js';
import { DEAL_FIELDS, dealRecord, legacyOk } from '../helpers/mock-bitrix.js';
import { mockCrmItems } from '../helpers/mock-crm-items.js';

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

const SECRET = 'rest/1/5ecretwebhookcode/';
const TEMPLATES = {
  templates: {
    '175': {
      id: '175',
      name: 'Коммерческое предложение №',
      active: 'Y',
      numeratorId: '49',
      sort: '100',
      // Живой портал: сделки — по воронкам «2_category_N», счета — «31_1», плюс служебные коды склада.
      entityTypeId: [
        '2_category_0',
        '2_category_5',
        '7',
        '31_1',
        '16documentrealization',
        'bitrix\\crm\\integration\\documentgenerator\\dataprovider\\storedocumentarrival',
      ],
      download:
        'https://p.bitrix24.invalid/bitrix/services/main/ajax.php?action=crm.documentgenerator.template.download&id=175',
      downloadMachine: `https://p.bitrix24.invalid/${SECRET}crm.documentgenerator.template.download/?token=abc`,
    },
    '137': {
      id: '137',
      name: 'Договор',
      active: 'Y',
      sort: '200',
      entityTypeId: ['2_category_0'],
      numeratorId: null,
    },
    '120': { id: '120', name: 'Старый акт', active: 'N', sort: '300', entityTypeId: ['2_category_0'] },
    '110': { id: '110', name: 'Анкета лида', active: 'Y', sort: '400', entityTypeId: ['1'] },
  },
};
const docRaw = (id: number, extra: Record<string, unknown> = {}) => ({
  id: String(id),
  title: `Договор № ${String(id)}`,
  number: String(id),
  templateId: '137',
  entityTypeId: '2',
  entityId: '5',
  createTime: '2026-10-06T10:00:00+03:00',
  pdfId: '2979',
  pdfUrl: `https://p.bitrix24.invalid/ajax.php?action=getPdf&id=${String(id)}`,
  downloadUrl: `https://p.bitrix24.invalid/ajax.php?action=download&id=${String(id)}`,
  pdfUrlMachine: `https://p.bitrix24.invalid/${SECRET}crm.documentgenerator.document.getpdf/?token=xyz`,
  publicUrl: null,
  values: { Client: 'ООО Ромашка', Inn: '7700000000' },
  ...extra,
});
let docs: Record<string, unknown>[];
/** Живой портал: document.get не присылает pdfId (только pdfUrl и т. п.). */
const withoutPdfId = (d: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'pdfId'));

const HISTORY = {
  chatId: 1763,
  sessionId: 321,
  message: {
    '85851': {
      id: '85851',
      chatid: '1763',
      senderid: '103',
      date: '2026-10-06T13:12:46+03:00',
      text: 'Откройте [b]карточку[/b], [url=https://x.invalid]ссылка[/url]',
      params: { fileId: [5437] },
    },
    '85833': {
      id: '85833',
      chatid: '1763',
      senderid: '0',
      date: '2026-10-06T13:09:25+03:00',
      text: '[b]Создан новый лид[/b]',
    },
    '85840': {
      id: '85840',
      chatid: '1763',
      senderid: '599',
      date: '2026-10-06T13:10:00+03:00',
      text: 'Здравствуйте! Нужен[br]договор',
    },
  },
  users: {
    '103': { id: 103, name: 'Оператор Ольга', connector: false },
    '599': { id: 599, name: 'Клиент Иван', connector: true },
  },
  files: {
    '5437': {
      id: 5437,
      name: 'scan.pdf',
      type: 'file',
      size: 2048,
      urlDownload: `https://p.bitrix24.invalid/${SECRET}disk.file?token=f`,
      urlShow: 'https://p.bitrix24.invalid/show',
    },
  },
  chat: {
    '1763': {
      id: 1763,
      name: 'Иван — Telegram',
      entityId: 'telegrambot|22|1775|599',
      entityData2: 'LEAD|1209|COMPANY|0|CONTACT|0|DEAL|0',
    },
  },
};

const LIST_FIELDS = {
  NAME: { FIELD_ID: 'NAME', NAME: 'Название', TYPE: 'NAME', IS_REQUIRED: 'Y', MULTIPLE: 'N' },
  PROPERTY_951: {
    FIELD_ID: 'PROPERTY_951',
    NAME: 'Исполнители',
    TYPE: 'S:employee',
    IS_REQUIRED: 'N',
    MULTIPLE: 'Y',
  },
  PROPERTY_1151: {
    FIELD_ID: 'PROPERTY_1151',
    NAME: 'Статус',
    TYPE: 'L',
    IS_REQUIRED: 'N',
    MULTIPLE: 'N',
    DISPLAY_VALUES_FORM: { '1669': 'Планирование', '1675': 'Завершено' },
  },
};
const ELEMENTS = [
  {
    ID: '6999',
    NAME: 'Акт сверки',
    CODE: '',
    CREATED_BY: '1',
    DATE_CREATE: '06.10.2026',
    PROPERTY_951: { '3743': '1269', '3745': '1271' },
    PROPERTY_1151: { '3800': '1675' },
    PROPERTY_777: { '1': 'x' },
  },
];

function setup(): void {
  t = createTestApp({ BITRIX_REQUESTS_PER_SECOND: '10', READ_ONLY_MODE: 'false' });
  docs = [docRaw(833), docRaw(820, { pdfId: '0' })];
  mockCrmItems(t.bitrix);
  t.bitrix
    .on('crm.deal.fields', legacyOk(DEAL_FIELDS))
    .on('crm.deal.get', (c) => {
      const id = Number(c.body['id']);
      if (id === 5) return legacyOk(dealRecord(5));
      if (id === 6) return legacyOk(dealRecord(6, { CATEGORY_ID: '5' }));
      return { status: 400, body: { error: 'NOT_FOUND', error_description: 'Not found' } };
    })
    .on(
      'imopenlines.config.list.get',
      legacyOk([{ ID: '1', LINE_NAME: 'Сайт и мессенджеры', ACTIVE: 'Y', QUEUE: [1, 2] }]),
    )
    .on(
      'imopenlines.crm.chat.get',
      legacyOk([{ CHAT_ID: '1763', CONNECTOR_ID: 'telegrambot', CONNECTOR_TITLE: 'Telegram' }]),
    )
    .on('imopenlines.session.history.get', legacyOk(HISTORY))
    .on('crm.documentgenerator.template.list', legacyOk(TEMPLATES, { total: 4 }))
    .on('crm.documentgenerator.document.get', (c) => {
      const d = docs.find((x) => Number(x['id']) === Number(c.body['id']));
      return d
        ? legacyOk({ document: withoutPdfId(d) })
        : { status: 400, body: { error: '100', error_description: 'Document not found' } };
    })
    .on('crm.documentgenerator.document.add', (c) => {
      const d = docRaw(901, {
        templateId: String(c.body['templateId']),
        entityId: String(c.body['entityId']),
        pdfId: '0',
      });
      docs.unshift(d);
      return legacyOk({ document: d });
    })
    .on(
      'lists.get',
      legacyOk([{ ID: '89', NAME: 'Реестр актов', CODE: 'acts', DESCRIPTION: '', ACTIVE: 'Y' }], {
        total: 1,
      }),
    )
    .on('lists.field.get', legacyOk(LIST_FIELDS))
    .on('lists.element.get', legacyOk(ELEMENTS, { total: 1 }));
  // Ответ document.list в форме страницы: {documents: [...]}
  t.bitrix.on('crm.documentgenerator.document.list', (c) => {
    const start = Number(c.body['start'] ?? 0);
    return legacyOk({ documents: docs.slice(start, start + 50) }, { total: docs.length });
  });
}

beforeEach(async () => {
  setup();
  const c = await connectInMemory(t.app);
  client = c.client;
  close = () => c.close();
});
afterEach(async () => {
  await close();
  t.app.close();
});

const noLinks = (v: unknown) => {
  const s = JSON.stringify(v);
  expect(s).not.toContain(SECRET);
  expect(s).not.toMatch(/https?:\/\//);
  expect(s).not.toMatch(/download|urlShow|Machine/);
};

describe('открытые линии', () => {
  it('openlines_list: ID, название, активность; очередь операторов не запрашивается и не отдаётся', async () => {
    const r = await call('openlines_list', {});
    expect(r.data).toEqual({
      items: [{ id: 1, name: 'Сайт и мессенджеры', active: true }],
      returnedCount: 1,
    });
    expect(t.bitrix.callsTo('imopenlines.config.list.get')[0]?.body).toEqual({
      PARAMS: { select: ['ID', 'LINE_NAME', 'ACTIVE'], order: { ID: 'asc' }, limit: 200 },
    });
  });

  it('openlines_crm_chats: запись читается первой (NOT_FOUND), по умолчанию все чаты (ACTIVE_ONLY=N)', async () => {
    expect((await call('openlines_crm_chats', { entityType: 'deal', recordId: 999 })).error?.code).toBe(
      'NOT_FOUND',
    );
    const r = await call('openlines_crm_chats', { entityType: 'deal', recordId: 5 });
    expect(r.data).toMatchObject({
      items: [{ chatId: 1763, connectorId: 'telegrambot', connectorTitle: 'Telegram' }],
    });
    expect(t.bitrix.callsTo('imopenlines.crm.chat.get')[0]?.body).toEqual({
      CRM_ENTITY_TYPE: 'deal',
      CRM_ENTITY: 5,
      ACTIVE_ONLY: 'N',
    });
  });

  it('openlines_chat_history: по времени, автор клиент/оператор/система, текст без BB-кодов, файлы без ссылок, привязки CRM', async () => {
    const r = await call('openlines_chat_history', { chatId: 1763 });
    expect(r.data).toMatchObject({
      chatId: 1763,
      sessionId: 321,
      chatName: 'Иван — Telegram',
      connectorId: 'telegrambot',
      crm: { lead: 1209 },
      returnedCount: 3,
      totalInSession: 3,
    });
    const msgs = r.data?.['messages'] as Record<string, unknown>[];
    expect(msgs.map((m) => [m['authorKind'], m['authorName'], m['text']])).toEqual([
      ['system', 'Система', 'Создан новый лид'],
      ['client', 'Клиент Иван', 'Здравствуйте! Нужен\nдоговор'],
      ['operator', 'Оператор Ольга', 'Откройте карточку, ссылка'],
    ]);
    expect(msgs[2]?.['files']).toEqual([{ name: 'scan.pdf', type: 'file', size: 2048 }]);
    noLinks(r.data);
  });

  it('openlines_chat_history: maxMessages — последние сообщения и пометка неполноты; без chatId и sessionId — ошибка схемы', async () => {
    const r = await call('openlines_chat_history', { sessionId: 321, maxMessages: 1 });
    expect((r.data?.['messages'] as unknown[]).length).toBe(1);
    expect(r.meta['completeness']).toBe('partial');
    expect(t.bitrix.callsTo('imopenlines.session.history.get')[0]?.body).toEqual({ SESSION_ID: 321 });
    const bad = await client.callTool({ name: 'openlines_chat_history', arguments: {} });
    expect(bad.isError).toBe(true);
  });

  it('прямой вызов истории линий закрыт (ссылки на файлы)', async () => {
    const r = await call('bitrix_rest_call', {
      apiVersion: 'legacy',
      method: 'imopenlines.session.history.get',
      params: { CHAT_ID: 1 },
    });
    expect(r.error?.code).toBe('METHOD_NOT_ALLOWED');
  });
});

describe('генератор документов CRM', () => {
  it('шаблоны: объект по ID как на живом портале; только активные и для нужного типа; ссылок и кода вебхука нет', async () => {
    const r = await call('crm_document_templates_list', { entityType: 'deal' });
    expect(
      (r.data?.['items'] as Record<string, unknown>[]).map((x) => [x['id'], x['name'], x['entityTypes']]),
    ).toEqual([
      [175, 'Коммерческое предложение №', ['deal', 'quote', 'invoice']],
      [137, 'Договор', ['deal']],
    ]);
    noLinks(r.data);
    const all = await call('crm_document_templates_list', { includeInactive: true });
    expect(all.data?.['returnedCount']).toBe(4);
  });

  it('документы записи: фильтр по типу и ID, признак готовности PDF; ссылки и значения полей не отдаются', async () => {
    const r = await call('crm_documents_list', { entityType: 'deal', recordId: 5 });
    expect(r.data).toMatchObject({
      returnedCount: 2,
      items: [
        {
          id: 833,
          number: '833',
          templateId: 137,
          entityType: 'deal',
          entityId: 5,
          pdfReady: true,
          hasPublicLink: false,
        },
        { id: 820, pdfReady: false },
      ],
    });
    expect(t.bitrix.callsTo('crm.documentgenerator.document.list')[0]?.body['filter']).toEqual({
      entityTypeId: 2,
      entityId: 5,
    });
    noLinks(r.data);
    expect(JSON.stringify(r.data)).not.toContain('7700000000');
  });

  it('живые привязки «2_category_N»: шаблон подходит сделке только своей воронки; фильтр dealCategoryId; служебные коды пропущены', async () => {
    const r = await call('crm_document_templates_list', { entityType: 'deal', dealCategoryId: 5 });
    expect(r.data?.['items']).toEqual([
      {
        id: 175,
        name: 'Коммерческое предложение №',
        active: true,
        entityTypes: ['deal', 'quote', 'invoice'],
        dealCategoryIds: [0, 5],
        numeratorId: 49,
        sort: 100,
      },
    ]);
    const wrong = await call('crm_document_create', {
      templateId: 137,
      entityType: 'deal',
      recordId: 6,
      dryRun: true,
    });
    expect(wrong.error?.details['reason']).toBe('TEMPLATE_ENTITY_MISMATCH');
    expect(wrong.error?.message).toContain('воронкам: 0');
    const right = await call('crm_document_create', {
      templateId: 175,
      entityType: 'deal',
      recordId: 6,
      dryRun: true,
    });
    expect(right.data?.['plan']).toMatchObject({
      details: { templateId: 175, entityTypeId: 2, entityId: 6 },
    });
  });

  it('crm_document_get: карточка без ссылок; готовность PDF без pdfId — по наличию pdfUrl', async () => {
    const r = await call('crm_document_get', { id: 833 });
    expect(r.data).toMatchObject({ id: 833, pdfReady: true, isTransformationError: false });
    noLinks(r.data);
  });

  it('crm_document_create: шаблон не того типа / выключен — до плана; полный цикл план → подтверждение → документ; ссылок нет и в ledger', async () => {
    const lead = await call('crm_document_create', {
      templateId: 110,
      entityType: 'deal',
      recordId: 5,
      idempotencyKey: randomUUID(),
    });
    expect(lead.error?.details['reason']).toBe('TEMPLATE_ENTITY_MISMATCH');
    const off = await call('crm_document_create', {
      templateId: 120,
      entityType: 'deal',
      recordId: 5,
      idempotencyKey: randomUUID(),
    });
    expect(off.error?.details['reason']).toBe('TEMPLATE_INACTIVE');
    const none = await call('crm_document_create', {
      templateId: 999,
      entityType: 'deal',
      recordId: 5,
      idempotencyKey: randomUUID(),
    });
    expect(none.error?.code).toBe('NOT_FOUND');
    expect(await t.app.operations.countByStatus()).toEqual({});

    const args = {
      templateId: 175,
      entityType: 'deal',
      recordId: 5,
      values: { DocumentNumber: '15' },
      idempotencyKey: randomUUID(),
    };
    const prep = await call('crm_document_create', args);
    expect(prep.error?.code).toBe('APPROVAL_REQUIRED');
    const plan = prep.error?.details['plan'] as Record<string, unknown>;
    expect(plan['details']).toMatchObject({
      method: 'crm.documentgenerator.document.add',
      templateId: 175,
      entityTypeId: 2,
      entityId: 5,
    });
    expect(JSON.stringify(plan['risks'])).toContain('нумератора');
    const id = prep.error?.details['operationId'] as string;
    await t.app.approvals.approve(id, 'owner', t.app.auth.portalKey);
    const done = await call('crm_document_create', { ...args, approvalId: id });
    expect(done.data).toMatchObject({ documentId: 901, number: '901', verified: true });
    noLinks(done.data);
    const again = await call('crm_document_create', { ...args, approvalId: id });
    expect(again.data).toMatchObject({ documentId: 901, replayed: true });
    noLinks(again.data);
    expect(t.bitrix.callsTo('crm.documentgenerator.document.add')).toHaveLength(1);
  });

  it('КП (quote) — документ по шаблону, привязанному к КП', async () => {
    const r = await call('crm_document_create', {
      templateId: 175,
      entityType: 'quote',
      recordId: 29,
      dryRun: true,
    });
    expect(r.data?.['plan']).toMatchObject({ details: { entityTypeId: 7, entityId: 29 } });
  });

  it('реестр: генератор документов и история линий закрыты для прямого вызова независимо от политики', () => {
    for (const m of [
      'crm.documentgenerator.template.list',
      'crm.documentgenerator.document.list',
      'crm.documentgenerator.document.get',
      'crm.documentgenerator.document.add',
      'imopenlines.session.history.get',
    ]) {
      expect(findMethod('legacy', m)?.rawCallable, m).toBe(false);
    }
  });

  it('прямой вызов генератора документов закрыт: в шаблонах приходит адрес с кодом вебхука', async () => {
    const r = await call('bitrix_rest_call', {
      apiVersion: 'legacy',
      method: 'crm.documentgenerator.template.list',
      params: {},
    });
    expect(r.error?.code).toBe('METHOD_NOT_ALLOWED');
  });
});

describe('универсальные списки', () => {
  it('lists_list и lists_fields_get', async () => {
    expect((await call('lists_list', {})).data).toMatchObject({
      items: [{ id: 89, name: 'Реестр актов', code: 'acts', active: true }],
    });
    expect(t.bitrix.callsTo('lists.get')[0]?.body).toMatchObject({ IBLOCK_TYPE_ID: 'lists' });
    const f = await call('lists_fields_get', { iblockId: 89 });
    expect(f.data?.['items']).toEqual(
      expect.arrayContaining([
        {
          fieldId: 'PROPERTY_1151',
          name: 'Статус',
          type: 'L',
          required: false,
          multiple: false,
          values: { '1669': 'Планирование', '1675': 'Завершено' },
        },
      ]),
    );
  });

  it('lists_elements_list: свойства подписаны названиями полей, варианты списка — текстом; поиск по названию; неизвестное поле — кодом с предупреждением', async () => {
    const r = await call('lists_elements_list', { iblockId: 89, nameContains: 'Акт' });
    expect(r.data).toMatchObject({
      items: [
        {
          id: 6999,
          name: 'Акт сверки',
          createdBy: 1,
          fields: { Исполнители: ['1269', '1271'], Статус: 'Завершено', PROPERTY_777: 'x' },
        },
      ],
    });
    expect(t.bitrix.callsTo('lists.element.get')[0]?.body).toMatchObject({
      IBLOCK_ID: 89,
      FILTER: { '%NAME': 'Акт' },
    });
    expect(JSON.stringify(r.meta['warnings'])).toContain('PROPERTY_777');
  });
});

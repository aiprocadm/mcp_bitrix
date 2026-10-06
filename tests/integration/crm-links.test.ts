/**
 * Живой портал 2026-10-06: связи CRM (контакты сделки, компании контакта), справочники (crm.status.add/update),
 * коммерческие предложения (crm.item.*, entityTypeId=7), сводка по всем воронкам и по лидам, тела писем в делах.
 * Формы ответов — с официальных страниц методов и живого портала (пустой код ошибки + «Not found.»).
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { connectInMemory, createTestApp, structured, type TestApp } from '../helpers/app.js';
import {
  DEAL_FIELDS,
  dealRecord,
  legacyListPage,
  legacyOk,
  type MockResponse,
} from '../helpers/mock-bitrix.js';
import {
  companyRecord,
  contactRecord,
  DEAL_CATEGORIES,
  STATUS_ENTITY_TYPES,
  STATUS_LISTS,
} from '../helpers/mock-crm.js';
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

/** Ответ портала на отсутствующую запись у crm.deal.contact.*: пустой код и «Not found.» (HTTP 400). */
const NOT_FOUND_EMPTY: MockResponse = { status: 400, body: { error: '', error_description: 'Not found.' } };

let dealContacts: Map<number, { CONTACT_ID: number; SORT: number; ROLE_ID: number; IS_PRIMARY: string }[]>;
let contactCompanies: Map<
  number,
  { COMPANY_ID: number; SORT: number; ROLE_ID: number; IS_PRIMARY: string }[]
>;
let statuses: Record<string, Record<string, unknown>[]>;
let nextStatusId: number;

const DEALS = [
  ...Array.from({ length: 6 }, (_, i) => ({
    ID: String(i + 1),
    CATEGORY_ID: '0',
    STAGE_ID: ['NEW', 'WON', 'LOSE'][i % 3],
    OPPORTUNITY: '1000.00',
    CURRENCY_ID: 'RUB',
  })),
  ...Array.from({ length: 3 }, (_, i) => ({
    ID: String(i + 10),
    CATEGORY_ID: '5',
    STAGE_ID: i === 0 ? 'C5:WON' : 'C5:NEW',
    OPPORTUNITY: '500.00',
    CURRENCY_ID: 'RUB',
  })),
];
const LEADS = [
  { ID: '1', STATUS_ID: 'NEW', SOURCE_ID: 'CALL', OPPORTUNITY: '0', CURRENCY_ID: 'RUB' },
  { ID: '2', STATUS_ID: 'NEW', SOURCE_ID: 'CALL', OPPORTUNITY: '0', CURRENCY_ID: 'RUB' },
  { ID: '3', STATUS_ID: 'JUNK', SOURCE_ID: 'WEB', OPPORTUNITY: '0', CURRENCY_ID: 'RUB' },
  { ID: '4', STATUS_ID: 'CONVERTED', SOURCE_ID: '', OPPORTUNITY: '0', CURRENCY_ID: 'RUB' },
];
const EMAIL_HTML =
  '<html><body><p>Добрый день!</p><p>Направляем&nbsp;КП <b>№29</b>.</p><ul><li>Охрана труда</li></ul></body></html>';
const ACTIVITIES = [
  {
    ID: '1',
    TYPE_ID: '4',
    SUBJECT: 'Письмо',
    DESCRIPTION: EMAIL_HTML,
    DESCRIPTION_TYPE: '3',
    COMPLETED: 'Y',
  },
  {
    ID: '2',
    TYPE_ID: '4',
    SUBJECT: 'Длинное',
    DESCRIPTION: `<p>${'а'.repeat(500)}</p>`,
    DESCRIPTION_TYPE: '3',
  },
  { ID: '3', TYPE_ID: '2', SUBJECT: 'Звонок', DESCRIPTION: 'Перезвонить', DESCRIPTION_TYPE: '1' },
];

function setup(): void {
  t = createTestApp({ BITRIX_REQUESTS_PER_SECOND: '10', READ_ONLY_MODE: 'false' });
  dealContacts = new Map([[5, [{ CONTACT_ID: 31, SORT: 10, ROLE_ID: 0, IS_PRIMARY: 'Y' }]]]);
  contactCompanies = new Map([[31, []]]);
  // Числовые ID, как на живом портале (общая подделка STATUS_LISTS использует текстовые).
  let n = 100;
  statuses = Object.fromEntries(
    Object.entries(structuredClone(STATUS_LISTS)).map(([k, list]) => [
      k,
      list.map((x) => ({ ...x, ID: String(n++) })),
    ]),
  );
  nextStatusId = 900;
  mockCrmItems(t.bitrix); // crm.item.*; маршруты crm.status.list и crm.category.list ниже перекрывают его
  t.bitrix
    .on('crm.deal.fields', legacyOk(DEAL_FIELDS))
    .on('crm.deal.get', (c) =>
      Number(c.body['id']) === 5
        ? legacyOk(dealRecord(5))
        : { status: 400, body: { error: 'NOT_FOUND', error_description: 'Not found' } },
    )
    .on('crm.contact.get', (c) =>
      [31, 32].includes(Number(c.body['id']))
        ? legacyOk(contactRecord(Number(c.body['id'])))
        : { status: 400, body: { error: 'NOT_FOUND', error_description: 'Not found' } },
    )
    .on('crm.company.get', (c) =>
      Number(c.body['id']) === 41
        ? legacyOk(companyRecord(41))
        : { status: 400, body: { error: 'NOT_FOUND', error_description: 'Not found' } },
    )
    .on('crm.contact.list', (c) => {
      const ids = ((c.body['filter'] ?? {}) as Record<string, unknown>)['@ID'] as number[];
      return legacyOk(
        ids.map((id) => contactRecord(id)),
        { total: ids.length },
      );
    })
    .on('crm.company.list', (c) => {
      const ids = ((c.body['filter'] ?? {}) as Record<string, unknown>)['@ID'] as number[];
      return legacyOk(
        ids.map((id) => companyRecord(id)),
        { total: ids.length },
      );
    })
    .on('crm.deal.contact.items.get', (c) => {
      const list = dealContacts.get(Number(c.body['id']));
      return list ? legacyOk(list) : NOT_FOUND_EMPTY;
    })
    .on('crm.deal.contact.add', (c) => {
      const list = dealContacts.get(Number(c.body['id']));
      if (!list) return NOT_FOUND_EMPTY;
      const f = c.body['fields'] as Record<string, unknown>;
      const id = Number(f['CONTACT_ID']);
      if (list.some((x) => x.CONTACT_ID === id)) return legacyOk(false);
      const primary =
        f['IS_PRIMARY'] === 'Y' || (f['IS_PRIMARY'] === undefined && !list.some((x) => x.IS_PRIMARY === 'Y'));
      if (primary) for (const x of list) x.IS_PRIMARY = 'N';
      list.push({ CONTACT_ID: id, SORT: 20, ROLE_ID: 0, IS_PRIMARY: primary ? 'Y' : 'N' });
      return legacyOk(true);
    })
    // Официальная страница: на несуществующий контакт — пустой массив, а не ошибка.
    .on('crm.contact.company.items.get', (c) => legacyOk(contactCompanies.get(Number(c.body['id'])) ?? []))
    .on('crm.contact.company.add', (c) => {
      const list = contactCompanies.get(Number(c.body['id'])) ?? [];
      const f = c.body['fields'] as Record<string, unknown>;
      const id = Number(f['COMPANY_ID']);
      if (list.some((x) => x.COMPANY_ID === id)) return legacyOk(false);
      list.push({ COMPANY_ID: id, SORT: 10, ROLE_ID: 0, IS_PRIMARY: list.length === 0 ? 'Y' : 'N' });
      contactCompanies.set(Number(c.body['id']), list);
      return legacyOk(true);
    })
    .on(
      'crm.status.entity.types',
      legacyOk([...STATUS_ENTITY_TYPES, { ID: 'QUOTE_STATUS', NAME: 'Стадии предложения' }]),
    )
    .on('crm.status.list', (c) => {
      const entityId = ((c.body['filter'] ?? {}) as Record<string, unknown>)['ENTITY_ID'];
      if (entityId === 'QUOTE_STATUS')
        return legacyOk([
          { ID: '501', ENTITY_ID: 'QUOTE_STATUS', STATUS_ID: 'DRAFT', NAME: 'Новое', SORT: '10' },
          {
            ID: '502',
            ENTITY_ID: 'QUOTE_STATUS',
            STATUS_ID: 'APPROVED',
            NAME: 'Принято',
            SORT: '30',
            SEMANTICS: 'S',
          },
        ]);
      return legacyOk(typeof entityId === 'string' ? (statuses[entityId] ?? []) : []);
    })
    .on('crm.status.get', (c) => {
      for (const list of Object.values(statuses)) {
        const i = list.findIndex((x) => Number(x['ID']) === Number(c.body['id']));
        if (i >= 0) return legacyOk({ ID: String(c.body['id']), ...list[i] });
      }
      return { status: 400, body: { error: '', error_description: 'Status is not found.' } };
    })
    .on('crm.status.add', (c) => {
      const f = c.body['fields'] as Record<string, unknown>;
      const id = nextStatusId++;
      const list = statuses[String(f['ENTITY_ID'])] ?? [];
      list.push({ ID: String(id), SYSTEM: 'N', ...f });
      statuses[String(f['ENTITY_ID'])] = list;
      return legacyOk(id);
    })
    .on('crm.status.update', (c) => {
      for (const list of Object.values(statuses)) {
        const i = list.findIndex((x) => Number(x['ID']) === Number(c.body['id']));
        const row = list[i];
        if (row) {
          Object.assign(row, c.body['fields'] as Record<string, unknown>);
          return legacyOk(true);
        }
      }
      return { status: 400, body: { error: '', error_description: 'Status is not found.' } };
    })
    .on('crm.category.list', (c) =>
      Number(c.body['entityTypeId']) === 7
        ? {
            status: 400,
            body: {
              error: 'ENTITY_TYPE_NOT_SUPPORTED',
              error_description: 'Сущность CRM Предложение не поддерживается',
            },
          }
        : legacyOk(DEAL_CATEGORIES),
    )
    .on('crm.deal.list', (c) => legacyListPage(DEALS, Number(c.body['start'] ?? 0), 50))
    .on('crm.lead.list', (c) => {
      // Портал отдаёт только запрошенные в select поля.
      const select = c.body['select'] as string[];
      const rows = LEADS.map((l) =>
        Object.fromEntries(Object.entries(l).filter(([k]) => select.includes(k))),
      );
      return legacyListPage(rows, Number(c.body['start'] ?? 0), 50);
    })
    .on('crm.activity.list', (c) => {
      const filter = (c.body['filter'] ?? {}) as Record<string, unknown>;
      const items = ACTIVITIES.filter(
        (a) => filter['TYPE_ID'] === undefined || Number(a.TYPE_ID) === filter['TYPE_ID'],
      );
      const select = c.body['select'] as string[];
      return legacyListPage(
        items.map((a) => Object.fromEntries(Object.entries(a).filter(([k]) => select.includes(k)))),
        Number(c.body['start'] ?? 0),
        50,
      );
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

async function approveAndRun(
  name: string,
  args: Record<string, unknown>,
): Promise<{ prep: Env; done: Env; id: string }> {
  const prep = await call(name, args);
  expect(prep.error?.code).toBe('APPROVAL_REQUIRED');
  const id = prep.error?.details['operationId'] as string;
  await t.app.approvals.approve(id, 'owner', t.app.auth.portalKey);
  const done = await call(name, { ...args, approvalId: id });
  return { prep, done, id };
}

describe('связи CRM', () => {
  it('crm_deal_contacts_list: все контакты с ФИО и признаком основного; нет сделки — NOT_FOUND', async () => {
    dealContacts.get(5)?.push({ CONTACT_ID: 32, SORT: 20, ROLE_ID: 0, IS_PRIMARY: 'N' });
    const r = await call('crm_deal_contacts_list', { dealId: 5 });
    expect(r.data).toMatchObject({
      ownerId: 5,
      returnedCount: 2,
      items: [
        { id: 31, title: 'Контактов31 Пётр', isPrimary: true },
        { id: 32, title: 'Контактов32 Пётр', isPrimary: false },
      ],
    });
    const missing = await call('crm_deal_contacts_list', { dealId: 999 });
    expect(missing.error?.code).toBe('NOT_FOUND');
  });

  it('пустой код ошибки с «Not found.» распознаётся как NOT_FOUND, а не сбой портала', async () => {
    t.bitrix.on('crm.deal.get', legacyOk(dealRecord(77)));
    const r = await call('crm_deal_contacts_list', { dealId: 77 });
    expect(r.error?.code).toBe('NOT_FOUND');
  });

  it('crm_deal_contact_add: план со сменой основного → подтверждение → одна запись → сверка; повтор — replay', async () => {
    const args = { dealId: 5, contactId: 32, isPrimary: true, idempotencyKey: randomUUID() };
    const { prep, done, id } = await approveAndRun('crm_deal_contact_add', args);
    const plan = prep.error?.details['plan'] as Record<string, unknown>;
    expect(plan).toMatchObject({
      target: 'crm.deal:5',
      details: {
        method: 'crm.deal.contact.add',
        fields: { CONTACT_ID: 32, IS_PRIMARY: 'Y' },
        currentPrimaryId: 31,
      },
    });
    expect(JSON.stringify(plan['risks'])).toContain('Основной сменится');
    expect(done.data).toMatchObject({
      ownerId: 5,
      linkedId: 32,
      linked: true,
      verified: true,
      replayed: false,
    });
    expect(dealContacts.get(5)).toEqual([
      { CONTACT_ID: 31, SORT: 10, ROLE_ID: 0, IS_PRIMARY: 'N' },
      { CONTACT_ID: 32, SORT: 20, ROLE_ID: 0, IS_PRIMARY: 'Y' },
    ]);
    const again = await call('crm_deal_contact_add', { ...args, approvalId: id });
    expect(again.data?.['replayed']).toBe(true);
    expect(t.bitrix.callsTo('crm.deal.contact.add')).toHaveLength(1);
  });

  it('crm_deal_contact_add: уже привязанный — CONFLICT ALREADY_LINKED до плана; нет контакта — NOT_FOUND', async () => {
    const dup = await call('crm_deal_contact_add', {
      dealId: 5,
      contactId: 31,
      idempotencyKey: randomUUID(),
    });
    expect(dup.error?.code).toBe('CONFLICT');
    expect(dup.error?.details['reason']).toBe('ALREADY_LINKED');
    const missing = await call('crm_deal_contact_add', {
      dealId: 5,
      contactId: 99,
      idempotencyKey: randomUUID(),
    });
    expect(missing.error?.code).toBe('NOT_FOUND');
    expect(await t.app.operations.countByStatus()).toEqual({});
  });

  it('crm_deal_contact_add: привязку успели сделать после подтверждения — precheck, операция failed, записи нет', async () => {
    const args = { dealId: 5, contactId: 32, idempotencyKey: randomUUID() };
    const prep = await call('crm_deal_contact_add', args);
    const id = prep.error?.details['operationId'] as string;
    await t.app.approvals.approve(id, 'owner', t.app.auth.portalKey);
    dealContacts.get(5)?.push({ CONTACT_ID: 32, SORT: 30, ROLE_ID: 0, IS_PRIMARY: 'N' });
    const done = await call('crm_deal_contact_add', { ...args, approvalId: id });
    expect(done.error?.code).toBe('CONFLICT');
    expect(done.error?.details['reason']).toBe('ALREADY_LINKED');
    expect(t.bitrix.callsTo('crm.deal.contact.add')).toHaveLength(0);
  });

  it('crm_contact_companies_list и crm_contact_company_add: контакт без компаний → привязка делает основной', async () => {
    expect((await call('crm_contact_companies_list', { contactId: 31 })).data).toMatchObject({
      returnedCount: 0,
    });
    // Пустой список у несуществующего контакта не маскирует отсутствие: владелец читается первым.
    expect((await call('crm_contact_companies_list', { contactId: 99 })).error?.code).toBe('NOT_FOUND');
    const { prep, done } = await approveAndRun('crm_contact_company_add', {
      contactId: 31,
      companyId: 41,
      idempotencyKey: randomUUID(),
    });
    expect((prep.error?.details['plan'] as Record<string, unknown>)['details']).toMatchObject({
      becomesPrimary: true,
      currentPrimaryId: null,
    });
    expect(done.data).toMatchObject({ linked: true, verified: true });
    expect((await call('crm_contact_companies_list', { contactId: 31 })).data).toMatchObject({
      items: [{ id: 41, title: '[MCP TEST] Компания 41', isPrimary: true }],
    });
  });
});

describe('справочники CRM: crm_status_create / crm_status_update', () => {
  it('стадия воронки DEAL_STAGE_5: план показывает итоговый код с префиксом C5:, сверка по crm.status.get', async () => {
    const { prep, done } = await approveAndRun('crm_status_create', {
      entityId: 'DEAL_STAGE_5',
      statusId: 'DECISION',
      name: 'Принятие решения',
      sort: 15,
      color: '#39A8EF',
      idempotencyKey: randomUUID(),
    });
    const plan = prep.error?.details['plan'] as Record<string, unknown>;
    expect(plan['details']).toMatchObject({
      fields: { ENTITY_ID: 'DEAL_STAGE_5', STATUS_ID: 'C5:DECISION', NAME: 'Принятие решения', SORT: 15 },
    });
    expect(JSON.stringify(plan['risks'])).toContain('Новая стадия появится в воронке');
    expect(done.data).toMatchObject({ statusId: 'C5:DECISION', id: 900, verified: true });
  });

  it('источник: код и семантика проверяются до плана — дубль, кириллица у стадии, семантика у не-стадии, нет справочника', async () => {
    const dup = await call('crm_status_create', {
      entityId: 'SOURCE',
      statusId: 'CALL',
      name: 'Звонок',
      idempotencyKey: randomUUID(),
    });
    expect(dup.error?.details['reason']).toBe('DUPLICATE_STATUS');
    const cyr = await call('crm_status_create', {
      entityId: 'STATUS',
      statusId: 'НОВЫЙ',
      name: 'x',
      idempotencyKey: randomUUID(),
    });
    expect(cyr.error?.details['reason']).toBe('INVALID_STATUS_ID');
    const sem = await call('crm_status_create', {
      entityId: 'SOURCE',
      statusId: 'AVITO',
      name: 'Авито',
      semantics: 'success',
      idempotencyKey: randomUUID(),
    });
    expect(sem.error?.details['reason']).toBe('NOT_A_STAGE_DIRECTORY');
    const none = await call('crm_status_create', {
      entityId: 'NO_SUCH',
      statusId: 'X',
      name: 'x',
      idempotencyKey: randomUUID(),
    });
    expect(none.error?.details['reason']).toBe('UNKNOWN_DIRECTORY');
    expect(await t.app.operations.countByStatus()).toEqual({});
    const ok = await call('crm_status_create', {
      entityId: 'SOURCE',
      statusId: 'AVITO',
      name: 'Авито',
      dryRun: true,
    });
    expect(ok.data).toMatchObject({ dryRun: true, statusId: 'AVITO' });
  });

  it('crm_status_update: план «было → станет» только по изменённым полям; нет изменений — NO_CHANGES; чужой stateHash — CONFLICT', async () => {
    const same = await call('crm_status_update', {
      entityId: 'SOURCE',
      statusId: 'CALL',
      name: 'Звонок',
      idempotencyKey: randomUUID(),
    });
    expect(same.error?.details['reason']).toBe('NO_CHANGES');
    const stale = await call('crm_status_update', {
      entityId: 'SOURCE',
      statusId: 'CALL',
      name: 'Входящий звонок',
      expectedStateHash: 'a'.repeat(64),
      idempotencyKey: randomUUID(),
    });
    expect(stale.error?.code).toBe('CONFLICT');
    const { prep, done } = await approveAndRun('crm_status_update', {
      entityId: 'SOURCE',
      statusId: 'CALL',
      name: 'Входящий звонок',
      sort: 10,
      idempotencyKey: randomUUID(),
    });
    expect((prep.error?.details['plan'] as Record<string, unknown>)['details']).toMatchObject({
      method: 'crm.status.update',
      fields: { NAME: 'Входящий звонок' },
      changes: { NAME: { from: 'Звонок', to: 'Входящий звонок' } },
    });
    expect(done.data).toMatchObject({ verified: true });
    expect(statuses['SOURCE']?.[0]?.['NAME']).toBe('Входящий звонок');
    const missing = await call('crm_status_update', {
      entityId: 'SOURCE',
      statusId: 'NOPE',
      name: 'x',
      idempotencyKey: randomUUID(),
    });
    expect(missing.error?.code).toBe('NOT_FOUND');
  });
});

describe('коммерческие предложения (entityType=quote, crm.item.* entityTypeId=7)', () => {
  it('список и карточка идут через crm.item.* с entityTypeId=7', async () => {
    const list = await call('crm_list_records', { entityType: 'quote' });
    expect(list.success).toBe(true);
    expect(t.bitrix.callsTo('crm.item.list')[0]?.body['entityTypeId']).toBe(7);
    const card = await call('crm_get_record', { entityType: 'quote', id: 29 });
    expect(card.success).toBe(true);
    expect(JSON.stringify(card.data)).toContain('[MCP TEST] КП 29');
  });

  it('создание: стадия сверяется с QUOTE_STATUS без запроса воронок (у КП их нет); чужая стадия — INVALID_STAGE', async () => {
    const bad = await call('crm_create_record', {
      entityType: 'quote',
      fields: { title: 'КП', stageId: 'C5:NEW', opened: 'Y' },
      idempotencyKey: randomUUID(),
    });
    expect(bad.error?.details['reason']).toBe('INVALID_STAGE');
    const { prep, done } = await approveAndRun('crm_create_record', {
      entityType: 'quote',
      fields: { title: 'КП на охрану труда', stageId: 'DRAFT', opened: 'Y', dealId: 5 },
      idempotencyKey: randomUUID(),
    });
    expect(JSON.stringify(prep.error?.details['plan'])).toContain('карточка КП');
    expect(done.data).toMatchObject({ verified: true });
    expect(
      t.bitrix.callsTo('crm.category.list').filter((c) => Number(c.body['entityTypeId']) === 7),
    ).toHaveLength(0);
    expect(t.bitrix.callsTo('crm.item.add')[0]?.body).toMatchObject({ entityTypeId: 7 });
  });

  it('entityTypeId для quote не передаётся', async () => {
    const r = await call('crm_list_records', { entityType: 'quote', entityTypeId: 31 });
    expect(r.error?.details['reason']).toBe('UNEXPECTED_ENTITY_TYPE_ID');
  });
});

describe('crm_pipelines_overview', () => {
  it('deal: все воронки за один проход — стадии, выиграно/проиграно/в работе, суммы', async () => {
    const r = await call('crm_pipelines_overview', {
      entityType: 'deal',
      from: '2026-01-01',
      to: '2026-12-31',
    });
    const groups = r.data?.['groups'] as Record<string, unknown>[];
    expect(
      groups.map((g) => [g['categoryId'], g['name'], g['count'], g['won'], g['lost'], g['inProgress']]),
    ).toEqual([
      [0, 'Общая', 6, 2, 2, 2],
      [5, 'Партнёры', 3, 1, 0, 2],
    ]);
    expect(r.data).toMatchObject({
      scannedCount: 9,
      hasMore: false,
      totals: { count: 9, sums: [{ currency: 'RUB', amount: 7500 }] },
    });
    expect(t.bitrix.callsTo('crm.deal.list')[0]?.body['filter']).toEqual({
      '>=DATE_CREATE': '2026-01-01',
      '<=DATE_CREATE': '2026-12-31',
    });
  });

  it('lead: стадии лидов и источники с названиями; поле даты сделок для лидов — VALIDATION_ERROR', async () => {
    const r = await call('crm_pipelines_overview', {
      entityType: 'lead',
      from: '2026-01-01',
      to: '2026-12-31',
    });
    expect(r.data?.['groups']).toMatchObject([{ name: 'Лиды', count: 4, won: 1, lost: 1, inProgress: 2 }]);
    expect(r.data?.['sources']).toEqual([
      { sourceId: 'CALL', name: 'Звонок', count: 2 },
      { sourceId: 'WEB', name: 'Веб-сайт', count: 1 },
      { sourceId: '', name: 'Не указан', count: 1 },
    ]);
    const bad = await call('crm_pipelines_overview', {
      entityType: 'lead',
      dateField: 'CLOSEDATE',
      from: '2026-01-01',
      to: '2026-12-31',
    });
    expect(bad.error?.code).toBe('VALIDATION_ERROR');
  });

  it('maxRecords останавливает просмотр и честно помечает неполноту', async () => {
    const r = await call('crm_pipelines_overview', {
      entityType: 'deal',
      from: '2026-01-01',
      to: '2026-12-31',
      maxRecords: 4,
    });
    expect(r.data).toMatchObject({ scannedCount: 4, hasMore: true, stoppedBy: 'maxRecords' });
    expect(r.meta['completeness']).toBe('partial');
  });
});

describe('crm_activities_list: письма', () => {
  it('kind=email фильтрует TYPE_ID=4; тело письма — обычный текст; длинное обрезается с пометкой', async () => {
    const r = await call('crm_activities_list', {
      entityType: 'deal',
      recordId: 5,
      kind: 'email',
      includeDescription: true,
      descriptionMaxChars: 200,
    });
    expect(t.bitrix.callsTo('crm.activity.list')[0]?.body['filter']).toMatchObject({ TYPE_ID: 4 });
    const items = r.data?.['items'] as Record<string, unknown>[];
    expect(items).toHaveLength(2);
    expect(items[0]?.['DESCRIPTION']).toBe('Добрый день!\n\nНаправляем КП №29.\n\n- Охрана труда');
    expect(items[0]?.['DESCRIPTION_TRUNCATED']).toBeUndefined();
    expect(items[1]).toMatchObject({ DESCRIPTION_TRUNCATED: true, DESCRIPTION_LENGTH: 500 });
    expect(String(items[1]?.['DESCRIPTION'])).toHaveLength(200);
  });

  it('без includeDescription текст не запрашивается', async () => {
    await call('crm_activities_list', { entityType: 'deal', recordId: 5 });
    expect(t.bitrix.callsTo('crm.activity.list')[0]?.body['select']).not.toContain('DESCRIPTION');
  });
});

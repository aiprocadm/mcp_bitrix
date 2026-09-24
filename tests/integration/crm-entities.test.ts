/**
 * Этап 13, срез 10 (ТЗ §9.4, §11 п.1–2): классические сущности CRM — лид/контакт/компания в list/get/fields/create,
 * crm_update_record (expectedStateHash → CONFLICT, INVALID_STAGE, diff в плане, сверка), crm_stages_and_statuses,
 * crm_search_records (название/имя, телефон/email через findbycomm, QUERY_TOO_BROAD).
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { connectInMemory, createTestApp, structured, type TestApp } from '../helpers/app.js';
import {
  DEAL_FIELDS,
  dealRecord,
  legacyError,
  legacyListPage,
  legacyOk,
  type RecordedCall,
} from '../helpers/mock-bitrix.js';
import {
  COMPANY_FIELDS,
  CONTACT_FIELDS,
  companyRecord,
  contactRecord,
  DEAL_CATEGORIES,
  LEAD_FIELDS,
  leadRecord,
  STATUS_ENTITY_TYPES,
  STATUS_LISTS,
} from '../helpers/mock-crm.js';

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

const LEADS = [1, 2, 3].map((i) => leadRecord(i));
const CONTACTS = [10, 11].map((i) =>
  contactRecord(i, { PHONE: [{ VALUE: '+79990000001', VALUE_TYPE: 'WORK' }] }),
);
const COMPANIES = [20, 21].map((i) => companyRecord(i));
const DEALS = [1, 2].map((i) => dealRecord(i));
/** Изменяемое состояние «портала» для update-сценариев. */
let store: Record<string, Record<number, Record<string, unknown>>>;

function byId(rows: Record<string, unknown>[]): Record<number, Record<string, unknown>> {
  return Object.fromEntries(rows.map((r) => [Number(r['ID']), { ...r }]));
}

/** Запись «портала» для правки извне в сценариях гонки. */
function row(kind: string, id: number): Record<string, unknown> {
  const r = store[kind]?.[id];
  if (!r) throw new Error(`нет записи ${kind}:${String(id)}`);
  return r;
}

function listHandler(kind: string) {
  return (c: RecordedCall) => {
    const filter = (c.body['filter'] ?? {}) as Record<string, unknown>;
    let rows = Object.values(store[kind] ?? {});
    for (const [k, v] of Object.entries(filter)) {
      if (k.startsWith('%')) {
        const f = k.slice(1);
        rows = rows.filter((r) => {
          const val = r[f];
          return typeof val === 'string' && val.toLowerCase().includes(String(v).toLowerCase());
        });
      } else if (k === '@ID') {
        const ids = (v as unknown[]).map(String);
        rows = rows.filter((r) => ids.includes(String(r['ID'])));
      }
    }
    return legacyListPage(rows, Number(c.body['start'] ?? 0), 50);
  };
}

function getHandler(kind: string) {
  return (c: RecordedCall) => {
    const row = store[kind]?.[Number(c.body['id'])];
    return row ? legacyOk(row) : legacyError('NOT_FOUND', 400, 'Not found');
  };
}

function updateHandler(kind: string) {
  return (c: RecordedCall) => {
    const row = store[kind]?.[Number(c.body['id'])];
    if (!row) return legacyError('NOT_FOUND', 400, 'Not found');
    Object.assign(row, c.body['fields'] as Record<string, unknown>, {
      DATE_MODIFY: '2026-09-24T12:00:00+03:00',
    });
    return legacyOk(true);
  };
}

function setup(overrides: Record<string, string> = {}) {
  store = { lead: byId(LEADS), contact: byId(CONTACTS), company: byId(COMPANIES), deal: byId(DEALS) };
  t = createTestApp(overrides);
  t.bitrix
    .on('crm.deal.fields', legacyOk(DEAL_FIELDS))
    .on('crm.lead.fields', legacyOk(LEAD_FIELDS))
    .on('crm.contact.fields', legacyOk(CONTACT_FIELDS))
    .on('crm.company.fields', legacyOk(COMPANY_FIELDS))
    .on('crm.category.list', legacyOk(DEAL_CATEGORIES))
    .on('crm.status.entity.types', legacyOk(STATUS_ENTITY_TYPES))
    .on('crm.status.list', (c) => {
      const entityId = ((c.body['filter'] ?? {}) as Record<string, unknown>)['ENTITY_ID'];
      return legacyOk(typeof entityId === 'string' ? (STATUS_LISTS[entityId] ?? []) : []);
    })
    .on('crm.duplicate.findbycomm', (c) => {
      const values = (c.body['values'] as string[]).map((v) => v.replace(/\D/g, ''));
      const found: Record<string, number[]> = {};
      if (c.body['type'] === 'PHONE' && values.includes('79990000001')) found['CONTACT'] = [10, 11];
      if (c.body['type'] === 'EMAIL' && (c.body['values'] as string[]).includes('lead@example.com'))
        found['LEAD'] = [2];
      return legacyOk(found);
    });
  for (const kind of ['deal', 'lead', 'contact', 'company']) {
    t.bitrix
      .on(`crm.${kind}.list`, listHandler(kind))
      .on(`crm.${kind}.get`, getHandler(kind))
      .on(`crm.${kind}.update`, updateHandler(kind))
      .on(
        `crm.${kind}.add`,
        legacyOk(kind === 'lead' ? 501 : kind === 'contact' ? 502 : kind === 'company' ? 503 : 500),
      );
  }
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

describe('чтение лидов, контактов, компаний', () => {
  it('crm_fields_get для каждой сущности: свой метод, кэш по сущности, у контакта нет TITLE', async () => {
    const lead = await call('crm_fields_get', { entityType: 'lead' });
    expect(lead.data?.['required']).toEqual(['TITLE']);
    const contact = await call('crm_fields_get', { entityType: 'contact' });
    expect(contact.data?.['required']).toEqual([]);
    expect((contact.data?.['fields'] as { name: string }[]).map((f) => f.name)).not.toContain('TITLE');
    const company = await call('crm_fields_get', { entityType: 'company' });
    expect(company.meta['method']).toBe('crm.company.fields');
    await call('crm_fields_get', { entityType: 'lead' });
    expect(t.bitrix.callsTo('crm.lead.fields')).toHaveLength(1);
    const bad = await client.callTool({ name: 'crm_fields_get', arguments: { entityType: 'invoice' } });
    expect(bad.isError).toBe(true);
  });

  it('crm_list_records: свои поля по умолчанию, свои методы; фильтр по неизвестному полю сущности отклоняется', async () => {
    const leads = await call('crm_list_records', { entityType: 'lead', pageSize: 10 });
    expect(leads.success).toBe(true);
    expect(leads.data?.['returnedCount']).toBe(3);
    expect(leads.meta['method']).toBe('crm.lead.list');
    expect(t.bitrix.callsTo('crm.lead.list')[0]?.body['select'] as string[]).toContain('STATUS_ID');
    const contacts = await call('crm_list_records', {
      entityType: 'contact',
      filter: { '%LAST_NAME': 'Контактов' },
    });
    expect(contacts.data?.['returnedCount']).toBe(2);
    // STAGE_ID есть у сделки, но не у компании — схема каждой сущности своя
    const bad = await call('crm_list_records', { entityType: 'company', filter: { STAGE_ID: 'NEW' } });
    expect(bad.error?.code).toBe('VALIDATION_ERROR');
    expect(bad.error?.details['reason']).toBe('UNKNOWN_FIELD');
    expect(t.bitrix.callsTo('crm.company.list')).toHaveLength(0);
  });

  it('crm_get_record: контакт с составным именем и stateHash; чужой ID → NOT_FOUND', async () => {
    const env = await call('crm_get_record', { entityType: 'contact', id: 10 });
    expect(env.success).toBe(true);
    expect(env.data?.['title']).toBe('Контактов10 Пётр');
    expect(env.data?.['stateHash']).toMatch(/^[a-f0-9]{64}$/);
    const missing = await call('crm_get_record', { entityType: 'company', id: 999 });
    expect(missing.error?.code).toBe('NOT_FOUND');
  });
});

describe('crm_stages_and_statuses', () => {
  it('без аргументов — справочники; deal — воронки и стадии общей воронки; categoryId — другая воронка; lead — статусы', async () => {
    const dicts = await call('crm_stages_and_statuses', {});
    expect((dicts.data?.['dictionaries'] as { id: string }[]).map((d) => d.id)).toContain('DEAL_STAGE_5');
    const deal = await call('crm_stages_and_statuses', { entityType: 'deal' });
    expect(deal.data?.['selectedCategoryId']).toBe(0);
    expect((deal.data?.['categories'] as { id: number }[]).map((c) => c.id)).toEqual([0, 5]);
    expect(
      (deal.data?.['statuses'] as { statusId: string; semantics?: string }[]).map((s) => s.statusId),
    ).toEqual(['NEW', 'PREPARATION', 'WON', 'LOSE']);
    expect((deal.meta.warnings ?? []).join(' ')).toContain('categoryId');
    const funnel5 = await call('crm_stages_and_statuses', { entityType: 'deal', categoryId: 5 });
    expect((funnel5.data?.['statuses'] as { statusId: string }[]).map((s) => s.statusId)).toEqual([
      'C5:NEW',
      'C5:WON',
    ]);
    const lead = await call('crm_stages_and_statuses', { entityType: 'lead' });
    expect((lead.data?.['statuses'] as { entityId: string }[]).map((s) => s.entityId)).toEqual(
      expect.arrayContaining(['STATUS', 'SOURCE']),
    );
    const direct = await call('crm_stages_and_statuses', { statusEntityId: 'COMPANY_TYPE' });
    expect((direct.data?.['statuses'] as { statusId: string }[]).map((s) => s.statusId)).toEqual([
      'CUSTOMER',
      'SUPPLIER',
    ]);
    // справочник кэшируется
    const calls = t.bitrix.callsTo('crm.status.list').length;
    await call('crm_stages_and_statuses', { statusEntityId: 'COMPANY_TYPE' });
    expect(t.bitrix.callsTo('crm.status.list')).toHaveLength(calls);
  });
});

describe('crm_search_records', () => {
  it('по названию/фамилии во всех типах; телефон → контакты через findbycomm; email → лид; пустой/короткий запрос — QUERY_TOO_BROAD', async () => {
    const byName = await call('crm_search_records', { query: 'Контактов1' });
    expect(byName.success).toBe(true);
    const names = byName.data?.['candidates'] as {
      entityType: string;
      id: number;
      matchedBy: string;
      title: string;
    }[];
    expect(names.map((c) => `${c.entityType}:${String(c.id)}:${c.matchedBy}`)).toEqual([
      'contact:10:name',
      'contact:11:name',
    ]);
    expect(names[0]?.title).toBe('Контактов10 Пётр');
    const byPhone = await call('crm_search_records', {
      entityTypes: ['contact', 'deal'],
      phone: '+7 (999) 000-00-01',
    });
    expect(
      (byPhone.data?.['candidates'] as { id: number; matchedBy: string }[]).map((c) => c.matchedBy),
    ).toEqual(['phone', 'phone']);
    expect((byPhone.meta.warnings ?? []).join(' ')).toContain('Сделки');
    expect(t.bitrix.callsTo('crm.duplicate.findbycomm')[0]?.body).toMatchObject({
      type: 'PHONE',
      entity_type: 'CONTACT',
    });
    const byEmail = await call('crm_search_records', { email: 'lead@example.com' });
    expect(byEmail.data?.['candidates'] as { entityType: string; id: number }[]).toEqual([
      expect.objectContaining({ entityType: 'lead', id: 2 }),
    ]);
    const empty = await call('crm_search_records', {});
    expect(empty.error?.details['reason']).toBe('QUERY_TOO_BROAD');
    const short = await call('crm_search_records', { query: 'ab' });
    expect(short.error?.details['reason']).toBe('QUERY_TOO_BROAD');
  });
});

describe('запись: create для лида/контакта/компании и crm_update_record', () => {
  beforeEach(async () => {
    await close();
    t.app.close();
    await reconnect({ READ_ONLY_MODE: 'false' });
  });

  it('crm_create_record: лид со стадией вне справочника → INVALID_STAGE до плана; контакт создаётся и сверяется по имени', async () => {
    const badStage = await call('crm_create_record', {
      entityType: 'lead',
      fields: { TITLE: '[MCP TEST] лид', STATUS_ID: 'NOPE' },
      idempotencyKey: randomUUID(),
    });
    expect(badStage.error?.code).toBe('VALIDATION_ERROR');
    expect(badStage.error?.details['reason']).toBe('INVALID_STAGE');
    expect(t.app.operations.countByStatus()).toEqual({});

    store['contact'] = {
      ...store['contact'],
      502: contactRecord(502, { NAME: 'Анна', LAST_NAME: 'Тестова' }),
    };
    const key = randomUUID();
    const args = {
      entityType: 'contact',
      fields: { NAME: 'Анна', LAST_NAME: 'Тестова', PHONE: [{ VALUE: '+79990000002', VALUE_TYPE: 'WORK' }] },
      idempotencyKey: key,
    };
    const prep = await call('crm_create_record', args);
    expect(prep.error?.code).toBe('APPROVAL_REQUIRED');
    expect(prep.error?.details['plan']).toMatchObject({
      action: 'Создать контакт «Тестова Анна»',
      target: 'crm.contact',
    });
    expect((prep.error?.details['plan'] as { risks: string[] }).risks.join(' ')).toContain(
      'crm_search_records',
    );
    const operationId = prep.error?.details['operationId'] as string;
    t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
    const done = await call('crm_create_record', { ...args, approvalId: operationId });
    expect(done.data).toMatchObject({
      entityType: 'contact',
      id: 502,
      verified: true,
      record: { title: 'Тестова Анна' },
    });
    expect(t.bitrix.callsTo('crm.contact.add')[0]?.body).toEqual({
      fields: { NAME: 'Анна', LAST_NAME: 'Тестова', PHONE: [{ VALUE: '+79990000002', VALUE_TYPE: 'WORK' }] },
    });
  });

  it('crm_update_record: план с diff, expectedStateHash защищает от гонки (CONFLICT), стадия из другой воронки — INVALID_STAGE, после подтверждения — одна запись и сверка', async () => {
    const before = await call('crm_get_record', { entityType: 'deal', id: 1 });
    const stateHash = before.data?.['stateHash'] as string;

    const dry = await call('crm_update_record', {
      entityType: 'deal',
      id: 1,
      fields: { STAGE_ID: 'PREPARATION', OPPORTUNITY: 2500 },
      expectedStateHash: stateHash,
      dryRun: true,
    });
    expect(dry.success).toBe(true);
    expect(dry.data?.['plan']).toMatchObject({
      details: {
        changes: { STAGE_ID: { from: 'NEW', to: 'PREPARATION' }, OPPORTUNITY: { from: '1000.00', to: 2500 } },
      },
    });
    expect((dry.data?.['plan'] as { risks: string[] }).risks.join(' ')).toContain('STAGE_ID');

    const wrongFunnel = await call('crm_update_record', {
      entityType: 'deal',
      id: 1,
      fields: { STAGE_ID: 'C5:WON' },
      idempotencyKey: randomUUID(),
    });
    expect(wrongFunnel.error?.details['reason']).toBe('INVALID_STAGE');

    // кто-то изменил сделку после чтения
    row('deal', 1)['TITLE'] = 'Изменено извне';
    const stale = await call('crm_update_record', {
      entityType: 'deal',
      id: 1,
      fields: { OPPORTUNITY: 2500 },
      expectedStateHash: stateHash,
      idempotencyKey: randomUUID(),
    });
    expect(stale.error?.code).toBe('CONFLICT');
    expect(stale.error?.details['reason']).toBe('STATE_CHANGED');
    expect(t.bitrix.callsTo('crm.deal.update')).toHaveLength(0);

    const fresh = (await call('crm_get_record', { entityType: 'deal', id: 1 })).data?.['stateHash'] as string;
    const key = randomUUID();
    const args = {
      entityType: 'deal',
      id: 1,
      fields: { STAGE_ID: 'PREPARATION', OPPORTUNITY: 2500 },
      expectedStateHash: fresh,
      idempotencyKey: key,
    };
    const prep = await call('crm_update_record', args);
    expect(prep.error?.code).toBe('APPROVAL_REQUIRED');
    const operationId = prep.error?.details['operationId'] as string;
    t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
    const done = await call('crm_update_record', { ...args, approvalId: operationId });
    expect(done.success).toBe(true);
    expect(done.data).toMatchObject({
      id: 1,
      verified: true,
      replayed: false,
      changedFields: ['STAGE_ID', 'OPPORTUNITY'],
    });
    expect(done.data?.['stateHash']).not.toBe(fresh);
    expect(t.bitrix.callsTo('crm.deal.update')).toHaveLength(1);
    expect(t.bitrix.callsTo('crm.deal.update')[0]?.body).toEqual({
      id: 1,
      fields: { STAGE_ID: 'PREPARATION', OPPORTUNITY: 2500 },
    });
    expect(row('deal', 1)['STAGE_ID']).toBe('PREPARATION');
    const again = await call('crm_update_record', { ...args, approvalId: operationId });
    expect(again.data?.['replayed']).toBe(true);
    expect(t.bitrix.callsTo('crm.deal.update')).toHaveLength(1);
  });

  it('crm_update_record: изменение между подтверждением и записью → CONFLICT в precheck, запись не выполняется', async () => {
    const stateHash = (await call('crm_get_record', { entityType: 'company', id: 20 })).data?.[
      'stateHash'
    ] as string;
    const args = {
      entityType: 'company',
      id: 20,
      fields: { TITLE: '[MCP TEST] Компания 20 (переименована)' },
      expectedStateHash: stateHash,
      idempotencyKey: randomUUID(),
    };
    const prep = await call('crm_update_record', args);
    const operationId = prep.error?.details['operationId'] as string;
    t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
    row('company', 20)['INDUSTRY'] = 'OTHER';
    const done = await call('crm_update_record', { ...args, approvalId: operationId });
    expect(done.error?.code).toBe('CONFLICT');
    expect(t.bitrix.callsTo('crm.company.update')).toHaveLength(0);
    const status = await call('operation_status', { operationId });
    expect(status.data?.['status']).toBe('failed');
  });

  it('портал вернул не true на update → OPERATION_OUTCOME_UNKNOWN; immutable/read-only поля отклоняются', async () => {
    t.bitrix.on('crm.lead.update', legacyOk(null));
    const ro = await call('crm_update_record', {
      entityType: 'lead',
      id: 1,
      fields: { DATE_CREATE: '2026-01-01' },
      idempotencyKey: randomUUID(),
    });
    expect(ro.error?.details['reason']).toBe('READ_ONLY_FIELD');
    const args = { entityType: 'lead', id: 1, fields: { TITLE: 'x' }, idempotencyKey: randomUUID() };
    const prep = await call('crm_update_record', args);
    const operationId = prep.error?.details['operationId'] as string;
    t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
    const done = await call('crm_update_record', { ...args, approvalId: operationId });
    expect(done.error?.code).toBe('OPERATION_OUTCOME_UNKNOWN');
  });
});

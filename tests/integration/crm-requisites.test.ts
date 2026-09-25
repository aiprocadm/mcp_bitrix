/**
 * Этап 13 (ТЗ §9.4, §8.2): реквизиты, шаблоны, адреса, банковские реквизиты и запись дел CRM на mock.
 * Формы ответов — по страницам документации (crm.requisite.*, crm.address.*, crm.enum.addresstype,
 * crm.requisite.bankdetail.*, crm.activity.*). Реальный портал здесь не проверяется.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { connectInMemory, createTestApp, structured, type TestApp } from '../helpers/app.js';
import { dealRecord, legacyError, legacyListPage, legacyOk } from '../helpers/mock-bitrix.js';
import { companyRecord } from '../helpers/mock-crm.js';

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

const F = (type: string, title: string, extra: Record<string, boolean> = {}) => ({
  type,
  isRequired: false,
  isReadOnly: false,
  isImmutable: false,
  isMultiple: false,
  isDynamic: false,
  title,
  ...extra,
});

/** Усечённая форма ответа crm.requisite.fields из документации. */
const REQUISITE_FIELDS = {
  ID: F('integer', 'ID', { isReadOnly: true }),
  ENTITY_TYPE_ID: F('integer', 'Entity type ID', { isRequired: true, isImmutable: true }),
  ENTITY_ID: F('integer', 'Entity ID', { isRequired: true, isImmutable: true }),
  PRESET_ID: F('integer', 'Preset ID', { isRequired: true, isImmutable: true }),
  DATE_CREATE: F('datetime', 'Creation date', { isReadOnly: true }),
  DATE_MODIFY: F('datetime', 'Modification date', { isReadOnly: true }),
  NAME: F('string', 'Name', { isRequired: true }),
  ACTIVE: F('char', 'Active'),
  SORT: F('integer', 'Sort'),
  RQ_COMPANY_NAME: F('string', 'Company name'),
  RQ_INN: F('string', 'INN'),
  RQ_KPP: F('string', 'KPP'),
  RQ_OGRN: F('string', 'OGRN'),
  RQ_OKPO: F('string', 'OKPO'),
  RQ_DIRECTOR: F('string', 'Director'),
  RQ_IDENT_DOC_NUM: F('string', 'Number'),
};

const BANK_FIELDS = {
  ID: F('integer', 'ID', { isReadOnly: true }),
  ENTITY_ID: F('integer', 'Object ID', { isRequired: true, isImmutable: true }),
  COUNTRY_ID: F('integer', 'Country ID'),
  NAME: F('string', 'Name', { isRequired: true }),
  RQ_BANK_NAME: F('string', 'Bank name'),
  RQ_BIK: F('string', 'BIK'),
  RQ_ACC_NUM: F('string', 'Account'),
  RQ_COR_ACC_NUM: F('string', 'Corr. account'),
  RQ_IBAN: F('string', 'IBAN'),
  RQ_SWIFT: F('string', 'SWIFT'),
  COMMENTS: F('string', 'Comments'),
};

/** Форма ответа crm.requisite.preset.list: result — массив, total. */
const PRESETS = [
  { ID: '1', NAME: 'Организация', COUNTRY_ID: '1', ACTIVE: 'Y', ENTITY_TYPE_ID: '8', SORT: '500' },
  { ID: '2', NAME: 'ИП', COUNTRY_ID: '1', ACTIVE: 'Y', ENTITY_TYPE_ID: '8', SORT: '510' },
  { ID: '5', NAME: 'Organization (US)', COUNTRY_ID: '122', ACTIVE: 'Y', ENTITY_TYPE_ID: '8', SORT: '600' },
];
/** Форма crm.requisite.preset.field.list. */
const PRESET_FIELDS: Record<string, Record<string, unknown>[]> = {
  '1': ['RQ_INN', 'RQ_KPP', 'RQ_COMPANY_NAME', 'RQ_OGRN', 'RQ_DIRECTOR'].map((n, i) => ({
    ID: i + 1,
    FIELD_NAME: n,
    FIELD_TITLE: '',
    IN_SHORT_LIST: 'Y',
    SORT: 510 + i * 10,
  })),
  '2': [{ ID: 1, FIELD_NAME: 'RQ_OGRNIP', FIELD_TITLE: '', IN_SHORT_LIST: 'Y', SORT: 500 }],
  '5': [{ ID: 1, FIELD_NAME: 'RQ_COMPANY_NAME', FIELD_TITLE: '', IN_SHORT_LIST: 'Y', SORT: 500 }],
};
/** Форма crm.enum.addresstype из документации. */
const ADDRESS_TYPES = [
  { ID: 11, NAME: 'Адрес доставки', SYMBOL_CODE: null, SYMBOL_CODE_SHORT: null },
  { ID: 1, NAME: 'Фактический адрес', SYMBOL_CODE: null, SYMBOL_CODE_SHORT: null },
  { ID: 6, NAME: 'Юридический адрес', SYMBOL_CODE: null, SYMBOL_CODE_SHORT: null },
];

/** Скаляр мок-запроса строкой (объекты в фильтрах мока не ожидаются). */
const str = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

let requisites: Record<number, Record<string, unknown>>;
let addresses: Record<string, unknown>[];
let bankDetails: Record<number, Record<string, unknown>>;
let activities: Record<number, Record<string, unknown>>;

const requisite = (id: number, extra: Record<string, unknown> = {}) => ({
  ID: String(id),
  ENTITY_TYPE_ID: '4',
  ENTITY_ID: '10',
  PRESET_ID: '1',
  DATE_CREATE: '2026-09-01T10:00:00+03:00',
  DATE_MODIFY: '',
  CREATED_BY_ID: '1',
  MODIFY_BY_ID: null,
  NAME: 'Организация',
  ACTIVE: 'Y',
  SORT: '500',
  RQ_COMPANY_NAME: 'ООО «Ромашка»',
  RQ_INN: '7701234567',
  RQ_KPP: '770101001',
  RQ_OGRN: null,
  RQ_DIRECTOR: 'Иванов И. И.',
  RQ_IDENT_DOC_NUM: '123456',
  ...extra,
});

const activity = (id: number, extra: Record<string, unknown> = {}) => ({
  ID: String(id),
  OWNER_ID: '5',
  OWNER_TYPE_ID: '2',
  TYPE_ID: '2',
  PROVIDER_ID: 'CRM_CALL',
  PROVIDER_TYPE_ID: 'CALL',
  SUBJECT: 'Позвонить клиенту',
  START_TIME: '2026-10-01T10:00:00+03:00',
  END_TIME: '2026-10-01T10:30:00+03:00',
  DEADLINE: '2026-10-01T10:00:00+03:00',
  COMPLETED: 'N',
  STATUS: '1',
  RESPONSIBLE_ID: '7',
  PRIORITY: '2',
  DESCRIPTION: '',
  DESCRIPTION_TYPE: '1',
  DIRECTION: '2',
  LAST_UPDATED: '2026-09-20T10:00:00+03:00',
  ...extra,
});

function setup(overrides: Record<string, string> = {}) {
  requisites = { 27: requisite(27), 28: requisite(28, { NAME: 'Филиал', PRESET_ID: '5' }) };
  addresses = [
    {
      TYPE_ID: '1',
      ENTITY_TYPE_ID: '8',
      ENTITY_ID: '27',
      ADDRESS_1: 'ул. Ленина, 1',
      ADDRESS_2: 'офис 5',
      CITY: 'Москва',
      POSTAL_CODE: '101000',
      REGION: null,
      PROVINCE: null,
      COUNTRY: 'Россия',
      COUNTRY_CODE: null,
      LOC_ADDR_ID: '479',
      ANCHOR_TYPE_ID: '4',
      ANCHOR_ID: '10',
    },
  ];
  bankDetails = {};
  activities = {
    999: activity(999),
    1000: activity(1000, { TYPE_ID: '4', PROVIDER_ID: 'CRM_EMAIL', SUBJECT: 'Письмо' }),
  };
  t = createTestApp({ BITRIX_REQUESTS_PER_SECOND: '10', READ_ONLY_MODE: 'false', ...overrides });
  t.bitrix
    .on('crm.company.get', (c) =>
      Number(c.body['id']) === 10 ? legacyOk(companyRecord(10)) : legacyError('NOT_FOUND', 400, 'Not found'),
    )
    .on('crm.deal.get', (c) =>
      Number(c.body['id']) === 5 ? legacyOk(dealRecord(5)) : legacyError('NOT_FOUND', 400, 'Not found'),
    )
    .on('crm.requisite.fields', legacyOk(REQUISITE_FIELDS))
    .on('crm.requisite.bankdetail.fields', legacyOk(BANK_FIELDS))
    .on('crm.requisite.list', (c) => {
      const filter = c.body['filter'] as Record<string, unknown>;
      const rows = Object.values(requisites).filter(
        (r) =>
          r['ENTITY_TYPE_ID'] === String(filter['ENTITY_TYPE_ID']) &&
          r['ENTITY_ID'] === str(filter['ENTITY_ID']),
      );
      return legacyListPage(rows, Number(c.body['start'] ?? 0), 50);
    })
    .on('crm.requisite.get', (c) => {
      const r = requisites[Number(c.body['id'])];
      return r
        ? legacyOk(r)
        : legacyError('', 400, `The Requisite with ID '${String(c.body['id'])}' is not found`);
    })
    .on('crm.requisite.add', (c) => {
      const f = c.body['fields'] as Record<string, unknown>;
      requisites[57] = requisite(57, Object.fromEntries(Object.entries(f).map(([k, v]) => [k, String(v)])));
      return legacyOk(57);
    })
    .on('crm.requisite.update', (c) => {
      const r = requisites[Number(c.body['id'])];
      if (!r) return legacyError('', 400, 'not found');
      Object.assign(r, c.body['fields'], { DATE_MODIFY: '2026-09-25T10:00:00+03:00' });
      return legacyOk(true);
    })
    .on('crm.requisite.preset.list', (c) => {
      const filter = (c.body['filter'] ?? {}) as Record<string, unknown>;
      const rows = PRESETS.filter(
        (p) =>
          (filter['ID'] === undefined || p.ID === str(filter['ID'])) &&
          (filter['COUNTRY_ID'] === undefined || p.COUNTRY_ID === str(filter['COUNTRY_ID'])),
      );
      return legacyListPage(rows, Number(c.body['start'] ?? 0), 50);
    })
    .on('crm.requisite.preset.field.list', (c) => {
      const id = String((c.body['preset'] as Record<string, unknown>)['ID']);
      const rows = PRESET_FIELDS[id];
      return rows ? legacyOk(rows, { total: rows.length }) : legacyError('', 400, 'The Preset is not found');
    })
    .on('crm.enum.addresstype', legacyOk(ADDRESS_TYPES))
    .on('crm.address.list', (c) => {
      const filter = c.body['filter'] as Record<string, unknown>;
      const ids =
        filter['ENTITY_ID'] !== undefined
          ? [str(filter['ENTITY_ID'])]
          : (filter['@ENTITY_ID'] as number[]).map(String);
      const rows = addresses.filter(
        (a) =>
          a['ENTITY_TYPE_ID'] === String(filter['ENTITY_TYPE_ID']) &&
          ids.includes(String(a['ENTITY_ID'])) &&
          (filter['TYPE_ID'] === undefined || a['TYPE_ID'] === str(filter['TYPE_ID'])),
      );
      return legacyListPage(rows, Number(c.body['start'] ?? 0), 50);
    })
    .on('crm.address.add', (c) => {
      const f = c.body['fields'] as Record<string, unknown>;
      addresses.push(Object.fromEntries(Object.entries(f).map(([k, v]) => [k, String(v)])));
      return legacyOk(true);
    })
    .on('crm.address.update', (c) => {
      const f = c.body['fields'] as Record<string, unknown>;
      const row = addresses.find(
        (a) => a['TYPE_ID'] === String(f['TYPE_ID']) && a['ENTITY_ID'] === String(f['ENTITY_ID']),
      );
      if (!row) return legacyError('', 400, 'TypeAddress not found');
      // Как в документации: не переданные текстовые поля очищаются.
      for (const k of ['ADDRESS_1', 'ADDRESS_2', 'CITY', 'POSTAL_CODE', 'REGION', 'PROVINCE', 'COUNTRY'])
        row[k] = f[k] === undefined ? '' : str(f[k]);
      return legacyOk(true);
    })
    .on('crm.requisite.bankdetail.add', (c) => {
      const f = c.body['fields'] as Record<string, unknown>;
      bankDetails[357] = {
        ID: '357',
        ...Object.fromEntries(Object.entries(f).map(([k, v]) => [k, String(v)])),
      };
      return legacyOk(357);
    })
    .on('crm.requisite.bankdetail.get', (c) => {
      const b = bankDetails[Number(c.body['id'])];
      return b ? legacyOk(b) : legacyError('', 400, 'not found');
    })
    .on('crm.activity.get', (c) => {
      const a = activities[Number(c.body['id'])];
      return a ? legacyOk(a) : legacyError('NOT_FOUND', 400, 'Not found');
    })
    .on('crm.activity.todo.add', (c) => {
      activities[1200] = activity(1200, {
        OWNER_TYPE_ID: String(c.body['ownerTypeId']),
        OWNER_ID: String(c.body['ownerId']),
        TYPE_ID: '6',
        PROVIDER_ID: 'CRM_TODO',
        SUBJECT: c.body['title'],
        RESPONSIBLE_ID: String(c.body['responsibleId']),
        DEADLINE: c.body['deadline'],
      });
      return legacyOk({ id: 1200 });
    })
    .on('crm.activity.add', (c) => {
      const f = c.body['fields'] as Record<string, unknown>;
      activities[1201] = activity(1201, {
        OWNER_TYPE_ID: String(f['OWNER_TYPE_ID']),
        OWNER_ID: String(f['OWNER_ID']),
        TYPE_ID: String(f['TYPE_ID']),
        SUBJECT: f['SUBJECT'],
        RESPONSIBLE_ID: String(f['RESPONSIBLE_ID']),
      });
      return legacyOk(1201);
    })
    .on('crm.activity.update', (c) => {
      const a = activities[Number(c.body['id'])];
      if (!a) return legacyError('NOT_FOUND', 400, 'Not found');
      for (const [k, v] of Object.entries(c.body['fields'] as Record<string, unknown>)) a[k] = String(v);
      return legacyOk(true);
    });
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

/** Полный путь: APPROVAL_REQUIRED → approve человеком → выполнение → replay без второй записи. */
async function approveAndRun(tool: string, args: Record<string, unknown>) {
  const prep = await call(tool, args);
  expect(prep.error?.code).toBe('APPROVAL_REQUIRED');
  const operationId = prep.error?.details['operationId'] as string;
  await t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
  const done = await call(tool, { ...args, approvalId: operationId });
  const again = await call(tool, { ...args, approvalId: operationId });
  return { prep, done, again, operationId };
}

describe('чтение реквизитов и шаблонов', () => {
  it('crm_requisites_list: фильтр по владельцу, профиль полей без паспортных данных, адреса с названием типа', async () => {
    const env = await call('crm_requisites_list', {
      ownerEntityTypeId: 4,
      ownerId: 10,
      includeAddresses: true,
    });
    expect(env.success).toBe(true);
    const req = t.bitrix.callsTo('crm.requisite.list')[0]?.body;
    expect(req?.['filter']).toEqual({ ENTITY_TYPE_ID: 4, ENTITY_ID: 10 });
    expect(req?.['select']).not.toContain('RQ_IDENT_DOC_NUM');
    const items = env.data?.['items'] as Record<string, unknown>[];
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ ID: '27', RQ_INN: '7701234567', PRESET_ID: '1' });
    expect(items[0]).not.toHaveProperty('RQ_IDENT_DOC_NUM');
    expect(items[0]?.['addresses']).toEqual([
      {
        typeId: 1,
        typeName: 'Фактический адрес',
        ADDRESS_1: 'ул. Ленина, 1',
        ADDRESS_2: 'офис 5',
        CITY: 'Москва',
        POSTAL_CODE: '101000',
        COUNTRY: 'Россия',
      },
    ]);
    expect(items[1]?.['addresses']).toEqual([]);
    // адреса запрошены по реквизитам (ENTITY_TYPE_ID=8), а не по компании
    expect(t.bitrix.callsTo('crm.address.list')[0]?.body['filter']).toEqual({
      ENTITY_TYPE_ID: 8,
      '@ENTITY_ID': [27, 28],
    });
    expect(env.meta['completeness']).toBe('complete');
  });

  it('crm_requisites_list: паспортные поля в select отклоняются; владелец-сделка — ошибка схемы', async () => {
    const env = await call('crm_requisites_list', {
      ownerEntityTypeId: 4,
      ownerId: 10,
      select: ['RQ_IDENT_DOC_NUM'],
    });
    expect(env.error?.details['reason']).toBe('FIELD_NOT_ALLOWED');
    const bad = await client.callTool({
      name: 'crm_requisites_list',
      arguments: { ownerEntityTypeId: 2, ownerId: 5 },
    });
    expect(bad.isError).toBe(true);
    expect(t.bitrix.callsTo('crm.requisite.list')).toHaveLength(0);
  });

  it('crm_requisites_list: 60 реквизитов, pageSize=20 — курсор проходит все без пропусков', async () => {
    for (let i = 100; i < 158; i += 1) requisites[i] = requisite(i);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let n = 0; n < 5; n += 1) {
      const env = await call('crm_requisites_list', {
        ownerEntityTypeId: 4,
        ownerId: 10,
        pageSize: 20,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...(env.data?.['items'] as { ID: string }[]).map((i) => i.ID));
      const page = env.meta['page'] as { nextCursor: string | null; hasMore: boolean };
      if (!page.hasMore) break;
      cursor = page.nextCursor ?? undefined;
    }
    expect(seen).toHaveLength(60);
    expect(new Set(seen).size).toBe(60);
  });

  it('crm_requisite_presets_list: фильтр страны, поля шаблонов через crm.requisite.preset.field.list', async () => {
    const env = await call('crm_requisite_presets_list', { countryId: 1, includeFields: true });
    expect(env.success).toBe(true);
    expect(t.bitrix.callsTo('crm.requisite.preset.list')[0]?.body['filter']).toEqual({
      COUNTRY_ID: 1,
      ACTIVE: 'Y',
    });
    const items = env.data?.['items'] as Record<string, unknown>[];
    expect(items.map((i) => i['id'])).toEqual([1, 2]);
    expect(items[0]).toMatchObject({ id: 1, name: 'Организация', countryId: 1, active: true });
    expect((items[0]?.['fields'] as { fieldName: string }[]).map((f) => f.fieldName)).toEqual([
      'RQ_INN',
      'RQ_KPP',
      'RQ_COMPANY_NAME',
      'RQ_OGRN',
      'RQ_DIRECTOR',
    ]);
    expect(t.bitrix.callsTo('crm.requisite.preset.field.list')[0]?.body).toEqual({ preset: { ID: 1 } });
  });
});

describe('crm_requisite_create', () => {
  const base = {
    ownerEntityTypeId: 4,
    ownerId: 10,
    presetId: 1,
    name: 'Реквизиты Ромашки',
    fields: { RQ_INN: '7701234567', RQ_KPP: '770101001' },
  };

  it('INVALID_PRESET до плана: неизвестный шаблон не порождает операцию и не читает владельца', async () => {
    const env = await call('crm_requisite_create', { ...base, presetId: 99, idempotencyKey: randomUUID() });
    expect(env.error?.code).toBe('VALIDATION_ERROR');
    expect(env.error?.details['reason']).toBe('INVALID_PRESET');
    expect(await t.app.operations.countByStatus()).toEqual({});
    expect(t.bitrix.callsTo('crm.company.get')).toHaveLength(0);
    expect(t.bitrix.callsTo('crm.requisite.add')).toHaveLength(0);
  });

  it('поля: вне шаблона → FIELD_NOT_IN_PRESET, неизвестное → UNKNOWN_FIELD, системное → FIELD_NOT_ALLOWED, владелец не найден → NOT_FOUND', async () => {
    const notInPreset = await call('crm_requisite_create', {
      ...base,
      fields: { RQ_OKPO: '123' },
      dryRun: true,
    });
    expect(notInPreset.error?.details['reason']).toBe('FIELD_NOT_IN_PRESET');
    const unknown = await call('crm_requisite_create', { ...base, fields: { RQ_FOO: '1' }, dryRun: true });
    expect(unknown.error?.details['reason']).toBe('UNKNOWN_FIELD');
    const system = await call('crm_requisite_create', { ...base, fields: { PRESET_ID: 2 }, dryRun: true });
    expect(system.error?.details['reason']).toBe('FIELD_NOT_ALLOWED');
    const passport = await call('crm_requisite_create', {
      ...base,
      fields: { RQ_IDENT_DOC_NUM: '1' },
      dryRun: true,
    });
    expect(passport.error?.details['reason']).toBe('FIELD_NOT_ALLOWED');
    const noOwner = await call('crm_requisite_create', { ...base, ownerId: 11, dryRun: true });
    expect(noOwner.error?.code).toBe('NOT_FOUND');
  });

  it('полный путь: план с владельцем/шаблоном и повышенным риском → одна запись → сверка → replay', async () => {
    const args = { ...base, idempotencyKey: randomUUID() };
    const { prep, done, again } = await approveAndRun('crm_requisite_create', args);
    const plan = prep.error?.details['plan'] as { details: Record<string, unknown>; risks: string[] };
    expect(plan.details).toMatchObject({
      owner: { entityTypeId: 4, id: 10 },
      preset: { id: 1, name: 'Организация', countryId: 1 },
      fields: {
        ENTITY_TYPE_ID: 4,
        ENTITY_ID: 10,
        PRESET_ID: 1,
        NAME: 'Реквизиты Ромашки',
        RQ_INN: '7701234567',
      },
    });
    expect(plan.risks[0]).toContain('Повышенный риск');
    expect(done.data).toMatchObject({ requisiteId: 57, verified: true, replayed: false });
    expect(t.bitrix.callsTo('crm.requisite.add')[0]?.body).toEqual({
      fields: {
        RQ_INN: '7701234567',
        RQ_KPP: '770101001',
        ENTITY_TYPE_ID: 4,
        ENTITY_ID: 10,
        PRESET_ID: 1,
        NAME: 'Реквизиты Ромашки',
      },
    });
    expect(again.data).toMatchObject({ requisiteId: 57, replayed: true });
    expect(t.bitrix.callsTo('crm.requisite.add')).toHaveLength(1);
  });

  it('ответ add без ID → OPERATION_OUTCOME_UNKNOWN, повтор не пишет второй раз', async () => {
    t.bitrix.on('crm.requisite.add', legacyOk(null));
    const args = { ...base, idempotencyKey: randomUUID() };
    const prep = await call('crm_requisite_create', args);
    const operationId = prep.error?.details['operationId'] as string;
    await t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
    const done = await call('crm_requisite_create', { ...args, approvalId: operationId });
    expect(done.error?.code).toBe('OPERATION_OUTCOME_UNKNOWN');
    const again = await call('crm_requisite_create', { ...args, approvalId: operationId });
    expect(again.error?.code).toBe('OPERATION_OUTCOME_UNKNOWN');
    expect(t.bitrix.callsTo('crm.requisite.add')).toHaveLength(1);
  });
});

describe('crm_requisite_update', () => {
  it('diff «было → станет», неизменяемые поля отклоняются, полный путь с expectedStateHash и сверкой', async () => {
    const immutable = await call('crm_requisite_update', {
      requisiteId: 27,
      fields: { PRESET_ID: 2 },
      dryRun: true,
    });
    expect(immutable.error?.details['reason']).toBe('IMMUTABLE_FIELD');

    const dry = await call('crm_requisite_update', {
      requisiteId: 27,
      fields: { RQ_KPP: '770201001' },
      dryRun: true,
    });
    const hash = dry.data?.['stateHash'] as string;
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    const plan = dry.data?.['plan'] as { details: Record<string, unknown>; risks: string[] };
    expect(plan.details['changes']).toEqual({ RQ_KPP: { from: '770101001', to: '770201001' } });
    expect(plan.risks.join(' ')).toContain('ключевые реквизиты');

    const args = {
      requisiteId: 27,
      fields: { RQ_KPP: '770201001' },
      expectedStateHash: hash,
      idempotencyKey: randomUUID(),
    };
    const { done, again } = await approveAndRun('crm_requisite_update', args);
    expect(done.data).toMatchObject({ requisiteId: 27, verified: true, changedFields: ['RQ_KPP'] });
    expect(t.bitrix.callsTo('crm.requisite.update')[0]?.body).toEqual({
      id: 27,
      fields: { RQ_KPP: '770201001' },
    });
    expect(again.data?.['replayed']).toBe(true);
    expect(t.bitrix.callsTo('crm.requisite.update')).toHaveLength(1);
  });

  it('CONFLICT: устаревший expectedStateHash до плана; изменение между подтверждением и записью — в precheck', async () => {
    const stale = await call('crm_requisite_update', {
      requisiteId: 27,
      fields: { RQ_KPP: '1' },
      expectedStateHash: 'a'.repeat(64),
      idempotencyKey: randomUUID(),
    });
    expect(stale.error?.code).toBe('CONFLICT');
    expect(await t.app.operations.countByStatus()).toEqual({});

    const dry = await call('crm_requisite_update', {
      requisiteId: 27,
      fields: { RQ_KPP: '1' },
      dryRun: true,
    });
    const args = {
      requisiteId: 27,
      fields: { RQ_KPP: '1' },
      expectedStateHash: dry.data?.['stateHash'],
      idempotencyKey: randomUUID(),
    };
    const prep = await call('crm_requisite_update', args);
    const operationId = prep.error?.details['operationId'] as string;
    await t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
    requisites[27] = { ...requisite(27), RQ_DIRECTOR: 'Петров П. П.' }; // чужое изменение
    const raced = await call('crm_requisite_update', { ...args, approvalId: operationId });
    expect(raced.error?.code).toBe('CONFLICT');
    expect(t.bitrix.callsTo('crm.requisite.update')).toHaveLength(0);
  });

  it('несуществующий реквизит: ошибка портала (по документации — пустой код и текст «not found») без плана', async () => {
    const env = await call('crm_requisite_update', {
      requisiteId: 404,
      fields: { NAME: 'x' },
      idempotencyKey: randomUUID(),
    });
    expect(env.success).toBe(false);
    expect(env.error?.code).not.toBe('APPROVAL_REQUIRED');
    expect(await t.app.operations.countByStatus()).toEqual({});
  });
});

describe('crm_requisite_address_set', () => {
  it('INVALID_ADDRESS_TYPE по справочнику crm.enum.addresstype до чтения реквизита и плана', async () => {
    const env = await call('crm_requisite_address_set', {
      requisiteId: 27,
      addressTypeId: 42,
      addressFields: { CITY: 'Казань' },
      idempotencyKey: randomUUID(),
    });
    expect(env.error?.code).toBe('VALIDATION_ERROR');
    expect(env.error?.details['reason']).toBe('INVALID_ADDRESS_TYPE');
    expect(env.error?.message).toContain('6 (Юридический адрес)');
    expect(await t.app.operations.countByStatus()).toEqual({});
    expect(t.bitrix.callsTo('crm.requisite.get')).toHaveLength(0);
  });

  it('адреса нужного типа нет → режим create, crm.address.add с ENTITY_TYPE_ID=8 и ID реквизита; replay', async () => {
    const args = {
      requisiteId: 27,
      addressTypeId: 6,
      addressFields: { ADDRESS_1: 'ул. Мира, 2', CITY: 'Москва', POSTAL_CODE: '101001' },
      idempotencyKey: randomUUID(),
    };
    const { prep, done, again } = await approveAndRun('crm_requisite_address_set', args);
    const plan = prep.error?.details['plan'] as { details: Record<string, unknown>; action: string };
    expect(plan.details['mode']).toBe('create');
    expect(plan.details['method']).toBe('crm.address.add');
    expect(plan.action).toContain('Добавить адрес «Юридический адрес»');
    expect(done.data).toMatchObject({ mode: 'create', verified: true, replayed: false });
    expect(t.bitrix.callsTo('crm.address.add')[0]?.body).toEqual({
      fields: {
        TYPE_ID: 6,
        ENTITY_TYPE_ID: 8,
        ENTITY_ID: 27,
        ADDRESS_1: 'ул. Мира, 2',
        CITY: 'Москва',
        POSTAL_CODE: '101001',
      },
    });
    expect(again.data).toMatchObject({ mode: 'create', replayed: true });
    expect(t.bitrix.callsTo('crm.address.add')).toHaveLength(1);
    expect(t.bitrix.callsTo('crm.address.update')).toHaveLength(0);
  });

  it('адрес этого типа есть → режим update: непереданные поля сохраняются, "" очищает, diff в плане', async () => {
    const args = {
      requisiteId: 27,
      addressTypeId: 1,
      addressFields: { ADDRESS_1: 'ул. Ленина, 3', ADDRESS_2: '' },
      idempotencyKey: randomUUID(),
    };
    const { prep, done } = await approveAndRun('crm_requisite_address_set', args);
    const plan = prep.error?.details['plan'] as { details: Record<string, unknown>; risks: string[] };
    expect(plan.details['mode']).toBe('update');
    expect(plan.details['changes']).toEqual({
      ADDRESS_1: { from: 'ул. Ленина, 1', to: 'ул. Ленина, 3' },
      ADDRESS_2: { from: 'офис 5', to: '' },
    });
    expect(plan.risks.join(' ')).toContain('Будут очищены поля: ADDRESS_2');
    expect(done.data).toMatchObject({ mode: 'update', verified: true });
    expect(t.bitrix.callsTo('crm.address.update')[0]?.body['fields']).toEqual({
      TYPE_ID: 1,
      ENTITY_TYPE_ID: 8,
      ENTITY_ID: 27,
      ADDRESS_1: 'ул. Ленина, 3',
      ADDRESS_2: '',
      CITY: 'Москва',
      POSTAL_CODE: '101000',
      REGION: '',
      PROVINCE: '',
      COUNTRY: 'Россия',
    });
    expect(t.bitrix.callsTo('crm.address.add')).toHaveLength(0);
  });

  it('CONFLICT: подтверждён create, но адрес этого типа появился до выполнения — запись не выполняется', async () => {
    const args = {
      requisiteId: 27,
      addressTypeId: 6,
      addressFields: { CITY: 'Москва' },
      idempotencyKey: randomUUID(),
    };
    const prep = await call('crm_requisite_address_set', args);
    const operationId = prep.error?.details['operationId'] as string;
    await t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
    addresses.push({ TYPE_ID: '6', ENTITY_TYPE_ID: '8', ENTITY_ID: '27', CITY: 'Тверь' });
    const raced = await call('crm_requisite_address_set', { ...args, approvalId: operationId });
    expect(raced.error?.code).toBe('CONFLICT');
    expect(t.bitrix.callsTo('crm.address.add')).toHaveLength(0);
    expect(t.bitrix.callsTo('crm.address.update')).toHaveLength(0);
  });
});

describe('crm_bank_account_add', () => {
  it('INVALID_BANK_DETAILS для шаблона РФ: БИК и счета — только цифры нужной длины; пустые не проверяются', async () => {
    const env = await call('crm_bank_account_add', {
      requisiteId: 27,
      name: 'Основной счёт',
      bankFields: { RQ_BIK: '04452522', RQ_ACC_NUM: '4070281000000000000A', RQ_COR_ACC_NUM: '' },
      idempotencyKey: randomUUID(),
    });
    expect(env.error?.code).toBe('VALIDATION_ERROR');
    expect(env.error?.details['reason']).toBe('INVALID_BANK_DETAILS');
    expect(env.error?.message).toContain('RQ_BIK');
    expect(env.error?.message).toContain('RQ_ACC_NUM');
    expect(env.error?.message).not.toContain('RQ_COR_ACC_NUM');
    const iban = await call('crm_bank_account_add', {
      requisiteId: 28,
      name: 'EUR',
      bankFields: { RQ_IBAN: 'DE89370400440532013001' },
      dryRun: true,
    });
    expect(iban.error?.details['reason']).toBe('INVALID_BANK_DETAILS');
    const unknown = await call('crm_bank_account_add', {
      requisiteId: 27,
      name: 'x',
      bankFields: { RQ_FOO: '1' },
      dryRun: true,
    });
    expect(unknown.error?.details['reason']).toBe('UNKNOWN_FIELD');
    expect(await t.app.operations.countByStatus()).toEqual({});
  });

  it('полный путь: COUNTRY_ID из шаблона, одна запись, сверка через bankdetail.get, replay', async () => {
    const args = {
      requisiteId: 27,
      name: 'Основной счёт',
      bankFields: {
        RQ_BANK_NAME: 'ПАО Банк',
        RQ_BIK: '044525225',
        RQ_ACC_NUM: '40702810000000000001',
        RQ_COR_ACC_NUM: '30101810400000000225',
      },
      idempotencyKey: randomUUID(),
    };
    const { done, again } = await approveAndRun('crm_bank_account_add', args);
    expect(done.data).toMatchObject({ requisiteId: 27, bankDetailId: 357, verified: true });
    expect(t.bitrix.callsTo('crm.requisite.bankdetail.add')[0]?.body).toEqual({
      fields: { ...args.bankFields, ENTITY_ID: 27, NAME: 'Основной счёт', COUNTRY_ID: 1 },
    });
    expect(again.data?.['replayed']).toBe(true);
    expect(t.bitrix.callsTo('crm.requisite.bankdetail.add')).toHaveLength(1);
  });
});

describe('crm_activity_create', () => {
  it('UNSUPPORTED_PROVIDER для email/task до чтения записи и плана', async () => {
    for (const provider of ['email', 'task', 'REST_APP']) {
      const env = await call('crm_activity_create', {
        entityType: 'deal',
        recordId: 5,
        provider,
        subject: 'x',
        responsibleId: 7,
        idempotencyKey: randomUUID(),
      });
      expect(env.error?.details['reason']).toBe('UNSUPPORTED_PROVIDER');
    }
    expect(t.bitrix.callsTo('crm.deal.get')).toHaveLength(0);
    expect(await t.app.operations.countByStatus()).toEqual({});
  });

  it('проверки провайдера: todo требует deadline и не принимает communications; звонок — ровно один телефон', async () => {
    const noDeadline = await call('crm_activity_create', {
      entityType: 'deal',
      recordId: 5,
      provider: 'todo',
      subject: 'x',
      responsibleId: 7,
      dryRun: true,
    });
    expect(noDeadline.error?.details['field']).toBe('deadline');
    const callNoComm = await call('crm_activity_create', {
      entityType: 'deal',
      recordId: 5,
      provider: 'call',
      subject: 'x',
      responsibleId: 7,
      start: '2026-10-01T10:00:00+03:00',
      dryRun: true,
    });
    expect(callNoComm.error?.details['field']).toBe('communications');
    const missing = await call('crm_activity_create', {
      entityType: 'deal',
      recordId: 404,
      provider: 'todo',
      subject: 'x',
      responsibleId: 7,
      deadline: '2026-10-01T10:00:00+03:00',
      dryRun: true,
    });
    expect(missing.error?.code).toBe('NOT_FOUND');
  });

  it('todo: crm.activity.todo.add (форма ответа {id}), сверка crm.activity.get, replay', async () => {
    const args = {
      entityType: 'deal',
      recordId: 5,
      provider: 'todo',
      subject: 'Подготовить КП',
      responsibleId: 7,
      deadline: '2026-10-02T15:00:00+03:00',
      idempotencyKey: randomUUID(),
    };
    const { prep, done, again } = await approveAndRun('crm_activity_create', args);
    expect((prep.error?.details['plan'] as { details: Record<string, unknown> }).details['method']).toBe(
      'crm.activity.todo.add',
    );
    expect(t.bitrix.callsTo('crm.activity.todo.add')[0]?.body).toEqual({
      ownerTypeId: 2,
      ownerId: 5,
      deadline: '2026-10-02T15:00:00+03:00',
      title: 'Подготовить КП',
      responsibleId: 7,
    });
    expect(done.data).toMatchObject({ activityId: 1200, provider: 'todo', verified: true });
    expect(again.data?.['replayed']).toBe(true);
    expect(t.bitrix.callsTo('crm.activity.todo.add')).toHaveLength(1);
  });

  it('call: crm.activity.add с TYPE_ID=2, направлением и одной коммуникацией PHONE', async () => {
    const args = {
      entityType: 'company',
      recordId: 10,
      provider: 'call',
      subject: 'Созвон по договору',
      responsibleId: 7,
      start: '2026-10-01T10:00:00+03:00',
      communications: [{ entityType: 'company', entityId: 10, value: '+74950000000' }],
      idempotencyKey: randomUUID(),
    };
    const { done } = await approveAndRun('crm_activity_create', args);
    expect(done.data).toMatchObject({ activityId: 1201, verified: true });
    expect(t.bitrix.callsTo('crm.activity.add')[0]?.body).toEqual({
      fields: {
        OWNER_TYPE_ID: 4,
        OWNER_ID: 10,
        TYPE_ID: 2,
        SUBJECT: 'Созвон по договору',
        RESPONSIBLE_ID: 7,
        START_TIME: '2026-10-01T10:00:00+03:00',
        END_TIME: '2026-10-01T10:00:00+03:00',
        COMPLETED: 'N',
        COMMUNICATIONS: [{ ENTITY_TYPE_ID: 4, ENTITY_ID: 10, TYPE: 'PHONE', VALUE: '+74950000000' }],
        DIRECTION: 2,
      },
    });
  });
});

describe('crm_activity_update', () => {
  it('закрыть звонок: diff и риск закрытия, одна запись crm.activity.update, сверка, replay', async () => {
    const dry = await call('crm_activity_update', {
      activityId: 999,
      fields: { COMPLETED: true },
      dryRun: true,
    });
    const plan = dry.data?.['plan'] as { details: Record<string, unknown>; risks: string[] };
    expect(plan.details['changes']).toEqual({ COMPLETED: { from: 'N', to: 'Y' } });
    expect(plan.risks.join(' ')).toContain('Дело будет закрыто');
    const args = {
      activityId: 999,
      fields: { COMPLETED: true },
      expectedStateHash: dry.data?.['stateHash'],
      idempotencyKey: randomUUID(),
    };
    const { done, again } = await approveAndRun('crm_activity_update', args);
    expect(done.data).toMatchObject({ activityId: 999, verified: true, changedFields: ['COMPLETED'] });
    expect(t.bitrix.callsTo('crm.activity.update')[0]?.body).toEqual({ id: 999, fields: { COMPLETED: 'Y' } });
    expect(again.data?.['replayed']).toBe(true);
    expect(t.bitrix.callsTo('crm.activity.update')).toHaveLength(1);
  });

  it('письмо → UNSUPPORTED_PROVIDER; DEADLINE и неизвестные поля не принимаются схемой; CONFLICT по хешу', async () => {
    const email = await call('crm_activity_update', {
      activityId: 1000,
      fields: { SUBJECT: 'x' },
      dryRun: true,
    });
    expect(email.error?.details['reason']).toBe('UNSUPPORTED_PROVIDER');
    const deadline = await client.callTool({
      name: 'crm_activity_update',
      arguments: { activityId: 999, fields: { DEADLINE: '2026-10-01' }, dryRun: true },
    });
    expect(deadline.isError).toBe(true);
    const conflict = await call('crm_activity_update', {
      activityId: 999,
      fields: { SUBJECT: 'Новая тема' },
      expectedStateHash: 'b'.repeat(64),
      idempotencyKey: randomUUID(),
    });
    expect(conflict.error?.code).toBe('CONFLICT');
    expect(t.bitrix.callsTo('crm.activity.update')).toHaveLength(0);
  });
});

describe('режим только чтения', () => {
  it('READ_ONLY_MODE=true: инструменты записи скрыты, чтение реквизитов доступно', async () => {
    await close();
    t.app.close();
    await reconnect({ READ_ONLY_MODE: 'true' });
    const names = (await client.listTools()).tools.map((x) => x.name);
    for (const n of [
      'crm_requisite_create',
      'crm_requisite_update',
      'crm_requisite_address_set',
      'crm_bank_account_add',
      'crm_activity_create',
      'crm_activity_update',
    ])
      expect(names).not.toContain(n);
    expect(names).toContain('crm_requisites_list');
    expect(names).toContain('crm_requisite_presets_list');
  });
});

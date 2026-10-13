/**
 * Заявка 2026-10-13 (п. 1, 2, 5): выгрузка в файл crm_export, подсчёты crm_count, записи без связей crm_orphans,
 * «не содержит» (`!%`) на сервере, compact/withNames в crm_list_records, смена pageSize при продолжении по курсору.
 * Мок портала намеренно повторяет ошибку живого портала: `!%TITLE` у него работает как `%TITLE` (возвращает совпадения),
 * поэтому тест проверяет, что условие до портала не доходит и исключение делает сервер.
 */
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { connectInMemory, createTestApp, structured, type TestApp } from '../helpers/app.js';
import { legacyOk, type RecordedCall } from '../helpers/mock-bitrix.js';
import {
  COMPANY_FIELDS,
  CONTACT_FIELDS,
  LEAD_FIELDS,
  STATUS_LISTS,
  companyRecord,
  contactRecord,
} from '../helpers/mock-crm.js';
import { DEAL_FIELDS } from '../helpers/mock-bitrix.js';
import { xlsxToText } from '../../src/files/extract-text.js';

interface Env {
  success: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; details: Record<string, unknown> };
  meta: Record<string, unknown> & {
    warnings?: string[];
    page?: { nextCursor: string | null; hasMore: boolean };
  };
}

type Row = Record<string, unknown>;

/** Фильтр мок-портала: >ID, @ПОЛЕ, %ПОЛЕ, >=/<= по строке, равенство. `!%` — как `%` (ошибка живого портала). */
function matches(r: Row, filter: Row): boolean {
  for (const [k, v] of Object.entries(filter)) {
    const m = /^(>=|<=|!%|>|<|@|%)?(.+)$/.exec(k);
    const op = m?.[1] ?? '';
    const val = r[m?.[2] ?? ''];
    const s = typeof val === 'string' || typeof val === 'number' ? String(val) : '';
    if (op === '>' && !(Number(s) > Number(v))) return false;
    if (op === '>=' && !(s >= String(v))) return false;
    if (op === '<=' && !(s <= String(v))) return false;
    if (op === '@' && !(v as unknown[]).map(String).includes(s)) return false;
    if ((op === '%' || op === '!%') && !s.toLowerCase().includes(String(v).toLowerCase())) return false;
    if (op === '' && s !== String(v)) return false;
  }
  return true;
}

function listHandler(rows: () => Row[], delayMs = 0) {
  return (c: RecordedCall) => {
    const filter = (c.body['filter'] ?? {}) as Row;
    const order = (c.body['order'] ?? { ID: 'DESC' }) as Record<string, string>;
    const select = c.body['select'] as string[] | undefined;
    let res = rows().filter((r) => matches(r, filter));
    res = [...res].sort((a, b) => (Number(a['ID']) - Number(b['ID'])) * (order['ID'] === 'ASC' ? 1 : -1));
    const pick = (r: Row) =>
      select ? Object.fromEntries(Object.entries(r).filter(([k]) => k === 'ID' || select.includes(k))) : r;
    const start = Number(c.body['start'] ?? 0);
    if (start === -1) return { ...legacyOk(res.slice(0, 50).map(pick)), delayMs };
    const next = start + 50 < res.length ? start + 50 : undefined;
    return {
      ...legacyOk(res.slice(start, start + 50).map(pick), {
        total: res.length,
        ...(next !== undefined ? { next } : {}),
      }),
      delayMs,
    };
  };
}

const USERS = [
  { ID: '7', NAME: 'Иван', LAST_NAME: 'Тестов', ACTIVE: true },
  { ID: '8', NAME: 'Анна', LAST_NAME: 'Пробная', ACTIVE: true },
  { ID: '9', NAME: 'Олег', LAST_NAME: 'Уволенный', ACTIVE: false },
];

// 130 компаний: ответственные 7/8/9 по кругу; каждая десятая — «тестовая» в названии; даты по месяцам.
const COMPANIES = Array.from({ length: 130 }, (_, i) =>
  companyRecord(i + 1, {
    TITLE: i % 10 === 0 ? `Тестовая фирма ${String(i + 1)}` : `ООО Ромашка ${String(i + 1)}`,
    ASSIGNED_BY_ID: String(7 + (i % 3)),
    DATE_CREATE: `2026-0${String(1 + (i % 3))}-15T10:00:00+03:00`,
    PHONE: i === 0 ? [{ VALUE: '+7 900 000-00-01', VALUE_TYPE: 'WORK' }] : [],
  }),
);
// Сделки у компаний 1..60 (у 1..10 — по две), лиды у компаний 100..130.
const DEALS = [
  ...Array.from({ length: 60 }, (_, i) => ({
    ID: String(i + 1),
    TITLE: `Сделка ${String(i + 1)}`,
    COMPANY_ID: String(i + 1),
    CONTACT_ID: '0',
  })),
  ...Array.from({ length: 10 }, (_, i) => ({
    ID: String(100 + i),
    TITLE: 'Повтор',
    COMPANY_ID: String(i + 1),
    CONTACT_ID: '2',
  })),
];
const CONTACTS = Array.from({ length: 5 }, (_, i) => contactRecord(i + 1));
/** Контакт 3 привязан к сделке 1 не основным контактом: в списке сделок его не видно, проверка по одному его находит. */
const SECONDARY_CONTACT_DEALS: Record<string, string[]> = { '3': ['1'] };

let root: string;
let t: TestApp;
let client: Client;
let close: () => Promise<void>;
const call = async (name: string, args: Record<string, unknown>) =>
  structured<Env>(await client.callTool({ name, arguments: args }));

async function start(companyDelayMs = 0) {
  t = createTestApp({ BITRIX_REQUESTS_PER_SECOND: '10', DOWNLOAD_DIR: root });
  t.bitrix
    .on('crm.company.fields', legacyOk(COMPANY_FIELDS))
    .on('crm.contact.fields', legacyOk(CONTACT_FIELDS))
    .on('crm.lead.fields', legacyOk(LEAD_FIELDS))
    .on('crm.deal.fields', legacyOk(DEAL_FIELDS))
    .on(
      'crm.company.list',
      listHandler(() => COMPANIES, companyDelayMs),
    )
    .on(
      'crm.contact.list',
      listHandler(() => CONTACTS),
    )
    .on(
      'crm.lead.list',
      listHandler(() => []),
    )
    .on('crm.deal.list', (c: RecordedCall) => {
      const f = (c.body['filter'] ?? {}) as Row;
      if (f['CONTACT_ID'] !== undefined && !Array.isArray(f['CONTACT_ID'])) {
        const ids = SECONDARY_CONTACT_DEALS[String(Number(f['CONTACT_ID']))] ?? [];
        return legacyOk(ids.map((id) => ({ ID: id })));
      }
      return listHandler(() => DEALS)(c);
    })
    .on(
      'crm.activity.list',
      listHandler(() => [{ ID: '1', OWNER_TYPE_ID: '4', OWNER_ID: '5', CREATED: '2099-01-01' }]),
    )
    .on('crm.status.list', (c: RecordedCall) => {
      const id = ((c.body['filter'] as Row | undefined)?.['ENTITY_ID'] as string | undefined) ?? '';
      return legacyOk(STATUS_LISTS[id] ?? []);
    })
    .on('user.get', (c: RecordedCall) => {
      const ids = ((c.body['FILTER'] as Row)['ID'] as unknown[]).map(String);
      return legacyOk(USERS.filter((u) => ids.includes(u.ID)));
    });
  const c = await connectInMemory(t.app);
  client = c.client;
  close = () => c.close();
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'mcp-bulk-'));
});
afterEach(async () => {
  // Только чтение: ни одного метода записи.
  expect(t.bitrix.calls.some((c) => /\.(add|update|delete)\.json$/.test(c.url))).toBe(false);
  await close();
  t.app.close();
  rmSync(root, { recursive: true, force: true });
});

describe('crm_list_records: «не содержит», compact, имена, курсор', () => {
  it('!%TITLE не уходит в портал и исключает совпадения на сервере', async () => {
    await start();
    const env = await call('crm_list_records', {
      entityType: 'company',
      filter: { '!%TITLE': 'тестов' },
      pageSize: 50,
    });
    expect(env.success).toBe(true);
    const sent = t.bitrix.callsTo('crm.company.list')[0]?.body['filter'] as Row;
    expect(Object.keys(sent)).not.toContain('!%TITLE');
    const items = env.data?.['items'] as Row[];
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => !String(i['TITLE']).includes('Тестовая'))).toBe(true);
    expect(env.meta.warnings?.join(' ')).toContain('не содержит');
  });

  it('compact убирает пустые поля и оставляет ключевые; withNames даёт ФИО, в т. ч. уволенного', async () => {
    await start();
    const env = await call('crm_list_records', {
      entityType: 'company',
      compact: true,
      withNames: true,
      pageSize: 3,
    });
    const items = env.data?.['items'] as Row[];
    expect(Object.keys(items[0] ?? {}).sort()).toEqual(
      ['ASSIGNED_BY_ID', 'ASSIGNED_BY_NAME', 'DATE_CREATE', 'ID', 'TITLE'].sort(),
    );
    const names = items.map((i) => i['ASSIGNED_BY_NAME']);
    expect(names).toContain('Уволенный Олег');
  });

  it('курсор продолжает выборку и при другом pageSize', async () => {
    await start();
    const p1 = await call('crm_list_records', { entityType: 'company', pageSize: 10 });
    const p2 = await call('crm_list_records', {
      entityType: 'company',
      pageSize: 25,
      cursor: p1.meta.page?.nextCursor,
    });
    expect(p2.success).toBe(true);
    const ids = [...(p1.data?.['items'] as Row[]), ...(p2.data?.['items'] as Row[])].map((i) =>
      Number(i['ID']),
    );
    expect(ids).toEqual(Array.from({ length: 35 }, (_, i) => 130 - i));
  });
});

describe('crm_export', () => {
  it('без DOWNLOAD_DIR — FEATURE_UNAVAILABLE', async () => {
    await start();
    await close();
    t.app.close();
    t = createTestApp({});
    const c = await connectInMemory(t.app);
    client = c.client;
    close = () => c.close();
    const env = await call('crm_export', { entityType: 'company' });
    expect(env.error?.code).toBe('FEATURE_UNAVAILABLE');
  });

  it('вся выборка в XLSX одной командой: имена, ссылки, телефоны; в ответе только путь, число и 5 строк', async () => {
    await start();
    const env = await call('crm_export', {
      entityType: 'company',
      fields: ['ID', 'TITLE', 'ASSIGNED_BY_ID', 'COMPANY_TYPE', 'PHONE'],
      fileName: 'все компании',
    });
    expect(env.success).toBe(true);
    expect(env.data).toMatchObject({ complete: true, rows: 130, fileName: 'все компании.xlsx' });
    const file = env.data?.['path'] as string;
    expect(file.startsWith(root)).toBe(true);
    expect(env.data?.['preview']).toHaveLength(5);
    expect(env.data?.['columns']).toEqual([
      'ID',
      'Название компании',
      'Ответственный',
      'Ответственный: имя',
      'Тип компании',
      'Тип компании: имя',
      'Телефон',
      'Ссылка',
    ]);
    // Обход по ID с start=-1, ровно 3 страницы по 50.
    const lists = t.bitrix.callsTo('crm.company.list');
    expect(lists).toHaveLength(3);
    expect(lists.every((c) => c.body['start'] === -1)).toBe(true);
    expect((lists[1]?.body['filter'] as Row)['>ID']).toBe(50);
    const text = xlsxToText(readFileSync(file)).text;
    expect(text).toContain('Уволенный Олег');
    expect(text).toContain('https://mock.bitrix24.invalid/crm/company/details/130/');
    expect(text).toContain('+7 900 000-00-01');
    expect(text).toContain('Клиент');
    expect(readdirSync(root).filter((f) => f.endsWith('.part.jsonl'))).toHaveLength(0);
    // Повтор не перезаписывает файл, а создаёт новый.
    const again = await call('crm_export', {
      entityType: 'company',
      fileName: 'все компании',
      format: 'csv',
    });
    expect(again.data?.['fileName']).toBe('все компании.csv');
  });

  it('CSV с фильтром и «!%»; по пределу времени — cursor, продолжение без дублей', async () => {
    await start(700);
    const first = await call('crm_export', {
      entityType: 'company',
      filter: { '!%TITLE': 'тестовая' },
      fields: ['ID', 'TITLE'],
      format: 'csv',
      maxSeconds: 1,
    });
    expect(first.success).toBe(true);
    expect(first.data?.['complete']).toBe(false);
    const cursor = first.data?.['cursor'] as string;
    expect(cursor).toBeTruthy();
    let env = first;
    for (let i = 0; i < 5 && env.data?.['complete'] === false; i++) {
      env = await call('crm_export', {
        entityType: 'company',
        filter: { '!%TITLE': 'тестовая' },
        fields: ['ID', 'TITLE'],
        format: 'csv',
        maxSeconds: 1,
        cursor: env.data?.['cursor'],
      });
      expect(env.success).toBe(true);
    }
    expect(env.data?.['complete']).toBe(true);
    expect(env.data?.['rows']).toBe(117);
    const csv = readFileSync(env.data?.['path'] as string, 'utf8');
    const ids = csv
      .trim()
      .split('\r\n')
      .slice(1)
      .map((l) => Number(l.split(';')[0]));
    expect(new Set(ids).size).toBe(117);
    expect(csv).not.toContain('Тестовая');
    // Использованный курсор второй раз не работает.
    const reuse = await call('crm_export', {
      entityType: 'company',
      filter: { '!%TITLE': 'тестовая' },
      fields: ['ID', 'TITLE'],
      format: 'csv',
      cursor,
    });
    expect(reuse.error?.code).toBe('VALIDATION_ERROR');
  });
});

describe('crm_count', () => {
  it('без группировки — один запрос и total портала', async () => {
    await start();
    const env = await call('crm_count', { entityType: 'company', filter: { ASSIGNED_BY_ID: 7 } });
    expect(env.data).toMatchObject({ total: 44, groups: [], complete: true });
    expect(t.bitrix.callsTo('crm.company.list')).toHaveLength(1);
  });

  it('по ответственным — таблица с ФИО; по месяцам создания; «!%» учитывается', async () => {
    await start();
    const byUser = await call('crm_count', { entityType: 'company', groupBy: 'ASSIGNED_BY_ID' });
    expect(byUser.data?.['total']).toBe(130);
    expect(byUser.data?.['groups']).toEqual([
      { key: '7', label: 'Тестов Иван', count: 44 },
      { key: '8', label: 'Пробная Анна', count: 43 },
      { key: '9', label: 'Уволенный Олег', count: 43 },
    ]);
    const lists = t.bitrix.callsTo('crm.company.list');
    expect(lists.at(-1)?.body['select']).toEqual(['ID', 'ASSIGNED_BY_ID']);

    const byMonth = await call('crm_count', {
      entityType: 'company',
      groupBy: 'DATE_CREATE',
      period: 'month',
      filter: { '!%TITLE': 'тестовая' },
    });
    expect(byMonth.data?.['groupBy']).toBe('DATE_CREATE:month');
    const groups = byMonth.data?.['groups'] as { key: string; count: number }[];
    expect(groups.map((g) => g.key)).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(groups.reduce((s, g) => s + g.count, 0)).toBe(117);

    const byType = await call('crm_count', { entityType: 'company', groupBy: 'COMPANY_TYPE' });
    expect(byType.data?.['groups']).toEqual([{ key: 'CUSTOMER', label: 'Клиент', count: 130 }]);
  });

  it('неизвестное поле группировки — понятная ошибка', async () => {
    await start();
    const env = await call('crm_count', { entityType: 'company', groupBy: 'NO_SUCH_FIELD' });
    expect(env.error?.code).toBe('VALIDATION_ERROR');
  });
});

describe('crm_orphans', () => {
  it('компании без сделок за всё время — файл и число за один вызов', async () => {
    await start();
    const env = await call('crm_orphans', { entityType: 'company', without: 'deals', format: 'csv' });
    expect(env.success).toBe(true);
    expect(env.data).toMatchObject({ complete: true, scanned: 130, found: 70 });
    const csv = readFileSync(env.data?.['path'] as string, 'utf8');
    expect(csv).toContain('/crm/company/details/61/');
    expect(csv).not.toContain('/crm/company/details/60/');
    // Связи проверяются пачкой: фильтр @COMPANY_ID по 50 ID.
    const dealCalls = t.bitrix.callsTo('crm.deal.list');
    expect((dealCalls[0]?.body['filter'] as Row)['@COMPANY_ID']).toHaveLength(50);
  });

  it('фильтр по дате создания и контакты: неосновной контакт сделки не считается «без сделок»', async () => {
    await start();
    const companies = await call('crm_orphans', {
      entityType: 'company',
      filter: { '>=DATE_CREATE': '2026-03-01' },
      format: 'csv',
    });
    expect(companies.data?.['scanned']).toBe(43);
    const contacts = await call('crm_orphans', { entityType: 'contact', format: 'csv' });
    // Контакт 2 — основной у сделок, 3 — неосновной; без сделок: 1, 4, 5.
    expect(contacts.data?.['found']).toBe(3);
    const csv = readFileSync(contacts.data?.['path'] as string, 'utf8');
    expect(csv).not.toContain('/crm/contact/details/3/');
    expect(existsSync(contacts.data?.['path'] as string)).toBe(true);
  });

  it('без дел за N дней — дела ищутся по владельцу и дате создания', async () => {
    await start();
    const env = await call('crm_orphans', {
      entityType: 'company',
      without: 'activities',
      activityDays: 30,
      format: 'csv',
    });
    expect(env.data?.['found']).toBe(129);
    const f = t.bitrix.callsTo('crm.activity.list')[0]?.body['filter'] as Row;
    expect(f['OWNER_TYPE_ID']).toBe(4);
    expect(f['>=CREATED']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

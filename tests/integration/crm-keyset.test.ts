/**
 * Ключевая пагинация crm_list_records (план ускорения, этап 6): первая страница — смещение с общим
 * числом, продолжение — фильтр по ID и start=-1. Правки во время листания не дают дублей и пропусков.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { connectInMemory, createTestApp, structured, type TestApp } from '../helpers/app.js';
import { DEAL_FIELDS, dealRecord, legacyIdList, legacyOk } from '../helpers/mock-bitrix.js';
import { STATUS_LISTS } from '../helpers/mock-crm.js';
import { keysetDirection, keysetFilter } from '../../src/tools/crm/crm-service.js';

interface Env {
  success: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; details: Record<string, unknown> };
  meta: Record<string, unknown>;
}

let t: TestApp;
let client: Client;
let close: () => Promise<void>;
let portal: { ID: string }[];
const call = async (args: Record<string, unknown>) =>
  structured<Env>(await client.callTool({ name: 'crm_list_records', arguments: args }));
const page = (env: Env) => env.meta['page'] as { nextCursor: string | null; hasMore: boolean };
const ids = (env: Env) => (env.data?.['items'] as { ID: string }[]).map((i) => Number(i.ID));

beforeEach(async () => {
  portal = Array.from({ length: 130 }, (_, i) => dealRecord(i + 1) as { ID: string });
  t = createTestApp({ MAX_PAGE_SIZE: '50' });
  t.bitrix
    .on('crm.deal.fields', legacyOk(DEAL_FIELDS))
    .on('crm.status.list', legacyOk(STATUS_LISTS['DEAL_STAGE']))
    .on('crm.deal.list', (c) => legacyIdList(portal, c.body));
  const c = await connectInMemory(t.app);
  client = c.client;
  close = () => c.close();
});
afterEach(async () => {
  await close();
  t.app.close();
});

describe('crm_list_records: ключевая пагинация по ID', () => {
  it('130 сделок по 50: общее число на первой странице, продолжение без смещения, без пропусков', async () => {
    const p1 = await call({ entityType: 'deal', pageSize: 50 });
    expect(p1.data?.['upstreamTotal']).toBe(130);
    const p2 = await call({ entityType: 'deal', pageSize: 50, cursor: page(p1).nextCursor });
    const p3 = await call({ entityType: 'deal', pageSize: 50, cursor: page(p2).nextCursor });
    expect(page(p3).hasMore).toBe(false);
    const all = [...ids(p1), ...ids(p2), ...ids(p3)];
    expect(all).toEqual(Array.from({ length: 130 }, (_, i) => 130 - i));
    const sent = t.bitrix.callsTo('crm.deal.list').map((c) => c.body);
    expect(sent[0]).toMatchObject({ start: 0, order: { ID: 'DESC' } });
    expect(sent[1]).toMatchObject({ start: -1, filter: { '<ID': 81 }, order: { ID: 'DESC' } });
    expect(sent[2]).toMatchObject({ start: -1, filter: { '<ID': 31 } });
  });

  it('новая и удалённая во время листания запись не дают дубля и пропуска', async () => {
    const p1 = await call({ entityType: 'deal', pageSize: 50 });
    portal.push(dealRecord(131) as { ID: string }); // новая — выше прочитанного, в выдачу не попадает
    portal = portal.filter((d) => d.ID !== '10'); // удалённая ниже границы
    const p2 = await call({ entityType: 'deal', pageSize: 50, cursor: page(p1).nextCursor });
    const p3 = await call({ entityType: 'deal', pageSize: 50, cursor: page(p2).nextCursor });
    const all = [...ids(p1), ...ids(p2), ...ids(p3)];
    expect(new Set(all).size).toBe(all.length);
    expect(all).toEqual(Array.from({ length: 130 }, (_, i) => 130 - i).filter((id) => id !== 10));
  });

  it('по возрастанию: граница пользователя >ID сужается ключом, не теряется', async () => {
    const p1 = await call({ entityType: 'deal', pageSize: 50, order: { ID: 'ASC' }, filter: { '>ID': 20 } });
    expect(ids(p1)[0]).toBe(21);
    const p2 = await call({
      entityType: 'deal',
      pageSize: 50,
      order: { ID: 'ASC' },
      filter: { '>ID': 20 },
      cursor: page(p1).nextCursor,
    });
    expect(ids(p2)[0]).toBe(71);
    expect(t.bitrix.callsTo('crm.deal.list')[1]?.body).toMatchObject({ start: -1, filter: { '>ID': 70 } });
  });

  it('сортировка не по ID — прежнее смещение', async () => {
    const p1 = await call({ entityType: 'deal', pageSize: 50, order: { DATE_CREATE: 'DESC' } });
    await call({
      entityType: 'deal',
      pageSize: 50,
      order: { DATE_CREATE: 'DESC' },
      cursor: page(p1).nextCursor,
    });
    expect(t.bitrix.callsTo('crm.deal.list').map((c) => c.body['start'])).toEqual([0, 50]);
  });
});

describe('выбор режима', () => {
  it('только сортировка ровно по ID и числовая граница пользователя', () => {
    expect(keysetDirection({ ID: 'DESC' }, {})).toBe('DESC');
    expect(keysetDirection({ ID: 'ASC' }, { '>ID': '5' })).toBe('ASC');
    expect(keysetDirection({ ID: 'ASC', TITLE: 'ASC' }, {})).toBeNull();
    expect(keysetDirection({ DATE_CREATE: 'DESC' }, {})).toBeNull();
    expect(keysetDirection({ ID: 'DESC' }, { '<ID': 'abc' })).toBeNull();
    expect(keysetFilter({ '<ID': 40, STAGE_ID: 'NEW' }, 'DESC', 81)).toEqual({ '<ID': 40, STAGE_ID: 'NEW' });
    expect(keysetFilter({}, 'ASC', 70)).toEqual({ '>ID': 70 });
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { connectInMemory, createTestApp, structured, type TestApp } from '../helpers/app.js';
import { DEAL_FIELDS, dealRecord, legacyError, legacyListPage, legacyOk } from '../helpers/mock-bitrix.js';
import { mockCrmItems } from '../helpers/mock-crm-items.js';

interface Env {
  success: boolean;
  data: { items: Record<string, unknown>[]; upstreamTotal?: number };
  error?: { code: string };
  meta: { page: { nextCursor: string | null; hasMore: boolean } };
}
let t: TestApp;
let client: Client;
let close: () => Promise<void>;
const call = async (args: Record<string, unknown>, name = 'crm_list_records') =>
  structured<Env>(await client.callTool({ name, arguments: args }));

beforeEach(async () => {
  t = createTestApp({ BITRIX_REQUESTS_PER_SECOND: '10' });
  t.bitrix.on('crm.deal.fields', legacyOk(DEAL_FIELDS));
  const connection = await connectInMemory(t.app);
  client = connection.client;
  close = () => connection.close();
});
afterEach(async () => {
  await close();
  t.app.close();
});

describe('bounded CRM reads', () => {
  it('compact also applies to crm.item lists, with full mode and explicit fields retained', async () => {
    mockCrmItems(t.bitrix);
    const compact = await call({ entityType: 'invoice' });
    expect(compact.success).toBe(true);
    expect(compact.data.items[0]).toHaveProperty('id', 40);
    expect(compact.data.items[0]).not.toHaveProperty('stageId');
    const full = await call({ entityType: 'invoice', compact: false });
    expect(full.data.items[0]).toHaveProperty('stageId');
    const select = await call({ entityType: 'invoice', select: ['title'] });
    expect(Object.keys(select.data.items[0] ?? {})).toEqual(['title']);
  });
  it('defaults to compact; explicit false retains former fields; explicit select remains exact', async () => {
    t.bitrix.on(
      'crm.deal.list',
      legacyOk([dealRecord(1, { STAGE_ID: 'NEW', OPPORTUNITY: '500', CURRENCY_ID: null })]),
    );
    const compact = await call({ entityType: 'deal' });
    expect(compact.success).toBe(true);
    expect(compact.data.items[0]).toHaveProperty('ID', '1');
    expect(compact.data.items[0]).not.toHaveProperty('STAGE_ID');
    expect(compact.data.items[0]).not.toHaveProperty('CURRENCY_ID');
    const full = await call({ entityType: 'deal', compact: false });
    expect(full.data.items[0]).toHaveProperty('STAGE_ID', 'NEW');
    const selected = await call({ entityType: 'deal', select: ['TITLE'] });
    expect(Object.keys(selected.data.items[0] ?? {})).toEqual(['TITLE']);
  });

  for (const order of [{ ID: 'ASC' }, { DATE_CREATE: 'ASC' }]) {
    it(`continues past an entirely filtered page (${Object.keys(order)[0]})`, async () => {
      const rows = Array.from({ length: 120 }, (_, i) =>
        dealRecord(i + 1, { TITLE: i < 100 ? 'skip' : 'keep' }),
      );
      t.bitrix.on('crm.deal.list', (c) => {
        const filter = c.body['filter'] as Record<string, unknown>;
        const start = Number(c.body['start']);
        const after = Number(filter['>ID'] ?? 0);
        return start === -1
          ? legacyOk(rows.filter((r) => Number(r.ID) > after).slice(0, 50))
          : legacyListPage(rows, start);
      });
      const result = await call({ entityType: 'deal', order, filter: { '!%TITLE': 'skip' }, pageSize: 20 });
      expect(result.success).toBe(true);
      expect(result.data.items.map((r) => r['ID'])).toEqual(
        Array.from({ length: 20 }, (_, i) => String(i + 101)),
      );
      expect(result.data.upstreamTotal).toBeUndefined();
      expect(result.meta.page.hasMore).toBe(false);
    });
  }

  for (const name of ['crm_activities_list', 'crm_activities_search']) {
    it(`${name}: ignores unrequested description/files and caps an explicitly requested email`, async () => {
      const text = 'message '.repeat(1000);
      t.bitrix.on(
        'crm.activity.list',
        legacyOk([
          {
            ID: '1',
            TYPE_ID: '4',
            DESCRIPTION_TYPE: '3',
            DESCRIPTION: `<p>${text}</p>`,
            FILES: [{ secret: 'private-file' }],
            COMMUNICATIONS: ['private-address'],
          },
        ]),
      );
      const base =
        name === 'crm_activities_list' ? { entityType: 'deal', recordId: 1 } : { withNames: false };
      const hidden = await call(base, name);
      expect(JSON.stringify(hidden.data)).not.toContain('message');
      expect(JSON.stringify(hidden.data)).not.toContain('private-');
      const shown = await call({ ...base, includeDescription: true, descriptionMaxChars: 200 }, name);
      const row = shown.data.items[0];
      expect(row?.['DESCRIPTION'] ?? row?.['description']).toHaveLength(200);
      expect(row?.['DESCRIPTION_TRUNCATED'] ?? row?.['descriptionTruncated']).toBe(true);
      expect(JSON.stringify(shown.data)).not.toContain('private-');
    });
  }

  it('upstream permission denial is preserved, with no alternate REST route', async () => {
    t.bitrix.on('crm.requisite.list', legacyError('ACCESS_DENIED', 403, 'Denied'));
    const result = await call({ inn: '7728150075' }, 'crm_find_by_requisite');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('BITRIX_ACCESS_DENIED');
    expect(t.bitrix.callsTo('crm.requisite.list')).toHaveLength(1);
    expect(t.bitrix.calls).toHaveLength(1);
  });
});

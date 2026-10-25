import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { connectInMemory, createTestApp, structured, type TestApp } from '../helpers/app.js';
import { legacyOk } from '../helpers/mock-bitrix.js';

interface Env {
  success: boolean;
  data: { items: Record<string, unknown>[]; matchBasis: string };
  error?: { code: string };
  meta: { page: { nextCursor: string | null; hasMore: boolean } };
}

let t: TestApp;
let client: Client;
let close: () => Promise<void>;
const call = async (args: Record<string, unknown>) =>
  structured<Env>(await client.callTool({ name: 'crm_find_by_requisite', arguments: args }));

beforeEach(async () => {
  t = createTestApp({ BITRIX_REQUESTS_PER_SECOND: '10' });
  t.bitrix.on('crm.requisite.list', (c) => {
    const start = Number(c.body['start'] ?? 0);
    return legacyOk(
      [
        {
          ID: String(start + 1),
          ENTITY_TYPE_ID: '4',
          ENTITY_ID: '10',
          RQ_INN: '7728150075',
          NAME: 'Первый',
          RQ_IDENT_DOC_NUM: 'must-not-leave',
        },
        { ID: String(start + 2), ENTITY_TYPE_ID: '4', ENTITY_ID: '11', RQ_INN: '7728150075', NAME: 'Второй' },
      ],
      { total: 4, ...(start === 0 ? { next: 50 } : {}) },
    );
  });
  const connected = await connectInMemory(t.app);
  client = connected.client;
  close = connected.close;
});

afterEach(async () => {
  await close();
  t.app.close();
});

describe('crm_find_by_requisite', () => {
  it('uses exact INN in one read and strips unexpected personal fields', async () => {
    const result = await call({ inn: '7728150075', pageSize: 2 });
    expect(result.success).toBe(true);
    expect(result.data.matchBasis).toBe('exact_requisite_inn');
    expect(result.data.items.map((r) => r['ENTITY_ID'])).toEqual(['10', '11']);
    expect(JSON.stringify(result.data)).not.toContain('must-not-leave');
    expect(t.bitrix.calls).toHaveLength(1);
    expect(t.bitrix.calls[0]?.body['filter']).toEqual({ RQ_INN: '7728150075', ENTITY_TYPE_ID: 4 });
    expect(result.meta.page.hasMore).toBe(true);
  });

  it('keeps all pages and binds the cursor to INN and owner type', async () => {
    const first = await call({ inn: '7728150075', pageSize: 2 });
    const wrong = await call({ inn: '7805731302', cursor: first.meta.page.nextCursor });
    expect(wrong.success).toBe(false);
    const wrongOwner = await call({
      inn: '7728150075',
      ownerEntityTypeId: 3,
      cursor: first.meta.page.nextCursor,
    });
    expect(wrongOwner.success).toBe(false);
    const second = await call({ inn: '7728150075', cursor: first.meta.page.nextCursor, pageSize: 2 });
    expect(second.success).toBe(true);
    expect(second.data.items.map((r) => r['ID'])).toEqual(['51', '52']);
    expect(second.meta.page.hasMore).toBe(false);
  });

  it('rejects malformed INN and unsupported owners before calling Bitrix', async () => {
    for (const args of [{ inn: '7728' }, { inn: 7728150075 }, { inn: '7728150075', ownerEntityTypeId: 8 }]) {
      const result = await client.callTool({ name: 'crm_find_by_requisite', arguments: args });
      expect(result.isError).toBe(true);
    }
    expect(t.bitrix.calls).toHaveLength(0);
  });
});

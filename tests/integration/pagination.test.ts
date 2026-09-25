import { describe, expect, it } from 'vitest';
import { bindingHash, CursorStore, paginateLegacy } from '../../src/bitrix/pagination.js';
import { AppError } from '../../src/errors/app-error.js';
import { SecretBox } from '../../src/security/crypto.js';
import { Database } from '../../src/storage/database.js';
import type { JsonValue } from '../../src/bitrix/legacy-adapter.js';
import { deals, type MockResponse, legacyListPage } from '../helpers/mock-bitrix.js';

function setup(ttl = 600) {
  const db = Database.open(':memory:');
  const store = new CursorStore(db, new SecretBox(Buffer.alloc(32, 3)), ttl);
  const all = deals(1, 50);
  const upstreamCalls: number[] = [];
  const fetchPage = (start: number) => {
    upstreamCalls.push(start);
    const page = legacyListPage(all, start, 50) as MockResponse & {
      body: { result: JsonValue[]; next?: number; total: number };
    };
    return Promise.resolve({ items: page.body.result, next: page.body.next, total: page.body.total });
  };
  const binding = {
    principalId: 'owner',
    portalKey: 'k1',
    tool: 'crm_list_records',
    bindingHash: bindingHash({ filter: { STAGE_ID: 'NEW' }, pageSize: 20 }),
  };
  return { db, store, fetchPage, binding, upstreamCalls };
}

describe('пагинация (T20, T21, ТЗ §14.3)', () => {
  it('T20: upstream 50, pageSize 20 → три страницы без пропусков и дублей, один upstream-запрос', async () => {
    const { store, fetchPage, binding, upstreamCalls } = setup();
    const p1 = await paginateLegacy({ store, binding, cursor: undefined, pageSize: 20, fetchPage });
    expect(p1.items).toHaveLength(20);
    expect(p1.hasMore).toBe(true);
    expect(p1.upstreamTotal).toBe(50);
    const p2 = await paginateLegacy({
      store,
      binding,
      cursor: p1.nextCursor ?? undefined,
      pageSize: 20,
      fetchPage,
    });
    expect(p2.items).toHaveLength(20);
    expect(p2.upstreamCalls).toBe(0);
    const p3 = await paginateLegacy({
      store,
      binding,
      cursor: p2.nextCursor ?? undefined,
      pageSize: 20,
      fetchPage,
    });
    expect(p3.items).toHaveLength(10);
    expect(p3.hasMore).toBe(false);
    expect(p3.nextCursor).toBeNull();
    const ids = [...p1.items, ...p2.items, ...p3.items].map((d) => (d as { ID: string }).ID);
    expect(new Set(ids).size).toBe(50);
    expect(ids).toEqual(deals(1, 50).map((d) => d.ID));
    expect(upstreamCalls).toEqual([0]);
  });

  it('T21: курсор с другим фильтром, чужим principal или повторно — отказ', async () => {
    const { store, fetchPage, binding } = setup();
    const p1 = await paginateLegacy({ store, binding, cursor: undefined, pageSize: 20, fetchPage });
    const cursor = p1.nextCursor ?? '';
    const other = { ...binding, bindingHash: bindingHash({ filter: { STAGE_ID: 'WON' }, pageSize: 20 }) };
    await expect(
      paginateLegacy({ store, binding: other, cursor, pageSize: 20, fetchPage }),
    ).rejects.toBeInstanceOf(AppError);
    await expect(
      paginateLegacy({
        store,
        binding: { ...binding, principalId: 'intruder' },
        cursor,
        pageSize: 20,
        fetchPage,
      }),
    ).rejects.toBeInstanceOf(AppError);
    // корректное использование расходует курсор
    await paginateLegacy({ store, binding, cursor, pageSize: 20, fetchPage });
    await expect(paginateLegacy({ store, binding, cursor, pageSize: 20, fetchPage })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('истёкший курсор отвергается', async () => {
    const { store, fetchPage, binding } = setup(-1);
    const p1 = await paginateLegacy({ store, binding, cursor: undefined, pageSize: 20, fetchPage });
    await expect(
      paginateLegacy({ store, binding, cursor: p1.nextCursor ?? '', pageSize: 20, fetchPage }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('состояние курсора хранится зашифрованным', async () => {
    const { db, store, fetchPage, binding } = setup();
    await paginateLegacy({ store, binding, cursor: undefined, pageSize: 20, fetchPage });
    const row = db.get<{ state_json: string }>('SELECT state_json FROM cursors');
    expect(row?.state_json.startsWith('v1:')).toBe(true);
    expect(row?.state_json).not.toContain('Сделка');
  });

  it('сбой портала при продолжении не расходует курсор: повтор с тем же cursor работает, после успеха — одноразовый', async () => {
    const { store, binding } = setup();
    // pageSize 50 = upstream-страница: продолжение требует нового запроса к порталу
    const all = deals(1, 120);
    let failNext = false;
    const flaky = (start: number) => {
      if (failNext) {
        failNext = false;
        return Promise.reject(new AppError('BITRIX_TIMEOUT', 'timeout'));
      }
      const page = legacyListPage(all, start, 50) as MockResponse & {
        body: { result: JsonValue[]; next?: number; total: number };
      };
      return Promise.resolve({ items: page.body.result, next: page.body.next, total: page.body.total });
    };
    const p1 = await paginateLegacy({ store, binding, cursor: undefined, pageSize: 50, fetchPage: flaky });
    const cursor = p1.nextCursor ?? undefined;
    failNext = true;
    await expect(
      paginateLegacy({ store, binding, cursor, pageSize: 50, fetchPage: flaky }),
    ).rejects.toThrow();
    const p2 = await paginateLegacy({ store, binding, cursor, pageSize: 50, fetchPage: flaky });
    expect((p2.items[0] as { ID: string }).ID).toBe('51');
    await expect(paginateLegacy({ store, binding, cursor, pageSize: 50, fetchPage: flaky })).rejects.toThrow(
      /Курсор недействителен/,
    );
  });
});

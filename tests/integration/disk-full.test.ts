/**
 * Этап 13/14: Диск полной версии (ТЗ §9.12, §8.5) на mock —
 * disk_storages_list, disk_children_list (DOWNLOAD_URL не утекает), disk_search_files (ограниченный обход,
 * очередь в курсоре, SCAN_LIMIT_REACHED, maxDepth, курсор чужого пользователя/фильтра), disk_delete_file
 * (корзина через markDeleted, скрыт/не-админ, approve/replay, CONFLICT, outcome unknown).
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import type { Principal } from '../../src/auth/principal.js';
import { dispatch } from '../../src/mcp/register-tools.js';
import { diskSearchFilesTool } from '../../src/tools/disk/read.js';
import { diskDeleteFileTool } from '../../src/tools/disk/delete-file.js';
import { connectInMemory, createTestApp, structured, type TestApp } from '../helpers/app.js';
import { legacyError, legacyListPage, legacyOk } from '../helpers/mock-bitrix.js';

interface Env {
  success: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; details: Record<string, unknown> };
  meta: Record<string, unknown> & {
    warnings?: string[];
    page?: { nextCursor: string | null; hasMore: boolean };
  };
}

let t: TestApp;
let client: Client;
let close: () => Promise<void>;
const responses: string[] = [];
const call = async (name: string, args: Record<string, unknown>) => {
  const r = await client.callTool({ name, arguments: args });
  responses.push(JSON.stringify(r));
  return structured<Env>(r);
};
const rejected = async (name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })).isError === true;
const opId = (env: Env): string => {
  const id = env.error?.details['operationId'];
  return typeof id === 'string' ? id : '';
};

const HOST = 'https://mock.bitrix24.invalid';
const SECRET_DL = `${HOST}/rest/download.json?auth=d9c4676900000secretauth&token=disk%7CaWQ9ODk2NCZf`;

function obj(
  id: number,
  name: string,
  type: 'file' | 'folder',
  parent: number,
  extra: Record<string, unknown> = {},
) {
  return {
    ID: String(id),
    NAME: name,
    CODE: null,
    STORAGE_ID: '3',
    TYPE: type,
    PARENT_ID: String(parent),
    DELETED_TYPE: '0',
    CREATE_TIME: '2030-01-14T15:01:14+03:00',
    UPDATE_TIME: '2030-01-14T15:01:14+03:00',
    DELETE_TIME: null,
    CREATED_BY: '7',
    UPDATED_BY: '7',
    DELETED_BY: '0',
    ...(type === 'file'
      ? { SIZE: '52486', FILE_ID: String(id * 10), GLOBAL_CONTENT_VERSION: '1', DOWNLOAD_URL: SECRET_DL }
      : { REAL_OBJECT_ID: String(id) }),
    DETAIL_URL: `${HOST}/company/personal/user/7/disk/path/${encodeURIComponent(name)}`,
    ...extra,
  };
}

let tree: Record<number, Record<string, unknown>[]>;
let files: Record<number, Record<string, unknown>>;

function setup(overrides: Record<string, string> = {}) {
  const docs = Array.from({ length: 55 }, (_, i) => obj(100 + i, `file-${String(i)}.txt`, 'file', 10));
  tree = {
    // корень хранилища 3
    0: [
      obj(10, 'Документы', 'folder', 1),
      obj(11, 'Архив', 'folder', 1),
      obj(20, 'Годовой отчет 2029.pdf', 'file', 1),
      obj(22, 'чужая ссылка.txt', 'file', 1, { DETAIL_URL: 'https://evil.example/steal?x=1' }),
    ],
    10: [...docs, obj(12, 'Проекты', 'folder', 10)],
    11: [obj(21, 'годовой отчет 2028.pdf', 'file', 11)],
    12: [obj(30, 'ГОДОВОЙ план.docx', 'file', 12), obj(13, 'Глубоко', 'folder', 12)],
    13: [obj(14, 'Глубже', 'folder', 13)],
    14: [obj(40, 'годовой-deep.txt', 'file', 14)],
  };
  files = { 20: obj(20, 'Годовой отчет 2029.pdf', 'file', 1) };
  t = createTestApp({ READ_ONLY_MODE: 'false', BITRIX_REQUESTS_PER_SECOND: '10', ...overrides });
  t.bitrix
    .on('disk.storage.getlist', (c) => {
      const all = [
        {
          ID: '3',
          NAME: 'Иван Тестов',
          CODE: null,
          MODULE_ID: 'disk',
          ENTITY_TYPE: 'user',
          ENTITY_ID: '7',
          ROOT_OBJECT_ID: '1',
        },
        {
          ID: '4',
          NAME: 'Общий диск',
          CODE: 'COMMON',
          MODULE_ID: 'disk',
          ENTITY_TYPE: 'common',
          ENTITY_ID: 's1',
          ROOT_OBJECT_ID: '2',
        },
      ];
      const et = (c.body['filter'] as Record<string, unknown> | undefined)?.['ENTITY_TYPE'];
      return legacyListPage(
        all.filter((s) => !et || s.ENTITY_TYPE === et),
        Number(c.body['start'] ?? 0),
      );
    })
    .on('disk.storage.getchildren', (c) =>
      Number(c.body['id']) === 3
        ? legacyListPage(tree[0] ?? [], Number(c.body['start'] ?? 0))
        : legacyError('ERROR_NOT_FOUND', 400, 'Could not find entity'),
    )
    .on('disk.folder.getchildren', (c) => {
      const list = tree[Number(c.body['id'])];
      return list ? legacyListPage(list, Number(c.body['start'] ?? 0)) : legacyError('ERROR_NOT_FOUND', 400);
    })
    .on('disk.folder.get', (c) =>
      Number(c.body['id']) === 1
        ? legacyOk({ ID: '1', NAME: 'Корень', STORAGE_ID: '3' })
        : legacyError('ERROR_NOT_FOUND', 400),
    )
    .on('disk.file.get', (c) => {
      const f = files[Number(c.body['id'])];
      return f ? legacyOk(f) : legacyError('ERROR_NOT_FOUND', 400, 'Could not find entity');
    })
    .on('disk.file.markdeleted', (c) => {
      const f = files[Number(c.body['id'])];
      if (!f) return legacyError('ERROR_NOT_FOUND', 400);
      f['DELETED_TYPE'] = '3';
      f['DELETE_TIME'] = '2030-02-16T14:43:38+03:00';
      return legacyOk(f);
    });
}

async function reconnect(overrides: Record<string, string> = {}) {
  setup(overrides);
  const c = await connectInMemory(t.app);
  client = c.client;
  close = () => c.close();
}

beforeEach(async () => {
  responses.length = 0;
  await reconnect();
});
afterEach(async () => {
  // секретные ссылки на скачивание не попадают ни в один ответ
  for (const r of responses) {
    expect(r).not.toContain('download.json');
    expect(r).not.toContain('secretauth');
    expect(r).not.toContain('evil.example');
  }
  await close();
  t.app.close();
});

describe('disk_storages_list / disk_children_list', () => {
  it('хранилища с rootFolderId; фильтр entityType передаётся в filter', async () => {
    const env = await call('disk_storages_list', {});
    expect(env.data?.['items']).toEqual([
      { id: 3, name: 'Иван Тестов', entityType: 'user', entityId: 7, rootFolderId: 1, moduleId: 'disk' },
      { id: 4, name: 'Общий диск', code: 'COMMON', entityType: 'common', rootFolderId: 2, moduleId: 'disk' },
    ]);
    const common = await call('disk_storages_list', { entityType: 'common' });
    expect((common.data?.['items'] as unknown[]).length).toBe(1);
    expect(t.bitrix.callsTo('disk.storage.getlist')[1]?.body['filter']).toEqual({ ENTITY_TYPE: 'common' });
  });

  it('корень хранилища: без DOWNLOAD_URL, detailUrl только на хост портала без параметров', async () => {
    const env = await call('disk_children_list', { storageId: 3 });
    expect(env.success).toBe(true);
    const items = env.data?.['items'] as Record<string, unknown>[];
    expect(items.map((i) => i['id'])).toEqual([10, 11, 20, 22]);
    expect(items[2]).toMatchObject({ type: 'file', size: 52486, parentId: 1, storageId: 3, deleted: false });
    expect(String(items[2]?.['detailUrl'])).toMatch(/^https:\/\/mock\.bitrix24\.invalid\/company\//);
    expect(items[3]).not.toHaveProperty('detailUrl');
    expect(items[0]).not.toHaveProperty('size');
    expect(t.bitrix.callsTo('disk.storage.getchildren')[0]?.body).toMatchObject({ id: 3 });
  });

  it('папка из 56 объектов: страницы по 50 и продолжение по cursor без пропусков; ровно одно из storageId/folderId', async () => {
    const first = await call('disk_children_list', { folderId: 10, pageSize: 50 });
    expect((first.data?.['items'] as unknown[]).length).toBe(50);
    const second = await call('disk_children_list', {
      folderId: 10,
      pageSize: 50,
      cursor: first.meta.page?.nextCursor,
    });
    expect((second.data?.['items'] as Record<string, unknown>[]).map((i) => i['id'])).toEqual([
      150, 151, 152, 153, 154, 12,
    ]);
    expect(second.meta.page?.hasMore).toBe(false);
    expect(await rejected('disk_children_list', { folderId: 10, storageId: 3 })).toBe(true);
    expect(await rejected('disk_children_list', {})).toBe(true);
  });
});

describe('disk_search_files', () => {
  it('recursive=false: только сама область, completeness complete, регистр не важен', async () => {
    const env = await call('disk_search_files', { storageId: 3, nameQuery: 'ГОДОВОЙ' });
    expect(env.success).toBe(true);
    expect((env.data?.['items'] as Record<string, unknown>[]).map((i) => [i['id'], i['path']])).toEqual([
      [20, 'Годовой отчет 2029.pdf'],
    ]);
    expect(env.meta.completeness).toBe('complete');
    expect(t.bitrix.callsTo('disk.folder.getchildren')).toHaveLength(0);
    // фильтр имени не передаётся в Bitrix: иначе отсеклись бы папки обхода
    expect(t.bitrix.callsTo('disk.storage.getchildren')[0]?.body).not.toHaveProperty('filter');
  });

  it('рекурсивный обход: папки с несовпавшим именем проходятся, очередь продолжается по cursor, пути собраны', async () => {
    const args = {
      storageId: 3,
      nameQuery: 'годовой',
      recursive: true,
      maxDepth: 5,
      maxVisited: 500,
      pageSize: 2,
    };
    const first = await call('disk_search_files', args);
    expect((first.data?.['items'] as Record<string, unknown>[]).map((i) => i['id'])).toEqual([20, 21]);
    expect(first.meta.completeness).toBe('partial');
    const cursor = first.meta.page?.nextCursor;
    expect(typeof cursor).toBe('string');
    const second = await call('disk_search_files', { ...args, cursor });
    const items = second.data?.['items'] as Record<string, unknown>[];
    expect(items.map((i) => [i['id'], i['path']])).toEqual([
      [30, 'Документы/Проекты/ГОДОВОЙ план.docx'],
      [40, 'Документы/Проекты/Глубоко/Глубже/годовой-deep.txt'],
    ]);
    expect(second.meta.page?.hasMore).toBe(false);
    expect(second.meta.completeness).toBe('complete');
    expect(second.data?.['coverage']).toMatchObject({
      scanFinished: true,
      scanLimitReached: false,
      pendingFolders: 0,
    });
    // папка 10 с 56 объектами прочитана двумя upstream-страницами
    expect(
      t.bitrix.callsTo('disk.folder.getchildren').filter((c) => Number(c.body['id']) === 10),
    ).toHaveLength(2);
  });

  it('maxDepth: глубже лимита не спускается, помечено partial с числом пропущенных папок', async () => {
    const env = await call('disk_search_files', {
      storageId: 3,
      nameQuery: 'годовой',
      recursive: true,
      maxDepth: 1,
    });
    expect((env.data?.['items'] as Record<string, unknown>[]).map((i) => i['id'])).toEqual([20, 21]);
    expect(env.data?.['coverage']).toMatchObject({ depthLimitedFolders: 1, scanFinished: true });
    expect(env.meta.completeness).toBe('partial');
    expect((env.meta.warnings ?? []).join(' ')).toContain('maxDepth=1');
  });

  it('maxVisited: SCAN_LIMIT_REACHED, partial, продолжения нет', async () => {
    const env = await call('disk_search_files', {
      storageId: 3,
      nameQuery: 'годовой',
      recursive: true,
      maxVisited: 10,
    });
    expect(env.success).toBe(true);
    expect((env.data?.['items'] as Record<string, unknown>[]).map((i) => i['id'])).toEqual([20]);
    expect(env.data?.['coverage']).toMatchObject({
      scannedObjects: 10,
      scanLimitReached: true,
      scanFinished: false,
      reason: 'SCAN_LIMIT_REACHED',
    });
    expect(env.meta.completeness).toBe('partial');
    expect(env.meta.page?.nextCursor).toBeNull();
    expect((env.meta.warnings ?? []).join(' ')).toContain('SCAN_LIMIT_REACHED');
  });

  it('T21: курсор чужого пользователя или другого запроса отклоняется', async () => {
    const args = { storageId: 3, nameQuery: 'годовой', recursive: true, pageSize: 1 };
    const first = await call('disk_search_files', args);
    const cursor = first.meta.page?.nextCursor ?? '';
    expect(cursor).not.toBe('');
    const other: Principal = { id: 'intruder', role: 'administrator', source: 'local' };
    const foreign = await dispatch(diskSearchFilesTool, { ...args, cursor }, t.app, undefined, other);
    expect(foreign.success).toBe(false);
    if (!foreign.success) expect(foreign.error.details.field).toBe('cursor');
    const changed = await call('disk_search_files', { ...args, nameQuery: 'план', cursor });
    expect(changed.error?.details['field']).toBe('cursor');
    expect(await rejected('disk_search_files', { nameQuery: 'x' })).toBe(true);
    expect(await rejected('disk_search_files', { storageId: 3, nameQuery: 'x', maxDepth: 6 })).toBe(true);
    expect(await rejected('disk_search_files', { storageId: 3, nameQuery: 'x', maxVisited: 501 })).toBe(true);
  });
});

describe('disk_delete_file', () => {
  it('скрыт без ENABLE_DESTRUCTIVE_TOOLS; не-админу — отказ; до Bitrix не доходит', async () => {
    expect((await client.listTools()).tools.map((x) => x.name)).not.toContain('disk_delete_file');
    const hidden = await dispatch(diskDeleteFileTool, { fileId: 20, dryRun: true }, t.app);
    expect(hidden.success).toBe(false);
    if (!hidden.success) expect(hidden.error.code).toBe('METHOD_NOT_ALLOWED');
    await close();
    t.app.close();
    await reconnect({ ENABLE_DESTRUCTIVE_TOOLS: 'true' });
    const operator: Principal = { id: 'op', role: 'operator', source: 'local' };
    const denied = await dispatch(
      diskDeleteFileTool,
      { fileId: 20, dryRun: true },
      t.app,
      undefined,
      operator,
    );
    expect(denied.success).toBe(false);
    if (!denied.success) expect(denied.error.code).toBe('ACCESS_DENIED');
    expect(t.bitrix.calls).toHaveLength(0);
  });

  it('план (корзина, имя, размер, папка) → approve → markDeleted → сверка; replay без второй записи', async () => {
    await close();
    t.app.close();
    await reconnect({ ENABLE_DESTRUCTIVE_TOOLS: 'true' });
    const dry = await call('disk_delete_file', { fileId: 20, dryRun: true });
    expect(dry.success).toBe(true);
    const hash = dry.data?.['stateHash'] as string;
    const plan = dry.data?.['plan'] as Record<string, unknown>;
    expect(plan['details']).toMatchObject({
      method: 'disk.file.markdeleted',
      mode: 'trash',
      impact: {
        name: 'Годовой отчет 2029.pdf',
        size: 52486,
        folderId: 1,
        folderName: 'Корень',
        storageId: 3,
      },
    });
    expect(JSON.stringify(plan)).toContain('Безвозвратное удаление (disk.file.delete) не выполняется');

    const args = { fileId: 20, expectedStateHash: hash, idempotencyKey: randomUUID() };
    const prep = await call('disk_delete_file', args);
    expect(prep.error?.code).toBe('APPROVAL_REQUIRED');
    expect(t.bitrix.callsTo('disk.file.markdeleted')).toHaveLength(0);
    await t.app.approvals.approve(opId(prep), 'owner', t.app.auth.portalKey);
    const done = await call('disk_delete_file', { ...args, approvalId: opId(prep) });
    expect(done.success).toBe(true);
    expect(done.data).toMatchObject({ fileId: 20, inTrash: true, verified: true, replayed: false });
    const again = await call('disk_delete_file', { ...args, approvalId: opId(prep) });
    expect(again.data).toMatchObject({ replayed: true });
    expect(t.bitrix.callsTo('disk.file.markdeleted')).toHaveLength(1);
    // новое намерение на уже удалённый файл — отказ до плана
    const inTrash = await call('disk_delete_file', { fileId: 20, dryRun: true });
    expect(inTrash.error?.details['reason']).toBe('ALREADY_IN_TRASH');
    expect(t.bitrix.callsTo('disk.file.delete')).toHaveLength(0);
  });

  it('CONFLICT: файл изменён (новая версия) до плана и между подтверждением и записью; NOT_FOUND без плана', async () => {
    await close();
    t.app.close();
    await reconnect({ ENABLE_DESTRUCTIVE_TOOLS: 'true' });
    const dry = await call('disk_delete_file', { fileId: 20, dryRun: true });
    const hash = dry.data?.['stateHash'] as string;
    const args = { fileId: 20, expectedStateHash: hash, idempotencyKey: randomUUID() };
    const prep = await call('disk_delete_file', args);
    await t.app.approvals.approve(opId(prep), 'owner', t.app.auth.portalKey);
    const f = files[20] ?? {};
    f['SIZE'] = '60000';
    f['GLOBAL_CONTENT_VERSION'] = '2';
    const raced = await call('disk_delete_file', { ...args, approvalId: opId(prep) });
    expect(raced.error?.code).toBe('CONFLICT');
    expect(t.bitrix.callsTo('disk.file.markdeleted')).toHaveLength(0);
    const stale = await call('disk_delete_file', {
      fileId: 20,
      expectedStateHash: hash,
      idempotencyKey: randomUUID(),
    });
    expect(stale.error?.code).toBe('CONFLICT');
    const missing = await call('disk_delete_file', { fileId: 999, dryRun: true });
    expect(missing.error?.code).toBe('NOT_FOUND');
  });

  it('ответ без ID → OPERATION_OUTCOME_UNKNOWN без повтора', async () => {
    await close();
    t.app.close();
    await reconnect({ ENABLE_DESTRUCTIVE_TOOLS: 'true' });
    t.bitrix.on('disk.file.markdeleted', legacyOk(true));
    const args = { fileId: 20, idempotencyKey: randomUUID() };
    const prep = await call('disk_delete_file', args);
    await t.app.approvals.approve(opId(prep), 'owner', t.app.auth.portalKey);
    const done = await call('disk_delete_file', { ...args, approvalId: opId(prep) });
    expect(done.error?.code).toBe('OPERATION_OUTCOME_UNKNOWN');
    const again = await call('disk_delete_file', { ...args, approvalId: opId(prep) });
    expect(again.error?.code).toBe('OPERATION_OUTCOME_UNKNOWN');
    expect(t.bitrix.callsTo('disk.file.markdeleted')).toHaveLength(1);
  });
});

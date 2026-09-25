/**
 * Этап 13 (ТЗ §9.14): База знаний 2.0 (REST 3.0 note.*) на mock.
 * T37 — поиск без курсора продолжения; T38 — конфликт с совместным редактором, overwrite не форсируется.
 * Реальный портал не проверялся.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { connectInMemory, createTestApp, structured, type TestApp } from '../helpers/app.js';
import { NoteStore, v3Error } from '../helpers/mock-note.js';
import { contentHash } from '../../src/tools/kb2/service.js';

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
let store: NoteStore;
let client: Client;
let close: () => Promise<void>;
const call = async (name: string, args: Record<string, unknown>) =>
  structured<Env>(await client.callTool({ name, arguments: args }));
/** Ошибка входной схемы отдаётся SDK как isError без structuredContent. */
const rejected = async (name: string, args: Record<string, unknown>) => {
  const r = await client.callTool({ name, arguments: args });
  return { isError: r.isError === true, text: JSON.stringify(r.content) };
};

const DOC_TEXT = '# Регламент\n\nПервый абзац.';

async function reconnect(overrides: Record<string, string> = {}) {
  t = createTestApp({
    ENABLED_MODULES: 'system,knowledgeBase',
    BITRIX_REQUESTS_PER_SECOND: '10',
    ...overrides,
  });
  store = new NoteStore()
    .collection(1, 'Регламенты')
    .collection(2, 'Продукт')
    .collection(3, 'Архив проектов', { policyLevel: 'view' })
    .document(10, 1, 'Введение', DOC_TEXT)
    .document(11, 1, 'Глава 1', 'Текст главы', 10)
    .document(12, 1, 'Параграф 1.1', 'Параграф', 11)
    .document(13, 1, 'Глава 2', '', 10)
    .document(20, 1, 'Приложения', 'Список')
    .document(30, 2, 'Документ другой базы', 'Чужой');
  store.install(t.bitrix);
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

describe('чтение баз и документов (REST 3.0)', () => {
  it('kb2_bases_list: запрос в форме v3 (/rest/api/, pagination.limit), native cursor {position,id} скрыт за серверным курсором', async () => {
    const first = await call('kb2_bases_list', { pageSize: 2 });
    expect(first.success).toBe(true);
    expect((first.data?.['items'] as { collectionId: number }[]).map((i) => i.collectionId)).toEqual([1, 2]);
    expect(first.meta['apiVersion']).toBe('v3');
    const req = t.bitrix.callsTo('note.collection.list')[0];
    expect(req?.url).toContain('/rest/api/7/');
    expect(req?.body).toEqual({ pagination: { limit: 2 } });
    const cursor = first.meta.page?.nextCursor;
    expect(typeof cursor).toBe('string');
    expect(cursor).not.toContain('position');
    const second = await call('kb2_bases_list', { pageSize: 2, cursor });
    expect((second.data?.['items'] as { collectionId: number }[]).map((i) => i.collectionId)).toEqual([3]);
    expect(t.bitrix.callsTo('note.collection.list')[1]?.body).toEqual({
      pagination: { limit: 2, afterCursor: { position: 200, id: 2 } },
    });
    expect(second.meta.page).toEqual({ nextCursor: null, hasMore: false });
    expect(second.meta['completeness']).toBe('complete');
  });

  it('курсор с чужой привязкой отклоняется: другой pageSize/инструмент/документ → VALIDATION_ERROR без вызова портала', async () => {
    const first = await call('kb2_bases_list', { pageSize: 1 });
    const cursor = first.meta.page?.nextCursor ?? '';
    const calls = t.bitrix.calls.length;
    const other = await call('kb2_bases_list', { pageSize: 2, cursor });
    expect(other.error?.code).toBe('VALIDATION_ERROR');
    expect(other.error?.details['field']).toBe('cursor');
    const tree = await call('kb2_documents_list', { collectionId: 1, pageSize: 1, cursor });
    expect(tree.error?.code).toBe('VALIDATION_ERROR');
    expect(t.bitrix.calls.length).toBe(calls);

    const doc = await call('kb2_document_get', { documentId: 10, maxChars: 500 });
    expect(doc.data?.['contentCursor']).toBeNull();
    store.document(40, 1, 'Длинный', 'а'.repeat(1500));
    const long = await call('kb2_document_get', { documentId: 40, maxChars: 500 });
    const cc = long.data?.['contentCursor'] as string;
    const foreign = await call('kb2_document_get', { documentId: 10, contentCursor: cc });
    expect(foreign.error?.code).toBe('VALIDATION_ERROR');
  });

  it('kb2_base_get: result.item; ENTITYNOTFOUND (HTTP 400) → NOT_FOUND', async () => {
    const env = await call('kb2_base_get', { collectionId: 3 });
    expect(env.data).toMatchObject({ collectionId: 3, name: 'Архив проектов', policyLevel: 'view' });
    expect(t.bitrix.callsTo('note.collection.get')[0]?.body).toEqual({ id: 3 });
    const missing = await call('kb2_base_get', { collectionId: 99 });
    expect(missing.error?.code).toBe('NOT_FOUND');
  });

  it('kb2_documents_list: плоское дерево с parentId/depth, поддерево по parentId, страницы по снимку без повторного запроса', async () => {
    const all = await call('kb2_documents_list', { collectionId: 1, pageSize: 3 });
    expect(t.bitrix.callsTo('note.document.tree.list')[0]?.body).toEqual({ collectionId: 1 });
    expect(all.data?.['total']).toBe(5);
    expect(all.data?.['items']).toEqual([
      { documentId: 10, parentId: null, title: 'Введение', position: 10, depth: 0, childCount: 2 },
      { documentId: 11, parentId: 10, title: 'Глава 1', position: 11, depth: 1, childCount: 1 },
      { documentId: 12, parentId: 11, title: 'Параграф 1.1', position: 12, depth: 2, childCount: 0 },
    ]);
    const next = await call('kb2_documents_list', {
      collectionId: 1,
      pageSize: 3,
      cursor: all.meta.page?.nextCursor,
    });
    expect((next.data?.['items'] as { documentId: number }[]).map((i) => i.documentId)).toEqual([13, 20]);
    expect(next.meta.page?.hasMore).toBe(false);
    expect(t.bitrix.callsTo('note.document.tree.list')).toHaveLength(1);

    const sub = await call('kb2_documents_list', { collectionId: 1, parentId: 11 });
    expect((sub.data?.['items'] as { documentId: number }[]).map((i) => i.documentId)).toEqual([12]);
    const nf = await call('kb2_documents_list', { collectionId: 1, parentId: 30 });
    expect(nf.error?.code).toBe('NOT_FOUND');
  });

  it('kb2_documents_list: truncated=true у портала → completeness partial и предупреждение', async () => {
    store.treeTruncated = true;
    const env = await call('kb2_documents_list', { collectionId: 1 });
    expect(env.data?.['truncated']).toBe(true);
    expect(env.meta['completeness']).toBe('partial');
    expect(env.meta.warnings?.join(' ')).toContain('TREE_MAX_NODES');
  });

  it('kb2_document_get: Markdown и contentHash (sha256 полного текста)', async () => {
    const env = await call('kb2_document_get', { documentId: 10 });
    expect(env.data).toMatchObject({
      documentId: 10,
      collectionId: 1,
      parentId: null,
      title: 'Введение',
      markdown: DOC_TEXT,
      contentHash: contentHash(DOC_TEXT),
      stateHash: contentHash(DOC_TEXT),
      content: { offset: 0, truncated: false, totalChars: DOC_TEXT.length },
      contentCursor: null,
    });
    expect(env.meta['completeness']).toBe('complete');
    expect(t.bitrix.callsTo('note.document.get')[0]?.body).toEqual({ id: 10 });
  });

  it('длинный документ: CONTENT_TRUNCATED, продолжение по contentCursor из снимка (без повторного запроса), хеш полного текста', async () => {
    const text = `${'А'.repeat(1200)}Б${'В'.repeat(299)}`;
    store.document(41, 1, 'Большой', text);
    const p1 = await call('kb2_document_get', { documentId: 41, maxChars: 1000 });
    expect(p1.data?.['markdown']).toBe(text.slice(0, 1000));
    expect(p1.data?.['content']).toEqual({
      offset: 0,
      returnedChars: 1000,
      totalChars: 1500,
      truncated: true,
    });
    expect(p1.meta['completeness']).toBe('partial');
    expect(p1.meta.warnings?.[0]).toContain('CONTENT_TRUNCATED');
    expect(p1.data?.['contentHash']).toBe(contentHash(text));
    // Текст меняется на портале — продолжение идёт по снимку, склейка совпадает с исходным текстом
    store.setMarkdown(41, 'изменено');
    const p2 = await call('kb2_document_get', {
      documentId: 41,
      maxChars: 1000,
      contentCursor: p1.data?.['contentCursor'],
    });
    expect(p2.data?.['content']).toEqual({
      offset: 1000,
      returnedChars: 500,
      totalChars: 1500,
      truncated: false,
    });
    expect(`${String(p1.data?.['markdown'])}${String(p2.data?.['markdown'])}`).toBe(text);
    expect(p2.data?.['contentCursor']).toBeNull();
    expect(p2.data?.['contentHash']).toBe(contentHash(text));
    expect(t.bitrix.callsTo('note.document.get')).toHaveLength(1);
    // Курсор одноразовый
    const again = await call('kb2_document_get', {
      documentId: 41,
      contentCursor: p1.data?.['contentCursor'],
    });
    expect(again.error?.code).toBe('VALIDATION_ERROR');
  });

  it('T37: поиск с hasMore=true — только первая страница, nextCursor=null, partial и предложение сузить запрос', async () => {
    for (let i = 0; i < 8; i++) store.document(100 + i, 1, `Отпуск ${String(i)}`, 'правила отпуска');
    const env = await call('kb2_documents_search', { query: 'отпуск', pageSize: 5 });
    expect(env.success).toBe(true);
    expect(t.bitrix.callsTo('note.document.search.list')[0]?.body).toEqual({
      query: 'отпуск',
      pagination: { limit: 5 },
    });
    expect(env.data?.['hasMore']).toBe(true);
    expect(env.data?.['coverage']).toBe('first-page-only');
    expect(env.data?.['suggestion']).toContain('уточните запрос');
    expect((env.data?.['items'] as unknown[]).length).toBe(5);
    expect((env.data?.['items'] as { snippet: string }[])[0]?.snippet).toBe('...отпуск & ещё...');
    expect(env.meta.page).toEqual({ nextCursor: null, hasMore: true });
    expect(env.meta['completeness']).toBe('partial');
    expect(env.meta.warnings?.[0]).toContain('PARTIAL_RESULT');
    // Параметра cursor у инструмента нет вовсе
    expect((await rejected('kb2_documents_search', { query: 'отпуск', cursor: 'x' })).isError).toBe(true);

    const exact = await call('kb2_documents_search', { query: 'Приложения' });
    expect(exact.data?.['hasMore']).toBe(false);
    expect(exact.meta['completeness']).toBe('complete');
    expect((await rejected('kb2_documents_search', { query: 'ab' })).isError).toBe(true);
    expect(t.bitrix.callsTo('note.document.search.list')).toHaveLength(2);
  });
});

describe('запись (REST 3.0)', () => {
  beforeEach(async () => {
    await close();
    t.app.close();
    await reconnect({ READ_ONLY_MODE: 'false' });
  });

  it('kb2_base_create: план → подтверждение → одна запись fields.name → сверка → replay без второго вызова', async () => {
    const args = { title: 'Новая база', idempotencyKey: randomUUID() };
    const prep = await call('kb2_base_create', args);
    expect(prep.error?.code).toBe('APPROVAL_REQUIRED');
    expect(prep.error?.details['plan']).toMatchObject({ details: { fields: { name: 'Новая база' } } });
    expect(t.bitrix.callsTo('note.collection.add')).toHaveLength(0);
    const operationId = prep.error?.details['operationId'] as string;
    await t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
    const done = await call('kb2_base_create', { ...args, approvalId: operationId });
    expect(done.data).toMatchObject({
      collectionId: 1000,
      name: 'Новая база',
      verified: true,
      replayed: false,
    });
    expect(t.bitrix.callsTo('note.collection.add')[0]?.body).toEqual({ fields: { name: 'Новая база' } });
    const again = await call('kb2_base_create', { ...args, approvalId: operationId });
    expect(again.data).toMatchObject({ collectionId: 1000, replayed: true });
    expect(t.bitrix.callsTo('note.collection.add')).toHaveLength(1);
  });

  it('kb2_document_create: полный путь approve/replay; вложенный документ в той же базе', async () => {
    const args = {
      collectionId: 1,
      parentId: 10,
      title: 'Глава 3',
      markdown: '## Глава 3\n\nТекст',
      idempotencyKey: randomUUID(),
    };
    const prep = await call('kb2_document_create', args);
    expect(prep.error?.code).toBe('APPROVAL_REQUIRED');
    expect(prep.error?.details['plan']).toMatchObject({
      target: 'note.collection:1',
      details: { parentId: 10, title: 'Глава 3', content: { markdown: '## Глава 3\n\nТекст' } },
    });
    const operationId = prep.error?.details['operationId'] as string;
    await t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
    const done = await call('kb2_document_create', { ...args, approvalId: operationId });
    expect(done.data).toMatchObject({
      documentId: 1000,
      collectionId: 1,
      parentId: 10,
      verified: true,
      replayed: false,
      contentHash: contentHash('## Глава 3\n\nТекст'),
    });
    expect(t.bitrix.callsTo('note.document.add')[0]?.body).toEqual({
      fields: { collectionId: 1, title: 'Глава 3', parentId: 10, markdown: '## Глава 3\n\nТекст' },
    });
    const again = await call('kb2_document_create', { ...args, approvalId: operationId });
    expect(again.data?.['replayed']).toBe(true);
    expect(t.bitrix.callsTo('note.document.add')).toHaveLength(1);
  });

  it('INVALID_PARENT: родитель из другой базы или несуществующий → отказ до плана; upstream NOTE_INVALID_PARENT тоже INVALID_PARENT', async () => {
    const foreign = await call('kb2_document_create', {
      collectionId: 1,
      parentId: 30,
      title: 'X',
      idempotencyKey: randomUUID(),
    });
    expect(foreign.error?.code).toBe('VALIDATION_ERROR');
    expect(foreign.error?.details['reason']).toBe('INVALID_PARENT');
    const missing = await call('kb2_document_create', {
      collectionId: 1,
      parentId: 999,
      title: 'X',
      idempotencyKey: randomUUID(),
    });
    expect(missing.error?.details['reason']).toBe('INVALID_PARENT');
    expect(await t.app.operations.countByStatus()).toEqual({});
    expect(t.bitrix.callsTo('note.document.add')).toHaveLength(0);

    // Родитель переехал между подтверждением и записью — precheck; портал ответил NOTE_INVALID_PARENT — тоже INVALID_PARENT
    const args = { collectionId: 1, parentId: 20, title: 'Y', idempotencyKey: randomUUID() };
    const prep = await call('kb2_document_create', args);
    const operationId = prep.error?.details['operationId'] as string;
    await t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
    t.bitrix.on('note.document.add', v3Error('NOTE_INVALID_PARENT'));
    const res = await call('kb2_document_create', { ...args, approvalId: operationId });
    expect(res.error?.code).toBe('VALIDATION_ERROR');
    expect(res.error?.details['reason']).toBe('INVALID_PARENT');
    expect(res.error?.details['upstreamCode']).toBe('NOTE_INVALID_PARENT');
  });

  it('длинный текст в плане: начало/конец и sha256, operationId не теряется из-за MAX_RESPONSE_BYTES', async () => {
    const text = 'ж'.repeat(60_000);
    const prep = await call('kb2_document_create', {
      collectionId: 1,
      title: 'Длинный',
      markdown: text,
      idempotencyKey: randomUUID(),
    });
    expect(prep.error?.code).toBe('APPROVAL_REQUIRED');
    expect(typeof prep.error?.details['operationId']).toBe('string');
    const content = (prep.error?.details['plan'] as { details: { content: Record<string, unknown> } }).details
      .content;
    expect(content).toMatchObject({ chars: 60_000, sha256: contentHash(text) });
    expect(content['markdown']).toBeUndefined();
  });

  it('kb2_document_create: ответ без result.item → OPERATION_OUTCOME_UNKNOWN, без повтора', async () => {
    const args = { collectionId: 1, title: 'Z', idempotencyKey: randomUUID() };
    const prep = await call('kb2_document_create', args);
    const operationId = prep.error?.details['operationId'] as string;
    await t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
    t.bitrix.on('note.document.add', { status: 200, body: { result: {} } });
    const res = await call('kb2_document_create', { ...args, approvalId: operationId });
    expect(res.error?.code).toBe('OPERATION_OUTCOME_UNKNOWN');
    expect(t.bitrix.callsTo('note.document.add')).toHaveLength(1);
  });

  it('markdown больше 256 KiB (в байтах UTF-8) → VALIDATION_ERROR до обращения к порталу', async () => {
    const env = await rejected('kb2_document_create', {
      collectionId: 1,
      title: 'Большой',
      markdown: 'я'.repeat(140_000),
      idempotencyKey: randomUUID(),
    });
    expect(env.isError).toBe(true);
    expect(t.bitrix.calls).toHaveLength(0);
  });

  it('kb2_document_update append: чтение, проверка хеша, добавление, update (overwrite=false), сверка, replay', async () => {
    const base = contentHash(DOC_TEXT);
    const noHash = await rejected('kb2_document_update', {
      documentId: 10,
      mode: 'append',
      markdown: 'Новый абзац.',
      idempotencyKey: randomUUID(),
    });
    expect(noHash.isError).toBe(true);
    expect(noHash.text).toContain('expectedStateHash');

    const args = {
      documentId: 10,
      mode: 'append',
      markdown: 'Новый абзац.',
      expectedStateHash: base,
      idempotencyKey: randomUUID(),
    };
    const prep = await call('kb2_document_update', args);
    expect(prep.error?.code).toBe('APPROVAL_REQUIRED');
    const plan = prep.error?.details['plan'] as { details: Record<string, unknown>; risks: string[] };
    expect(plan.details).toMatchObject({ mode: 'append', baseContentHash: base, overwrite: false });
    expect(plan.risks.join(' ')).toContain('CAS');
    const operationId = prep.error?.details['operationId'] as string;
    await t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
    const done = await call('kb2_document_update', { ...args, approvalId: operationId });
    const expected = `${DOC_TEXT}\n\nНовый абзац.`;
    expect(done.data).toMatchObject({
      documentId: 10,
      verified: true,
      replayed: false,
      contentHash: contentHash(expected),
    });
    expect(t.bitrix.callsTo('note.document.update')[0]?.body).toEqual({
      id: 10,
      fields: { markdown: expected },
      overwrite: false,
    });
    const again = await call('kb2_document_update', { ...args, approvalId: operationId });
    expect(again.data).toMatchObject({ replayed: true, contentHash: contentHash(expected) });
    expect(t.bitrix.callsTo('note.document.update')).toHaveLength(1);
  });

  it('изменившийся хеш: до плана и в precheck → CONFLICT (COLLABORATIVE_EDIT_CONFLICT), записи нет', async () => {
    const stale = await call('kb2_document_update', {
      documentId: 10,
      mode: 'replace',
      markdown: 'Новое',
      expectedStateHash: contentHash('старый текст'),
      idempotencyKey: randomUUID(),
    });
    expect(stale.error?.code).toBe('CONFLICT');
    expect(stale.error?.details['reason']).toBe('COLLABORATIVE_EDIT_CONFLICT');
    expect(await t.app.operations.countByStatus()).toEqual({});

    const args = {
      documentId: 10,
      mode: 'append',
      markdown: 'Ещё',
      expectedStateHash: contentHash(DOC_TEXT),
      idempotencyKey: randomUUID(),
    };
    const prep = await call('kb2_document_update', args);
    const operationId = prep.error?.details['operationId'] as string;
    await t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
    store.setMarkdown(10, `${DOC_TEXT}\n\nПравка коллеги`);
    const raced = await call('kb2_document_update', { ...args, approvalId: operationId });
    expect(raced.error?.code).toBe('CONFLICT');
    expect(raced.error?.details['reason']).toBe('COLLABORATIVE_EDIT_CONFLICT');
    expect(t.bitrix.callsTo('note.document.update')).toHaveLength(0);
  });

  it('T38: несохранённые правки редактора → CONFLICT, overwrite не форсируется; overwrite=true — только отдельный план с риском', async () => {
    store.unsaved.add(10);
    const base = contentHash(DOC_TEXT);
    const key = randomUUID();
    const args = {
      documentId: 10,
      mode: 'replace',
      markdown: 'Новый текст',
      expectedStateHash: base,
      idempotencyKey: key,
    };
    const prep = await call('kb2_document_update', args);
    const operationId = prep.error?.details['operationId'] as string;
    await t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
    const res = await call('kb2_document_update', { ...args, approvalId: operationId });
    expect(res.error?.code).toBe('CONFLICT');
    expect(res.error?.details['reason']).toBe('COLLABORATIVE_EDIT_CONFLICT');
    expect(res.error?.details['upstreamCode']).toBe('NOTE_DOCUMENT_HAS_UNSAVED_CHANGES');
    // Ровно одна попытка и именно с overwrite=false; автоматического повтора с overwrite=true нет
    const updates = t.bitrix.callsTo('note.document.update');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.body['overwrite']).toBe(false);
    expect(store.documents.get(10)?.markdown).toBe(DOC_TEXT);
    expect((await call('operation_status', { operationId })).data?.['status']).toBe('failed');

    // Подтверждение overwrite=false нельзя «перенести» на overwrite=true
    const reuse = await call('kb2_document_update', { ...args, overwrite: true, approvalId: operationId });
    expect(['APPROVAL_MISMATCH', 'IDEMPOTENCY_CONFLICT']).toContain(reuse.error?.code);
    // overwrite=true без expectedStateHash запрещён
    const noHash = await rejected('kb2_document_update', {
      documentId: 10,
      mode: 'replace',
      markdown: 'Новый текст',
      overwrite: true,
      idempotencyKey: randomUUID(),
    });
    expect(noHash.isError).toBe(true);

    const forced = { ...args, overwrite: true, idempotencyKey: randomUUID() };
    const prep2 = await call('kb2_document_update', forced);
    expect(prep2.error?.code).toBe('APPROVAL_REQUIRED');
    const plan2 = prep2.error?.details['plan'] as {
      action: string;
      risks: string[];
      details: Record<string, unknown>;
    };
    expect(plan2.details['overwrite']).toBe(true);
    expect(plan2.action).toContain('overwrite=true');
    expect(plan2.risks[0]).toContain('ЗАТРЁТ НЕСОХРАНЁННЫЕ ПРАВКИ');
    expect(prep2.error?.details['operationId']).not.toBe(operationId);
    const op2 = prep2.error?.details['operationId'] as string;
    await t.app.approvals.approve(op2, 'owner', t.app.auth.portalKey);
    const done = await call('kb2_document_update', { ...forced, approvalId: op2 });
    expect(done.data).toMatchObject({ verified: true, contentHash: contentHash('Новый текст') });
    expect(t.bitrix.callsTo('note.document.update')[1]?.body['overwrite']).toBe(true);
  });

  it('replace с новым названием: diff названия в плане, сверка title; без expectedStateHash — риск в плане', async () => {
    const args = {
      documentId: 20,
      mode: 'replace',
      markdown: 'Новый список',
      title: 'Приложения (2026)',
      idempotencyKey: randomUUID(),
    };
    const prep = await call('kb2_document_update', args);
    const plan = prep.error?.details['plan'] as { details: Record<string, unknown>; risks: string[] };
    expect(plan.details['title']).toEqual({ from: 'Приложения', to: 'Приложения (2026)' });
    expect(plan.risks.join(' ')).toContain('expectedStateHash не передан');
    const operationId = prep.error?.details['operationId'] as string;
    await t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
    const done = await call('kb2_document_update', { ...args, approvalId: operationId });
    expect(done.data).toMatchObject({ verified: true });
    expect(t.bitrix.callsTo('note.document.update')[0]?.body).toEqual({
      id: 20,
      fields: { markdown: 'Новый список', title: 'Приложения (2026)' },
      overwrite: false,
    });
  });

  it('dryRun: план без подтверждения и без записи', async () => {
    const env = await call('kb2_document_update', {
      documentId: 10,
      mode: 'append',
      markdown: 'x',
      dryRun: true,
    });
    expect(env.data).toMatchObject({ dryRun: true, stateHash: contentHash(DOC_TEXT) });
    expect(await t.app.operations.countByStatus()).toEqual({});
    expect(t.bitrix.callsTo('note.document.update')).toHaveLength(0);
  });

  it('модуль knowledgeBase выключен → инструментов kb2_* нет в tools/list', async () => {
    const on = (await client.listTools()).tools.map((x) => x.name).filter((n) => n.startsWith('kb2_'));
    expect(on.sort()).toEqual([
      'kb2_base_create',
      'kb2_base_get',
      'kb2_bases_list',
      'kb2_document_create',
      'kb2_document_get',
      'kb2_document_update',
      'kb2_documents_list',
      'kb2_documents_search',
    ]);
    await close();
    t.app.close();
    await reconnect({ ENABLED_MODULES: 'system' });
    expect((await client.listTools()).tools.some((x) => x.name.startsWith('kb2_'))).toBe(false);
  });
});

/**
 * Этап 13 (ТЗ §9.13, T36): классическая база знаний на landing, mock.
 * Внутренний scope KNOWLEDGE/GROUP в запросах; статья создаётся черновиком и не публикуется сама;
 * порядок блоков (цепочка AFTER_ID); PARTIAL_SUCCESS без повторного landing.landing.add; replace только
 * конкретных блоков с CONFLICT по хешу; публикация — отдельное подтверждённое действие с проверкой базы.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { connectInMemory, createTestApp, structured, type TestApp } from '../helpers/app.js';
import { legacyError, legacyOk, type RecordedCall } from '../helpers/mock-bitrix.js';

interface Env {
  success: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; details: Record<string, unknown> };
  meta: Record<string, unknown> & { warnings?: string[]; completeness?: string };
}

let t: TestApp;
let client: Client;
let close: () => Promise<void>;
const call = async (name: string, args: Record<string, unknown>) =>
  structured<Env>(await client.callTool({ name, arguments: args }));

type Row = Record<string, unknown>;
interface Block {
  id: number;
  lid: number;
  code: string;
  content: string;
}

let sites: Row[];
let folders: Row[];
let pages: Row[];
let blocks: Block[];
let nextBlockId: number;
/** Номер вызова addblock (1-based), на котором mock вернёт ошибку. */
let failAddBlockAt: number | undefined;
let addBlockCalls: number;

/** Скалярное значение тела запроса mock → строка. */
const str = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));

const TEXT_BLOCK = '27.one_col_fix_title_and_text_2';

const siteType = (siteId: unknown) => sites.find((s) => s['ID'] === String(siteId))?.['TYPE'];
const scopeOf = (c: RecordedCall) => (c.body['scope'] as string | undefined) ?? 'PAGE';
const params = (c: RecordedCall) => (c.body['params'] ?? {}) as Row;

function setup(overrides: Record<string, string> = {}) {
  sites = [
    { ID: '10', TITLE: 'База знаний отдела', CODE: '/kb/', TYPE: 'KNOWLEDGE', ACTIVE: 'N', DESCRIPTION: '' },
    { ID: '12', TITLE: 'Регламенты', CODE: '/reg/', TYPE: 'KNOWLEDGE', ACTIVE: 'Y', DESCRIPTION: '' },
    { ID: '20', TITLE: 'Лендинг', CODE: '/promo/', TYPE: 'PAGE', ACTIVE: 'Y', DESCRIPTION: '' },
  ];
  folders = [{ ID: '5', PARENT_ID: null, SITE_ID: '10', TITLE: 'Инструкции', ACTIVE: 'N', DELETED: 'N' }];
  pages = [
    { ID: '40', TITLE: 'Отпуск', CODE: 'otpusk', SITE_ID: '10', FOLDER_ID: '5', FOLDER: 'N', ACTIVE: 'N' },
    {
      ID: '41',
      TITLE: 'Командировки',
      CODE: 'trip',
      SITE_ID: '10',
      FOLDER_ID: null,
      FOLDER: 'N',
      ACTIVE: 'Y',
    },
    { ID: '42', TITLE: 'Промо', CODE: 'promo', SITE_ID: '20', FOLDER_ID: null, FOLDER: 'N', ACTIVE: 'Y' },
  ];
  blocks = [
    {
      id: 301,
      lid: 40,
      code: TEXT_BLOCK,
      content: '<div class="block-wrapper"><h2>Как оформить</h2><p>Шаг 1</p></div>',
    },
    {
      id: 302,
      lid: 40,
      code: TEXT_BLOCK,
      content: '<div><p>Шаг 2 <script>alert(1)</script>подробно</p></div>',
    },
    { id: 303, lid: 40, code: TEXT_BLOCK, content: `<div><p>${'х'.repeat(500)}</p></div>` },
  ];
  nextBlockId = 500;
  failAddBlockAt = undefined;
  addBlockCalls = 0;
  t = createTestApp({
    ENABLED_MODULES: 'system,knowledgeBase',
    BITRIX_REQUESTS_PER_SECOND: '10',
    ...overrides,
  });
  t.bitrix
    .on('landing.site.getlist', (c) => {
      const p = params(c);
      const f = (p['filter'] ?? {}) as Row;
      // Без scope видны только PAGE/STORE/SMN; со scope — только его тип (landing/types).
      let rows = sites.filter((s) => s['TYPE'] === scopeOf(c));
      if (f['ID'] !== undefined) rows = rows.filter((s) => s['ID'] === str(f['ID']));
      const offset = Number(p['offset'] ?? 0);
      const limit = p['limit'] === undefined ? rows.length : Number(p['limit']);
      return legacyOk(rows.slice(offset, offset + limit));
    })
    .on('landing.site.add', (c) => {
      const f = c.body['fields'] as Row;
      sites.push({
        ID: '11',
        TITLE: f['TITLE'],
        CODE: '/new/',
        TYPE: f['TYPE'],
        ACTIVE: 'N',
        DESCRIPTION: '',
      });
      return legacyOk(11);
    })
    .on('landing.site.getfolders', (c) => {
      const f = (c.body['filter'] ?? {}) as Row;
      return legacyOk(
        folders.filter(
          (x) =>
            x['SITE_ID'] === str(c.body['siteId']) && (f['ID'] === undefined || x['ID'] === str(f['ID'])),
        ),
      );
    })
    .on('landing.site.addfolder', (c) => {
      const f = c.body['fields'] as Row;
      folders.push({
        ID: '6',
        PARENT_ID: f['PARENT_ID'] === undefined ? null : str(f['PARENT_ID']),
        SITE_ID: str(c.body['siteId']),
        TITLE: f['TITLE'],
        ACTIVE: 'N',
      });
      return legacyOk(6);
    })
    .on('landing.landing.getlist', (c) => {
      const p = params(c);
      const f = (p['filter'] ?? {}) as Row;
      let rows = pages.filter((x) => siteType(x['SITE_ID']) === scopeOf(c));
      for (const k of ['ID', 'SITE_ID', 'FOLDER_ID'])
        if (f[k] !== undefined) rows = rows.filter((x) => x[k] === str(f[k]));
      const offset = Number(p['offset'] ?? 0);
      const limit = p['limit'] === undefined ? rows.length : Number(p['limit']);
      return legacyOk(rows.slice(offset, offset + limit));
    })
    .on('landing.landing.add', (c) => {
      const f = c.body['fields'] as Row;
      pages.push({
        ID: '100',
        TITLE: f['TITLE'],
        CODE: 'new',
        SITE_ID: str(f['SITE_ID']),
        FOLDER_ID: f['FOLDER_ID'] === undefined ? null : str(f['FOLDER_ID']),
        FOLDER: 'N',
        ACTIVE: 'N',
      });
      return legacyOk(100);
    })
    .on('landing.landing.update', (c) => {
      const p = pages.find((x) => x['ID'] === str(c.body['lid']));
      if (p) p['TITLE'] = (c.body['fields'] as Row)['TITLE'];
      return legacyOk(true);
    })
    .on('landing.landing.publication', (c) => {
      const p = pages.find((x) => x['ID'] === str(c.body['lid']));
      if (!p) return legacyError('LANDING_NOT_EXIST', 400, 'Landing not found');
      p['ACTIVE'] = 'Y';
      const s = sites.find((x) => x['ID'] === p['SITE_ID']);
      if (s) s['ACTIVE'] = 'Y';
      return legacyOk(true);
    })
    .on('landing.landing.addblock', (c) => {
      addBlockCalls += 1;
      if (failAddBlockAt === addBlockCalls)
        return legacyError('BLOCK_CANT_BE_ADDED', 400, 'Cannot add block');
      const lid = Number(c.body['lid']);
      const f = c.body['fields'] as Row;
      const block: Block = { id: nextBlockId++, lid, code: str(f['CODE']), content: str(f['CONTENT']) };
      const idx = f['AFTER_ID'] === undefined ? -1 : blocks.findIndex((b) => b.id === Number(f['AFTER_ID']));
      if (idx < 0) {
        const first = blocks.findIndex((b) => b.lid === lid);
        blocks.splice(first < 0 ? blocks.length : first, 0, block); // без AFTER_ID — в начало страницы
      } else blocks.splice(idx + 1, 0, block);
      return legacyOk(block.id);
    })
    .on('landing.block.getlist', (c) =>
      legacyOk(
        blocks
          .filter((b) => b.lid === Number(c.body['lid']))
          .map((b) => ({
            id: b.id,
            lid: b.lid,
            code: b.code,
            name: 'Текст',
            active: true,
            meta: {},
            content: b.content,
          })),
      ),
    )
    .on('landing.block.updatecontent', (c) => {
      const b = blocks.find((x) => x.id === Number(c.body['block']) && x.lid === Number(c.body['lid']));
      if (!b) return legacyError('BLOCK_NOT_FOUND', 400, 'Block not found');
      b.content = str(c.body['content']);
      return legacyOk(true);
    })
    .on('landing.block.getrepository', (c) => {
      const text = { name: 'Текст', items: { [TEXT_BLOCK]: { name: 'Заголовок и текст' } } };
      return legacyOk(
        c.body['section'] === 'text' ? text : { favourite: { name: 'Избранное', items: {} }, text },
      );
    });
}

async function reconnect(overrides: Record<string, string> = {}) {
  setup(overrides);
  const c = await connectInMemory(t.app);
  client = c.client;
  close = () => c.close();
}

beforeEach(async () => {
  await reconnect({ READ_ONLY_MODE: 'false' });
});
afterEach(async () => {
  await close();
  t.app.close();
});

async function prepare(tool: string, args: Record<string, unknown>) {
  const prep = await call(tool, args);
  expect(prep.error?.code, JSON.stringify(prep.error)).toBe('APPROVAL_REQUIRED');
  const operationId = prep.error?.details['operationId'] as string;
  const plan = prep.error?.details['plan'] as {
    details: Record<string, unknown>;
    risks: string[];
    action: string;
  };
  return { operationId, plan };
}
async function approveAndRun(tool: string, args: Record<string, unknown>) {
  const { operationId, plan } = await prepare(tool, args);
  await t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
  const done = await call(tool, { ...args, approvalId: operationId });
  return { operationId, plan, done };
}

describe('чтение', () => {
  it('kb_legacy_bases_list: верхнеуровневый scope=KNOWLEDGE и filter.TYPE, пагинация limit/offset с курсором', async () => {
    const p1 = await call('kb_legacy_bases_list', { pageSize: 1 });
    expect(p1.success).toBe(true);
    expect(p1.data?.['items']).toEqual([
      expect.objectContaining({
        siteId: 10,
        title: 'База знаний отдела',
        type: 'KNOWLEDGE',
        published: false,
      }),
    ]);
    expect(t.bitrix.callsTo('landing.site.getlist')[0]?.body).toMatchObject({
      scope: 'KNOWLEDGE',
      params: {
        filter: { TYPE: 'KNOWLEDGE' },
        order: { ID: 'ASC' },
        limit: 2,
        offset: 0,
      },
    });
    const page = p1.meta['page'] as { nextCursor: string; hasMore: boolean };
    expect(page.hasMore).toBe(true);
    const p2 = await call('kb_legacy_bases_list', { pageSize: 1, cursor: page.nextCursor });
    expect((p2.data?.['items'] as Row[])[0]?.['siteId']).toBe(12);
    expect((p2.meta['page'] as { hasMore: boolean }).hasMore).toBe(false);
    // обычный сайт (PAGE) в список баз знаний не попадает
    const all = await call('kb_legacy_bases_list', {});
    expect((all.data?.['items'] as Row[]).map((x) => x['siteId'])).toEqual([10, 12]);
  });

  it('kb_legacy_articles_list: фильтр SITE_ID и FOLDER_ID, черновик/опубликовано', async () => {
    const env = await call('kb_legacy_articles_list', { siteId: 10, folderId: 5 });
    expect(env.data?.['items']).toEqual([
      expect.objectContaining({
        articleId: 40,
        title: 'Отпуск',
        folderId: 5,
        published: false,
        isFolder: false,
      }),
    ]);
    expect(t.bitrix.callsTo('landing.landing.getlist')[0]?.body).toMatchObject({
      scope: 'KNOWLEDGE',
      params: { filter: { SITE_ID: 10, FOLDER_ID: 5 } },
    });
  });

  it('kb_legacy_article_get: блоки по порядку, структура текста, очистка HTML, CONTENT_TRUNCATED и stateHash черновика', async () => {
    const env = await call('kb_legacy_article_get', { articleId: 40 });
    expect(env.success).toBe(true);
    const out = env.data?.['blocks'] as Row[];
    expect(out.map((b) => [b['position'], b['blockId']])).toEqual([
      [1, 301],
      [2, 302],
      [3, 303],
    ]);
    expect(out[0]?.['content']).toBe('## Как оформить\n\nШаг 1');
    expect(out[1]?.['content']).toBe('Шаг 2 подробно');
    expect(env.data?.['stateHash']).toMatch(/^[a-f0-9]{64}$/);
    expect(t.bitrix.callsTo('landing.block.getlist')[0]?.body).toEqual({
      scope: 'KNOWLEDGE',
      lid: 40,
      params: { edit_mode: true, get_content: true },
    });

    const html = await call('kb_legacy_article_get', { articleId: 40, format: 'sanitizedHtml' });
    expect(JSON.stringify(html.data?.['blocks'])).not.toContain('script');

    const cut = await call('kb_legacy_article_get', { articleId: 40, maxChars: 200 });
    expect(cut.meta.completeness).toBe('partial');
    expect(cut.data?.['contentTruncated']).toBe(true);
    expect(cut.meta.warnings?.[0]).toContain('CONTENT_TRUNCATED');
    const cb = cut.data?.['blocks'] as Row[];
    expect(cb[2]?.['truncated']).toBe(true);
    expect(cb).toHaveLength(3); // структура (ID и порядок) сохраняется и при усечении
  });

  it('статья чужого scope (обычный сайт) не видна: NOT_FOUND', async () => {
    const env = await call('kb_legacy_article_get', { articleId: 42 });
    expect(env.error?.code).toBe('NOT_FOUND');
  });
});

describe('kb_legacy_article_create (T36)', () => {
  const base = { siteId: 10, title: 'Больничный', format: 'text' as const };

  it('без blockCode — список текстовых блоков портала (код не выдумывается); publish=true отклоняется', async () => {
    const env = await call('kb_legacy_article_create', {
      ...base,
      content: 'Текст',
      idempotencyKey: randomUUID(),
    });
    expect(env.error?.code).toBe('VALIDATION_ERROR');
    expect(env.error?.details['reason']).toBe('BLOCK_CODE_REQUIRED');
    expect(env.error?.details['nextAction']).toContain(TEXT_BLOCK);
    expect(t.bitrix.callsTo('landing.block.getrepository')[0]?.body).toEqual({
      scope: 'KNOWLEDGE',
      section: 'text',
    });
    const pub = await call('kb_legacy_article_create', {
      ...base,
      content: 'Текст',
      blockCode: TEXT_BLOCK,
      publish: true,
      idempotencyKey: randomUUID(),
    });
    expect(pub.error?.details['reason']).toBe('PUBLISH_IS_SEPARATE_ACTION');
    expect(await t.app.operations.countByStatus()).toEqual({});
  });

  it('черновик, публикация не вызывается, порядок блоков через цепочку AFTER_ID, сверка, replay', async () => {
    const args = {
      ...base,
      folderId: 5,
      blockCode: TEXT_BLOCK,
      content: ['Первый абзац\n\nВторой абзац', 'Раздел <два>', 'Третий'],
      idempotencyKey: randomUUID(),
    };
    const { plan, done, operationId } = await approveAndRun('kb_legacy_article_create', args);
    expect(plan.details['publish']).toBe(false);
    expect(plan.risks[0]).toContain('черновиком');
    expect((plan.details['blocks'] as Row[]).map((b) => b['html'])).toEqual([
      '<p>Первый абзац</p>\n<p>Второй абзац</p>',
      '<p>Раздел &lt;два&gt;</p>',
      '<p>Третий</p>',
    ]);
    expect(done.success, JSON.stringify(done.error)).toBe(true);
    expect(done.data).toMatchObject({
      articleId: 100,
      blockIds: [500, 501, 502],
      draft: true,
      verified: true,
    });
    expect(t.bitrix.callsTo('landing.landing.add')[0]?.body).toEqual({
      scope: 'KNOWLEDGE',
      fields: { TITLE: 'Больничный', SITE_ID: 10, FOLDER_ID: 5 },
    });
    const adds = t.bitrix.callsTo('landing.landing.addblock').map((c) => c.body['fields'] as Row);
    expect(adds.map((f) => f['AFTER_ID'])).toEqual([undefined, 500, 501]);
    expect(adds.every((f) => f['CODE'] === TEXT_BLOCK)).toBe(true);
    expect(t.bitrix.callsTo('landing.landing.publication')).toHaveLength(0);
    expect(pages.find((p) => p['ID'] === '100')?.['ACTIVE']).toBe('N');

    const again = await call('kb_legacy_article_create', { ...args, approvalId: operationId });
    expect(again.data?.['replayed']).toBe(true);
    expect(t.bitrix.callsTo('landing.landing.add')).toHaveLength(1);
  });

  it('PARTIAL_SUCCESS: страница создана, второй блок не добавлен — ID и статусы шагов, повтор без второго landing.landing.add', async () => {
    failAddBlockAt = 2;
    const args = {
      ...base,
      blockCode: TEXT_BLOCK,
      content: ['Один', 'Два', 'Три'],
      idempotencyKey: randomUUID(),
    };
    const { done, operationId } = await approveAndRun('kb_legacy_article_create', args);
    expect(done.error?.code).toBe('PARTIAL_SUCCESS');
    expect(done.error?.message).toContain('#100');
    expect(done.error?.message).toContain('block 1: done (блок #500)');
    expect(done.error?.message).toContain('block 2: failed');
    expect(done.error?.message).toContain('block 3: skipped');
    expect(done.error?.details['nextAction']).toContain('НЕ повторяйте kb_legacy_article_create');
    expect((await t.app.operations.get(operationId))?.status).toBe('succeeded');

    failAddBlockAt = undefined;
    const withApproval = await call('kb_legacy_article_create', { ...args, approvalId: operationId });
    expect(withApproval.error?.code).toBe('PARTIAL_SUCCESS');
    const sameKey = await call('kb_legacy_article_create', args);
    expect(sameKey.error?.code).toBe('PARTIAL_SUCCESS');
    expect(t.bitrix.callsTo('landing.landing.add')).toHaveLength(1);
    expect(t.bitrix.callsTo('landing.landing.addblock')).toHaveLength(2);
  });

  it('неизвестная база или раздел → NOT_FOUND до плана', async () => {
    const noSite = await call('kb_legacy_article_create', {
      ...base,
      siteId: 20,
      blockCode: TEXT_BLOCK,
      content: 'x',
      idempotencyKey: randomUUID(),
    });
    expect(noSite.error?.code).toBe('NOT_FOUND');
    const noFolder = await call('kb_legacy_article_create', {
      ...base,
      folderId: 77,
      blockCode: TEXT_BLOCK,
      content: 'x',
      idempotencyKey: randomUUID(),
    });
    expect(noFolder.error?.code).toBe('NOT_FOUND');
    expect(await t.app.operations.countByStatus()).toEqual({});
  });
});

describe('kb_legacy_article_update', () => {
  async function readHash(): Promise<string> {
    const env = await call('kb_legacy_article_get', { articleId: 40 });
    return env.data?.['stateHash'] as string;
  }

  it('replace: нужны blockIds и expectedStateHash; чужой блок и устаревший хеш отклоняются до плана', async () => {
    const common = { articleId: 40, mode: 'replace', content: 'Новый шаг', idempotencyKey: randomUUID() };
    const noIds = await call('kb_legacy_article_update', common);
    expect(noIds.error?.details['reason']).toBe('BLOCK_IDS_REQUIRED');
    const noHash = await call('kb_legacy_article_update', { ...common, blockIds: [302] });
    expect(noHash.error?.details['reason']).toBe('STATE_HASH_REQUIRED');
    const conflict = await call('kb_legacy_article_update', {
      ...common,
      blockIds: [302],
      expectedStateHash: 'b'.repeat(64),
    });
    expect(conflict.error?.code).toBe('CONFLICT');
    const hash = await readHash();
    const foreign = await call('kb_legacy_article_update', {
      ...common,
      blockIds: [999],
      expectedStateHash: hash,
    });
    expect(foreign.error?.details['reason']).toBe('BLOCK_NOT_ON_PAGE');
    expect(await t.app.operations.countByStatus()).toEqual({});
  });

  it('replace: «было → станет» в плане, замена только указанного блока, переименование, replay', async () => {
    const hash = await readHash();
    const args = {
      articleId: 40,
      mode: 'replace',
      blockIds: [302],
      content: '<p onclick="x()">Шаг 2 <b>обновлён</b></p>',
      format: 'html',
      title: 'Отпуск (2026)',
      expectedStateHash: hash,
      idempotencyKey: randomUUID(),
    };
    const { plan, done, operationId } = await approveAndRun('kb_legacy_article_update', args);
    expect(plan.details['replace']).toEqual([
      { blockId: 302, code: TEXT_BLOCK, before: 'Шаг 2 подробно', after: '<p>Шаг 2 <b>обновлён</b></p>' },
    ]);
    expect(plan.details['title']).toEqual({ from: 'Отпуск', to: 'Отпуск (2026)' });
    expect(done.success, JSON.stringify(done.error)).toBe(true);
    expect(done.data).toMatchObject({ articleId: 40, changedBlockIds: [302], draft: true, verified: true });
    expect(t.bitrix.callsTo('landing.block.updatecontent')).toHaveLength(1);
    expect(t.bitrix.callsTo('landing.block.updatecontent')[0]?.body).toEqual({
      scope: 'KNOWLEDGE',
      lid: 40,
      block: 302,
      content: '<p>Шаг 2 <b>обновлён</b></p>',
    });
    expect(blocks.find((b) => b.id === 301)?.content).toContain('Шаг 1');
    expect(t.bitrix.callsTo('landing.landing.publication')).toHaveLength(0);
    const again = await call('kb_legacy_article_update', { ...args, approvalId: operationId });
    expect(again.data?.['replayed']).toBe(true);
    expect(t.bitrix.callsTo('landing.block.updatecontent')).toHaveLength(1);
  });

  it('CONFLICT в precheck: блок изменён после подтверждения — запись не выполняется', async () => {
    const hash = await readHash();
    const args = {
      articleId: 40,
      mode: 'replace',
      blockIds: [301],
      content: 'Иначе',
      expectedStateHash: hash,
      idempotencyKey: randomUUID(),
    };
    const { operationId } = await prepare('kb_legacy_article_update', args);
    await t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
    const b = blocks.find((x) => x.id === 301);
    if (b) b.content = '<p>правка из редактора</p>';
    const done = await call('kb_legacy_article_update', { ...args, approvalId: operationId });
    expect(done.error?.code).toBe('CONFLICT');
    expect(t.bitrix.callsTo('landing.block.updatecontent')).toHaveLength(0);
  });

  it('append: новые блоки после последнего блока черновика, по порядку', async () => {
    const args = {
      articleId: 40,
      mode: 'append',
      blockCode: TEXT_BLOCK,
      content: ['Шаг 4', 'Шаг 5'],
      idempotencyKey: randomUUID(),
    };
    const { plan, done } = await approveAndRun('kb_legacy_article_update', args);
    expect(plan.details['append']).toMatchObject({ afterBlockId: 303 });
    expect(done.data).toMatchObject({ addedBlockIds: [500, 501], verified: true });
    const adds = t.bitrix
      .callsTo('landing.landing.addblock')
      .map((c) => (c.body['fields'] as Row)['AFTER_ID']);
    expect(adds).toEqual([303, 500]);
    expect(blocks.filter((x) => x.lid === 40).map((x) => x.id)).toEqual([301, 302, 303, 500, 501]);
  });
});

describe('kb_legacy_article_publish', () => {
  it('план показывает, что неопубликованная база станет активной и раздел опубликуется; approve → publication', async () => {
    const hash = (await call('kb_legacy_article_get', { articleId: 40 })).data?.['stateHash'];
    const args = { articleId: 40, expectedStateHash: hash, idempotencyKey: randomUUID() };
    const { plan, done } = await approveAndRun('kb_legacy_article_publish', args);
    expect(plan.risks[0]).toContain('СЕЙЧАС НЕ ОПУБЛИКОВАНА');
    expect(plan.risks.join(' ')).toContain('раздел #5');
    expect(plan.details['site']).toEqual({ siteId: 10, type: 'KNOWLEDGE', published: false });
    expect(done.data).toMatchObject({ articleId: 40, published: true, verified: true });
    expect(t.bitrix.callsTo('landing.landing.publication')[0]?.body).toEqual({ scope: 'KNOWLEDGE', lid: 40 });
  });

  it('статья не базы знаний → NOT_KNOWLEDGE_BASE без плана', async () => {
    // Страница видна в scope KNOWLEDGE, но её сайт не находится как база знаний (например, удалён/иного типа).
    pages.push({ ID: '43', TITLE: 'Сирота', SITE_ID: '10', FOLDER: 'N', ACTIVE: 'N' });
    t.bitrix.on('landing.site.getlist', () => legacyOk([]));
    const env = await call('kb_legacy_article_publish', { articleId: 43, idempotencyKey: randomUUID() });
    expect(env.error?.details['reason']).toBe('NOT_KNOWLEDGE_BASE');
    expect(t.bitrix.callsTo('landing.landing.publication')).toHaveLength(0);
    expect(await t.app.operations.countByStatus()).toEqual({});
  });
});

describe('базы и разделы', () => {
  it('kb_legacy_base_create: TYPE совпадает со scope, база неопубликована; approve → сверка', async () => {
    const args = { title: 'Новая база', scope: 'KNOWLEDGE', idempotencyKey: randomUUID() };
    const { plan, done } = await approveAndRun('kb_legacy_base_create', args);
    expect(plan.risks[0]).toContain('ACTIVE=N');
    expect(done.data).toMatchObject({ siteId: 11, verified: true });
    expect(t.bitrix.callsTo('landing.site.add')[0]?.body).toEqual({
      scope: 'KNOWLEDGE',
      fields: { TITLE: 'Новая база', CODE: '', TYPE: 'KNOWLEDGE' },
    });
  });

  it('kb_legacy_section_create: landing.site.addFolder с PARENT_ID; неизвестный родитель → NOT_FOUND', async () => {
    const missing = await call('kb_legacy_section_create', {
      siteId: 10,
      title: 'Раздел',
      parentId: 99,
      idempotencyKey: randomUUID(),
    });
    expect(missing.error?.code).toBe('NOT_FOUND');
    const args = { siteId: 10, title: 'Отпуска', parentId: 5, idempotencyKey: randomUUID() };
    const { done } = await approveAndRun('kb_legacy_section_create', args);
    expect(done.data).toMatchObject({ siteId: 10, sectionId: 6, sectionType: 'folder', verified: true });
    expect(t.bitrix.callsTo('landing.site.addfolder')[0]?.body).toEqual({
      scope: 'KNOWLEDGE',
      siteId: 10,
      fields: { TITLE: 'Отпуска', PARENT_ID: 5 },
    });
  });

  it('метод раздела отсутствует на портале → FEATURE_UNAVAILABLE', async () => {
    t.bitrix.on('landing.site.addfolder', {
      status: 404,
      body: { error: 'ERROR_METHOD_NOT_FOUND', error_description: 'Method not found!' },
    });
    const { done } = await approveAndRun('kb_legacy_section_create', {
      siteId: 10,
      title: 'X',
      idempotencyKey: randomUUID(),
    });
    expect(done.error?.code).toBe('FEATURE_UNAVAILABLE');
  });
});

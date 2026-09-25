/**
 * Этап 13 (ТЗ §9.10, T35): Лента на mock — публикация с обязательной аудиторией (AUDIENCE_REQUIRED),
 * очистка script/iframe/on*, изменение с CONFLICT и отдельным пунктом аудитории, список новостей,
 * комментарии пользователя (coverage=userComments, FULL_THREAD_UNAVAILABLE), полный путь approve/replay.
 * Формы ответов — по документации log.blogpost.* / log.blogcomment.*.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { htmlToText, sanitizeFeedText, sanitizeHtml, textToHtml } from '../../src/tools/feed/sanitize.js';
import { connectInMemory, createTestApp, structured, type TestApp } from '../helpers/app.js';
import { legacyListPage, legacyOk } from '../helpers/mock-bitrix.js';

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

/** Скалярное значение тела запроса mock → строка. */
const str = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));

const post = (id: number, extra: Record<string, unknown> = {}) => ({
  ID: String(id),
  BLOG_ID: '299',
  PUBLISH_STATUS: 'P',
  TITLE: `Новость ${String(id)}`,
  AUTHOR_ID: id % 2 === 0 ? '7' : '9',
  ENABLE_COMMENTS: 'Y',
  NUM_COMMENTS: '0',
  DETAIL_TEXT: `Текст новости ${String(id)}`,
  DATE_PUBLISH: '2026-09-17T15:29:15+03:00',
  HAS_SOCNET_ALL: 'N',
  UF_BLOG_POST_FILE: { ID: '19', VALUE: [505] },
  FILES: [505],
  ...extra,
});

let posts: Record<string, unknown>[];
let comments: {
  id: number;
  comment_id: number;
  log_id: number;
  date: string;
  text: string;
  attach: number[];
}[];
let addResult: unknown;

function setup(overrides: Record<string, string> = {}) {
  posts = Array.from({ length: 60 }, (_, i) => post(i + 1));
  comments = Array.from({ length: 5 }, (_, i) => ({
    id: 4821 + i,
    comment_id: 4821 + i,
    log_id: 13579,
    date: '2026-09-20T11:05:42+03:00',
    text: `Комментарий ${String(i)}`,
    attach: i === 0 ? [90210] : [],
  }));
  addResult = undefined;
  t = createTestApp({
    ENABLED_MODULES: 'system,feed',
    BITRIX_REQUESTS_PER_SECOND: '10',
    ...overrides,
  });
  t.bitrix
    .on('log.blogpost.get', (c) => {
      const id = c.body['POST_ID'];
      if (id !== undefined)
        return legacyOk(
          posts.filter((p) => p['ID'] === str(id)),
          { total: 1 },
        );
      return legacyListPage(posts, Number(c.body['start'] ?? 0), 50);
    })
    .on('log.blogpost.add', (c) => {
      if (addResult !== undefined) return legacyOk(addResult);
      const dest = c.body['DEST'] as string[];
      posts.push(
        post(217, {
          TITLE: c.body['POST_TITLE'],
          DETAIL_TEXT: c.body['POST_MESSAGE'],
          HAS_SOCNET_ALL: dest.includes('UA') ? 'Y' : 'N',
        }),
      );
      return legacyOk(217);
    })
    .on('log.blogpost.update', (c) => {
      const p = posts.find((x) => x['ID'] === str(c.body['POST_ID']));
      if (!p) return { status: 400, body: { error: 'SONET_CONTROLLER_LIVEFEED_BLOGPOST_UPDATE_ERROR' } };
      if (c.body['POST_TITLE'] !== undefined) p['TITLE'] = c.body['POST_TITLE'];
      if (c.body['POST_MESSAGE'] !== undefined) p['DETAIL_TEXT'] = c.body['POST_MESSAGE'];
      const dest = c.body['DEST'] as string[] | undefined;
      if (dest) p['HAS_SOCNET_ALL'] = dest.includes('UA') ? 'Y' : 'N';
      return legacyOk(Number(c.body['POST_ID']));
    })
    .on('log.blogcomment.add', (c) => {
      comments.push({
        id: 4900,
        comment_id: 4900,
        log_id: 13600,
        date: '2026-09-24T12:00:00+03:00',
        text: str(c.body['TEXT']),
        attach: [],
      });
      return legacyOk(4900);
    })
    .on('log.blogcomment.user.get', (c) => {
      const first = c.body['FIRST_ID'] as number | undefined;
      const last = c.body['LAST_ID'] as number | undefined;
      const limit = Number(c.body['LIMIT'] ?? 100);
      const list = comments
        .filter((x) => (first === undefined || x.id > first) && (last === undefined || x.id < last))
        .sort((a, b) => b.id - a.id)
        .slice(0, limit);
      return legacyOk({ comments: list, files: {} });
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

async function approveAndRun(tool: string, args: Record<string, unknown>) {
  const prep = await call(tool, args);
  expect(prep.error?.code).toBe('APPROVAL_REQUIRED');
  const operationId = prep.error?.details['operationId'] as string;
  t.app.approvals.approve(operationId, 'owner', t.app.auth.portalKey);
  const done = await call(tool, { ...args, approvalId: operationId });
  return { prep, done, operationId };
}

describe('очистка текста', () => {
  it('sanitizeHtml: script/iframe/on*/javascript: удаляются, разрешённая разметка остаётся', () => {
    const r = sanitizeHtml(
      '<h2>Заголовок</h2><p onclick="steal()">Текст <b>жирный</b></p>' +
        '<script>alert(1)</script><iframe src="https://evil"></iframe>' +
        '<a href="javascript:alert(1)">плохо</a><a href="https://example.com" target="_blank">хорошо</a>' +
        '<img src="x" onerror="alert(1)"><scr<script>x</script>ipt>alert(2)</script>' +
        '<a href="jav&#x09;ascript:alert(3)">обход</a><div style="background:url(javascript:x)">d</div>',
    );
    expect(r.value).not.toMatch(/script|iframe|onclick|onerror|javascript|style=/i);
    expect(r.value).toContain('<h2>Заголовок</h2>');
    expect(r.value).toContain('<b>жирный</b>');
    expect(r.value).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">хорошо</a>',
    );
    expect(r.removed).toEqual(expect.arrayContaining(['script', 'iframe', 'on*-атрибуты']));
  });

  it('sanitizeFeedText: HTML-теги и опасные BBCode-ссылки удаляются, обычный текст и «<» сохраняются', () => {
    const r = sanitizeFeedText(
      'a < b и [b]важно[/b] <script>alert(1)</script><span onmouseover="x()">текст</span> ' +
        '[url=javascript:alert(1)]ссылка[/url] [url=https://ok.example]норм[/url]',
    );
    expect(r.value).toBe('a < b и [b]важно[/b] текст ссылка [url=https://ok.example]норм[/url]');
    expect(r.removed).toEqual(expect.arrayContaining(['script', 'on*-атрибуты']));
  });

  it('textToHtml/htmlToText сохраняют структуру: абзацы, заголовки, пункты', () => {
    expect(textToHtml('Первый <абзац>\nстрока\n\nВторой')).toBe(
      '<p>Первый &lt;абзац&gt;<br>строка</p>\n<p>Второй</p>',
    );
    expect(htmlToText('<h2>Раздел</h2><p>Текст&nbsp;1</p><ul><li>один</li><li>два</li></ul>')).toBe(
      '## Раздел\n\nТекст 1\n\n- один\n- два',
    );
  });
});

describe('feed_post_create', () => {
  it('AUDIENCE_REQUIRED: без получателей и с пустым списком — отказ до плана, «вся компания» не подставляется', async () => {
    for (const extra of [{}, { recipientAccessCodes: [] }]) {
      const env = await call('feed_post_create', {
        title: 'Новость',
        text: 'Текст',
        idempotencyKey: randomUUID(),
        ...extra,
      });
      expect(env.error?.code).toBe('VALIDATION_ERROR');
      expect(env.error?.details['reason']).toBe('AUDIENCE_REQUIRED');
    }
    const bad = await client.callTool({
      name: 'feed_post_create',
      arguments: {
        title: 'Новость',
        text: 'Текст',
        recipientAccessCodes: ['G2'],
        idempotencyKey: randomUUID(),
      },
    });
    expect(bad.isError).toBe(true);
    expect(t.bitrix.callsTo('log.blogpost.add')).toHaveLength(0);
    expect(t.app.operations.countByStatus()).toEqual({});
  });

  it('очистка script до плана; APPROVAL_REQUIRED → approve → одна публикация с заданной аудиторией → replay', async () => {
    const args = {
      title: 'Регламент',
      text: 'С 1 ноября <script>alert(1)</script><b onclick="x()">новый порядок</b> [url=javascript:alert(1)]тут[/url]',
      recipientAccessCodes: ['U7', 'SG3', 'U7'],
      idempotencyKey: randomUUID(),
    };
    const { prep, done } = await approveAndRun('feed_post_create', args);
    const plan = prep.error?.details['plan'] as { details: Record<string, unknown>; risks: string[] };
    expect(plan.details['text']).toBe('С 1 ноября новый порядок тут');
    expect(plan.details['recipientAccessCodes']).toEqual(['U7', 'SG3']);
    expect(plan.risks.join(' ')).toContain('Текст очищен');
    expect(plan.risks.join(' ')).not.toContain('ВСЯ КОМПАНИЯ');
    expect(done.success).toBe(true);
    expect(done.data).toMatchObject({ postId: 217, verified: true, replayed: false });
    expect(t.bitrix.callsTo('log.blogpost.add')[0]?.body).toEqual({
      POST_TITLE: 'Регламент',
      POST_MESSAGE: 'С 1 ноября новый порядок тут',
      DEST: ['U7', 'SG3'],
    });
    const again = await call('feed_post_create', { ...args, approvalId: prep.error?.details['operationId'] });
    expect(again.data?.['replayed']).toBe(true);
    expect(t.bitrix.callsTo('log.blogpost.add')).toHaveLength(1);
  });

  it('UA — только явно и с отдельным риском «вся компания»', async () => {
    const env = await call('feed_post_create', {
      title: 'Всем',
      text: 'Текст',
      recipientAccessCodes: ['UA'],
      dryRun: true,
    });
    const plan = env.data?.['plan'] as { risks: string[] };
    expect(plan.risks[0]).toContain('ВСЯ КОМПАНИЯ (UA)');
  });

  it('ответ без ID → OPERATION_OUTCOME_UNKNOWN, повтор не публикует второй раз', async () => {
    addResult = false;
    const args = { title: 'X', text: 'Y', recipientAccessCodes: ['U7'], idempotencyKey: randomUUID() };
    const { done, operationId } = await approveAndRun('feed_post_create', args);
    expect(done.error?.code).toBe('OPERATION_OUTCOME_UNKNOWN');
    const again = await call('feed_post_create', { ...args, approvalId: operationId });
    expect(again.error?.code).toBe('OPERATION_OUTCOME_UNKNOWN');
    expect(t.bitrix.callsTo('log.blogpost.add')).toHaveLength(1);
  });
});

describe('feed_post_update', () => {
  it('CONFLICT по expectedStateHash до плана; смена аудитории — отдельный пункт diff и риска; заголовок сохраняется', async () => {
    const conflict = await call('feed_post_update', {
      postId: 2,
      patch: { text: 'Новый текст' },
      expectedStateHash: 'a'.repeat(64),
      idempotencyKey: randomUUID(),
    });
    expect(conflict.error?.code).toBe('CONFLICT');
    expect(t.app.operations.countByStatus()).toEqual({});

    const list = await call('feed_posts_list', { pageSize: 5 });
    const item = (list.data?.['items'] as Record<string, unknown>[]).find((p) => p['postId'] === 2);
    const args = {
      postId: 2,
      patch: { text: 'Новый текст', recipientAccessCodes: ['DR5'] },
      expectedStateHash: item?.['stateHash'],
      idempotencyKey: randomUUID(),
    };
    const { prep, done } = await approveAndRun('feed_post_update', args);
    const plan = prep.error?.details['plan'] as {
      details: { changes: Record<string, unknown> };
      risks: string[];
    };
    expect(plan.details.changes['text']).toEqual({ from: 'Текст новости 2', to: 'Новый текст' });
    expect(plan.details.changes['audience']).toMatchObject({
      to: ['DR5 — сотрудники отдела #5 (с подотделами)'],
    });
    expect(plan.risks[0]).toContain('СМЕНА АУДИТОРИИ');
    expect(done.data).toMatchObject({ postId: 2, verified: true, replayed: false });
    expect(t.bitrix.callsTo('log.blogpost.update')[0]?.body).toEqual({
      POST_ID: 2,
      POST_TITLE: 'Новость 2',
      POST_MESSAGE: 'Новый текст',
      DEST: ['DR5'],
    });
  });

  it('пустая новая аудитория → AUDIENCE_REQUIRED; несуществующий пост → NOT_FOUND без плана', async () => {
    const empty = await call('feed_post_update', {
      postId: 2,
      patch: { recipientAccessCodes: [] },
      idempotencyKey: randomUUID(),
    });
    expect(empty.error?.details['reason']).toBe('AUDIENCE_REQUIRED');
    const missing = await call('feed_post_update', {
      postId: 999,
      patch: { title: 'x' },
      idempotencyKey: randomUUID(),
    });
    expect(missing.error?.code).toBe('NOT_FOUND');
    expect(t.app.operations.countByStatus()).toEqual({});
  });
});

describe('feed_posts_list', () => {
  it('период передаётся LOG_DATE_FROM/TO; курсор идёт по start; UF-объекты не выдаются; authorId — локальный фильтр', async () => {
    const p1 = await call('feed_posts_list', { from: '2026-09-01', to: '2026-09-30', pageSize: 40 });
    expect(p1.success).toBe(true);
    const items = p1.data?.['items'] as Record<string, unknown>[];
    expect(items).toHaveLength(40);
    expect(Object.keys(items[0] ?? {})).not.toContain('UF_BLOG_POST_FILE');
    expect(t.bitrix.callsTo('log.blogpost.get')[0]?.body).toMatchObject({
      LOG_DATE_FROM: '2026-09-01',
      LOG_DATE_TO: '2026-09-30',
      start: 0,
    });
    const cursor = (p1.meta['page'] as { nextCursor: string }).nextCursor;
    const p2 = await call('feed_posts_list', { from: '2026-09-01', to: '2026-09-30', pageSize: 40, cursor });
    expect((p2.data?.['items'] as unknown[]).length).toBe(20);
    expect((p2.meta['page'] as { hasMore: boolean }).hasMore).toBe(false);

    const byAuthor = await call('feed_posts_list', { authorId: 7, pageSize: 10 });
    const own = byAuthor.data?.['items'] as { authorId: number }[];
    expect(own.every((p) => p.authorId === 7)).toBe(true);
    expect(byAuthor.meta.warnings?.join(' ')).toContain('локально');
  });
});

describe('комментарии (T35)', () => {
  it('feed_comments_list: coverage=userComments, ветка не заявляется полной, вложения — только число', async () => {
    const env = await call('feed_comments_list', { userId: 7, pageSize: 3 });
    expect(env.success).toBe(true);
    expect(env.data?.['coverage']).toBe('userComments');
    expect(env.data?.['threadComplete']).toBe(false);
    const items = env.data?.['items'] as Record<string, unknown>[];
    expect(items.map((c) => c['commentId'])).toEqual([4825, 4824, 4823]);
    expect(items[0]).not.toHaveProperty('attach');
    expect(env.meta.warnings?.join(' ')).toContain('coverage=userComments');
    expect(t.bitrix.callsTo('log.blogcomment.user.get')[0]?.body).toEqual({ USER_ID: 7, LIMIT: 3 });
    const cursor = (env.meta['page'] as { nextCursor: string }).nextCursor;
    const next = await call('feed_comments_list', { userId: 7, pageSize: 3, cursor });
    expect((next.data?.['items'] as Record<string, unknown>[]).map((c) => c['commentId'])).toEqual([
      4822, 4821,
    ]);
    expect(t.bitrix.callsTo('log.blogcomment.user.get')[1]?.body).toEqual({
      USER_ID: 7,
      LAST_ID: 4823,
      LIMIT: 3,
    });
    expect((next.meta['page'] as { hasMore: boolean }).hasMore).toBe(false);
  });

  it('postId → FULL_THREAD_UNAVAILABLE без обращения к порталу (log_id ≠ ID поста)', async () => {
    const env = await call('feed_comments_list', { postId: 217 });
    expect(env.error?.code).toBe('FEATURE_UNAVAILABLE');
    expect(env.error?.details['reason']).toBe('FULL_THREAD_UNAVAILABLE');
    expect(t.bitrix.callsTo('log.blogcomment.user.get')).toHaveLength(0);
  });

  it('feed_comment_add: пост читается до плана, approve → одна запись, сверка по комментариям пользователя, replay', async () => {
    const args = { postId: 3, text: 'Поддерживаю<iframe src="x"></iframe>', idempotencyKey: randomUUID() };
    const { prep, done, operationId } = await approveAndRun('feed_comment_add', args);
    expect((prep.error?.details['plan'] as { details: Record<string, unknown> }).details['text']).toBe(
      'Поддерживаю',
    );
    expect(done.data).toMatchObject({ postId: 3, commentId: 4900, verified: true, replayed: false });
    expect(t.bitrix.callsTo('log.blogcomment.add')[0]?.body).toEqual({ POST_ID: 3, TEXT: 'Поддерживаю' });
    expect(t.bitrix.callsTo('log.blogcomment.user.get').at(-1)?.body).toEqual({ FIRST_ID: 4899, LIMIT: 10 });
    const again = await call('feed_comment_add', { ...args, approvalId: operationId });
    expect(again.data?.['replayed']).toBe(true);
    expect(t.bitrix.callsTo('log.blogcomment.add')).toHaveLength(1);
  });
});

describe('режим только чтения', () => {
  it('READ_ONLY_MODE=true: инструменты записи скрыты, чтение работает', async () => {
    await close();
    t.app.close();
    await reconnect({ READ_ONLY_MODE: 'true' });
    const names = (await client.listTools()).tools.map((x) => x.name);
    for (const n of ['feed_post_create', 'feed_post_update', 'feed_comment_add'])
      expect(names).not.toContain(n);
    expect(names).toEqual(expect.arrayContaining(['feed_posts_list', 'feed_comments_list']));
    const r = await call('feed_posts_list', { pageSize: 1 });
    expect(r.success).toBe(true);
  });
});

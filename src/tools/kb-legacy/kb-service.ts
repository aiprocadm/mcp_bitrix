/**
 * Классическая база знаний на landing (ТЗ §9.13, T36): чтение баз, папок, страниц и блоков,
 * подготовка содержимого блоков и хеш состояния статьи.
 *
 * Внутренний параметр landing `scope` (KNOWLEDGE | GROUP) передаётся верхнеуровневым полем запроса
 * и НЕ является REST-scope `landing` (landing/types). Без него методы видят только обычные сайты.
 */
import { z } from 'zod';
import type { JsonObject, JsonValue } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { stateHash } from '../../security/idempotency.js';
import { asText, idOf, isObj, upstreamShapeError, yn } from '../shared.js';
import type { ToolContext } from '../types.js';
import { htmlToText, sanitizeHtml, textToHtml } from '../feed/sanitize.js';

export const KB_SCOPES = ['KNOWLEDGE', 'GROUP'] as const;
export type KbScope = (typeof KB_SCOPES)[number];

export const kbScopeSchema = z
  .enum(KB_SCOPES)
  .default('KNOWLEDGE')
  .describe(
    'Внутренний scope landing: KNOWLEDGE — базы знаний, GROUP — базы знаний групп. Это не REST-разрешение landing',
  );

const call = (ctx: ToolContext, method: string, params: JsonObject) =>
  ctx.bitrix.call('legacy', method, params, { requestId: ctx.requestId, signal: ctx.signal });

// ---------- базы (сайты) ----------

export interface KbBase {
  siteId: number;
  title: string;
  code: string;
  type: string;
  published: boolean;
  description: string;
  dateCreate: string;
  dateModify: string;
}

export const SITE_SELECT = [
  'ID',
  'TITLE',
  'CODE',
  'TYPE',
  'ACTIVE',
  'DESCRIPTION',
  'DATE_CREATE',
  'DATE_MODIFY',
];

export function normalizeBase(raw: Record<string, JsonValue>): KbBase {
  const siteId = idOf(raw['ID']);
  if (siteId === undefined) throw upstreamShapeError('landing.site.getlist', 'legacy', 'сайт без ID');
  return {
    siteId,
    title: asText(raw['TITLE']),
    code: asText(raw['CODE']),
    type: asText(raw['TYPE']),
    published: yn(raw['ACTIVE']),
    description: asText(raw['DESCRIPTION']),
    dateCreate: asText(raw['DATE_CREATE']),
    dateModify: asText(raw['DATE_MODIFY']),
  };
}

/** Страница баз: landing.site.getlist с limit/offset (ORM), лишняя строка определяет hasMore. */
export async function listBases(
  ctx: ToolContext,
  scope: KbScope,
  offset: number,
  limit: number,
  filter: JsonObject = {},
): Promise<Record<string, JsonValue>[]> {
  const r = await call(ctx, 'landing.site.getlist', {
    scope,
    params: { select: SITE_SELECT, filter: { TYPE: scope, ...filter }, order: { ID: 'ASC' }, limit, offset },
  });
  if (!Array.isArray(r.result)) throw upstreamShapeError('landing.site.getlist', 'legacy');
  return r.result.filter(isObj);
}

export async function getBase(ctx: ToolContext, scope: KbScope, siteId: number): Promise<KbBase> {
  const rows = await listBases(ctx, scope, 0, 1, { ID: siteId });
  const row = rows.find((x) => idOf(x['ID']) === siteId);
  if (!row) {
    throw new AppError(
      'NOT_FOUND',
      `База знаний #${String(siteId)} не найдена в scope ${scope} или недоступна текущему пользователю`,
      { method: 'landing.site.getlist', apiVersion: 'legacy' },
    );
  }
  return normalizeBase(row);
}

// ---------- папки ----------

export async function getFolder(
  ctx: ToolContext,
  scope: KbScope,
  siteId: number,
  folderId: number,
): Promise<Record<string, JsonValue>> {
  const r = await call(ctx, 'landing.site.getfolders', { scope, siteId, filter: { ID: folderId } });
  if (!Array.isArray(r.result)) throw upstreamShapeError('landing.site.getfolders', 'legacy');
  const row = r.result.find((x) => isObj(x) && idOf(x['ID']) === folderId);
  if (!isObj(row)) {
    throw new AppError(
      'NOT_FOUND',
      `Раздел (папка) #${String(folderId)} не найден в базе #${String(siteId)}`,
      {
        method: 'landing.site.getfolders',
        apiVersion: 'legacy',
      },
    );
  }
  return row;
}

// ---------- статьи (страницы) ----------

export interface KbArticle {
  articleId: number;
  title: string;
  code: string;
  siteId: number | null;
  folderId: number | null;
  isFolder: boolean;
  published: boolean;
  dateModify: string;
  datePublic: string | null;
}

export const PAGE_SELECT = [
  'ID',
  'TITLE',
  'CODE',
  'SITE_ID',
  'FOLDER_ID',
  'FOLDER',
  'ACTIVE',
  'DATE_MODIFY',
  'DATE_PUBLIC',
];

export function normalizeArticle(raw: Record<string, JsonValue>): KbArticle {
  const articleId = idOf(raw['ID']);
  if (articleId === undefined)
    throw upstreamShapeError('landing.landing.getlist', 'legacy', 'страница без ID');
  const datePublic = asText(raw['DATE_PUBLIC']);
  return {
    articleId,
    title: asText(raw['TITLE']),
    code: asText(raw['CODE']),
    siteId: idOf(raw['SITE_ID']) ?? null,
    folderId: idOf(raw['FOLDER_ID']) ?? null,
    isFolder: yn(raw['FOLDER']),
    published: yn(raw['ACTIVE']),
    dateModify: asText(raw['DATE_MODIFY']),
    datePublic: datePublic === '' ? null : datePublic,
  };
}

export async function listArticles(
  ctx: ToolContext,
  scope: KbScope,
  filter: JsonObject,
  offset: number,
  limit: number,
): Promise<Record<string, JsonValue>[]> {
  const r = await call(ctx, 'landing.landing.getlist', {
    scope,
    params: { select: PAGE_SELECT, filter, order: { ID: 'ASC' }, limit, offset },
  });
  if (!Array.isArray(r.result)) throw upstreamShapeError('landing.landing.getlist', 'legacy');
  return r.result.filter(isObj);
}

export async function getArticle(ctx: ToolContext, scope: KbScope, articleId: number): Promise<KbArticle> {
  const rows = await listArticles(ctx, scope, { ID: articleId }, 0, 1);
  const row = rows.find((x) => idOf(x['ID']) === articleId);
  if (!row) {
    throw new AppError(
      'NOT_FOUND',
      `Статья #${String(articleId)} не найдена в scope ${scope} или недоступна текущему пользователю`,
      { method: 'landing.landing.getlist', apiVersion: 'legacy' },
    );
  }
  const a = normalizeArticle(row);
  if (a.isFolder) {
    throw new AppError('VALIDATION_ERROR', `#${String(articleId)} — папка, а не статья`, {
      field: 'articleId',
      reason: 'NOT_AN_ARTICLE',
    });
  }
  return a;
}

// ---------- блоки ----------

export interface KbBlock {
  blockId: number;
  code: string;
  name: string;
  active: boolean;
  /** Готовый HTML блока (landing.block.getlist get_content). */
  html: string;
}

/**
 * Блоки страницы в порядке выдачи landing.block.getlist (draft: edit_mode=true).
 * Один вызов с get_content=true даёт порядок, ID и HTML всех блоков — хеш состояния считается по нему.
 */
export async function listBlocks(
  ctx: ToolContext,
  scope: KbScope,
  articleId: number,
  version: 'draft' | 'published' = 'draft',
): Promise<KbBlock[]> {
  const r = await call(ctx, 'landing.block.getlist', {
    scope,
    lid: articleId,
    params: { edit_mode: version === 'draft', get_content: true },
  });
  if (!Array.isArray(r.result)) throw upstreamShapeError('landing.block.getlist', 'legacy');
  const out: KbBlock[] = [];
  for (const row of r.result) {
    if (!isObj(row)) continue;
    const blockId = idOf(row['id']);
    if (blockId === undefined) throw upstreamShapeError('landing.block.getlist', 'legacy', 'блок без id');
    out.push({
      blockId,
      code: asText(row['code']),
      name: asText(row['name']),
      active: row['active'] === true || yn(row['active']),
      html: asText(row['content']),
    });
  }
  return out;
}

/** Хеш содержимого черновика: порядок, ID и HTML всех блоков. */
export const blocksStateHash = (blocks: readonly KbBlock[]): string =>
  stateHash(blocks.map((b) => ({ id: b.blockId, code: b.code, active: b.active, html: b.html })));

// ---------- подготовка содержимого ----------

export const CONTENT_ITEM_MAX = 65_536;
export const CONTENT_TOTAL_MAX = 262_144;
export const CONTENT_BLOCKS_MAX = 20;

export const contentSchema = z
  .union([
    z.string().min(1).max(CONTENT_ITEM_MAX),
    z.array(z.string().min(1).max(CONTENT_ITEM_MAX)).min(1).max(CONTENT_BLOCKS_MAX),
  ])
  .describe(
    'Содержимое: строка (один блок) или массив строк (по блоку на элемент, порядок сохраняется). До 20 блоков, 64 KiB на блок, 256 KiB всего',
  );

export const formatSchema = z
  .enum(['text', 'html'])
  .default('text')
  .describe('text — обычный текст (абзацы по пустой строке); html — HTML, будет очищен по allowlist');

export const blockCodeSchema = z
  .string()
  .regex(/^(repo_\d{1,10}|[a-z0-9][a-z0-9_.-]{0,99})$/i, 'код блока из landing.block.getrepository')
  .optional()
  .describe(
    'Код блока из репозитория landing (ключ result.items у landing.block.getrepository в том же scope), например текстового блока портала. ' +
      'Документация не называет универсальный код «HTML-блока»; без blockCode инструмент вернёт список кодов раздела text',
  );

export interface PreparedBlock {
  position: number;
  html: string;
  chars: number;
}

/** Контент → очищенные HTML-блоки; removed — что удалено очисткой (для плана). */
export function prepareBlocks(
  content: string | readonly string[],
  format: 'text' | 'html',
): { blocks: PreparedBlock[]; removed: string[] } {
  const items = typeof content === 'string' ? [content] : [...content];
  const total = items.reduce((n, s) => n + s.length, 0);
  if (total > CONTENT_TOTAL_MAX) {
    throw new AppError(
      'VALIDATION_ERROR',
      'Содержимое больше 256 KiB; разбейте статью на несколько изменений',
      {
        field: 'content',
        reason: 'CONTENT_TOO_LARGE',
      },
    );
  }
  const removed = new Set<string>();
  const blocks = items.map((raw, i) => {
    let html: string;
    if (format === 'text') html = textToHtml(raw);
    else {
      const r = sanitizeHtml(raw);
      r.removed.forEach((x) => removed.add(x));
      html = r.value;
    }
    if (html.trim() === '' || htmlToText(html) === '') {
      throw new AppError('VALIDATION_ERROR', `Блок ${String(i + 1)} пуст после очистки`, {
        field: 'content',
        reason: 'EMPTY_AFTER_SANITIZE',
      });
    }
    return { position: i + 1, html, chars: html.length };
  });
  return { blocks, removed: [...removed] };
}

/**
 * Проверка кода блока по репозиторию landing (landing.block.getrepository в том же scope).
 * Без кода — VALIDATION_ERROR со списком кодов раздела text: выдумывать «HTML-блок» нельзя.
 */
export async function assertBlockCode(
  ctx: ToolContext,
  scope: KbScope,
  code: string | undefined,
): Promise<string> {
  if (code === undefined) {
    const r = await call(ctx, 'landing.block.getrepository', { scope, section: 'text' });
    const items = isObj(r.result) && isObj(r.result['items']) ? r.result['items'] : {};
    const candidates = Object.entries(items)
      .slice(0, 10)
      .map(([k, v]) => `${k}${isObj(v) && asText(v['name']) ? ` (${asText(v['name']).slice(0, 60)})` : ''}`);
    throw new AppError('VALIDATION_ERROR', 'Не указан blockCode — код блока из репозитория landing', {
      field: 'blockCode',
      reason: 'BLOCK_CODE_REQUIRED',
      nextAction: candidates.length
        ? `Выберите текстовый блок из репозитория портала и повторите с blockCode: ${candidates.join('; ')}`
        : 'Раздел text репозитория пуст или недоступен в этом scope; уточните код блока у администратора портала',
    });
  }
  const r = await call(ctx, 'landing.block.getrepository', { scope });
  if (!isObj(r.result)) throw upstreamShapeError('landing.block.getrepository', 'legacy');
  for (const section of Object.values(r.result)) {
    if (isObj(section) && isObj(section['items']) && Object.hasOwn(section['items'], code)) return code;
  }
  throw new AppError('VALIDATION_ERROR', `Блок ${code} недоступен в репозитории landing для scope ${scope}`, {
    field: 'blockCode',
    reason: 'BLOCK_CODE_UNAVAILABLE',
    nextAction: 'Повторите без blockCode, чтобы получить список доступных текстовых блоков',
  });
}

// ---------- шаги составной записи ----------

export interface StepStatus {
  step: string;
  method: string;
  status: 'done' | 'failed' | 'unknown' | 'skipped';
  blockId?: number;
  position?: number;
  errorCode?: string;
}

/** Добавить блок; ответ без ID → исход неизвестен (без повтора). */
export async function addBlock(
  ctx: ToolContext,
  scope: KbScope,
  articleId: number,
  code: string,
  html: string,
  afterId: number | undefined,
): Promise<number | undefined> {
  const r = await ctx.bitrix.call(
    'legacy',
    'landing.landing.addblock',
    {
      scope,
      lid: articleId,
      fields: { CODE: code, CONTENT: html, ...(afterId !== undefined ? { AFTER_ID: afterId } : {}) },
    },
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  return idOf(r.result) ?? (isObj(r.result) ? idOf(r.result['id']) : undefined);
}

export const stepsText = (steps: readonly StepStatus[]): string =>
  steps
    .map(
      (s) =>
        `${s.step}: ${s.status}${s.blockId !== undefined ? ` (блок #${String(s.blockId)})` : ''}${s.errorCode ? ` [${s.errorCode}]` : ''}`,
    )
    .join('; ');

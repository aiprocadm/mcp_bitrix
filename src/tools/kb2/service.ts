/**
 * Сервис Базы знаний 2.0 (ТЗ §9.14): REST 3.0 `note.*`, scope `note`.
 * Формы ответов — по официальным страницам методов: get/add/update → result.item,
 * list → result.items (+ nextCursor | hasMore | truncated). Сеть — только через ctx.bitrix (v3).
 */
import { createHash } from 'node:crypto';
import type { JsonObject, JsonValue } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { asText, idOf, isObj, num, upstreamShapeError } from '../shared.js';
import type { ToolContext } from '../types.js';

/** Документированный предел Markdown для note.document.add/update (1 048 576 байт). */
export const UPSTREAM_MARKDOWN_MAX_BYTES = 1_048_576;
/** Наш начальный предел входного текста (ТЗ §9.14): 256 KiB. */
export const INPUT_MARKDOWN_MAX_BYTES = 262_144;
/** До какого размера текст показывается в плане целиком; длиннее — начало/конец + sha256. */
export const PLAN_INLINE_CHARS = 16_000;

/** Код upstream при несохранённых правках совместного редактора (note.document.update). */
export const UNSAVED_CHANGES_CODE = 'NOTE_DOCUMENT_HAS_UNSAVED_CHANGES';
/** Код upstream: родитель не из той же базы (note.document.add). */
export const INVALID_PARENT_CODE = 'NOTE_INVALID_PARENT';

export async function callV3(ctx: ToolContext, method: string, params: JsonObject): Promise<JsonValue> {
  try {
    const r = await ctx.bitrix.call('v3', method, params, { requestId: ctx.requestId, signal: ctx.signal });
    return r.result;
  } catch (e) {
    // REST 3.0: BITRIX_REST_V3_EXCEPTION_ENTITYNOTFOUNDEXCEPTION приходит с HTTP 400 (обзор REST 3.0),
    // а общий разбор ищет «NOT_FOUND» с подчёркиванием — здесь приводим к NOT_FOUND явно.
    if (AppError.is(e) && e.code !== 'NOT_FOUND' && /NOTFOUND/i.test(e.details.upstreamCode ?? '')) {
      throw new AppError('NOT_FOUND', 'Объект не найден или недоступен', {
        ...e.details,
        retryable: false,
        nextAction: 'Проверьте ID и права; архивные и удалённые документы недоступны',
      });
    }
    throw e;
  }
}

/** sha256 полного текста Markdown (UTF-8) — contentHash и stateHash документа. */
export function contentHash(markdown: string): string {
  return createHash('sha256').update(markdown, 'utf8').digest('hex');
}

export const byteLength = (s: string): number => Buffer.byteLength(s, 'utf8');

// ---------- базы ----------

export interface Kb2Collection {
  collectionId: number;
  name: string;
  position: number | null;
  policyLevel: string | null;
  createdBy: number | null;
  updatedBy: number | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export function normalizeCollection(raw: JsonValue, method: string): Kb2Collection {
  if (!isObj(raw)) throw upstreamShapeError(method, 'v3');
  const id = idOf(raw['id']);
  if (id === undefined) throw upstreamShapeError(method, 'v3');
  return {
    collectionId: id,
    name: asText(raw['name']),
    position: num(raw['position']) ?? null,
    policyLevel: asText(raw['policyLevel']) || null,
    createdBy: idOf(raw['createdBy']) ?? null,
    updatedBy: idOf(raw['updatedBy']) ?? null,
    createdAt: asText(raw['createdAt']) || null,
    updatedAt: asText(raw['updatedAt']) || null,
  };
}

/** result.item → объект; иначе неожиданная форма. */
export function itemOf(result: JsonValue, method: string): JsonValue {
  if (!isObj(result) || !isObj(result['item'])) throw upstreamShapeError(method, 'v3');
  return result['item'];
}

export async function getCollection(ctx: ToolContext, collectionId: number): Promise<Kb2Collection> {
  const method = 'note.collection.get';
  return normalizeCollection(itemOf(await callV3(ctx, method, { id: collectionId }), method), method);
}

// ---------- документы ----------

export interface Kb2Document {
  documentId: number;
  collectionId: number | null;
  parentId: number | null;
  title: string;
  markdown: string;
  position: number | null;
  createdBy: number | null;
  updatedBy: number | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export function normalizeDocument(raw: JsonValue, method: string): Kb2Document {
  if (!isObj(raw)) throw upstreamShapeError(method, 'v3');
  const id = idOf(raw['id']);
  const md = raw['markdown'];
  if (id === undefined || (md !== undefined && md !== null && typeof md !== 'string')) {
    throw upstreamShapeError(method, 'v3');
  }
  return {
    documentId: id,
    collectionId: idOf(raw['collectionId']) ?? null,
    parentId: idOf(raw['parentId']) ?? null,
    title: asText(raw['title']),
    markdown: typeof md === 'string' ? md : '',
    position: num(raw['position']) ?? null,
    createdBy: idOf(raw['createdBy']) ?? null,
    updatedBy: idOf(raw['updatedBy']) ?? null,
    createdAt: asText(raw['createdAt']) || null,
    updatedAt: asText(raw['updatedAt']) || null,
  };
}

export async function getDocument(ctx: ToolContext, documentId: number): Promise<Kb2Document> {
  const method = 'note.document.get';
  return normalizeDocument(itemOf(await callV3(ctx, method, { id: documentId }), method), method);
}

/** Метаданные документа без текста (для ответов и планов). */
export function documentMeta(d: Kb2Document) {
  return {
    documentId: d.documentId,
    collectionId: d.collectionId,
    parentId: d.parentId,
    title: d.title,
    position: d.position,
    createdBy: d.createdBy,
    updatedBy: d.updatedBy,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

// ---------- дерево ----------

export interface Kb2TreeNode {
  documentId: number;
  parentId: number | null;
  title: string;
  position: number | null;
  depth: number;
  childCount: number;
}

/** Обход дерева note.document.tree.list в глубину (порядок выдачи портала сохраняется). */
export function flattenTree(items: JsonValue[], method: string): Kb2TreeNode[] {
  const out: Kb2TreeNode[] = [];
  const walk = (nodes: JsonValue[], depth: number, parent: number | null) => {
    for (const n of nodes) {
      if (!isObj(n)) throw upstreamShapeError(method, 'v3');
      const id = idOf(n['id']);
      if (id === undefined) throw upstreamShapeError(method, 'v3');
      const children = Array.isArray(n['children']) ? n['children'] : [];
      out.push({
        documentId: id,
        parentId: idOf(n['parentId']) ?? parent,
        title: asText(n['title']),
        position: num(n['position']) ?? null,
        depth,
        childCount: children.length,
      });
      if (depth < 64) walk(children, depth + 1, id);
    }
  };
  walk(items, 0, null);
  return out;
}

/** Потомки узла parentId (без самого узла), в порядке обхода. undefined — узла нет в дереве. */
export function subtreeOf(nodes: Kb2TreeNode[], parentId: number): Kb2TreeNode[] | undefined {
  const idx = nodes.findIndex((n) => n.documentId === parentId);
  if (idx < 0) return undefined;
  const base = nodes[idx]?.depth ?? 0;
  const out: Kb2TreeNode[] = [];
  for (let i = idx + 1; i < nodes.length; i++) {
    const n = nodes[i];
    if (!n || n.depth <= base) break;
    out.push(n);
  }
  return out;
}

// ---------- текст ----------

/** Граница куска: не разрезать суррогатную пару UTF-16. */
export function safeCut(text: string, end: number): number {
  if (end >= text.length) return text.length;
  const code = text.charCodeAt(end - 1);
  return code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
}

/**
 * Кусок текста [offset, offset+maxChars), дополнительно ужатый так, чтобы JSON-строка укладывалась в maxBytes
 * (ответ инструмента ограничен MAX_RESPONSE_BYTES).
 */
export function sliceChunk(text: string, offset: number, maxChars: number, maxBytes: number): string {
  let end = safeCut(text, Math.min(text.length, offset + maxChars));
  let chunk = text.slice(offset, end);
  while (chunk.length > 1 && byteLength(JSON.stringify(chunk)) > maxBytes) {
    end = safeCut(text, offset + Math.max(1, Math.floor(chunk.length * 0.8)));
    chunk = text.slice(offset, end);
  }
  return chunk;
}

/** Текст для плана: целиком, если короткий; иначе начало, конец, размер и sha256. */
export function planText(text: string): Record<string, unknown> {
  if (text.length <= PLAN_INLINE_CHARS)
    return { markdown: text, chars: text.length, sha256: contentHash(text) };
  return {
    markdownHead: text.slice(0, safeCut(text, 4000)),
    markdownTail: text.slice(text.length - 2000),
    chars: text.length,
    bytes: byteLength(text),
    sha256: contentHash(text),
    note: `Текст длиннее ${String(PLAN_INLINE_CHARS)} символов: показаны начало и конец; подтверждение привязано к хешу полного текста аргументов`,
  };
}

/** Текст дописывается с пустой строкой-разделителем, чтобы Markdown-блоки не склеились. */
export function appendMarkdown(current: string, addition: string): string {
  if (current.length === 0) return addition;
  if (current.endsWith('\n\n')) return current + addition;
  if (current.endsWith('\n')) return `${current}\n${addition}`;
  return `${current}\n\n${addition}`;
}

/** Фрагмент поиска: HTML с <b>…</b> → простой текст (внешние данные портала). */
export function snippetText(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .slice(0, 1000);
}

// ---------- ошибки ----------

export function collaborativeConflict(message: string, upstreamCode?: string): AppError {
  return new AppError('CONFLICT', message, {
    reason: 'COLLABORATIVE_EDIT_CONFLICT',
    ...(upstreamCode ? { upstreamCode } : {}),
    method: 'note.document.update',
    apiVersion: 'v3',
    nextAction:
      'Документ меняется в Bitrix24 (совместный редактор или другая запись). Перечитайте его (kb2_document_get), ' +
      'дождитесь сохранения правок и подготовьте новый план с новым expectedStateHash. ' +
      'overwrite=true автоматически НЕ включается: это отдельное решение человека с риском затереть несохранённые правки',
  });
}

export function invalidParent(message: string, upstreamCode?: string): AppError {
  return new AppError('VALIDATION_ERROR', message, {
    field: 'parentId',
    reason: 'INVALID_PARENT',
    ...(upstreamCode ? { upstreamCode } : {}),
    nextAction:
      'Укажите parentId документа из той же базы (kb2_documents_list) или не передавайте parentId для корневого документа',
  });
}

export const upstreamCodeOf = (e: unknown): string | undefined =>
  AppError.is(e) ? e.details.upstreamCode : undefined;

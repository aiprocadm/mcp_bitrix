/**
 * Сервис Ленты (ТЗ §9.10): чтение поста по ID, нормализация, коды аудитории и хеш состояния.
 * Все вызовы — через ctx.bitrix (методы из src/bitrix/registry/feed-landing.ts).
 */
import { z } from 'zod';
import type { JsonValue } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { stateHash } from '../../security/idempotency.js';
import { asText, idOf, isObj, num, upstreamShapeError, yn } from '../shared.js';
import type { ToolContext } from '../types.js';

/**
 * Коды получателей строго по документации log.blogpost.add (DEST): U<id>, SG<id>, DR<id>, UA.
 * Никакого значения по умолчанию: аудиторию выбирает пользователь (ТЗ §9.10).
 */
export const ACCESS_CODE_RE = /^(UA|U[1-9]\d{0,9}|SG[1-9]\d{0,9}|DR[1-9]\d{0,9})$/;

export const accessCodesSchema = z
  .array(
    z
      .string()
      .max(12)
      .regex(ACCESS_CODE_RE, 'код получателя: U<id> (сотрудник), SG<id> (группа), DR<id> (отдел) или UA'),
  )
  .max(50)
  .describe(
    'Получатели: U<id> — сотрудник, SG<id> — группа/проект, DR<id> — отдел, UA — все авторизованные пользователи. Обязательно, минимум один; «вся компания» не подставляется сама',
  );

/** Пустая аудитория → AUDIENCE_REQUIRED до плана. Дубли убираются с сохранением порядка. */
export function requireAudience(codes: readonly string[] | undefined): string[] {
  const uniq = [...new Set(codes ?? [])];
  if (uniq.length === 0) {
    throw new AppError('VALIDATION_ERROR', 'Не указана аудитория публикации (recipientAccessCodes)', {
      field: 'recipientAccessCodes',
      reason: 'AUDIENCE_REQUIRED',
      nextAction:
        'Уточните у пользователя получателей: U<id> сотрудника, SG<id> группы, DR<id> отдела или UA (вся компания — только по явной просьбе)',
    });
  }
  return uniq;
}

export function describeAudience(codes: readonly string[]): string[] {
  return codes.map((c) => {
    if (c === 'UA') return 'UA — все авторизованные пользователи портала';
    if (c.startsWith('SG')) return `${c} — участники группы/проекта #${c.slice(2)}`;
    if (c.startsWith('DR')) return `${c} — сотрудники отдела #${c.slice(2)} (с подотделами)`;
    return `${c} — сотрудник #${c.slice(1)}`;
  });
}

export interface FeedPost {
  id: number;
  title: string;
  text: string;
  authorId: number | null;
  datePublish: string;
  publishStatus: string;
  numComments: number;
  commentsEnabled: boolean;
  /** HAS_SOCNET_ALL: пост адресован всем авторизованным (UA). */
  visibleToAll: boolean;
}

export function normalizePost(raw: Record<string, JsonValue>): FeedPost {
  const id = idOf(raw['ID']);
  if (id === undefined) throw upstreamShapeError('log.blogpost.get', 'legacy', 'пост без ID');
  return {
    id,
    title: asText(raw['TITLE']),
    text: asText(raw['DETAIL_TEXT']),
    authorId: idOf(raw['AUTHOR_ID']) ?? null,
    datePublish: asText(raw['DATE_PUBLISH']),
    publishStatus: asText(raw['PUBLISH_STATUS']),
    numComments: num(raw['NUM_COMMENTS']) ?? 0,
    commentsEnabled: yn(raw['ENABLE_COMMENTS']),
    visibleToAll: yn(raw['HAS_SOCNET_ALL']),
  };
}

/** Хеш того, что меняет feed_post_update: заголовок, текст, признак «всем». */
export const postStateHash = (p: FeedPost): string =>
  stateHash({ id: p.id, title: p.title, text: p.text, visibleToAll: p.visibleToAll });

/** Пост по ID (log.blogpost.get POST_ID). Нет в выдаче (удалён/нет доступа) → NOT_FOUND. */
export async function getPost(ctx: ToolContext, postId: number): Promise<FeedPost> {
  const r = await ctx.bitrix.call(
    'legacy',
    'log.blogpost.get',
    { POST_ID: postId },
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  if (!Array.isArray(r.result)) throw upstreamShapeError('log.blogpost.get', 'legacy');
  const row = r.result.find((x) => isObj(x) && idOf(x['ID']) === postId);
  if (!isObj(row)) {
    throw new AppError(
      'NOT_FOUND',
      `Пост #${String(postId)} не найден или недоступен текущему пользователю`,
      {
        method: 'log.blogpost.get',
        apiVersion: 'legacy',
      },
    );
  }
  return normalizePost(row);
}

export interface FeedComment {
  id: number;
  commentId: number | null;
  /** ID записи журнала Ленты. НЕ равен ID поста (соответствие не документировано). */
  logId: number | null;
  date: string;
  text: string;
  attachmentCount: number;
}

export function normalizeComment(raw: Record<string, JsonValue>): FeedComment | undefined {
  const id = idOf(raw['id']);
  if (id === undefined) return undefined;
  const attach = raw['attach'];
  return {
    id,
    commentId: idOf(raw['comment_id']) ?? null,
    logId: idOf(raw['log_id']) ?? null,
    date: asText(raw['date']),
    text: asText(raw['text']),
    attachmentCount: Array.isArray(attach) ? attach.length : 0,
  };
}

/** log.blogcomment.user.get: форма ответа по документации — result.comments[] (+ result.files). */
export async function userComments(
  ctx: ToolContext,
  params: { userId?: number; firstId?: number; lastId?: number; limit: number },
): Promise<FeedComment[]> {
  const r = await ctx.bitrix.call(
    'legacy',
    'log.blogcomment.user.get',
    {
      ...(params.userId !== undefined ? { USER_ID: params.userId } : {}),
      ...(params.firstId !== undefined ? { FIRST_ID: params.firstId } : {}),
      ...(params.lastId !== undefined ? { LAST_ID: params.lastId } : {}),
      LIMIT: params.limit,
    },
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  const result = r.result;
  const list = isObj(result) ? result['comments'] : undefined;
  if (!Array.isArray(list)) throw upstreamShapeError('log.blogcomment.user.get', 'legacy');
  const out: FeedComment[] = [];
  for (const row of list) {
    const c = isObj(row) ? normalizeComment(row) : undefined;
    if (c) out.push(c);
  }
  return out;
}

/**
 * Общие части записей задач (ТЗ §9.8): снимок состояния и stateHash, сравнение значений,
 * признаки REST 3.0 (requireResult/needsControl/containsResults/chatId), права из result.task.action.
 * Сеть — только через ctx.bitrix; записи — только из perform() инструментов через MutationExecutor.
 */
import type { JsonObject } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { stateHash } from '../../security/idempotency.js';
import { asText, isObj, upstreamShapeError } from '../shared.js';
import type { ToolContext } from '../types.js';
import { getTask, type TaskRecord } from './task-service.js';

/** UPPER_CASE имя поля запроса → camelCase ключ ответа legacy tasks.task.* (RESPONSIBLE_ID → responsibleId). */
export function camelKey(upper: string): string {
  const [head = '', ...rest] = upper.toLowerCase().split('_');
  return head + rest.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

/** Поля, по которым считается stateHash задачи (camelCase ответа). changedDate ловит любые прочие правки. */
const STATE_KEYS = [
  'id',
  'title',
  'description',
  'status',
  'responsibleId',
  'createdBy',
  'deadline',
  'groupId',
  'priority',
  'parentId',
  'accomplices',
  'auditors',
  'startDatePlan',
  'endDatePlan',
  'changedDate',
] as const;

export function taskStateHash(task: Record<string, unknown>): string {
  const snap: Record<string, unknown> = {};
  for (const k of STATE_KEYS) snap[k] = task[k] ?? null;
  return stateHash(snap);
}

/**
 * Полная карточка задачи для плана записи: tasks.task.get без select (все стандартные поля, action, chatId)
 * плюс значения запрошенных UF_* (они приходят только по select).
 */
export async function readTaskForWrite(
  ctx: ToolContext,
  taskId: number,
  extraUpperFields: readonly string[] = [],
): Promise<TaskRecord> {
  const task = await getTask(ctx, taskId);
  const missing = extraUpperFields.filter((f) => !(camelKey(f) in task));
  if (missing.length === 0) return task;
  const extra = await getTask(ctx, taskId, ['ID', ...missing]);
  return { ...task, ...extra };
}

/** Действие разрешено текущему пользователю? undefined — портал не вернул action (проверку делает сам Bitrix). */
export function actionAllowed(task: Record<string, unknown>, action: string): boolean | undefined {
  const a = task['action'];
  if (!isObj(a) || typeof a[action] !== 'boolean') return undefined;
  return a[action];
}

/** Нормализованное сравнение значения, которое записали, с прочитанным (даты — как моменты, массивы — как множества). */
export function sameTaskValue(want: unknown, got: unknown): boolean {
  if (Array.isArray(want) || Array.isArray(got)) {
    const a = (Array.isArray(want) ? want : []).map(asText).sort();
    const b = (Array.isArray(got) ? got : []).map(asText).sort();
    return a.length === b.length && a.every((x, i) => x === b[i]);
  }
  const w = asText(want);
  const g = asText(got);
  if (w === g) return true;
  if (w === '' && (got === null || got === undefined || g === '0')) return true;
  if (/^\d{4}-\d{2}-\d{2}T/.test(w)) {
    const a = Date.parse(w);
    const b = Date.parse(g);
    return !Number.isNaN(a) && a === b;
  }
  return false;
}

/** Признаки задачи из REST 3.0 tasks.task.get (result.item), нужные для завершения и выбора backend обсуждения. */
export interface TaskV3Flags {
  requireResult: boolean | undefined;
  containsResults: boolean | undefined;
  needsControl: boolean | undefined;
  chatId: number | undefined;
}

/** Ошибки, при которых REST 3.0 считается недоступным для этой проверки (а не сбоем операции). */
const V3_UNAVAILABLE = new Set([
  'FEATURE_UNAVAILABLE',
  'BITRIX_SCOPE_MISSING',
  'BITRIX_ACCESS_DENIED',
  'BITRIX_APP_CONTEXT_REQUIRED',
  'METHOD_NOT_ALLOWED',
]);

export async function getTaskV3Flags(
  ctx: ToolContext,
  taskId: number,
): Promise<{ ok: true; flags: TaskV3Flags } | { ok: false; code: string }> {
  try {
    const r = await ctx.bitrix.call(
      'v3',
      'tasks.task.get',
      { id: taskId, select: ['id', 'requireResult', 'containsResults', 'needsControl', 'chatId'] },
      { requestId: ctx.requestId, signal: ctx.signal },
    );
    const item = isObj(r.result) ? r.result['item'] : undefined;
    if (!isObj(item))
      throw upstreamShapeError('tasks.task.get', 'v3', 'tasks.task.get (REST 3.0) вернул ответ без item');
    const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
    const chat = Number(item['chatId']);
    return {
      ok: true,
      flags: {
        requireResult: bool(item['requireResult']),
        containsResults: bool(item['containsResults']),
        needsControl: bool(item['needsControl']),
        chatId: Number.isSafeInteger(chat) && chat > 0 ? chat : undefined,
      },
    };
  } catch (e) {
    const err = AppError.from(e);
    if (V3_UNAVAILABLE.has(err.code)) return { ok: false, code: err.code };
    throw err;
  }
}

/** chatId новой карточки из legacy tasks.task.get (поле chatId, «возвращается по умолчанию»). */
export function legacyChatId(task: Record<string, unknown>): number | undefined {
  const n = Number(task['chatId'] ?? task['CHAT_ID']);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** Краткое описание задачи для плана: название, ответственный, постановщик, статус. */
export function taskPlanBrief(
  task: Record<string, unknown>,
  statusName: (c: unknown) => string | undefined,
): JsonObject {
  return {
    id: Number(task['id']),
    title: asText(task['title']),
    responsibleId: asText(task['responsibleId']),
    createdBy: asText(task['createdBy']),
    status: asText(task['status']),
    statusName: statusName(task['status']) ?? null,
  };
}

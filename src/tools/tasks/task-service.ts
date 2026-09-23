/**
 * Сервис задач: tasks.task.getfields / list / get / add (legacy, scope `task`).
 * Ответы legacy `tasks.task.*` приходят в camelCase (`result.task`, `result.tasks[]`).
 */
import type { JsonObject, JsonValue } from '../../bitrix/legacy-adapter.js';
import { bindingHash, paginateLegacy, type PageResult } from '../../bitrix/pagination.js';
import { AppError } from '../../errors/app-error.js';
import type { ToolContext } from '../types.js';
import { asText } from '../crm/deal-fields.js';
import { parseTaskFieldsResult, type TaskFieldsMeta } from './task-fields.js';

const CACHE_KIND = 'fields';
const CACHE_ID = 'tasks.task';

export type TaskRecord = Record<string, JsonValue>;

export async function getTaskFieldsMeta(ctx: ToolContext, refresh = false): Promise<TaskFieldsMeta> {
  if (!refresh) {
    const cached = ctx.capabilities.getCached<TaskFieldsMeta>(CACHE_KIND, CACHE_ID);
    if (cached) return cached;
  }
  const r = await ctx.bitrix.call(
    'legacy',
    'tasks.task.getfields',
    {},
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  const meta = parseTaskFieldsResult(r.result);
  ctx.capabilities.setCached(CACHE_KIND, CACHE_ID, meta);
  return meta;
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

export interface ListTasksArgs {
  filter: JsonObject;
  order: Record<string, 'asc' | 'desc'>;
  select: string[];
  pageSize: number;
  cursor: string | undefined;
}

export async function listTasks(ctx: ToolContext, args: ListTasksArgs): Promise<PageResult> {
  const binding = {
    principalId: ctx.principal.id,
    portalKey: ctx.bitrix.auth.portalKey,
    tool: 'task_list',
    bindingHash: bindingHash({
      filter: args.filter,
      order: args.order,
      select: args.select,
      pageSize: args.pageSize,
    }),
  };
  return paginateLegacy({
    store: ctx.cursors,
    binding,
    cursor: args.cursor,
    pageSize: args.pageSize,
    fetchPage: async (start) => {
      const r = await ctx.bitrix.call(
        'legacy',
        'tasks.task.list',
        { filter: args.filter, order: args.order, select: args.select, start },
        { requestId: ctx.requestId, signal: ctx.signal },
      );
      const tasks = asObject(r.result)?.['tasks'];
      if (!Array.isArray(tasks)) {
        throw new AppError('BITRIX_UPSTREAM_ERROR', 'tasks.task.list вернул ответ без массива tasks', {
          method: 'tasks.task.list',
          apiVersion: 'legacy',
        });
      }
      return { items: tasks as JsonValue[], next: r.next, total: r.total };
    },
  });
}

export async function getTask(ctx: ToolContext, taskId: number, select?: string[]): Promise<TaskRecord> {
  const params: JsonObject = { taskId };
  if (select) params['select'] = select;
  const r = await ctx.bitrix.call('legacy', 'tasks.task.get', params, {
    requestId: ctx.requestId,
    signal: ctx.signal,
  });
  const task = asObject(asObject(r.result)?.['task']);
  if (!task) {
    throw new AppError('NOT_FOUND', 'Задача не найдена или недоступна', {
      method: 'tasks.task.get',
      apiVersion: 'legacy',
    });
  }
  return task as TaskRecord;
}

export async function createTask(
  ctx: ToolContext,
  fields: JsonObject,
): Promise<{ id: number; task: TaskRecord }> {
  const r = await ctx.bitrix.call(
    'legacy',
    'tasks.task.add',
    { fields },
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  const task = asObject(asObject(r.result)?.['task']);
  const id = Number(task?.['id']);
  if (!task || !Number.isInteger(id) || id <= 0) {
    throw new AppError(
      'OPERATION_OUTCOME_UNKNOWN',
      'tasks.task.add вернул ответ без task.id; исход неизвестен',
      {
        method: 'tasks.task.add',
        apiVersion: 'legacy',
        reason: 'outcome-unknown',
        nextAction: 'Проверьте список задач в Bitrix24 перед повторной попыткой',
      },
    );
  }
  return { id, task: task as TaskRecord };
}

/** Сверка по §15.3: ответственный и срок. Даты сравниваются как моменты времени. */
export function compareTask(
  requested: JsonObject,
  actual: Record<string, unknown>,
): { verified: boolean; warnings: string[] } {
  const warnings: string[] = [];
  const wantResp = asText(requested['RESPONSIBLE_ID']);
  const gotResp = asText(actual['responsibleId']);
  if (wantResp && wantResp !== gotResp)
    warnings.push(`Ответственный: запрошен ${wantResp}, в портале ${gotResp}`);
  const wantDeadline = asText(requested['DEADLINE']);
  const gotDeadline = asText(actual['deadline']);
  if (wantDeadline) {
    const a = Date.parse(wantDeadline);
    const b = Date.parse(gotDeadline);
    if (Number.isNaN(b) || a !== b)
      warnings.push(`Срок: запрошен ${wantDeadline}, в портале ${gotDeadline || '(пусто)'}`);
  }
  const titleOk = asText(actual['title']) === asText(requested['TITLE']);
  if (!titleOk)
    warnings.push(
      `Название: запрошено «${asText(requested['TITLE'])}», в портале «${asText(actual['title'])}»`,
    );
  return { verified: titleOk && wantResp === gotResp, warnings };
}

/** Компактная карточка задачи для ответов: id, title, статус (код и имя), ответственный, срок, группа. */
export function taskBrief(
  task: TaskRecord,
  statusName: (code: unknown) => string | undefined,
): Record<string, unknown> {
  return {
    id: Number(task['id']),
    title: asText(task['title']),
    status: asText(task['status']),
    statusName: statusName(task['status']) ?? null,
    responsibleId: asText(task['responsibleId']),
    createdBy: asText(task['createdBy']),
    deadline: task['deadline'] ?? null,
    groupId: asText(task['groupId']),
  };
}

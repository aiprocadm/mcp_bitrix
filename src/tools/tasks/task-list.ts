import { z } from 'zod';
import type { JsonObject } from '../../bitrix/legacy-adapter.js';
import { ok } from '../../mcp/result.js';
import { pageArgsShape } from '../../schemas/common.js';
import { defineTool, READ_ANNOTATIONS } from '../types.js';
import {
  TASK_STATUS,
  taskStatusName,
  validateTaskFilter,
  validateTaskOrder,
  validateTaskSelect,
} from './task-fields.js';
import { getTaskFieldsMeta, listTasks, taskBrief, type TaskRecord } from './task-service.js';

const scalar = z.union([z.string().max(500), z.number(), z.boolean()]);
const STATUS_NAMES = Object.keys(TASK_STATUS) as [keyof typeof TASK_STATUS, ...(keyof typeof TASK_STATUS)[]];

export const taskListTool = defineTool({
  name: 'task_list',
  module: 'tasks',
  title: 'Список задач',
  description:
    'Страница задач Bitrix24 (tasks.task.list) по ответственному, статусу, группе и произвольному фильтру. ' +
    'Использовать, когда нужен список задач по условию: «мои задачи в работе», «задачи проекта», «просроченные». ' +
    'Статус: new, pending (ждёт выполнения), inProgress, awaitingControl, completed, deferred. ' +
    'Ключи filter — ИМЕНА_ПОЛЕЙ с префиксами Bitrix (например {"<DEADLINE": "2026-10-01T00:00:00+03:00"}). ' +
    'До 50 задач за вызов; продолжение — по cursor.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      responsibleId: z.number().int().positive().optional(),
      createdBy: z.number().int().positive().optional(),
      groupId: z.number().int().positive().optional(),
      status: z.enum(STATUS_NAMES).optional(),
      filter: z
        .record(z.string().max(120), z.union([scalar, z.array(scalar).max(100)]))
        .default({})
        .describe('Дополнительные условия фильтра Bitrix24'),
      order: z.record(z.string().max(100), z.enum(['asc', 'desc', 'ASC', 'DESC'])).default({ ID: 'desc' }),
      select: z
        .array(z.string().max(100))
        .max(100)
        .optional()
        .describe(
          'Поля ответа; по умолчанию ID, TITLE, STATUS, RESPONSIBLE_ID, CREATED_BY, DEADLINE, GROUP_ID, CREATED_DATE',
        ),
      ...pageArgsShape,
    })
    .strict(),
  outputDataSchema: z.object({
    items: z.array(z.record(z.string(), z.unknown())),
    returnedCount: z.number(),
    upstreamTotal: z.number().optional(),
  }),
  handler: async (args, ctx) => {
    const meta = await getTaskFieldsMeta(ctx);
    const base: Record<string, unknown> = {};
    if (args.responsibleId !== undefined) base['RESPONSIBLE_ID'] = args.responsibleId;
    if (args.createdBy !== undefined) base['CREATED_BY'] = args.createdBy;
    if (args.groupId !== undefined) base['GROUP_ID'] = args.groupId;
    if (args.status !== undefined) base['STATUS'] = TASK_STATUS[args.status];
    const filter: JsonObject = validateTaskFilter({ ...base, ...args.filter }, meta);
    const order = validateTaskOrder(args.order, meta);
    const select = validateTaskSelect(
      args.select ?? [
        'ID',
        'TITLE',
        'STATUS',
        'RESPONSIBLE_ID',
        'CREATED_BY',
        'DEADLINE',
        'GROUP_ID',
        'CREATED_DATE',
      ],
      meta,
    );
    const pageSize = Math.min(
      args.pageSize ?? ctx.config.limits.defaultPageSize,
      ctx.config.limits.maxPageSize,
    );
    const page = await listTasks(ctx, { filter, order, select, pageSize, cursor: args.cursor });
    const items = page.items.map((t) => {
      const rec: TaskRecord = t && typeof t === 'object' && !Array.isArray(t) ? t : {};
      return { ...rec, statusName: taskStatusName(rec['status']) ?? null };
    });
    return ok(
      {
        items,
        returnedCount: items.length,
        ...(page.upstreamTotal !== undefined ? { upstreamTotal: page.upstreamTotal } : {}),
      },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: 'tasks.task.list',
        apiVersion: 'legacy',
        page: { nextCursor: page.nextCursor, hasMore: page.hasMore },
        completeness: page.hasMore ? 'partial' : 'complete',
        warnings: page.upstreamCalls === 0 ? ['Страница отдана из буфера предыдущего запроса к порталу'] : [],
      },
    );
  },
});

export { taskBrief };

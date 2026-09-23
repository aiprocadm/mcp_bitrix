import { z } from 'zod';
import { ok } from '../../mcp/result.js';
import { defineTool, READ_ANNOTATIONS } from '../types.js';
import { taskStatusName, validateTaskSelect } from './task-fields.js';
import { getTask, getTaskFieldsMeta, taskBrief } from './task-service.js';

export const taskGetTool = defineTool({
  name: 'task_get',
  module: 'tasks',
  title: 'Задача по ID',
  description:
    'Задача Bitrix24 целиком по ID в рамках доступных полей (tasks.task.get). Использовать, когда известен ID задачи ' +
    'и нужны её поля: название, описание, ответственный, срок, статус, участники, привязки. ' +
    'select ограничивает поля (имена — ВЕРХНИЙ_РЕГИСТР, например TITLE, DEADLINE, RESPONSIBLE_ID). ' +
    'Комментарии и чек-листы — отдельные инструменты полной версии.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      taskId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      select: z
        .array(z.string().max(100))
        .max(100)
        .optional()
        .describe('Поля ответа; по умолчанию все доступные'),
    })
    .strict(),
  outputDataSchema: z.object({
    taskId: z.number(),
    brief: z.record(z.string(), z.unknown()),
    task: z.record(z.string(), z.unknown()),
  }),
  handler: async (args, ctx) => {
    if (args.select) validateTaskSelect(args.select, await getTaskFieldsMeta(ctx));
    const task = await getTask(ctx, args.taskId, args.select);
    return ok(
      { taskId: args.taskId, brief: taskBrief(task, taskStatusName), task },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: 'tasks.task.get',
        apiVersion: 'legacy',
      },
    );
  },
});

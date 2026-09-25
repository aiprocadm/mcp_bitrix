/**
 * task_delete (ТЗ §9.8, §11 п.8, этап 14): единичное удаление задачи через MutationExecutor.
 * Виден только при ENABLE_DESTRUCTIVE_TOOLS=true и роли administrator (register-tools).
 * До плана: задача читается (NOT_FOUND — без плана), собирается impact — подзадачи (tasks.task.list по PARENT_ID),
 * пункты чек-листов (task.checklistitem.getlist), число комментариев/чат новой карточки.
 * stateHash + expectedStateHash (CONFLICT до плана и в precheck); после удаления — повторное чтение
 * должно дать NOT_FOUND (verified=true), иначе verified=false с предупреждением.
 */
import { z } from 'zod';
import { AppError } from '../../errors/app-error.js';
import { ok } from '../../mcp/result.js';
import { requireIdempotencyUnlessDryRun, updateArgsShape } from '../../schemas/common.js';
import {
  asText,
  idSchema,
  isObj,
  mutationOutputShape,
  mutationPrincipal,
  num,
  outcomeUnknown,
} from '../shared.js';
import { defineTool, DESTRUCTIVE_ANNOTATIONS, type ToolContext } from '../types.js';
import { listChecklist } from './task-checklist-service.js';
import { taskStatusName } from './task-fields.js';
import { getTask, type TaskRecord } from './task-service.js';
import { legacyChatId, taskPlanBrief, taskStateHash } from './task-write-service.js';

interface Impact {
  subtasksCount: number | null;
  subtasks: { id: number; title: string }[];
  checklistItemsCount: number | null;
  commentsCount: number | null;
  chatId: number | null;
  warnings: string[];
}

async function collectImpact(ctx: ToolContext, task: TaskRecord, taskId: number): Promise<Impact> {
  const warnings: string[] = [];
  let subtasksCount: number | null = null;
  let subtasks: { id: number; title: string }[] = [];
  try {
    const r = await ctx.bitrix.call(
      'legacy',
      'tasks.task.list',
      { filter: { PARENT_ID: taskId }, select: ['ID', 'TITLE'], order: { ID: 'asc' }, start: 0 },
      { requestId: ctx.requestId, signal: ctx.signal },
    );
    const list = isObj(r.result) ? r.result['tasks'] : undefined;
    if (Array.isArray(list)) {
      subtasks = list
        .filter(isObj)
        .slice(0, 10)
        .map((t) => ({ id: Number(t['id']), title: asText(t['title']) }));
      subtasksCount = r.total ?? list.length;
    } else warnings.push('Подзадачи: tasks.task.list вернул неожиданную форму — число не установлено');
  } catch (e) {
    warnings.push(`Подзадачи не проверены: ${AppError.from(e).code}`);
  }
  let checklistItemsCount: number | null = null;
  try {
    checklistItemsCount = (await listChecklist(ctx, taskId)).length;
  } catch (e) {
    warnings.push(`Чек-листы не проверены: ${AppError.from(e).code}`);
  }
  const comments = num(task['commentsCount']);
  return {
    subtasksCount,
    subtasks,
    checklistItemsCount,
    commentsCount: comments ?? null,
    chatId: legacyChatId(task) ?? null,
    warnings,
  };
}

async function readOrNull(ctx: ToolContext, taskId: number): Promise<TaskRecord | null> {
  try {
    return await getTask(ctx, taskId);
  } catch (e) {
    if (AppError.from(e).code === 'NOT_FOUND') return null;
    throw e;
  }
}

export const taskDeleteTool = defineTool({
  name: 'task_delete',
  module: 'tasks',
  title: 'Удалить задачу',
  description:
    'Удалить одну задачу Bitrix24 (tasks.task.delete). Использовать только когда пользователь явно просит удалить конкретную ' +
    'задачу по ID; для закрытия используйте task_complete. План показывает название, ответственного, статус и последствия: ' +
    'подзадачи, пункты чек-листов, комментарии/чат задачи. Рекомендуется expectedStateHash из task_get. ' +
    'Доступно только роли administrator при ENABLE_DESTRUCTIVE_TOOLS=true. Порядок: без approvalId — APPROVAL_REQUIRED; ' +
    'человек подтверждает; повтор с approvalId удаляет один раз и проверяет, что задача больше не читается.',
  operation: 'delete',
  annotations: DESTRUCTIVE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      taskId: idSchema.describe('ID задачи'),
      ...updateArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({
    taskId: z.number(),
    deleted: z.boolean().optional(),
    stateHash: z.string().optional(),
    ...mutationOutputShape,
  }),
  handler: async (args, ctx) => {
    // Повтор подтверждённой операции после успеха: задачи уже нет — отдаём исполнителю (replay без записи).
    const task = args.approvalId ? await readOrNull(ctx, args.taskId) : await getTask(ctx, args.taskId);
    const currentHash = task ? taskStateHash(task) : null;
    if (!args.approvalId && args.expectedStateHash && args.expectedStateHash !== currentHash) {
      throw new AppError('CONFLICT', 'Задача изменилась после чтения: expectedStateHash не совпадает', {
        field: 'expectedStateHash',
        reason: 'STATE_CHANGED',
        nextAction: 'Прочитайте задачу заново (task_get) и подготовьте новый план',
      });
    }
    if (
      !args.approvalId &&
      task &&
      task['action'] &&
      isObj(task['action']) &&
      task['action']['remove'] === false
    ) {
      throw new AppError(
        'BITRIX_ACCESS_DENIED',
        'Портал не разрешает текущему пользователю удалить эту задачу',
        {
          reason: 'ACTION_NOT_ALLOWED',
          nextAction: 'Проверьте права владельца вебхука (action.remove=false)',
        },
      );
    }
    const impact = task ? await collectImpact(ctx, task, args.taskId) : undefined;
    const risks = [
      'Удаление необратимо через этот сервер: задача и её обсуждение станут недоступны участникам',
    ];
    if (impact?.subtasksCount)
      risks.push(
        `У задачи ${String(impact.subtasksCount)} подзадач(и): проверьте, что с ними будет по правилам портала`,
      );
    if (impact?.checklistItemsCount)
      risks.push(`Будут удалены пункты чек-листов: ${String(impact.checklistItemsCount)}`);
    if (impact?.commentsCount)
      risks.push(`В задаче ${String(impact.commentsCount)} комментариев — они будут недоступны`);
    if (impact?.chatId) risks.push(`У задачи есть чат новой карточки (chat${String(impact.chatId)})`);
    risks.push(...(impact?.warnings ?? []));
    if (!args.expectedStateHash)
      risks.push(
        'expectedStateHash не передан: если задачу изменят до выполнения, удаление всё равно применится',
      );

    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: mutationPrincipal(ctx),
      tool: 'task_delete',
      operationKind: 'delete',
      args,
      expectedStateHash: args.expectedStateHash ?? null,
      summary: {
        action: `УДАЛИТЬ задачу #${String(args.taskId)} «${asText(task?.['title'])}»`,
        target: `task:${String(args.taskId)}`,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: {
          method: 'tasks.task.delete',
          ...(task ? { task: taskPlanBrief(task, taskStatusName) } : {}),
          stateHash: currentHash,
          impact: impact
            ? {
                subtasksCount: impact.subtasksCount,
                subtasks: impact.subtasks,
                checklistItemsCount: impact.checklistItemsCount,
                commentsCount: impact.commentsCount,
                chatId: impact.chatId,
              }
            : null,
        },
        risks,
      },
      validationLevel: 'local',
      precheck: async () => {
        const fresh = await getTask(ctx, args.taskId);
        if (args.expectedStateHash && taskStateHash(fresh) !== args.expectedStateHash) {
          throw new AppError('CONFLICT', 'Задача изменилась после подтверждения; удаление отменено', {
            reason: 'STATE_CHANGED',
            nextAction: 'Прочитайте задачу заново и подготовьте новый план',
          });
        }
      },
      perform: async () => {
        const r = await ctx.bitrix.call(
          'legacy',
          'tasks.task.delete',
          { taskId: args.taskId },
          { requestId: ctx.requestId, signal: ctx.signal },
        );
        if (!isObj(r.result) || r.result['task'] !== true) {
          throw outcomeUnknown(
            'tasks.task.delete',
            'legacy',
            'Проверьте, существует ли задача (task_get), прежде чем повторять',
          );
        }
        return { id: args.taskId, result: { taskId: args.taskId, deleted: true } };
      },
      verify: async () => {
        try {
          await getTask(ctx, args.taskId, ['ID']);
          return { verified: false, warnings: ['После удаления задача всё ещё читается'] };
        } catch (e) {
          const code = AppError.from(e).code;
          if (code === 'NOT_FOUND') return { verified: true, warnings: [] };
          return { verified: false, warnings: [`Проверка удаления не завершена: ${code}`] };
        }
      },
    });

    if (outcome.kind === 'dry-run') {
      return ok(
        {
          taskId: args.taskId,
          dryRun: true,
          plan: outcome.plan,
          validationLevel: outcome.validationLevel,
          ...(currentHash ? { stateHash: currentHash } : {}),
        },
        {
          requestId: ctx.requestId,
          durationMs: Date.now() - ctx.startedAt,
          warnings: ['dryRun: удаление не выполнялось, подтверждение не создано'],
        },
      );
    }
    return ok(
      {
        taskId: args.taskId,
        deleted: outcome.result['deleted'] === true,
        operationId: outcome.operationId,
        verified: outcome.verified,
        replayed: outcome.replayed,
      },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: 'tasks.task.delete',
        apiVersion: 'legacy',
        warnings: outcome.warnings,
        completeness: outcome.verified ? 'complete' : 'unknown',
      },
    );
  },
});

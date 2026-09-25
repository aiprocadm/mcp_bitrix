/**
 * task_update и task_complete (ТЗ §9.8, §8.2, T15, T30): изменение и завершение задачи через MutationExecutor.
 *
 * task_update: patch — только поля из tasks.task.getfields (UPPER_CASE, серверные запрещены, типы проверены),
 * текущая задача читается до плана (tasks.task.get), stateHash/expectedStateHash → CONFLICT,
 * diff «было → станет», precheck перед записью, после — перечитать и сверить каждое поле.
 *
 * task_complete: до плана проверяются права (action.complete), требование результата (REST 3.0
 * tasks.task.get: requireResult/containsResults) → RESULT_REQUIRED без плана; после tasks.task.complete
 * задача перечитывается и возвращается ФАКТИЧЕСКИЙ статус: при контроле постановщика это «Ждёт контроля» (4),
 * а не «Завершена» (5). Ложного «завершена» нет.
 */
import { z } from 'zod';
import type { JsonObject } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { ok } from '../../mcp/result.js';
import { requireIdempotencyUnlessDryRun, updateArgsShape } from '../../schemas/common.js';
import {
  asText,
  idSchema,
  isObj,
  mutationOutputShape,
  mutationPrincipal,
  outcomeUnknown,
  yn,
} from '../shared.js';
import { defineTool, UPDATE_ANNOTATIONS, type ToolContext } from '../types.js';
import { taskStatusName, validateTaskFieldsForWrite } from './task-fields.js';
import { getTask, getTaskFieldsMeta, type TaskRecord } from './task-service.js';
import {
  actionAllowed,
  camelKey,
  getTaskV3Flags,
  readTaskForWrite,
  sameTaskValue,
  taskPlanBrief,
  taskStateHash,
  type TaskV3Flags,
} from './task-write-service.js';

const conflictBeforePlan = () =>
  new AppError('CONFLICT', 'Задача изменилась после чтения: expectedStateHash не совпадает', {
    field: 'expectedStateHash',
    reason: 'STATE_CHANGED',
    nextAction: 'Прочитайте задачу заново (task_get) и повторите с новым stateHash',
  });
const conflictAfterApproval = () =>
  new AppError('CONFLICT', 'Задача изменилась после подтверждения; изменение отменено', {
    reason: 'STATE_CHANGED',
    nextAction: 'Прочитайте задачу заново и подготовьте новый план',
  });

// ---------- task_update ----------

const patchValue = z.union([
  z.string().max(20_000),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string().max(2000), z.number()])).max(100),
]);

function updateRisks(fields: JsonObject, current: TaskRecord, hasExpected: boolean): string[] {
  const risks = ['Участники задачи получат уведомления об изменении; могут сработать роботы/автоматизация'];
  const changed = (k: string) => k in fields && !sameTaskValue(fields[k], current[camelKey(k)]);
  if (changed('RESPONSIBLE_ID'))
    risks.push('Смена ответственного: новый исполнитель получит задачу и уведомление, прежний — потеряет её');
  if (changed('DEADLINE')) risks.push('Изменится крайний срок: изменятся счётчики просрочки и напоминания');
  if (changed('AUDITORS') || changed('ACCOMPLICES'))
    risks.push('Список наблюдателей/соисполнителей заменяется целиком переданным массивом');
  if (changed('GROUP_ID')) risks.push('Перенос в другую группу/проект меняет круг видящих задачу');
  if (changed('PARENT_ID')) risks.push('Смена родительской задачи меняет иерархию и расчёт сроков подзадач');
  if (!hasExpected)
    risks.push(
      'expectedStateHash не передан: если задачу изменят до выполнения, изменение всё равно применится',
    );
  return risks;
}

export const taskUpdateTool = defineTool({
  name: 'task_update',
  module: 'tasks',
  title: 'Изменить задачу',
  description:
    'Изменить поля существующей задачи Bitrix24 (tasks.task.update). Использовать, когда пользователь явно просит поменять ' +
    'название, описание, срок, ответственного, участников или пользовательские поля конкретной задачи. ' +
    'patch — только изменяемые поля в ВЕРХНЕМ_РЕГИСТРЕ по схеме портала (TITLE, DESCRIPTION, DEADLINE с часовым поясом, ' +
    'RESPONSIBLE_ID, AUDITORS, ACCOMPLICES, UF_*); статус меняется не здесь, а через task_complete. ' +
    'Рекомендуется expectedStateHash из task_get: при чужом изменении будет CONFLICT. Порядок: без approvalId — ' +
    'APPROVAL_REQUIRED с планом (diff «было → станет»); человек подтверждает; повтор с approvalId применяет изменение один раз.',
  operation: 'update',
  annotations: UPDATE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      taskId: idSchema.describe('ID задачи'),
      patch: z
        .record(z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/, 'имя поля — ВЕРХНИЙ_РЕГИСТР'), patchValue)
        .refine((p) => Object.keys(p).length >= 1 && Object.keys(p).length <= 30, {
          message: 'от 1 до 30 полей',
        })
        .describe('Изменяемые поля: {"DEADLINE":"2026-10-01T18:00:00+03:00","RESPONSIBLE_ID":12}'),
      ...updateArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({
    taskId: z.number(),
    changedFields: z.array(z.string()).optional(),
    stateHash: z.string().optional(),
    ...mutationOutputShape,
  }),
  handler: async (args, ctx) => {
    if ('STATUS' in args.patch) {
      throw new AppError('VALIDATION_ERROR', 'STATUS: статус задачи этим инструментом не меняется', {
        field: 'patch.STATUS',
        reason: 'USE_DEDICATED_TOOL',
        nextAction:
          'Для завершения используйте task_complete (он проверяет требование результата и контроль)',
      });
    }
    const meta = await getTaskFieldsMeta(ctx);
    const fields = validateTaskFieldsForWrite(args.patch, meta, 'update');
    const keys = Object.keys(fields);
    const current = await readTaskForWrite(
      ctx,
      args.taskId,
      keys.filter((k) => k.startsWith('UF_')),
    );
    const currentHash = taskStateHash(current);
    // С approvalId сверку делает исполнитель и precheck; ранний отказ сорвал бы replay выполненной операции.
    if (!args.approvalId) {
      if (args.expectedStateHash && args.expectedStateHash !== currentHash) throw conflictBeforePlan();
      if (actionAllowed(current, 'edit') === false) {
        throw new AppError(
          'BITRIX_ACCESS_DENIED',
          'Портал не разрешает текущему пользователю изменять эту задачу',
          {
            reason: 'ACTION_NOT_ALLOWED',
            nextAction: 'Проверьте права владельца вебхука на задачу (action.edit=false)',
          },
        );
      }
      if (keys.every((k) => sameTaskValue(fields[k], current[camelKey(k)]))) {
        throw new AppError(
          'VALIDATION_ERROR',
          'Все переданные значения совпадают с текущими; изменять нечего',
          {
            field: 'patch',
            reason: 'NO_CHANGES',
          },
        );
      }
    }
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const k of keys) changes[k] = { from: current[camelKey(k)] ?? null, to: fields[k] ?? null };
    const title = asText(current['title']);

    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: mutationPrincipal(ctx),
      tool: 'task_update',
      operationKind: 'update',
      args: { ...args, fields },
      expectedStateHash: args.expectedStateHash ?? null,
      summary: {
        action: `Изменить задачу #${String(args.taskId)} «${title}»: ${keys.join(', ')}`,
        target: `task:${String(args.taskId)}`,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: {
          method: 'tasks.task.update',
          task: taskPlanBrief(current, taskStatusName),
          stateHash: currentHash,
          timezone: ctx.config.bitrix.timezone,
          changes,
        },
        risks: updateRisks(fields, current, Boolean(args.expectedStateHash)),
      },
      validationLevel: 'local+metadata',
      precheck: async () => {
        if (!args.expectedStateHash) return;
        const fresh = await getTask(ctx, args.taskId);
        if (taskStateHash(fresh) !== args.expectedStateHash) throw conflictAfterApproval();
      },
      perform: async () => {
        const r = await ctx.bitrix.call(
          'legacy',
          'tasks.task.update',
          { taskId: args.taskId, fields },
          { requestId: ctx.requestId, signal: ctx.signal },
        );
        if (!isObj(r.result) || !isObj(r.result['task'])) {
          throw outcomeUnknown(
            'tasks.task.update',
            'legacy',
            'Проверьте задачу в Bitrix24 (task_get) перед повторной попыткой',
          );
        }
        return { id: args.taskId, result: { taskId: args.taskId, changedFields: keys } };
      },
      verify: async () => {
        const after = await getTask(ctx, args.taskId, ['ID', ...keys]);
        const warnings: string[] = [];
        for (const k of keys) {
          const got = after[camelKey(k)];
          if (!sameTaskValue(fields[k], got))
            warnings.push(
              `${k}: запрошено ${JSON.stringify(fields[k])}, в портале ${JSON.stringify(got ?? null)}`,
            );
        }
        return { verified: warnings.length === 0, warnings };
      },
    });

    if (outcome.kind === 'dry-run') {
      return ok(
        {
          taskId: args.taskId,
          dryRun: true,
          plan: outcome.plan,
          validationLevel: outcome.validationLevel,
          stateHash: currentHash,
        },
        {
          requestId: ctx.requestId,
          durationMs: Date.now() - ctx.startedAt,
          warnings: ['dryRun: запись не выполнялась, подтверждение не создано'],
        },
      );
    }
    let stateHash: string | undefined;
    if (!outcome.replayed) {
      try {
        stateHash = taskStateHash(await getTask(ctx, args.taskId));
      } catch {
        stateHash = undefined;
      }
    }
    return ok(
      {
        taskId: args.taskId,
        changedFields: keys,
        operationId: outcome.operationId,
        verified: outcome.verified,
        replayed: outcome.replayed,
        ...(stateHash ? { stateHash } : {}),
      },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: 'tasks.task.update',
        apiVersion: 'legacy',
        warnings: outcome.warnings,
        completeness: outcome.verified ? 'complete' : 'unknown',
      },
    );
  },
});

// ---------- task_complete ----------

type FlagsResult = Awaited<ReturnType<typeof getTaskV3Flags>>;

/** Отказы до плана и в precheck: уже завершена, нет права завершить, требуется результат, а его нет (T30). */
function assertCompletable(task: TaskRecord, flags: FlagsResult): void {
  const status = asText(task['status']);
  if (status === '5') {
    throw new AppError('VALIDATION_ERROR', 'Задача уже завершена', {
      reason: 'ALREADY_COMPLETED',
      status: 'completed',
    });
  }
  if (actionAllowed(task, 'complete') === false) {
    throw new AppError(
      'BITRIX_ACCESS_DENIED',
      'Портал не разрешает текущему пользователю завершить эту задачу',
      {
        reason: 'ACTION_NOT_ALLOWED',
        status: taskStatusName(status) ?? status,
        nextAction:
          status === '4'
            ? 'Задача ждёт контроля постановщика: принять работу может постановщик в Bitrix24'
            : 'Проверьте роль владельца вебхука в задаче (action.complete=false)',
      },
    );
  }
  if (flags.ok && flags.flags.requireResult === true && flags.flags.containsResults === false) {
    throw new AppError(
      'VALIDATION_ERROR',
      'Задача требует результат: без записи результата её нельзя завершить',
      {
        reason: 'RESULT_REQUIRED',
        nextAction:
          'Попросите исполнителя зафиксировать результат в задаче (сообщение/комментарий, отмеченный как результат), затем повторите',
      },
    );
  }
}

function completeRisks(task: TaskRecord, flags: FlagsResult, hasExpected: boolean): string[] {
  const risks = ['Постановщик и участники получат уведомление о завершении; могут сработать роботы'];
  if (controlEnabled(task, flags))
    risks.push(
      'Включён контроль постановщика: если завершает не постановщик, задача перейдёт в «Ждёт контроля», а не в «Завершена»',
    );
  if (!flags.ok)
    risks.push(
      `Требование результата не проверено: REST 3.0 tasks.task.get недоступен (${flags.code}); если результат обязателен, портал отклонит завершение`,
    );
  else if (flags.flags.requireResult === true && flags.flags.containsResults === undefined)
    risks.push(
      'Задача требует результат; наличие результата портал не сообщил — завершение может быть отклонено',
    );
  if (!hasExpected)
    risks.push(
      'expectedStateHash не передан: если задачу изменят до выполнения, завершение всё равно применится',
    );
  return risks;
}

const controlEnabled = (task: TaskRecord, flags: FlagsResult): boolean =>
  yn(task['taskControl']) || (flags.ok && flags.flags.needsControl === true);

async function readForComplete(
  ctx: ToolContext,
  taskId: number,
): Promise<{ task: TaskRecord; flags: FlagsResult }> {
  const task = await getTask(ctx, taskId);
  const flags = await getTaskV3Flags(ctx, taskId);
  return { task, flags };
}

function statusView(status: string) {
  return {
    status,
    statusName: taskStatusName(status) ?? null,
    completed: status === '5',
    awaitingControl: status === '4',
  };
}

export const taskCompleteTool = defineTool({
  name: 'task_complete',
  module: 'tasks',
  title: 'Завершить задачу',
  description:
    'Завершить задачу Bitrix24 (tasks.task.complete) и вернуть её ФАКТИЧЕСКИЙ статус после перечитывания. ' +
    'Использовать, когда пользователь явно просит закрыть/завершить конкретную задачу. До плана проверяются права ' +
    'и требование результата: если задача требует результат, а его нет — RESULT_REQUIRED, ничего не меняется. ' +
    'При контроле постановщика задача может перейти в «Ждёт контроля» (completed=false, awaitingControl=true) — это не «завершена». ' +
    'Порядок: без approvalId — APPROVAL_REQUIRED с планом; человек подтверждает; повтор с approvalId выполняет один раз.',
  operation: 'update',
  annotations: UPDATE_ANNOTATIONS,
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
    status: z.string().optional(),
    statusName: z.string().nullable().optional(),
    completed: z.boolean().optional(),
    awaitingControl: z.boolean().optional(),
    stateHash: z.string().optional(),
    ...mutationOutputShape,
  }),
  handler: async (args, ctx) => {
    const { task, flags } = await readForComplete(ctx, args.taskId);
    const currentHash = taskStateHash(task);
    if (!args.approvalId) {
      if (args.expectedStateHash && args.expectedStateHash !== currentHash) throw conflictBeforePlan();
      assertCompletable(task, flags);
    }
    const control = controlEnabled(task, flags);
    const v3: TaskV3Flags | undefined = flags.ok ? flags.flags : undefined;

    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: mutationPrincipal(ctx),
      tool: 'task_complete',
      operationKind: 'update',
      args,
      expectedStateHash: args.expectedStateHash ?? null,
      summary: {
        action: `Завершить задачу #${String(args.taskId)} «${asText(task['title'])}»`,
        target: `task:${String(args.taskId)}`,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: {
          method: 'tasks.task.complete',
          task: taskPlanBrief(task, taskStatusName),
          stateHash: currentHash,
          taskControl: control,
          requireResult: v3?.requireResult ?? null,
          containsResults: v3?.containsResults ?? null,
          expectedStatus: control
            ? 'completed (5) или awaitingControl (4) — зависит от роли'
            : 'completed (5)',
        },
        risks: completeRisks(task, flags, Boolean(args.expectedStateHash)),
      },
      validationLevel: flags.ok ? 'local+metadata' : 'local',
      // Между подтверждением и записью: заново проверить состояние и требование результата (T15, T30).
      precheck: async () => {
        const fresh = await readForComplete(ctx, args.taskId);
        if (args.expectedStateHash && taskStateHash(fresh.task) !== args.expectedStateHash)
          throw conflictAfterApproval();
        assertCompletable(fresh.task, fresh.flags);
      },
      perform: async () => {
        const r = await ctx.bitrix.call(
          'legacy',
          'tasks.task.complete',
          { taskId: args.taskId },
          { requestId: ctx.requestId, signal: ctx.signal },
        );
        const t = isObj(r.result) ? r.result['task'] : undefined;
        if (!isObj(t)) {
          throw outcomeUnknown(
            'tasks.task.complete',
            'legacy',
            'Проверьте статус задачи в Bitrix24 (task_get) перед повторной попыткой',
          );
        }
        return { id: args.taskId, result: { taskId: args.taskId, status: asText(t['status']) } };
      },
      verify: async () => {
        const after = await getTask(ctx, args.taskId, ['ID', 'STATUS']);
        const s = asText(after['status']);
        if (s === '5') return { verified: true, warnings: [] };
        if (s === '4')
          return {
            verified: true,
            warnings: [
              'Задача НЕ завершена окончательно: статус «Ждёт контроля» — работу должен принять постановщик',
            ],
          };
        return {
          verified: false,
          warnings: [
            `После завершения портал показывает статус ${s} (${taskStatusName(s) ?? 'неизвестен'}), а не «Завершена»`,
          ],
        };
      },
    });

    if (outcome.kind === 'dry-run') {
      return ok(
        {
          taskId: args.taskId,
          dryRun: true,
          plan: outcome.plan,
          validationLevel: outcome.validationLevel,
          stateHash: currentHash,
        },
        {
          requestId: ctx.requestId,
          durationMs: Date.now() - ctx.startedAt,
          warnings: ['dryRun: запись не выполнялась, подтверждение не создано'],
        },
      );
    }
    // Фактический статус — из свежего чтения; при replay или сбое чтения — из ответа tasks.task.complete.
    let status = asText(outcome.result['status']);
    let stateHash: string | undefined;
    if (!outcome.replayed) {
      try {
        const after = await getTask(ctx, args.taskId);
        status = asText(after['status']);
        stateHash = taskStateHash(after);
      } catch {
        stateHash = undefined;
      }
    }
    const view = statusView(status);
    const warnings = [...outcome.warnings];
    if (!view.completed && !warnings.some((w) => w.includes('НЕ завершена')))
      warnings.push(`Задача НЕ завершена: фактический статус ${status} (${view.statusName ?? 'неизвестен'})`);
    return ok(
      {
        taskId: args.taskId,
        ...view,
        operationId: outcome.operationId,
        verified: outcome.verified,
        replayed: outcome.replayed,
        ...(stateHash ? { stateHash } : {}),
      },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: 'tasks.task.complete',
        apiVersion: 'legacy',
        warnings,
        completeness: outcome.verified ? 'complete' : 'unknown',
      },
    );
  },
});

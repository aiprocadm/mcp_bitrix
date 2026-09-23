/**
 * task_create (ТЗ §9.8, §10.1, §15.2, §15.3): поставить задачу через MutationExecutor.
 * План фиксирует заголовок, ответственного, участников, группу, срок с зоной; после записи —
 * tasks.task.get по ID и сверка ответственного/срока.
 */
import { z } from 'zod';
import type { JsonObject } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { ok } from '../../mcp/result.js';
import { requireIdempotencyUnlessDryRun, writeArgsShape } from '../../schemas/common.js';
import { CREATE_ANNOTATIONS, defineTool } from '../types.js';
import {
  assertDateTimeWithZone,
  CRM_BINDING_RE,
  taskStatusName,
  validateTaskFieldsForWrite,
} from './task-fields.js';
import { compareTask, createTask, getTask, getTaskFieldsMeta, taskBrief } from './task-service.js';

const idList = z.array(z.number().int().positive()).max(50);

export const taskCreateTool = defineTool({
  name: 'task_create',
  module: 'tasks',
  title: 'Поставить задачу',
  description:
    'Поставить задачу в Bitrix24 (tasks.task.add) на известного сотрудника. Использовать, когда пользователь явно просит ' +
    'создать задачу и известен ID ответственного (не имя). Срок — ISO 8601 с часовым поясом. ' +
    'Порядок: вызов без approvalId возвращает APPROVAL_REQUIRED с operationId и планом — задача ещё не создана; ' +
    'человек подтверждает план в терминале; повторный вызов с теми же параметрами и approvalId создаёт задачу ровно один раз. ' +
    'dryRun=true только показывает план. Участники получат уведомления.',
  operation: 'create',
  annotations: CREATE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      title: z.string().min(1).max(255),
      responsibleId: z.number().int().positive().describe('ID сотрудника-исполнителя'),
      description: z.string().max(20_000).optional(),
      deadline: z.string().max(40).optional().describe('Срок: 2026-10-01T18:00:00+03:00 (зона обязательна)'),
      groupId: z.number().int().positive().optional().describe('ID группы/проекта'),
      auditorIds: idList.optional().describe('Наблюдатели'),
      accompliceIds: idList.optional().describe('Соисполнители'),
      crmBindings: z
        .array(z.string().regex(CRM_BINDING_RE, 'формат D_<id> (сделка), L_<id>, C_<id>, CO_<id>'))
        .max(20)
        .optional()
        .describe('Привязки к CRM: D_123 — сделка 123, L_ — лид, C_ — контакт, CO_ — компания'),
      customFields: z
        .record(
          z.string().regex(/^UF_[A-Z0-9_]{1,96}$/),
          z.union([
            z.string().max(20_000),
            z.number(),
            z.boolean(),
            z.array(z.union([z.string().max(2000), z.number()])).max(100),
          ]),
        )
        .optional()
        .describe('Пользовательские поля задачи UF_* по схеме портала'),
      ...writeArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({
    dryRun: z.boolean().optional(),
    plan: z.record(z.string(), z.unknown()).optional(),
    validationLevel: z.string().optional(),
    id: z.number().nullable().optional(),
    operationId: z.string().optional(),
    verified: z.boolean().optional(),
    replayed: z.boolean().optional(),
    task: z.record(z.string(), z.unknown()).optional(),
  }),
  handler: async (args, ctx) => {
    const meta = await getTaskFieldsMeta(ctx);
    const raw: Record<string, unknown> = {
      TITLE: args.title,
      RESPONSIBLE_ID: args.responsibleId,
      ...(args.description !== undefined ? { DESCRIPTION: args.description } : {}),
      ...(args.deadline !== undefined ? { DEADLINE: assertDateTimeWithZone('deadline', args.deadline) } : {}),
      ...(args.groupId !== undefined ? { GROUP_ID: args.groupId } : {}),
      ...(args.auditorIds?.length ? { AUDITORS: args.auditorIds } : {}),
      ...(args.accompliceIds?.length ? { ACCOMPLICES: args.accompliceIds } : {}),
      ...(args.crmBindings?.length ? { UF_CRM_TASK: args.crmBindings } : {}),
      ...(args.customFields ?? {}),
    };
    if (args.deadline !== undefined && Date.parse(args.deadline) < Date.now() - 60_000) {
      throw new AppError('VALIDATION_ERROR', 'deadline: срок в прошлом', { field: 'deadline' });
    }
    const fields: JsonObject = validateTaskFieldsForWrite(raw, meta);
    const risks = ['Ответственный, наблюдатели и соисполнители получат уведомления о новой задаче'];
    if (args.groupId !== undefined) risks.push('Задача станет видна участникам группы/проекта');
    if (args.crmBindings?.length) risks.push('Задача появится в карточках связанных элементов CRM');
    if (args.deadline === undefined) risks.push('Срок не задан: задача без дедлайна');

    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: {
        id: ctx.principal.id,
        portalKey: ctx.bitrix.auth.portalKey,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
      },
      tool: 'task_create',
      operationKind: 'create',
      args: { ...args, fields },
      summary: {
        action: `Поставить задачу «${args.title}» на сотрудника #${args.responsibleId}`,
        target: 'task',
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: { method: 'tasks.task.add', timezone: ctx.config.bitrix.timezone, fields },
        risks,
      },
      validationLevel: 'local+metadata',
      perform: async () => {
        const created = await createTask(ctx, fields);
        return { id: created.id, result: { id: created.id } };
      },
      verify: async (performed) => {
        const task = await getTask(ctx, Number(performed.id), [
          'ID',
          'TITLE',
          'RESPONSIBLE_ID',
          'DEADLINE',
          'GROUP_ID',
          'STATUS',
        ]);
        return compareTask(fields, task);
      },
    });

    if (outcome.kind === 'dry-run') {
      return ok(
        { dryRun: true, plan: outcome.plan, validationLevel: outcome.validationLevel },
        {
          requestId: ctx.requestId,
          durationMs: Date.now() - ctx.startedAt,
          warnings: ['dryRun: запись не выполнялась, подтверждение не создано'],
        },
      );
    }
    const id = typeof outcome.id === 'number' ? outcome.id : null;
    let task: Record<string, unknown> | undefined;
    if (id !== null && !outcome.replayed) {
      try {
        task = taskBrief(
          await getTask(ctx, id, [
            'ID',
            'TITLE',
            'STATUS',
            'RESPONSIBLE_ID',
            'CREATED_BY',
            'DEADLINE',
            'GROUP_ID',
          ]),
          taskStatusName,
        );
      } catch {
        task = undefined;
      }
    }
    return ok(
      {
        id,
        operationId: outcome.operationId,
        verified: outcome.verified,
        replayed: outcome.replayed,
        ...(task ? { task } : {}),
      },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: 'tasks.task.add',
        apiVersion: 'legacy',
        warnings: outcome.warnings,
        completeness: outcome.verified ? 'complete' : 'unknown',
      },
    );
  },
});

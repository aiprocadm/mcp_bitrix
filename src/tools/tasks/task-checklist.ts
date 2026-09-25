/**
 * Чек-листы задачи (ТЗ §9.8): task_checklist_get / add / update / set_complete / delete.
 * Старый API task.checklistitem.* с позиционными параметрами — тела строятся только через checklistParams.
 * Запись — через MutationExecutor: план → подтверждение человеком → одна запись → сверка по getlist.
 * Принадлежность пункта задаче проверяется сервером по getlist (complete/renew/update сами её не проверяют).
 */
import { z } from 'zod';
import type { JsonObject } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { ok } from '../../mcp/result.js';
import {
  pageArgsShape,
  requireIdempotencyUnlessDryRun,
  updateArgsShape,
  writeArgsShape,
} from '../../schemas/common.js';
import {
  asText,
  idOf,
  idSchema,
  mutationOutputShape,
  mutationPrincipal,
  outcomeUnknown,
  pageMeta,
  pageSizeOf,
  statefulPage,
} from '../shared.js';
import {
  CREATE_ANNOTATIONS,
  defineTool,
  DESTRUCTIVE_ANNOTATIONS,
  READ_ANNOTATIONS,
  UPDATE_ANNOTATIONS,
  type ToolContext,
} from '../types.js';
import {
  checklistItemHash,
  checklistParams,
  descendants,
  findItem,
  flattenTree,
  listChecklist,
  type ChecklistItem,
  type TreeItem,
} from './task-checklist-service.js';
import { getTask } from './task-service.js';

const itemIdSchema = idSchema.describe('ID пункта чек-листа');
const titleSchema = z.string().trim().min(1).max(2000);

async function taskTitle(ctx: ToolContext, taskId: number): Promise<string> {
  return asText((await getTask(ctx, taskId, ['ID', 'TITLE']))['title']);
}

const itemBrief = (i: ChecklistItem) => ({
  id: i.id,
  parentId: i.parentId,
  title: i.title,
  sortIndex: i.sortIndex,
  isComplete: i.isComplete,
});

const conflict = (afterApproval: boolean) =>
  new AppError(
    'CONFLICT',
    afterApproval
      ? 'Пункт чек-листа изменился после подтверждения; изменение отменено'
      : 'Пункт чек-листа изменился после чтения: expectedStateHash не совпадает',
    {
      ...(afterApproval ? {} : { field: 'expectedStateHash' }),
      reason: 'STATE_CHANGED',
      nextAction: 'Прочитайте чек-лист заново (task_checklist_get) и подготовьте новый план',
    },
  );

/** Результат boolean-методов (complete/renew/delete): true — выполнено, false — документированный отказ. */
function assertTrue(method: string, result: unknown): void {
  if (result === true) return;
  if (result === false) {
    throw new AppError(
      'BITRIX_UPSTREAM_ERROR',
      `${method} вернул false: пункт не найден или операция не выполнена`,
      {
        method,
        apiVersion: 'legacy',
        reason: 'RESULT_FALSE',
        nextAction: 'Прочитайте чек-лист заново (task_checklist_get)',
      },
    );
  }
  throw outcomeUnknown(method, 'legacy', 'Прочитайте чек-лист (task_checklist_get) перед повторной попыткой');
}

// ---------- task_checklist_get ----------

const itemOutput = z.object({
  id: z.number(),
  parentId: z.number(),
  depth: z.number(),
  title: z.string(),
  sortIndex: z.number(),
  isComplete: z.boolean(),
  isImportant: z.boolean(),
  childrenCount: z.number(),
  toggledBy: z.string().nullable(),
  toggledDate: z.string().nullable(),
  members: z.array(z.object({ id: z.string(), type: z.string() })),
  attachmentsCount: z.number(),
  stateHash: z.string(),
});

const treeOutput = (i: TreeItem): z.infer<typeof itemOutput> => ({
  id: i.id,
  parentId: i.parentId,
  depth: i.depth,
  title: i.title,
  sortIndex: i.sortIndex,
  isComplete: i.isComplete,
  isImportant: i.isImportant,
  childrenCount: i.childrenCount,
  toggledBy: i.toggledBy,
  toggledDate: i.toggledDate,
  members: i.members,
  attachmentsCount: i.attachmentsCount,
  stateHash: checklistItemHash(i),
});

export const taskChecklistGetTool = defineTool({
  name: 'task_checklist_get',
  module: 'tasks',
  title: 'Чек-листы задачи',
  description:
    'Пункты чек-листов задачи с иерархией и статусом (task.checklistitem.getlist). Использовать, когда нужно увидеть, ' +
    'что уже сделано по задаче, или получить itemId/stateHash перед изменением пункта. Корневой пункт (parentId=0, depth=0) — ' +
    'название чек-листа; вложенные идут сразу за родителем в порядке sortIndex. Страницы — по cursor.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      taskId: idSchema.describe('ID задачи'),
      ...pageArgsShape,
    })
    .strict(),
  outputDataSchema: z.object({
    taskId: z.number(),
    items: z.array(itemOutput),
    returnedCount: z.number(),
    summary: z.object({ total: z.number(), completed: z.number(), checklists: z.number() }),
  }),
  handler: async (args, ctx) => {
    if (!args.cursor) await getTask(ctx, args.taskId, ['ID']); // NOT_FOUND для несуществующей задачи
    const pageSize = pageSizeOf(ctx, args.pageSize);
    const summary = { total: 0, completed: 0, checklists: 0 };
    const warnings: string[] = [];
    const page = await statefulPage<{ offset: number }>(ctx, {
      tool: 'task_checklist_get',
      bindingParts: { taskId: args.taskId, pageSize },
      cursor: args.cursor,
      initial: { offset: 0 },
      fetch: async (s) => {
        const all = await listChecklist(ctx, args.taskId);
        const tree = flattenTree(all);
        summary.total = all.length;
        summary.completed = all.filter((i) => i.isComplete).length;
        summary.checklists = tree.items.filter((i) => i.depth === 0).length;
        if (tree.orphans)
          warnings.push(`Пунктов без найденного родителя: ${String(tree.orphans)} (показаны как корневые)`);
        const slice = tree.items.slice(s.offset, s.offset + pageSize);
        const nextOffset = s.offset + pageSize;
        return {
          items: slice.map(treeOutput),
          next: nextOffset < tree.items.length ? { offset: nextOffset } : undefined,
        };
      },
    });
    return ok(
      { taskId: args.taskId, items: page.items, returnedCount: page.items.length, summary },
      pageMeta(ctx, 'task.checklistitem.getlist', page, 'legacy', warnings),
    );
  },
});

// ---------- task_checklist_add ----------

export const taskChecklistAddTool = defineTool({
  name: 'task_checklist_add',
  module: 'tasks',
  title: 'Добавить пункт чек-листа',
  description:
    'Добавить пункт в чек-лист задачи (task.checklistitem.add). Использовать, когда пользователь просит добавить шаг/пункт ' +
    'в задачу. parentId — ID существующего пункта-родителя этой задачи (из task_checklist_get); parentId=0 создаёт новый ' +
    'чек-лист с названием title; без parentId пункт попадает в существующий корневой чек-лист (если его нет — будет создан). ' +
    'Порядок: без approvalId — APPROVAL_REQUIRED; человек подтверждает; повтор с approvalId добавляет пункт один раз.',
  operation: 'create',
  annotations: CREATE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      taskId: idSchema.describe('ID задачи'),
      title: titleSchema.describe('Текст пункта (для parentId=0 — название чек-листа)'),
      parentId: z
        .number()
        .int()
        .min(0)
        .max(Number.MAX_SAFE_INTEGER)
        .optional()
        .describe('ID родительского пункта; 0 — новый чек-лист'),
      ...writeArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({
    taskId: z.number(),
    itemId: z.number().nullable().optional(),
    ...mutationOutputShape,
  }),
  handler: async (args, ctx) => {
    const title = await taskTitle(ctx, args.taskId);
    const items = await listChecklist(ctx, args.taskId);
    let parent: ChecklistItem | undefined;
    if (args.parentId !== undefined && args.parentId > 0) {
      parent = items.find((i) => i.id === args.parentId && (!i.taskId || i.taskId === args.taskId));
      // Документация: при несуществующем PARENT_ID портал молча создаст новый чек-лист — не допускаем.
      if (!parent) {
        throw new AppError('VALIDATION_ERROR', 'parentId: такого пункта нет в чек-листах этой задачи', {
          field: 'parentId',
          reason: 'PARENT_NOT_FOUND',
          nextAction: 'Возьмите ID родителя из task_checklist_get; parentId=0 создаёт новый чек-лист',
        });
      }
    }
    const fields: JsonObject = { TITLE: args.title };
    if (args.parentId !== undefined) fields['PARENT_ID'] = args.parentId;
    const roots = items.filter((i) => i.parentId === 0);
    const placement =
      args.parentId === 0
        ? 'новый чек-лист'
        : parent
          ? `внутрь пункта #${String(parent.id)} «${parent.title}»`
          : roots.length
            ? `в корневой чек-лист «${roots[0]?.title ?? ''}»`
            : 'в новый чек-лист (в задаче чек-листов нет)';

    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: mutationPrincipal(ctx),
      tool: 'task_checklist_add',
      operationKind: 'create',
      args,
      summary: {
        action: `Добавить пункт «${args.title}» в задачу #${String(args.taskId)} «${title}»: ${placement}`,
        target: `task:${String(args.taskId)}:checklist`,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: {
          method: 'task.checklistitem.add',
          taskId: args.taskId,
          fields,
          ...(parent ? { parent: itemBrief(parent) } : {}),
          existingItems: items.length,
        },
        risks: ['Участники задачи увидят новый пункт; изменение попадёт в историю задачи'],
      },
      validationLevel: 'local',
      perform: async () => {
        const r = await ctx.bitrix.call(
          'legacy',
          'task.checklistitem.add',
          checklistParams.add(args.taskId, fields),
          { requestId: ctx.requestId, signal: ctx.signal },
        );
        const id = idOf(r.result);
        if (id === undefined)
          throw outcomeUnknown(
            'task.checklistitem.add',
            'legacy',
            'Прочитайте чек-лист (task_checklist_get) перед повтором',
          );
        return { id, result: { itemId: id } };
      },
      verify: async (performed) => {
        const after = await listChecklist(ctx, args.taskId);
        const item = after.find((i) => i.id === Number(performed.id));
        if (!item) return { verified: false, warnings: ['Пункт добавлен, но не найден в чек-листе задачи'] };
        const warnings: string[] = [];
        if (item.title !== args.title) warnings.push('Текст пункта в портале отличается от отправленного');
        if (parent && item.parentId !== parent.id)
          warnings.push(`Пункт оказался под родителем ${String(item.parentId)}`);
        return { verified: warnings.length === 0, warnings };
      },
    });
    if (outcome.kind === 'dry-run') {
      return ok(
        { taskId: args.taskId, dryRun: true, plan: outcome.plan, validationLevel: outcome.validationLevel },
        {
          requestId: ctx.requestId,
          durationMs: Date.now() - ctx.startedAt,
          warnings: ['dryRun: запись не выполнялась, подтверждение не создано'],
        },
      );
    }
    return ok(
      {
        taskId: args.taskId,
        itemId: typeof outcome.id === 'number' ? outcome.id : null,
        operationId: outcome.operationId,
        verified: outcome.verified,
        replayed: outcome.replayed,
      },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: 'task.checklistitem.add',
        apiVersion: 'legacy',
        warnings: outcome.warnings,
        completeness: outcome.verified ? 'complete' : 'unknown',
      },
    );
  },
});

// ---------- общая часть update / set_complete / delete ----------

async function readItem(
  ctx: ToolContext,
  taskId: number,
  itemId: number,
): Promise<{ items: ChecklistItem[]; item: ChecklistItem }> {
  const items = await listChecklist(ctx, taskId);
  return { items, item: findItem(items, taskId, itemId) };
}

function executedResponse(
  ctx: ToolContext,
  outcome: Exclude<Awaited<ReturnType<ToolContext['mutations']['execute']>>, { kind: 'dry-run' }>,
  method: string,
  data: Record<string, unknown>,
) {
  return ok(
    { ...data, operationId: outcome.operationId, verified: outcome.verified, replayed: outcome.replayed },
    {
      requestId: ctx.requestId,
      durationMs: Date.now() - ctx.startedAt,
      method,
      apiVersion: 'legacy',
      warnings: outcome.warnings,
      completeness: outcome.verified ? 'complete' : 'unknown',
    },
  );
}

function dryRunResponse(
  ctx: ToolContext,
  data: Record<string, unknown>,
  plan: Record<string, unknown>,
  level: string,
) {
  return ok(
    { ...data, dryRun: true, plan, validationLevel: level },
    {
      requestId: ctx.requestId,
      durationMs: Date.now() - ctx.startedAt,
      warnings: ['dryRun: запись не выполнялась, подтверждение не создано'],
    },
  );
}

const itemMutationOutput = z.object({
  taskId: z.number(),
  itemId: z.number(),
  isComplete: z.boolean().optional(),
  changed: z.boolean().optional(),
  deleted: z.boolean().optional(),
  stateHash: z.string().optional(),
  ...mutationOutputShape,
});

// ---------- task_checklist_update ----------

export const taskChecklistUpdateTool = defineTool({
  name: 'task_checklist_update',
  module: 'tasks',
  title: 'Изменить пункт чек-листа',
  description:
    'Изменить текст или порядок пункта чек-листа задачи (task.checklistitem.update). Использовать, когда пользователь просит ' +
    'переименовать пункт или поменять его позицию (sortIndex: меньше — выше). Отметка «выполнено» меняется через ' +
    'task_checklist_set_complete. Рекомендуется expectedStateHash пункта из task_checklist_get. Порядок: без approvalId — ' +
    'APPROVAL_REQUIRED с diff; человек подтверждает; повтор с approvalId применяет изменение один раз.',
  operation: 'update',
  annotations: UPDATE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      taskId: idSchema.describe('ID задачи'),
      itemId: itemIdSchema,
      title: titleSchema.optional().describe('Новый текст пункта'),
      sortIndex: z.number().int().min(0).max(1_000_000).optional().describe('Новый индекс сортировки'),
      ...updateArgsShape,
    })
    .strict()
    .refine((a) => a.title !== undefined || a.sortIndex !== undefined, {
      message: 'нужно title и/или sortIndex',
      path: ['title'],
    })
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: itemMutationOutput,
  handler: async (args, ctx) => {
    const { item } = await readItem(ctx, args.taskId, args.itemId);
    const currentHash = checklistItemHash(item);
    const fields: JsonObject = {};
    if (args.title !== undefined) fields['TITLE'] = args.title;
    if (args.sortIndex !== undefined) fields['SORT_INDEX'] = args.sortIndex;
    if (!args.approvalId) {
      if (args.expectedStateHash && args.expectedStateHash !== currentHash) throw conflict(false);
      if (
        (args.title ?? item.title) === item.title &&
        (args.sortIndex ?? item.sortIndex) === item.sortIndex
      ) {
        throw new AppError('VALIDATION_ERROR', 'Значения совпадают с текущими; изменять нечего', {
          reason: 'NO_CHANGES',
        });
      }
    }
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (args.title !== undefined) changes['TITLE'] = { from: item.title, to: args.title };
    if (args.sortIndex !== undefined) changes['SORT_INDEX'] = { from: item.sortIndex, to: args.sortIndex };
    const title = await taskTitle(ctx, args.taskId);

    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: mutationPrincipal(ctx),
      tool: 'task_checklist_update',
      operationKind: 'update',
      args,
      expectedStateHash: args.expectedStateHash ?? null,
      summary: {
        action: `Изменить пункт #${String(args.itemId)} «${item.title}» чек-листа задачи #${String(args.taskId)} «${title}»`,
        target: `task:${String(args.taskId)}:checklist:${String(args.itemId)}`,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: {
          method: 'task.checklistitem.update',
          item: itemBrief(item),
          stateHash: currentHash,
          changes,
        },
        risks: [
          'Изменение попадёт в историю задачи',
          ...(args.expectedStateHash
            ? []
            : [
                'expectedStateHash не передан: если пункт изменят до выполнения, изменение всё равно применится',
              ]),
        ],
      },
      validationLevel: 'local',
      precheck: async () => {
        const fresh = await readItem(ctx, args.taskId, args.itemId);
        if (args.expectedStateHash && checklistItemHash(fresh.item) !== args.expectedStateHash)
          throw conflict(true);
      },
      perform: async () => {
        const r = await ctx.bitrix.call(
          'legacy',
          'task.checklistitem.update',
          checklistParams.update(args.taskId, args.itemId, fields),
          { requestId: ctx.requestId, signal: ctx.signal },
        );
        // Документировано: при успехе result = null.
        if (r.result === false)
          throw new AppError('BITRIX_UPSTREAM_ERROR', 'task.checklistitem.update вернул false', {
            method: 'task.checklistitem.update',
            apiVersion: 'legacy',
            reason: 'RESULT_FALSE',
          });
        return { id: args.itemId, result: { itemId: args.itemId } };
      },
      verify: async () => {
        const { item: after } = await readItem(ctx, args.taskId, args.itemId);
        const warnings: string[] = [];
        if (args.title !== undefined && after.title !== args.title)
          warnings.push('Текст пункта в портале отличается');
        if (args.sortIndex !== undefined && after.sortIndex !== args.sortIndex)
          warnings.push(`sortIndex в портале ${String(after.sortIndex)}`);
        return { verified: warnings.length === 0, warnings };
      },
    });
    const base = { taskId: args.taskId, itemId: args.itemId };
    if (outcome.kind === 'dry-run')
      return dryRunResponse(ctx, { ...base, stateHash: currentHash }, outcome.plan, outcome.validationLevel);
    return executedResponse(ctx, outcome, 'task.checklistitem.update', base);
  },
});

// ---------- task_checklist_set_complete ----------

export const taskChecklistSetCompleteTool = defineTool({
  name: 'task_checklist_set_complete',
  module: 'tasks',
  title: 'Выполнить/возобновить пункт',
  description:
    'Отметить пункт чек-листа задачи выполненным (task.checklistitem.complete) или вернуть в работу (task.checklistitem.renew). ' +
    'Использовать, когда пользователь просит отметить шаг задачи сделанным или снять отметку. Если пункт уже в нужном ' +
    'состоянии — записи нет (changed=false). Порядок: без approvalId — APPROVAL_REQUIRED; человек подтверждает; ' +
    'повтор с approvalId выполняет один раз и перечитывает статус пункта.',
  operation: 'update',
  annotations: UPDATE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      taskId: idSchema.describe('ID задачи'),
      itemId: itemIdSchema,
      completed: z.boolean().describe('true — выполнен, false — вернуть в работу'),
      ...updateArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: itemMutationOutput,
  handler: async (args, ctx) => {
    const { item } = await readItem(ctx, args.taskId, args.itemId);
    const currentHash = checklistItemHash(item);
    const method = args.completed ? 'task.checklistitem.complete' : 'task.checklistitem.renew';
    const base = { taskId: args.taskId, itemId: args.itemId };
    if (!args.approvalId) {
      if (args.expectedStateHash && args.expectedStateHash !== currentHash) throw conflict(false);
      if (item.isComplete === args.completed) {
        return ok(
          { ...base, isComplete: item.isComplete, changed: false, stateHash: currentHash },
          {
            requestId: ctx.requestId,
            durationMs: Date.now() - ctx.startedAt,
            method: 'task.checklistitem.getlist',
            apiVersion: 'legacy',
            warnings: [`Пункт уже ${item.isComplete ? 'выполнен' : 'не выполнен'}; запись не требовалась`],
          },
        );
      }
    }
    const title = await taskTitle(ctx, args.taskId);
    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: mutationPrincipal(ctx),
      tool: 'task_checklist_set_complete',
      operationKind: 'update',
      args,
      expectedStateHash: args.expectedStateHash ?? null,
      summary: {
        action: `${args.completed ? 'Отметить выполненным' : 'Вернуть в работу'} пункт #${String(args.itemId)} «${item.title}» задачи #${String(args.taskId)} «${title}»`,
        target: `task:${String(args.taskId)}:checklist:${String(args.itemId)}`,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: {
          method,
          item: itemBrief(item),
          stateHash: currentHash,
          changes: { IS_COMPLETE: { from: item.isComplete ? 'Y' : 'N', to: args.completed ? 'Y' : 'N' } },
        },
        risks: ['Изменение отметки попадёт в историю задачи и может обновить прогресс чек-листа'],
      },
      validationLevel: 'local',
      precheck: async () => {
        const fresh = await readItem(ctx, args.taskId, args.itemId);
        if (args.expectedStateHash && checklistItemHash(fresh.item) !== args.expectedStateHash)
          throw conflict(true);
      },
      perform: async () => {
        const r = await ctx.bitrix.call('legacy', method, checklistParams.item(args.taskId, args.itemId), {
          requestId: ctx.requestId,
          signal: ctx.signal,
        });
        assertTrue(method, r.result);
        return { id: args.itemId, result: { itemId: args.itemId, isComplete: args.completed } };
      },
      verify: async () => {
        const { item: after } = await readItem(ctx, args.taskId, args.itemId);
        return after.isComplete === args.completed
          ? { verified: true, warnings: [] }
          : {
              verified: false,
              warnings: [`В портале пункт ${after.isComplete ? 'выполнен' : 'не выполнен'}`],
            };
      },
    });
    if (outcome.kind === 'dry-run')
      return dryRunResponse(ctx, { ...base, stateHash: currentHash }, outcome.plan, outcome.validationLevel);
    return executedResponse(ctx, outcome, method, {
      ...base,
      isComplete: outcome.result['isComplete'] === true,
      changed: true,
    });
  },
});

// ---------- task_checklist_delete ----------

export const taskChecklistDeleteTool = defineTool({
  name: 'task_checklist_delete',
  module: 'tasks',
  title: 'Удалить пункт чек-листа',
  description:
    'Удалить пункт чек-листа задачи (task.checklistitem.delete). Использовать только когда пользователь явно просит удалить ' +
    'конкретный пункт по itemId из task_checklist_get. План показывает пункт и вложенные в него подпункты; удаление ' +
    'корневого пункта затрагивает весь чек-лист. Доступно только роли administrator при ENABLE_DESTRUCTIVE_TOOLS=true. ' +
    'Порядок: без approvalId — APPROVAL_REQUIRED; человек подтверждает; повтор с approvalId удаляет один раз.',
  operation: 'delete',
  annotations: DESTRUCTIVE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      taskId: idSchema.describe('ID задачи'),
      itemId: itemIdSchema,
      ...updateArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: itemMutationOutput,
  handler: async (args, ctx) => {
    const items = await listChecklist(ctx, args.taskId);
    // Повтор подтверждённой операции после успеха: пункта уже нет — исполнитель вернёт сохранённый результат.
    const item = args.approvalId
      ? items.find((i) => i.id === args.itemId && (!i.taskId || i.taskId === args.taskId))
      : findItem(items, args.taskId, args.itemId);
    const currentHash = item ? checklistItemHash(item) : null;
    if (!args.approvalId && args.expectedStateHash && args.expectedStateHash !== currentHash)
      throw conflict(false);
    const children = item ? descendants(items, item.id) : [];
    const title = await taskTitle(ctx, args.taskId);
    const risks = ['Удаление необратимо через этот сервер'];
    if (item?.parentId === 0)
      risks.unshift('Это корневой пункт — название чек-листа: удаляется весь чек-лист');
    if (children.length)
      risks.unshift(`Вместе с пунктом затрагиваются вложенные подпункты: ${String(children.length)}`);
    if (!args.expectedStateHash)
      risks.push(
        'expectedStateHash не передан: если пункт изменят до выполнения, удаление всё равно применится',
      );

    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: mutationPrincipal(ctx),
      tool: 'task_checklist_delete',
      operationKind: 'delete',
      args,
      expectedStateHash: args.expectedStateHash ?? null,
      summary: {
        action: `УДАЛИТЬ пункт #${String(args.itemId)} «${item?.title ?? ''}» чек-листа задачи #${String(args.taskId)} «${title}»`,
        target: `task:${String(args.taskId)}:checklist:${String(args.itemId)}`,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: {
          method: 'task.checklistitem.delete',
          ...(item ? { item: itemBrief(item) } : {}),
          stateHash: currentHash,
          impact: { descendantsCount: children.length, descendants: children.slice(0, 20).map(itemBrief) },
        },
        risks,
      },
      validationLevel: 'local',
      precheck: async () => {
        const fresh = await readItem(ctx, args.taskId, args.itemId);
        if (args.expectedStateHash && checklistItemHash(fresh.item) !== args.expectedStateHash)
          throw conflict(true);
      },
      perform: async () => {
        const r = await ctx.bitrix.call(
          'legacy',
          'task.checklistitem.delete',
          checklistParams.item(args.taskId, args.itemId),
          { requestId: ctx.requestId, signal: ctx.signal },
        );
        assertTrue('task.checklistitem.delete', r.result);
        return { id: args.itemId, result: { itemId: args.itemId, deleted: true } };
      },
      verify: async () => {
        const after = await listChecklist(ctx, args.taskId);
        if (after.some((i) => i.id === args.itemId))
          return { verified: false, warnings: ['После удаления пункт всё ещё есть в чек-листе'] };
        const left = children.filter((c) => after.some((i) => i.id === c.id)).length;
        return {
          verified: true,
          warnings: left ? [`Вложенных подпунктов осталось в портале: ${String(left)}`] : [],
        };
      },
    });
    const base = { taskId: args.taskId, itemId: args.itemId };
    if (outcome.kind === 'dry-run')
      return dryRunResponse(
        ctx,
        { ...base, ...(currentHash ? { stateHash: currentHash } : {}) },
        outcome.plan,
        outcome.validationLevel,
      );
    return executedResponse(ctx, outcome, 'task.checklistitem.delete', {
      ...base,
      deleted: outcome.result['deleted'] === true,
    });
  },
});

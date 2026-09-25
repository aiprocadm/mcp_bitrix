/**
 * Запись оргструктуры (ТЗ §9.2, §8.2): company_department_create / _update / _delete.
 * Всё через MutationExecutor: чтения и проверки до плана (INVALID_PARENT, INVALID_HEAD, HIERARCHY_CYCLE,
 * DEPARTMENT_NOT_EMPTY), план с diff и рисками → подтверждение человеком → precheck (CONFLICT) → одна запись → сверка.
 * Удаление отдела с подотделами или сотрудниками запрещено до плана: людей и подотделы сервер неявно не переносит.
 */
import { z } from 'zod';
import type { JsonObject } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { requireIdempotencyUnlessDryRun, updateArgsShape, writeArgsShape } from '../../schemas/common.js';
import {
  idOf,
  idSchema,
  mutationOutputShape,
  mutationPrincipal,
  mutationResponse,
  outcomeUnknown,
} from '../shared.js';
import {
  CREATE_ANNOTATIONS,
  defineTool,
  DESTRUCTIVE_ANNOTATIONS,
  UPDATE_ANNOTATIONS,
  type ToolContext,
} from '../types.js';
import {
  assertActiveHead,
  assertNoCycle,
  departmentMemberCount,
  departmentStateHash,
  departmentsWhere,
  findDepartment,
  departmentNotFound,
  getDepartment,
  invalidParent,
  listAllDepartments,
  type Department,
} from './company-service.js';

const nameSchema = z.string().trim().min(1).max(255);

const brief = (d: Department | undefined | null) => (d ? { id: d.id, name: d.name } : null);

function conflict(message: string): AppError {
  return new AppError('CONFLICT', message, {
    field: 'expectedStateHash',
    reason: 'STATE_CHANGED',
    nextAction: 'Прочитайте отдел заново (company_departments_list) и подготовьте новый план',
  });
}

async function writeCall(ctx: ToolContext, method: string, params: JsonObject) {
  return ctx.bitrix.call('legacy', method, params, { requestId: ctx.requestId, signal: ctx.signal });
}

// ---------- company_department_create ----------

export const companyDepartmentCreateTool = defineTool({
  name: 'company_department_create',
  module: 'company',
  title: 'Создать отдел',
  description:
    'Добавить подразделение в оргструктуру (department.add): название, родительский отдел, руководитель. ' +
    'Использовать, только когда пользователь явно просит создать отдел. Родитель проверяется до плана (INVALID_PARENT); ' +
    'без parentId отдел создаётся в единственном корневом отделе, и это видно в плане. Руководитель — только активный ' +
    'сотрудник (ID из employee_search). Порядок: APPROVAL_REQUIRED с планом → подтверждение человеком → повтор с approvalId.',
  operation: 'create',
  annotations: CREATE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      name: nameSchema.describe('Название отдела'),
      parentId: idSchema.optional().describe('ID родительского отдела; по умолчанию — корневой'),
      headId: idSchema.optional().describe('ID активного сотрудника-руководителя'),
      ...writeArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({
    ...mutationOutputShape,
    name: z.string(),
    departmentId: z.number().optional(),
  }),
  handler: async (args, ctx) => {
    let parent: Department | undefined;
    let parentDefaulted = false;
    if (args.parentId !== undefined) {
      parent = await findDepartment(ctx, args.parentId);
      if (!parent) throw invalidParent(args.parentId, 'parentId');
    } else {
      // department.add требует PARENT; второй корень портал не допускает — берём единственный корень явно.
      const all = await listAllDepartments(ctx);
      const roots = all.items.filter((d) => d.parentId === null);
      if (!all.complete || roots.length !== 1) {
        throw new AppError(
          'VALIDATION_ERROR',
          'Не удалось однозначно определить корневой отдел; укажите parentId',
          {
            field: 'parentId',
            reason: 'INVALID_PARENT',
            nextAction: 'Выберите родителя через company_departments_list',
          },
        );
      }
      parent = roots[0];
      parentDefaulted = true;
    }
    if (!parent) throw invalidParent(args.parentId ?? 0, 'parentId');
    const head = args.headId !== undefined ? await assertActiveHead(ctx, args.headId, 'headId') : undefined;
    const risks = ['Отдел появится в структуре компании у всех сотрудников; может быть создан чат отдела'];
    if (parentDefaulted) risks.push(`parentId не указан: отдел будет создан в корне «${parent.name}»`);
    if (head) risks.push(`${head.fullName} получит права руководителя отдела`);
    const dup = await departmentsWhere(ctx, { NAME: args.name, PARENT: parent.id });
    if (dup.items.length > 0)
      risks.push(
        `У «${parent.name}» уже есть отдел с таким названием (#${dup.items.map((d) => d.id).join(', #')})`,
      );
    const parentId = parent.id;

    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: mutationPrincipal(ctx),
      tool: 'company_department_create',
      operationKind: 'create',
      args,
      summary: {
        action: `Создать отдел «${args.name}» в «${parent.name}» (#${String(parentId)})`,
        target: `department:parent:${String(parentId)}`,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: {
          method: 'department.add',
          name: args.name,
          parent: brief(parent),
          parentDefaulted,
          head: head ? { id: head.id, fullName: head.fullName, position: head.position } : null,
        },
        risks,
      },
      validationLevel: 'local+metadata',
      perform: async () => {
        const params: JsonObject = { NAME: args.name, PARENT: parentId };
        if (args.headId !== undefined) params['UF_HEAD'] = args.headId;
        const r = await writeCall(ctx, 'department.add', params);
        const id = idOf(r.result);
        if (id === undefined)
          throw outcomeUnknown(
            'department.add',
            'legacy',
            'Проверьте структуру (company_departments_list) перед повторным созданием',
          );
        return { id, result: { departmentId: id } };
      },
      verify: async (performed) => {
        const d = await findDepartment(ctx, Number(performed.id));
        if (!d) return { verified: false, warnings: ['Созданный отдел не читается через department.get'] };
        const warnings: string[] = [];
        if (d.name !== args.name) warnings.push('Название в портале отличается от запрошенного');
        if (d.parentId !== parentId) warnings.push('Родитель в портале отличается от запрошенного');
        if (args.headId !== undefined && d.headId !== null && d.headId !== args.headId)
          warnings.push('Руководитель в портале отличается от запрошенного');
        const verified = warnings.length === 0;
        if (args.headId !== undefined && d.headId === null)
          warnings.push('department.get не вернул UF_HEAD: руководитель не сверен');
        return { verified, warnings };
      },
    });
    return mutationResponse(ctx, outcome, {
      base: { name: args.name },
      method: 'department.add',
      resultFields: ['departmentId'],
    });
  },
});

// ---------- company_department_update ----------

const patchSchema = z
  .object({
    name: nameSchema.optional().describe('Новое название'),
    parentId: idSchema.optional().describe('Новый родительский отдел (не сам отдел и не его подотдел)'),
    headId: idSchema.optional().describe('Новый руководитель: ID активного сотрудника'),
  })
  .strict()
  .refine((p) => p.name !== undefined || p.parentId !== undefined || p.headId !== undefined, {
    message: 'нужно хотя бы одно изменение: name, parentId или headId',
  });

export const companyDepartmentUpdateTool = defineTool({
  name: 'company_department_update',
  module: 'company',
  title: 'Изменить отдел',
  description:
    'Изменить название, родителя или руководителя отдела (department.update). Использовать, только когда пользователь явно ' +
    'просит переименовать отдел, перенести его в другой отдел или сменить руководителя. Перенос в собственный подотдел ' +
    'отклоняется до плана (HIERARCHY_CYCLE). Передайте expectedStateHash из company_departments_list: если отдел изменили, ' +
    'будет CONFLICT. Порядок: APPROVAL_REQUIRED с diff «было → станет» → подтверждение человеком → повтор с approvalId.',
  operation: 'update',
  annotations: UPDATE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      id: idSchema.describe('ID отдела'),
      patch: patchSchema,
      ...updateArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({
    ...mutationOutputShape,
    id: z.number(),
    changedFields: z.array(z.string()).optional(),
    stateHash: z.string().optional(),
  }),
  handler: async (args, ctx) => {
    const current = await getDepartment(ctx, args.id);
    const currentHash = departmentStateHash(current);
    if (!args.approvalId && args.expectedStateHash && args.expectedStateHash !== currentHash)
      throw conflict('Отдел изменился после чтения: expectedStateHash не совпадает');

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    const risks: string[] = [];
    const { patch } = args;
    // В запрос уходят все поля patch (одинаково при подготовке и выполнении); в diff — только отличающиеся.
    const params: JsonObject = { ID: args.id };
    if (patch.name !== undefined) params['NAME'] = patch.name;
    if (patch.parentId !== undefined) params['PARENT'] = patch.parentId;
    if (patch.headId !== undefined) params['UF_HEAD'] = patch.headId;
    if (patch.name !== undefined && patch.name !== current.name) {
      changes['name'] = { from: current.name, to: patch.name };
      risks.push('Новое название увидят все сотрудники в структуре, профилях и чатах отдела');
    }
    if (patch.parentId !== undefined && patch.parentId !== current.parentId) {
      if (current.parentId === null) {
        throw new AppError('VALIDATION_ERROR', 'Корневой отдел компании нельзя перенести', {
          field: 'patch.parentId',
          reason: 'ROOT_DEPARTMENT',
        });
      }
      const chain = await assertNoCycle(ctx, args.id, patch.parentId);
      const [oldParent, newParent] = [
        await findDepartment(ctx, current.parentId),
        await findDepartment(ctx, patch.parentId),
      ];
      changes['parent'] = { from: brief(oldParent), to: brief(newParent) };
      risks.push(
        'Перенос меняет подчинённость: руководители и права по структуре изменятся для всех сотрудников отдела и его подотделов',
        `Цепочка нового родителя до корня: #${chain.join(' → #')}`,
      );
    }
    if (patch.headId !== undefined && patch.headId !== current.headId) {
      const head = await assertActiveHead(ctx, patch.headId, 'patch.headId');
      changes['head'] = {
        from: current.headId,
        to: { id: head.id, fullName: head.fullName, position: head.position },
      };
      risks.push(
        `${head.fullName} станет руководителем: получит доступ к задачам/отчётам подчинённых; прежний руководитель эти права по отделу потеряет`,
      );
      if (current.headId === null)
        risks.push('Портал не вернул текущего руководителя (UF_HEAD): «было» может быть неизвестно');
    }
    // С approvalId пустой diff возможен при повторе уже выполненной операции — решает исполнитель (replay).
    if (Object.keys(changes).length === 0 && !args.approvalId) {
      throw new AppError('VALIDATION_ERROR', 'Изменений нет: значения совпадают с текущими', {
        field: 'patch',
        reason: 'NO_CHANGES',
      });
    }
    if (!args.expectedStateHash)
      risks.push(
        'expectedStateHash не передан: если отдел изменят до выполнения, изменение всё равно применится',
      );
    const changedFields = Object.keys(patch);

    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: mutationPrincipal(ctx),
      tool: 'company_department_update',
      operationKind: 'update',
      args,
      expectedStateHash: args.expectedStateHash ?? null,
      summary: {
        action: `Изменить отдел #${String(args.id)} «${current.name}»: ${Object.keys(changes).join(', ')}`,
        target: `department:${String(args.id)}`,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: { method: 'department.update', id: args.id, stateHash: currentHash, changes },
        risks,
      },
      validationLevel: 'local+metadata',
      precheck: async () => {
        const fresh = await findDepartment(ctx, args.id);
        if (!fresh) throw conflict('Отдел удалён или стал недоступен после подтверждения');
        if (args.expectedStateHash && departmentStateHash(fresh) !== args.expectedStateHash)
          throw conflict('Отдел изменился после подтверждения; изменение отменено');
        // Структура могла измениться: цикл проверяется повторно непосредственно перед записью.
        if (patch.parentId !== undefined && patch.parentId !== fresh.parentId)
          await assertNoCycle(ctx, args.id, patch.parentId);
      },
      perform: async () => {
        const r = await writeCall(ctx, 'department.update', params);
        if (r.result !== true)
          throw outcomeUnknown('department.update', 'legacy', 'Сверьте отдел через company_departments_list');
        return { id: args.id, result: { id: args.id, changedFields } };
      },
      verify: async () => {
        const d = await findDepartment(ctx, args.id);
        if (!d) return { verified: false, warnings: ['Отдел не читается после изменения'] };
        const warnings: string[] = [];
        if (params['NAME'] !== undefined && d.name !== params['NAME'])
          warnings.push('Название в портале отличается от запрошенного');
        if (params['PARENT'] !== undefined && d.parentId !== params['PARENT'])
          warnings.push('Родитель в портале отличается от запрошенного');
        if (params['UF_HEAD'] !== undefined && d.headId !== null && d.headId !== params['UF_HEAD'])
          warnings.push('Руководитель в портале отличается от запрошенного');
        const verified = warnings.length === 0;
        if (params['UF_HEAD'] !== undefined && d.headId === null)
          warnings.push('department.get не вернул UF_HEAD: руководитель не сверен');
        return { verified, warnings };
      },
    });
    const response = mutationResponse(ctx, outcome, {
      base: { id: args.id },
      method: 'department.update',
      resultFields: ['changedFields'],
      dryRunExtra: { stateHash: currentHash },
    });
    if (response.success && outcome.kind === 'executed' && !outcome.replayed) {
      try {
        const d = await findDepartment(ctx, args.id);
        if (d) (response.data as Record<string, unknown>)['stateHash'] = departmentStateHash(d);
      } catch {
        // новый хеш — удобство; его отсутствие не отменяет выполненную запись
      }
    }
    return response;
  },
});

// ---------- company_department_delete ----------

async function assertEmpty(ctx: ToolContext, d: Department): Promise<void> {
  const children = await departmentsWhere(ctx, { PARENT: d.id });
  const members = await departmentMemberCount(ctx, d.id);
  const childCount = children.total ?? children.items.length;
  if (childCount > 0 || members.total > 0) {
    const parts: string[] = [];
    if (childCount > 0)
      parts.push(
        `подотделов: ${String(childCount)} (#${children.items
          .slice(0, 10)
          .map((c) => c.id)
          .join(', #')})`,
      );
    if (members.total > 0) parts.push(`сотрудников (включая уволенных): ${String(members.total)}`);
    throw new AppError(
      'VALIDATION_ERROR',
      `Отдел «${d.name}» не пуст — ${parts.join('; ')}. Удаление запрещено`,
      {
        reason: 'DEPARTMENT_NOT_EMPTY',
        nextAction:
          'Сначала явно перенесите подотделы (company_department_update) и сотрудников (company_employee_departments_set), затем повторите',
      },
    );
  }
}

export const companyDepartmentDeleteTool = defineTool({
  name: 'company_department_delete',
  module: 'company',
  title: 'Удалить пустой отдел',
  description:
    'Удалить согласованный ПУСТОЙ отдел из оргструктуры (department.delete). Использовать, только когда пользователь явно ' +
    'просит удалить конкретный отдел. Отдел с подотделами или сотрудниками (включая уволенных) не удаляется: ' +
    'DEPARTMENT_NOT_EMPTY до плана, людей сервер неявно не переносит. Корневой отдел не удаляется. Передайте expectedStateHash. ' +
    'Порядок: APPROVAL_REQUIRED → подтверждение человеком → повтор с approvalId; после — проверка, что отдел исчез.',
  operation: 'delete',
  annotations: DESTRUCTIVE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      id: idSchema.describe('ID отдела'),
      ...updateArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({
    ...mutationOutputShape,
    id: z.number(),
    deleted: z.boolean().optional(),
    stateHash: z.string().optional(),
  }),
  handler: async (args, ctx) => {
    const found = await findDepartment(ctx, args.id);
    if (!found && args.approvalId) {
      // Повтор уже выполненного удаления: отдела закономерно нет — результат отдаёт исполнитель (replay).
      // Если операция ещё не выполнялась, precheck откажет (CONFLICT), записи не будет.
      const outcome = await ctx.mutations.execute({
        requestId: ctx.requestId,
        principal: mutationPrincipal(ctx),
        tool: 'company_department_delete',
        operationKind: 'delete',
        args,
        expectedStateHash: args.expectedStateHash ?? null,
        summary: {
          action: `УДАЛИТЬ отдел #${String(args.id)}`,
          target: `department:${String(args.id)}`,
          portalOrigin: ctx.bitrix.auth.portalOrigin,
          details: { method: 'department.delete', id: args.id },
          risks: [],
        },
        precheck: () => Promise.reject(conflict('Отдел уже удалён или недоступен; удаление не выполняется')),
        perform: () => Promise.reject(conflict('Отдел недоступен')),
      });
      return mutationResponse(ctx, outcome, {
        base: { id: args.id },
        method: 'department.delete',
        resultFields: ['deleted'],
      });
    }
    if (!found) throw departmentNotFound(args.id);
    const current = found;
    if (current.parentId === null) {
      throw new AppError('VALIDATION_ERROR', 'Корневой отдел компании удалить нельзя', {
        reason: 'ROOT_DEPARTMENT',
      });
    }
    await assertEmpty(ctx, current);
    const currentHash = departmentStateHash(current);
    if (!args.approvalId && args.expectedStateHash && args.expectedStateHash !== currentHash)
      throw conflict('Отдел изменился после чтения: expectedStateHash не совпадает');
    const parent = await findDepartment(ctx, current.parentId);
    const risks = [
      'Удаление необратимо: восстановить отдел через REST нельзя, только создать заново с новым ID',
      'Ссылки на отдел (фильтры отчётов, права доступа по отделу, чат отдела) перестанут работать',
    ];
    if (!args.expectedStateHash)
      risks.push('expectedStateHash не передан: изменения отдела после чтения не будут обнаружены');

    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: mutationPrincipal(ctx),
      tool: 'company_department_delete',
      operationKind: 'delete',
      args,
      expectedStateHash: args.expectedStateHash ?? null,
      summary: {
        action: `УДАЛИТЬ отдел #${String(args.id)} «${current.name}»`,
        target: `department:${String(args.id)}`,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: {
          method: 'department.delete',
          department: { ...brief(current), headId: current.headId },
          parent: brief(parent),
          stateHash: currentHash,
          impact: { childDepartments: 0, members: 0 },
        },
        risks,
      },
      validationLevel: 'local+metadata',
      precheck: async () => {
        const fresh = await findDepartment(ctx, args.id);
        if (!fresh) throw conflict('Отдел уже удалён или стал недоступен после подтверждения');
        if (args.expectedStateHash && departmentStateHash(fresh) !== args.expectedStateHash)
          throw conflict('Отдел изменился после подтверждения; удаление отменено');
        // Пока план ждал подтверждения, в отдел могли добавить людей или подотделы.
        await assertEmpty(ctx, fresh);
      },
      perform: async () => {
        const r = await writeCall(ctx, 'department.delete', { ID: args.id });
        if (r.result !== true)
          throw outcomeUnknown(
            'department.delete',
            'legacy',
            'Проверьте, есть ли отдел в company_departments_list',
          );
        return { id: args.id, result: { id: args.id, deleted: true } };
      },
      verify: async () => {
        const still = await findDepartment(ctx, args.id);
        return still
          ? { verified: false, warnings: ['Отдел всё ещё читается после удаления'] }
          : { verified: true, warnings: [] };
      },
    });
    return mutationResponse(ctx, outcome, {
      base: { id: args.id },
      method: 'department.delete',
      resultFields: ['deleted'],
      dryRunExtra: { stateHash: currentHash },
    });
  },
});

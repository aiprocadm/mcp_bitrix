/**
 * company_employee_departments_set (ТЗ §9.2, §8.2 повышенный риск): полный состав отделов сотрудника
 * через user.update с UF_DEPARTMENT. До плана: доступность user.update (method.get через ctx.capabilities;
 * явное «недоступно» → FEATURE_UNAVAILABLE), сотрудник и все отделы существуют, diff прежний/новый состав.
 */
import { z } from 'zod';
import { requireMethod } from '../../bitrix/method-registry.js';
import { AppError } from '../../errors/app-error.js';
import { stateHash } from '../../security/idempotency.js';
import { requireIdempotencyUnlessDryRun, updateArgsShape } from '../../schemas/common.js';
import {
  idSchema,
  mutationOutputShape,
  mutationPrincipal,
  mutationResponse,
  outcomeUnknown,
} from '../shared.js';
import { defineTool, DESTRUCTIVE_ANNOTATIONS, type ToolContext } from '../types.js';
import { findDepartment, findEmployee, type Department, type Employee } from './company-service.js';

const employeeStateHash = (e: Employee) => stateHash({ id: e.id, departmentIds: e.departmentIds });

async function getEmployee(ctx: ToolContext, userId: number): Promise<Employee> {
  const e = await findEmployee(ctx, userId);
  if (!e)
    throw new AppError('NOT_FOUND', `Сотрудник #${String(userId)} не найден или недоступен`, {
      method: 'user.get',
      apiVersion: 'legacy',
      nextAction: 'Найдите ID через employee_search',
    });
  return e;
}

export const companyEmployeeDepartmentsSetTool = defineTool({
  name: 'company_employee_departments_set',
  module: 'company',
  title: 'Изменить отделы сотрудника',
  description:
    'Задать ПОЛНЫЙ список отделов сотрудника (user.update, поле UF_DEPARTMENT): отделы вне списка сотрудник покинет. ' +
    'Использовать, только когда пользователь явно просит перевести сотрудника или изменить его принадлежность к отделам. ' +
    'План показывает прежний и новый состав (добавляемые/убираемые отделы); передайте expectedStateHash из прошлого ответа, ' +
    'иначе параллельные изменения не будут обнаружены. Требует права приглашения пользователей; если метод недоступен — ' +
    'FEATURE_UNAVAILABLE. Порядок: APPROVAL_REQUIRED → подтверждение человеком → повтор с approvalId.',
  operation: 'update',
  annotations: DESTRUCTIVE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      userId: idSchema.describe('ID сотрудника'),
      departmentIds: z
        .array(idSchema)
        .min(1)
        .max(20)
        .refine((a) => new Set(a).size === a.length, 'ID отделов не должны повторяться')
        .describe('Новый полный список ID отделов (1..20)'),
      ...updateArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({
    ...mutationOutputShape,
    userId: z.number(),
    departmentIds: z.array(z.number()).optional(),
    stateHash: z.string().optional(),
  }),
  handler: async (args, ctx) => {
    const target = [...args.departmentIds].sort((a, b) => a - b);
    const cap = await ctx.capabilities.probe(requireMethod('legacy', 'user.update'), ctx.requestId);
    if (cap.status === 'unavailable') {
      throw new AppError('FEATURE_UNAVAILABLE', `user.update недоступен: ${cap.reason ?? 'нет доступа'}`, {
        method: 'user.update',
        apiVersion: 'legacy',
        requiredScope: 'user',
        reason: 'METHOD_UNAVAILABLE',
        nextAction: 'Выдайте вебхуку scope user и права на приглашение/изменение пользователей',
      });
    }
    const employee = await getEmployee(ctx, args.userId);
    const currentHash = employeeStateHash(employee);
    if (!args.approvalId && args.expectedStateHash && args.expectedStateHash !== currentHash) {
      throw new AppError(
        'CONFLICT',
        'Отделы сотрудника изменились после чтения: expectedStateHash не совпадает',
        {
          field: 'expectedStateHash',
          reason: 'STATE_CHANGED',
          nextAction: 'Подготовьте план заново (dryRun) и сверьте текущий состав',
        },
      );
    }
    const names = new Map<number, Department>();
    for (const id of new Set([...target, ...employee.departmentIds])) {
      const d = await findDepartment(ctx, id);
      if (d) names.set(id, d);
      else if (target.includes(id))
        throw new AppError('VALIDATION_ERROR', `Отдел #${String(id)} не найден или недоступен`, {
          field: 'departmentIds',
          reason: 'INVALID_DEPARTMENT',
          nextAction: 'Проверьте ID через company_departments_list',
        });
    }
    const label = (id: number) => ({ id, name: names.get(id)?.name ?? null });
    const added = target.filter((id) => !employee.departmentIds.includes(id));
    const removed = employee.departmentIds.filter((id) => !target.includes(id));
    if (added.length === 0 && removed.length === 0 && !args.approvalId) {
      throw new AppError('VALIDATION_ERROR', 'Состав отделов не меняется', {
        field: 'departmentIds',
        reason: 'NO_CHANGES',
      });
    }
    const risks = [
      'Повышенный риск: меняются руководитель сотрудника, права доступа по структуре и видимость задач/отчётов',
      'Сотрудник может быть добавлен в чаты новых отделов и удалён из чатов прежних',
    ];
    const headOf = removed.filter((id) => names.get(id)?.headId === employee.id);
    if (headOf.length > 0)
      risks.push(
        `Сотрудник — руководитель покидаемых отделов #${headOf.join(', #')}: руководство отделом при этом не передаётся автоматически`,
      );
    if (!employee.active) risks.push('Сотрудник неактивен (уволен)');
    if (cap.status !== 'supported')
      risks.push(
        'Доступность user.update не подтверждена method.get; права проверит сам портал при выполнении',
      );
    if (!args.expectedStateHash)
      risks.push('expectedStateHash не передан: параллельные изменения состава не будут обнаружены');

    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: mutationPrincipal(ctx),
      tool: 'company_employee_departments_set',
      operationKind: 'update',
      args,
      expectedStateHash: args.expectedStateHash ?? null,
      summary: {
        action: `Изменить отделы сотрудника #${String(employee.id)} ${employee.fullName}`,
        target: `user:${String(employee.id)}:UF_DEPARTMENT`,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: {
          method: 'user.update',
          field: 'UF_DEPARTMENT',
          employee: { id: employee.id, fullName: employee.fullName, position: employee.position },
          stateHash: currentHash,
          before: employee.departmentIds.map(label),
          after: target.map(label),
          added: added.map(label),
          removed: removed.map(label),
        },
        risks,
      },
      validationLevel: 'local+metadata',
      precheck: async () => {
        const fresh = await getEmployee(ctx, args.userId);
        if (args.expectedStateHash && employeeStateHash(fresh) !== args.expectedStateHash) {
          throw new AppError(
            'CONFLICT',
            'Отделы сотрудника изменились после подтверждения; изменение отменено',
            {
              reason: 'STATE_CHANGED',
              nextAction: 'Подготовьте новый план',
            },
          );
        }
      },
      perform: async () => {
        const r = await ctx.bitrix.call(
          'legacy',
          'user.update',
          { ID: args.userId, UF_DEPARTMENT: target },
          { requestId: ctx.requestId, signal: ctx.signal },
        );
        if (r.result !== true)
          throw outcomeUnknown('user.update', 'legacy', 'Сверьте отделы сотрудника через employee_search');
        return { id: args.userId, result: { userId: args.userId, departmentIds: target } };
      },
      verify: async () => {
        const after = await getEmployee(ctx, args.userId);
        const same = after.departmentIds.join(',') === target.join(',');
        return {
          verified: same,
          warnings: same ? [] : [`В портале отделы: #${after.departmentIds.join(', #')}`],
        };
      },
    });
    const response = mutationResponse(ctx, outcome, {
      base: { userId: args.userId },
      method: 'user.update',
      resultFields: ['departmentIds'],
      dryRunExtra: { stateHash: currentHash },
    });
    if (response.success && outcome.kind === 'executed' && !outcome.replayed) {
      try {
        (response.data as Record<string, unknown>)['stateHash'] = employeeStateHash(
          await getEmployee(ctx, args.userId),
        );
      } catch {
        // новый хеш — удобство; запись уже выполнена
      }
    }
    return response;
  },
});

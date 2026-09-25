/**
 * employee_search (ТЗ §9.2, T24): поиск сотрудников user.search без автоматического выбора.
 * Несколько кандидатов (в том числе однофамильцы) возвращаются все с признаком ambiguous —
 * это не ошибка поиска; выбор делает человек по ID. Только минимальные поля (§8.4).
 */
import { z } from 'zod';
import type { JsonObject } from '../../bitrix/legacy-adapter.js';
import { ok } from '../../mcp/result.js';
import { pageArgsShape } from '../../schemas/common.js';
import { idSchema, pageMeta, pageSizeOf } from '../shared.js';
import { defineTool, READ_ANNOTATIONS, type ToolContext } from '../types.js';
import { EMPLOYEE_SELECT, findDepartment, normalizeEmployee, type Employee } from './company-service.js';
import { offsetPage } from './offset-page.js';

const MAX_DEPARTMENT_LOOKUPS = 10;

async function departmentNames(
  ctx: ToolContext,
  ids: number[],
): Promise<{ names: Map<number, string>; warning?: string }> {
  const names = new Map<number, string>();
  const unique = [...new Set(ids)];
  if (unique.length > MAX_DEPARTMENT_LOOKUPS)
    return { names, warning: 'Отделов на странице слишком много: названия не подставлены, только ID' };
  try {
    for (const id of unique) {
      const d = await findDepartment(ctx, id);
      if (d) names.set(id, d.name);
    }
    return { names };
  } catch {
    return { names, warning: 'Названия отделов недоступны (нет scope department или прав); показаны ID' };
  }
}

const employeeOut = z.object({
  id: z.number(),
  fullName: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  secondName: z.string(),
  position: z.string(),
  active: z.boolean(),
  userType: z.string(),
  departments: z.array(z.object({ id: z.number(), name: z.string().nullable() })),
});

export const employeeSearchTool = defineTool({
  name: 'employee_search',
  module: 'company',
  title: 'Найти сотрудника',
  description:
    'Найти сотрудников по ФИО, должности или названию отдела (user.search). Возвращает минимум для идентификации: ' +
    'ID, ФИО, должность, отделы, активность — без телефонов, email и дат рождения. Использовать, чтобы узнать ID сотрудника ' +
    'перед назначением ответственным, руководителем отдела или отправкой сообщения. Если кандидатов несколько (ambiguous=true, ' +
    'в том числе полные однофамильцы), сервер НЕ выбирает сам: покажите список пользователю и попросите выбрать ID.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      query: z.string().trim().min(1).max(100).describe('Строка поиска: ФИО, должность или название отдела'),
      activeOnly: z.boolean().default(true).describe('Только работающие сотрудники (по умолчанию true)'),
      departmentId: idSchema.optional().describe('Искать только в этом отделе'),
      ...pageArgsShape,
    })
    .strict(),
  outputDataSchema: z.object({
    query: z.string(),
    items: z.array(employeeOut),
    returnedCount: z.number(),
    total: z.number().nullable(),
    ambiguous: z.boolean(),
    sameNameGroups: z.array(z.array(z.number())),
    selectionRequired: z.boolean(),
  }),
  handler: async (args, ctx) => {
    const pageSize = pageSizeOf(ctx, args.pageSize);
    const filter: JsonObject = { FIND: args.query };
    // ACTIVE и UF_DEPARTMENT — параметры фильтра user.get, которые user.search наследует (страница user.search).
    if (args.activeOnly) filter['ACTIVE'] = true;
    if (args.departmentId !== undefined) filter['UF_DEPARTMENT'] = args.departmentId;
    const page = await offsetPage(ctx, {
      tool: 'employee_search',
      method: 'user.search',
      params: { FILTER: filter, select: [...EMPLOYEE_SELECT] },
      bindingParts: {
        query: args.query,
        activeOnly: args.activeOnly,
        departmentId: args.departmentId ?? null,
      },
      pageSize,
      cursor: args.cursor,
    });
    const warnings: string[] = [];
    let employees = page.items.map(normalizeEmployee).filter((e): e is Employee => e !== undefined);
    // Страховка: если портал проигнорировал фильтр, не выдаём лишних.
    const before = employees.length;
    if (args.activeOnly) employees = employees.filter((e) => e.active);
    const departmentId = args.departmentId;
    if (departmentId !== undefined)
      employees = employees.filter((e) => e.departmentIds.includes(departmentId));
    if (employees.length < before) warnings.push('Портал вернул записи вне фильтра; они исключены локально');

    const deps = await departmentNames(
      ctx,
      employees.flatMap((e) => e.departmentIds),
    );
    if (deps.warning) warnings.push(deps.warning);

    const byName = new Map<string, number[]>();
    for (const e of employees) {
      const k = e.fullName.toLocaleLowerCase('ru').replace(/\s+/g, ' ');
      byName.set(k, [...(byName.get(k) ?? []), e.id]);
    }
    const sameNameGroups = [...byName.values()].filter((g) => g.length > 1);
    const ambiguous = employees.length > 1 || page.hasMore;
    if (sameNameGroups.length > 0)
      warnings.push(
        'Есть сотрудники с одинаковым ФИО: автоматический выбор не выполняется, уточните по ID/должности/отделу',
      );
    else if (ambiguous) warnings.push('Найдено несколько кандидатов: выберите нужного по ID');
    if (employees.length === 0) warnings.push('Никого не найдено; проверьте написание или activeOnly');

    return ok(
      {
        query: args.query,
        items: employees.map((e) => ({
          id: e.id,
          fullName: e.fullName,
          firstName: e.firstName,
          lastName: e.lastName,
          secondName: e.secondName,
          position: e.position,
          active: e.active,
          userType: e.userType,
          departments: e.departmentIds.map((id) => ({ id, name: deps.names.get(id) ?? null })),
        })),
        returnedCount: employees.length,
        total: page.total ?? null,
        ambiguous,
        sameNameGroups,
        selectionRequired: ambiguous,
      },
      pageMeta(ctx, 'user.search', page, 'legacy', warnings),
    );
  },
});

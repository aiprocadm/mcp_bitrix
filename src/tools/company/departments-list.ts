/**
 * company_departments_list (ТЗ §9.2): подразделения department.get со связями parent/head.
 * Классический department.* не покрывает команды и матричные связи новой структуры — это указано в описании.
 */
import { z } from 'zod';
import type { JsonObject } from '../../bitrix/legacy-adapter.js';
import { ok } from '../../mcp/result.js';
import { pageArgsShape } from '../../schemas/common.js';
import { idSchema, pageMeta, pageSizeOf } from '../shared.js';
import { defineTool, READ_ANNOTATIONS } from '../types.js';
import {
  departmentStateHash,
  employeeNames,
  normalizeDepartment,
  type Department,
} from './company-service.js';
import { offsetPage } from './offset-page.js';

export const companyDepartmentsListTool = defineTool({
  name: 'company_departments_list',
  module: 'company',
  title: 'Отделы компании',
  description:
    'Список подразделений оргструктуры (department.get): ID, название, родитель, руководитель и stateHash для изменений. ' +
    'Использовать, чтобы найти ID отдела, построить дерево (parentId) или получить expectedStateHash перед ' +
    'company_department_update/delete. Фильтры: id — один отдел, parentId — прямые подотделы. ' +
    'Команды и матричные связи новой оргструктуры этим методом не покрываются.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      id: idSchema.optional().describe('Только отдел с этим ID'),
      parentId: idSchema.optional().describe('Только прямые подотделы этого отдела'),
      ...pageArgsShape,
    })
    .strict(),
  outputDataSchema: z.object({
    items: z.array(
      z.object({
        id: z.number(),
        name: z.string(),
        sort: z.number().nullable(),
        parentId: z.number().nullable(),
        headId: z.number().nullable(),
        headName: z.string().nullable(),
        stateHash: z.string(),
      }),
    ),
    returnedCount: z.number(),
    total: z.number().nullable(),
  }),
  handler: async (args, ctx) => {
    const pageSize = pageSizeOf(ctx, args.pageSize);
    const params: JsonObject = { sort: 'ID', order: 'ASC' };
    if (args.id !== undefined) params['ID'] = args.id;
    if (args.parentId !== undefined) params['PARENT'] = args.parentId;
    const page = await offsetPage(ctx, {
      tool: 'company_departments_list',
      method: 'department.get',
      params,
      startKey: 'START',
      bindingParts: { id: args.id ?? null, parentId: args.parentId ?? null },
      pageSize,
      cursor: args.cursor,
    });
    const deps = page.items.map(normalizeDepartment).filter((d): d is Department => d !== undefined);
    const warnings: string[] = [];
    let heads = new Map<number, string>();
    try {
      heads = await employeeNames(
        ctx,
        deps.map((d) => d.headId).filter((h): h is number => h !== null),
      );
    } catch {
      warnings.push('Имена руководителей недоступны (scope user/права); показаны только ID');
    }
    if (deps.some((d) => d.headId === null))
      warnings.push('headId=null: руководитель не назначен или портал не вернул UF_HEAD');
    return ok(
      {
        items: deps.map((d) => ({
          ...d,
          headName: d.headId !== null ? (heads.get(d.headId) ?? null) : null,
          stateHash: departmentStateHash(d),
        })),
        returnedCount: deps.length,
        total: page.total ?? null,
      },
      pageMeta(ctx, 'department.get', page, 'legacy', warnings),
    );
  },
});

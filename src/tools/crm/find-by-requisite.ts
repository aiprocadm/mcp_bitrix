/** Exact INN lookup in requisites: no name guessing and no writes. */
import { z } from 'zod';
import { ok } from '../../mcp/result.js';
import { pageArgsShape } from '../../schemas/common.js';
import { isObj, legacyListPage, pageMeta, pageSizeOf } from '../shared.js';
import { defineTool, READ_ANNOTATIONS } from '../types.js';

const SELECT = ['ID', 'ENTITY_TYPE_ID', 'ENTITY_ID', 'NAME', 'RQ_COMPANY_NAME', 'RQ_INN'];

export const crmFindByRequisiteTool = defineTool({
  name: 'crm_find_by_requisite',
  module: 'crm',
  title: 'Найти клиента по ИНН в реквизитах',
  description:
    'Точный поиск по ИНН через crm.requisite.list. Использовать, когда известен ИНН клиента: ' +
    'возвращает ID реквизита и владельца без поиска по названию. Несколько совпадений остаются отдельными; ' +
    'владельцы: компания (4, по умолчанию) или контакт (3). Продолжение по cursor, паспортные поля не выдаются.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      inn: z
        .string()
        .regex(/^(?:[0-9]{10}|[0-9]{12})$/)
        .describe('ИНН: строка из 10 или 12 цифр'),
      ownerEntityTypeId: z.union([z.literal(3), z.literal(4)]).default(4),
      ...pageArgsShape,
    })
    .strict(),
  outputDataSchema: z.object({
    inn: z.string(),
    ownerEntityTypeId: z.number(),
    items: z.array(z.record(z.string(), z.unknown())),
    returnedCount: z.number(),
    matchBasis: z.literal('exact_requisite_inn'),
  }),
  handler: async (args, ctx) => {
    const page = await legacyListPage(ctx, {
      tool: 'crm_find_by_requisite',
      method: 'crm.requisite.list',
      params: {
        filter: { RQ_INN: args.inn, ENTITY_TYPE_ID: args.ownerEntityTypeId },
        select: SELECT,
        order: { ID: 'ASC' },
      },
      bindingParts: { inn: args.inn, ownerEntityTypeId: args.ownerEntityTypeId },
      pageSize: pageSizeOf(ctx, args.pageSize),
      cursor: args.cursor,
    });
    // A portal can ignore select and return additional fields.
    const allowed = new Set(SELECT);
    const items = page.items
      .filter(isObj)
      .map((r) => Object.fromEntries(Object.entries(r).filter(([key]) => allowed.has(key))));
    return ok(
      {
        inn: args.inn,
        ownerEntityTypeId: args.ownerEntityTypeId,
        items,
        returnedCount: items.length,
        matchBasis: 'exact_requisite_inn',
      },
      pageMeta(ctx, 'crm.requisite.list', page),
    );
  },
});

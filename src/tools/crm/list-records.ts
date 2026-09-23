import { z } from 'zod';
import { ok } from '../../mcp/result.js';
import { pageArgsShape } from '../../schemas/common.js';
import { defineTool, READ_ANNOTATIONS } from '../types.js';
import { validateFilter, validateOrder, validateSelect } from './deal-fields.js';
import { getDealFieldsMeta, listDeals } from './deal-service.js';

const scalar = z.union([z.string().max(500), z.number(), z.boolean()]);

export const crmListRecordsTool = defineTool({
  name: 'crm_list_records',
  module: 'crm',
  title: 'Список записей CRM',
  description:
    'Страница записей CRM (в MVP — сделки) с фильтром, сортировкой и выбором полей. ' +
    'Использовать, когда нужен список сделок по условию: стадия, ответственный, даты, часть названия. ' +
    'Ключи фильтра — как в Bitrix24: ИМЯ_ПОЛЯ с префиксом (=, %, >, <, >=, <=, !, @, ><), например {">=DATE_CREATE": "2026-09-01", "%TITLE": "договор"}. ' +
    'Поля проверяются по схеме портала (crm_fields_get). Одна страница до 50 записей; продолжение — по cursor из ответа.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      entityType: z.literal('deal').describe('Тип сущности; в MVP только deal'),
      filter: z
        .record(z.string().max(120), z.union([scalar, z.array(scalar).max(100)]))
        .default({})
        .describe('Условия фильтра Bitrix24; поля из схемы портала'),
      order: z
        .record(z.string().max(100), z.enum(['ASC', 'DESC', 'asc', 'desc']))
        .default({ ID: 'DESC' })
        .describe('Сортировка, например {"DATE_CREATE": "DESC"}'),
      select: z
        .array(z.string().max(100))
        .max(100)
        .optional()
        .describe(
          'Поля в ответе; по умолчанию ID, TITLE, STAGE_ID, CATEGORY_ID, ASSIGNED_BY_ID, OPPORTUNITY, CURRENCY_ID, DATE_CREATE',
        ),
      ...pageArgsShape,
    })
    .strict(),
  outputDataSchema: z.object({
    entityType: z.literal('deal'),
    items: z.array(z.record(z.string(), z.unknown())),
    returnedCount: z.number(),
    upstreamTotal: z.number().optional(),
  }),
  handler: async (args, ctx) => {
    const meta = await getDealFieldsMeta(ctx);
    const filter = validateFilter(args.filter, meta);
    const order = validateOrder(args.order, meta);
    const select = validateSelect(
      args.select ?? [
        'ID',
        'TITLE',
        'STAGE_ID',
        'CATEGORY_ID',
        'ASSIGNED_BY_ID',
        'OPPORTUNITY',
        'CURRENCY_ID',
        'DATE_CREATE',
      ],
      meta,
    );
    const pageSize = Math.min(
      args.pageSize ?? ctx.config.limits.defaultPageSize,
      ctx.config.limits.maxPageSize,
    );
    const page = await listDeals(ctx, { filter, order, select, pageSize, cursor: args.cursor });
    return ok(
      {
        entityType: 'deal' as const,
        items: page.items as Record<string, unknown>[],
        returnedCount: page.items.length,
        ...(page.upstreamTotal !== undefined ? { upstreamTotal: page.upstreamTotal } : {}),
      },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: 'crm.deal.list',
        apiVersion: 'legacy',
        page: { nextCursor: page.nextCursor, hasMore: page.hasMore },
        completeness: page.hasMore ? 'partial' : 'complete',
        warnings: page.upstreamCalls === 0 ? ['Страница отдана из буфера предыдущего запроса к порталу'] : [],
      },
    );
  },
});

import { z } from 'zod';
import { ok } from '../../mcp/result.js';
import { pageArgsShape } from '../../schemas/common.js';
import { defineTool, READ_ANNOTATIONS } from '../types.js';
import { validateFilter, validateOrder, validateSelect } from './deal-fields.js';
import { getFieldsMeta, listRecords } from './crm-service.js';
import {
  entityTypeIdSchema,
  itemListEnvelope,
  recordEntityTypeSchema,
  resolveRecordTarget,
} from './item-ops.js';

const scalar = z.union([z.string().max(500), z.number(), z.boolean()]);

export const crmListRecordsTool = defineTool({
  name: 'crm_list_records',
  module: 'crm',
  title: 'Список записей CRM',
  description:
    'Страница записей CRM (сделки, лиды, контакты, компании, элементы смарт-процессов, новые счета) с фильтром, сортировкой и выбором полей. ' +
    'Использовать, когда нужен список записей по условию: стадия, ответственный, даты, часть названия. ' +
    'Классика (crm.<entity>.list): ключи ИМЯ_ПОЛЯ с префиксом (=, %, >, <, >=, <=, !, @, ><), например {">=DATE_CREATE": "2026-09-01", "%TITLE": "договор"}. ' +
    'smart (нужен entityTypeId) и invoice идут через crm.item.list: поля camelCase, например {">=createdTime": "2026-09-01", "%title": "договор"}; регистр автоматически не переводится. ' +
    'Поля проверяются по схеме портала (crm_fields_get). Одна страница до 50 записей; продолжение — по cursor из ответа.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      entityType: recordEntityTypeSchema,
      entityTypeId: entityTypeIdSchema.optional(),
      filter: z
        .record(z.string().max(120), z.union([scalar, z.array(scalar).max(100)]))
        .default({})
        .describe('Условия фильтра Bitrix24; поля из схемы портала'),
      order: z
        .record(z.string().max(100), z.enum(['ASC', 'DESC', 'asc', 'desc']))
        .optional()
        .describe(
          'Сортировка, например {"DATE_CREATE": "DESC"} (smart/invoice: {"createdTime": "DESC"}); по умолчанию ID по убыванию',
        ),
      select: z
        .array(z.string().max(100))
        .max(100)
        .optional()
        .describe(
          'Поля в ответе; по умолчанию ключевые поля сущности (ID, название/имя, стадия, ответственный, даты)',
        ),
      ...pageArgsShape,
    })
    .strict(),
  outputDataSchema: z.object({
    entityType: recordEntityTypeSchema,
    entityTypeId: z.number().optional(),
    items: z.array(z.record(z.string(), z.unknown())),
    returnedCount: z.number(),
    upstreamTotal: z.number().optional(),
  }),
  handler: async (args, ctx) => {
    const resolved = await resolveRecordTarget(ctx, args.entityType, args.entityTypeId);
    if (resolved.kind === 'item') {
      return itemListEnvelope(
        ctx,
        resolved.target,
        { tool: 'crm_list_records', ...args },
        { entityType: args.entityType, entityTypeId: resolved.target.entityTypeId },
      );
    }
    const entity = resolved.entity;
    const meta = await getFieldsMeta(ctx, entity);
    const filter = validateFilter(args.filter, meta);
    const order = validateOrder(args.order ?? { ID: 'DESC' }, meta);
    const select = validateSelect(args.select ?? [...entity.defaultSelect], meta);
    const pageSize = Math.min(
      args.pageSize ?? ctx.config.limits.defaultPageSize,
      ctx.config.limits.maxPageSize,
    );
    const page = await listRecords(ctx, entity, { filter, order, select, pageSize, cursor: args.cursor });
    return ok(
      {
        entityType: entity.type,
        items: page.items as Record<string, unknown>[],
        returnedCount: page.items.length,
        ...(page.upstreamTotal !== undefined ? { upstreamTotal: page.upstreamTotal } : {}),
      },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: `${entity.methodBase}.list`,
        apiVersion: 'legacy',
        page: { nextCursor: page.nextCursor, hasMore: page.hasMore },
        completeness: page.hasMore ? 'partial' : 'complete',
        warnings: page.upstreamCalls === 0 ? ['Страница отдана из буфера предыдущего запроса к порталу'] : [],
      },
    );
  },
});

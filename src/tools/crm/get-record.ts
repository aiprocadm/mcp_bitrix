import { z } from 'zod';
import { ok } from '../../mcp/result.js';
import { defineTool, READ_ANNOTATIONS } from '../types.js';
import { validateSelect } from './deal-fields.js';
import { dealStateHash, getDeal, getDealFieldsMeta, pickFields } from './deal-service.js';

export const crmGetRecordTool = defineTool({
  name: 'crm_get_record',
  module: 'crm',
  title: 'Карточка записи CRM',
  description:
    'Карточка записи CRM по ID (в MVP — сделка) в рамках доступных полей. Использовать, когда известен ID и нужны поля сделки. ' +
    'Возвращает stateHash для последующих изменений (expectedStateHash). Связанные блоки (дела, комментарии, товары) ' +
    'через include появятся в полной версии; бинарные вложения не скачиваются.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      entityType: z.literal('deal').describe('Тип сущности; в MVP только deal'),
      id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).describe('ID сделки'),
      select: z
        .array(z.string().max(100))
        .max(100)
        .optional()
        .describe('Ограничить набор полей; по умолчанию все доступные'),
    })
    .strict(),
  outputDataSchema: z.object({
    entityType: z.literal('deal'),
    id: z.number(),
    record: z.record(z.string(), z.unknown()),
    stateHash: z.string(),
  }),
  handler: async (args, ctx) => {
    if (args.select) validateSelect(args.select, await getDealFieldsMeta(ctx));
    const record = await getDeal(ctx, args.id);
    return ok(
      {
        entityType: 'deal' as const,
        id: args.id,
        record: pickFields(record, args.select),
        stateHash: dealStateHash(record),
      },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: 'crm.deal.get',
        apiVersion: 'legacy',
      },
    );
  },
});

import { z } from 'zod';
import { ok } from '../../mcp/result.js';
import { defineTool, READ_ANNOTATIONS } from '../types.js';
import { describeFields } from './deal-fields.js';
import { getDealFieldsMeta } from './deal-service.js';

export const crmFieldsGetTool = defineTool({
  name: 'crm_fields_get',
  module: 'crm',
  title: 'Схема полей CRM',
  description:
    'Схема полей сущности CRM с портала: имя, тип, обязательность, только-чтение, множественность, варианты списков. ' +
    'Использовать перед crm_create_record и при ошибке VALIDATION_ERROR/UNKNOWN_FIELD, чтобы узнать точные имена ' +
    'и обязательные поля (включая пользовательские UF_CRM_*). В MVP поддерживается только entityType=deal.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      entityType: z.literal('deal').describe('Тип сущности; в MVP только deal'),
      refresh: z.boolean().default(false).describe('Игнорировать кэш (5 минут)'),
    })
    .strict(),
  outputDataSchema: z.object({
    entityType: z.literal('deal'),
    count: z.number(),
    required: z.array(z.string()),
    fields: z.array(
      z.object({
        name: z.string(),
        title: z.string(),
        type: z.string(),
        isRequired: z.boolean(),
        isReadOnly: z.boolean(),
        isMultiple: z.boolean(),
        items: z.array(z.object({ ID: z.string(), VALUE: z.string() })).optional(),
      }),
    ),
  }),
  handler: async (args, ctx) => {
    const meta = await getDealFieldsMeta(ctx, args.refresh);
    const fields = describeFields(meta);
    return ok(
      {
        entityType: 'deal' as const,
        count: fields.length,
        required: fields.filter((f) => f.isRequired && !f.isReadOnly).map((f) => f.name),
        fields,
      },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: 'crm.deal.fields',
        apiVersion: 'legacy',
      },
    );
  },
});

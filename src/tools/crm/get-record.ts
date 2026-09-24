import { z } from 'zod';
import { ok } from '../../mcp/result.js';
import { defineTool, READ_ANNOTATIONS } from '../types.js';
import { validateSelect } from './deal-fields.js';
import { classicEntity, entityTypeSchema, recordTitle } from './entities.js';
import { getFieldsMeta, getRecord, pickFields, recordStateHash } from './crm-service.js';

export const crmGetRecordTool = defineTool({
  name: 'crm_get_record',
  module: 'crm',
  title: 'Карточка записи CRM',
  description:
    'Карточка записи CRM (сделка, лид, контакт, компания) по ID в рамках доступных полей. Использовать, когда известен ID ' +
    'и нужны поля записи. Возвращает stateHash для последующих изменений (expectedStateHash в crm_update_record). ' +
    'Связанные блоки (дела, комментарии, товары, реквизиты) через include появятся следующими срезами; бинарные вложения не скачиваются.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      entityType: entityTypeSchema,
      id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).describe('ID записи'),
      select: z
        .array(z.string().max(100))
        .max(100)
        .optional()
        .describe('Ограничить набор полей; по умолчанию все доступные'),
    })
    .strict(),
  outputDataSchema: z.object({
    entityType: entityTypeSchema,
    id: z.number(),
    title: z.string(),
    record: z.record(z.string(), z.unknown()),
    stateHash: z.string(),
  }),
  handler: async (args, ctx) => {
    const entity = classicEntity(args.entityType);
    if (args.select) validateSelect(args.select, await getFieldsMeta(ctx, entity));
    const record = await getRecord(ctx, entity, args.id);
    return ok(
      {
        entityType: entity.type,
        id: args.id,
        title: recordTitle(entity, record),
        record: pickFields(record, args.select),
        stateHash: recordStateHash(record),
      },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: `${entity.methodBase}.get`,
        apiVersion: 'legacy',
      },
    );
  },
});

/**
 * crm_create_record (ТЗ §9.4, §10.1, §15.3): создание сделки через MutationExecutor.
 * План фиксирует портал, тип, название, категорию, стадию, ответственного и все поля;
 * после записи — get по ID и сверка ключевых полей.
 */
import { z } from 'zod';
import { ok } from '../../mcp/result.js';
import { requireIdempotencyUnlessDryRun, writeArgsShape } from '../../schemas/common.js';
import { CREATE_ANNOTATIONS, defineTool } from '../types.js';
import { asText, validateFieldsForWrite } from './deal-fields.js';
import { compareKeyFields, createDeal, getDeal, getDealFieldsMeta } from './deal-service.js';

const fieldValue = z.union([
  z.string().max(20_000),
  z.number(),
  z.boolean(),
  z.null(),
  z
    .array(z.union([z.string().max(20_000), z.number(), z.boolean(), z.record(z.string(), z.string())]))
    .max(100),
  z.record(z.string().max(50), z.string().max(1000)),
]);

export const crmCreateRecordTool = defineTool({
  name: 'crm_create_record',
  module: 'crm',
  title: 'Создать запись CRM',
  description:
    'Создать запись CRM (в MVP — сделку через crm.deal.add). Поля проверяются по схеме портала (crm_fields_get): ' +
    'неизвестные и read-only отклоняются, обязательные должны быть заполнены. ' +
    'Использовать, когда пользователь явно просит создать сделку. Порядок: вызов без approvalId возвращает APPROVAL_REQUIRED ' +
    'с operationId и планом — запись ещё не сделана; человек подтверждает план в терминале; повторный вызов с теми же ' +
    'параметрами и approvalId создаёт сделку ровно один раз. dryRun=true только показывает план. ' +
    'Могут сработать роботы и уведомления стадии.',
  operation: 'create',
  annotations: CREATE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      entityType: z.literal('deal').describe('Тип сущности; в MVP только deal'),
      fields: z
        .record(z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/, 'имена полей — ВЕРХНИЙ_РЕГИСТР'), fieldValue)
        .describe(
          'Поля сделки по схеме портала: TITLE обязателен; CATEGORY_ID, STAGE_ID, ASSIGNED_BY_ID, OPPORTUNITY, CURRENCY_ID, UF_CRM_*',
        ),
      ...writeArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({
    entityType: z.literal('deal'),
    dryRun: z.boolean().optional(),
    plan: z.record(z.string(), z.unknown()).optional(),
    validationLevel: z.string().optional(),
    id: z.number().nullable().optional(),
    operationId: z.string().optional(),
    verified: z.boolean().optional(),
    replayed: z.boolean().optional(),
    record: z.record(z.string(), z.unknown()).optional(),
  }),
  handler: async (args, ctx) => {
    const meta = await getDealFieldsMeta(ctx);
    const fields = validateFieldsForWrite(args.fields, meta, 'create');
    const risks = ['Могут сработать роботы/бизнес-процессы и уведомления стадии сделки'];
    if (!('CATEGORY_ID' in fields))
      risks.push('CATEGORY_ID не указан: сделка попадёт в воронку по умолчанию');
    if (!('STAGE_ID' in fields)) risks.push('STAGE_ID не указан: стадия по умолчанию для воронки');
    if (!('ASSIGNED_BY_ID' in fields))
      risks.push('ASSIGNED_BY_ID не указан: ответственным станет владелец вебхука');

    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: {
        id: ctx.principal.id,
        portalKey: ctx.bitrix.auth.portalKey,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
      },
      tool: 'crm_create_record',
      operationKind: 'create',
      args: { ...args, fields },
      summary: {
        action: `Создать сделку «${asText(fields['TITLE'])}»`,
        target: 'crm.deal',
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: { entityType: 'deal', method: 'crm.deal.add', fields },
        risks,
      },
      validationLevel: 'local+metadata',
      perform: async () => {
        const id = await createDeal(ctx, fields);
        return { id, result: { id } };
      },
      verify: async (performed) => {
        const record = await getDeal(ctx, Number(performed.id));
        const cmp = compareKeyFields(fields, record);
        return cmp;
      },
    });

    if (outcome.kind === 'dry-run') {
      return ok(
        {
          entityType: 'deal' as const,
          dryRun: true,
          plan: outcome.plan,
          validationLevel: outcome.validationLevel,
        },
        {
          requestId: ctx.requestId,
          durationMs: Date.now() - ctx.startedAt,
          warnings: ['dryRun: запись не выполнялась, подтверждение не создано'],
        },
      );
    }
    const id = typeof outcome.id === 'number' ? outcome.id : null;
    let record: Record<string, unknown> | undefined;
    if (id !== null && !outcome.replayed) {
      try {
        const full = await getDeal(ctx, id);
        record = {
          ID: full['ID'],
          TITLE: full['TITLE'],
          STAGE_ID: full['STAGE_ID'],
          CATEGORY_ID: full['CATEGORY_ID'],
          ASSIGNED_BY_ID: full['ASSIGNED_BY_ID'],
        };
      } catch {
        record = undefined;
      }
    }
    return ok(
      {
        entityType: 'deal' as const,
        id,
        operationId: outcome.operationId,
        verified: outcome.verified,
        replayed: outcome.replayed,
        ...(record ? { record } : {}),
      },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: 'crm.deal.add',
        apiVersion: 'legacy',
        warnings: outcome.warnings,
        completeness: outcome.verified ? 'complete' : 'unknown',
      },
    );
  },
});

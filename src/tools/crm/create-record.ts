/**
 * crm_create_record (ТЗ §9.4, §15.3): создание записи классического CRM через MutationExecutor.
 * План фиксирует портал, тип, название, ключевые поля и все поля целиком; стадия/статус проверяются
 * по справочнику до плана (INVALID_STAGE); после записи — get по ID и сверка ключевых полей.
 */
import { z } from 'zod';
import { ok } from '../../mcp/result.js';
import { requireIdempotencyUnlessDryRun, writeArgsShape } from '../../schemas/common.js';
import { CREATE_ANNOTATIONS, defineTool } from '../types.js';
import { asText, validateFieldsForWrite } from './deal-fields.js';
import { recordTitle, type ClassicEntity } from './entities.js';
import { assertStageValid, compareFields, createRecord, getFieldsMeta, getRecord } from './crm-service.js';
import {
  entityTypeIdSchema,
  itemCreateEnvelope,
  recordEntityTypeSchema,
  resolveRecordTarget,
} from './item-ops.js';

export const crmFieldValue = z.union([
  z.string().max(20_000),
  z.number(),
  z.boolean(),
  z.null(),
  z
    .array(z.union([z.string().max(20_000), z.number(), z.boolean(), z.record(z.string(), z.string())]))
    .max(100),
  z.record(z.string().max(50), z.string().max(1000)),
]);

export const crmFieldsSchema = z
  .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,99}$/, 'имя поля: буквы, цифры, _'), crmFieldValue)
  .describe(
    'Поля по схеме портала (crm_fields_get): классический CRM — ВЕРХНИЙ_РЕГИСТР (TITLE, UF_CRM_*); ' +
      'smart/invoice (crm.item.*) — camelCase (title, stageId, ufCrm5_…). Регистр автоматически не переводится',
  );

function createRisks(entity: ClassicEntity, fields: Record<string, unknown>): string[] {
  const risks = ['Могут сработать роботы/бизнес-процессы и уведомления'];
  if (entity.type === 'deal') {
    if (!('CATEGORY_ID' in fields))
      risks.push('CATEGORY_ID не указан: сделка попадёт в воронку по умолчанию');
    if (!('STAGE_ID' in fields)) risks.push('STAGE_ID не указан: стадия по умолчанию для воронки');
  }
  if (entity.type === 'lead' && !('STATUS_ID' in fields))
    risks.push('STATUS_ID не указан: статус лида по умолчанию');
  if (!('ASSIGNED_BY_ID' in fields))
    risks.push('ASSIGNED_BY_ID не указан: ответственным станет владелец вебхука');
  if (entity.type === 'contact' || entity.type === 'company') {
    risks.push(
      'Дубли не проверяются автоматически: перед созданием стоит выполнить crm_search_records по телефону/email',
    );
  }
  return risks;
}

export const crmCreateRecordTool = defineTool({
  name: 'crm_create_record',
  module: 'crm',
  title: 'Создать запись CRM',
  description:
    'Создать запись CRM: сделку, лид, контакт, компанию (crm.<entity>.add, поля ВЕРХНИЙ_РЕГИСТР) либо элемент смарт-процесса ' +
    '(entityType=smart + entityTypeId) или новый счёт (invoice) через crm.item.add (поля camelCase). Поля проверяются по схеме портала ' +
    '(crm_fields_get): неизвестные и read-only отклоняются, обязательные должны быть заполнены, стадия/статус — по справочнику. ' +
    'Использовать, когда пользователь явно просит создать запись. Порядок: вызов без approvalId возвращает APPROVAL_REQUIRED ' +
    'с operationId и планом — запись ещё не сделана; человек подтверждает план (CLI или панель); повторный вызов с теми же ' +
    'параметрами и approvalId создаёт запись ровно один раз. dryRun=true только показывает план. Могут сработать роботы и уведомления.',
  operation: 'create',
  annotations: CREATE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      entityType: recordEntityTypeSchema,
      entityTypeId: entityTypeIdSchema.optional(),
      fields: crmFieldsSchema,
      ...writeArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({
    entityType: recordEntityTypeSchema,
    entityTypeId: z.number().optional(),
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
    const resolved = await resolveRecordTarget(ctx, args.entityType, args.entityTypeId);
    if (resolved.kind === 'item') {
      const { envelope } = await itemCreateEnvelope(ctx, resolved.target, {
        tool: 'crm_create_record',
        rawFields: args.fields,
        args,
        base: { entityType: args.entityType, entityTypeId: resolved.target.entityTypeId },
      });
      return envelope;
    }
    const entity: ClassicEntity = resolved.entity;
    const meta = await getFieldsMeta(ctx, entity);
    const fields = validateFieldsForWrite(args.fields, meta, 'create');
    await assertStageValid(ctx, entity, fields, undefined);
    const title = recordTitle(entity, fields) || asText(fields['TITLE']);
    const method = `${entity.methodBase}.add`;

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
        action: `Создать ${entity.labelAccusative} «${title}»`,
        target: entity.methodBase,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: { entityType: entity.type, method, fields },
        risks: createRisks(entity, fields),
      },
      validationLevel: 'local+metadata',
      perform: async () => {
        const id = await createRecord(ctx, entity, fields);
        return { id, result: { id } };
      },
      verify: async (performed) => {
        const record = await getRecord(ctx, entity, Number(performed.id));
        return compareFields(entity, fields, record);
      },
    });

    if (outcome.kind === 'dry-run') {
      return ok(
        {
          entityType: entity.type,
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
        const full = await getRecord(ctx, entity, id);
        record = { ID: full['ID'], title: recordTitle(entity, full) };
        for (const key of entity.keyFields) if (full[key] !== undefined) record[key] = full[key];
      } catch {
        record = undefined;
      }
    }
    return ok(
      {
        entityType: entity.type,
        id,
        operationId: outcome.operationId,
        verified: outcome.verified,
        replayed: outcome.replayed,
        ...(record ? { record } : {}),
      },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method,
        apiVersion: 'legacy',
        warnings: outcome.warnings,
        completeness: outcome.verified ? 'complete' : 'unknown',
      },
    );
  },
});

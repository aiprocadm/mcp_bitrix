/**
 * crm_update_record (ТЗ §9.4, §8.2, §15.3): изменение полей записи классического CRM через MutationExecutor.
 * До плана: поля по схеме (update-режим: immutable отклоняются), текущая запись читается, expectedStateHash
 * сверяется (CONFLICT), стадия — по справочнику (INVALID_STAGE). План показывает diff «было → станет».
 * Перед записью precheck повторно сверяет состояние; после — get и сверка всех запрошенных полей.
 */
import { z } from 'zod';
import { AppError } from '../../errors/app-error.js';
import { ok } from '../../mcp/result.js';
import { requireIdempotencyUnlessDryRun, updateArgsShape } from '../../schemas/common.js';
import { defineTool, UPDATE_ANNOTATIONS } from '../types.js';
import { validateFieldsForWrite } from './deal-fields.js';
import { recordTitle, type ClassicEntity } from './entities.js';
import {
  assertStageValid,
  compareFields,
  getFieldsMeta,
  getRecord,
  recordStateHash,
  updateRecord,
  type CrmRecord,
} from './crm-service.js';
import { crmFieldsSchema } from './create-record.js';
import {
  entityTypeIdSchema,
  itemUpdateEnvelope,
  recordEntityTypeSchema,
  resolveRecordTarget,
} from './item-ops.js';

function updateRisks(entity: ClassicEntity, fields: Record<string, unknown>, current: CrmRecord): string[] {
  const risks = ['Могут сработать роботы/бизнес-процессы и уведомления об изменении'];
  if (
    entity.stageField &&
    entity.stageField in fields &&
    fields[entity.stageField] !== current[entity.stageField]
  ) {
    risks.push(`Смена ${entity.stageField} запускает автоматизацию стадии и меняет воронку/отчёты`);
  }
  if ('ASSIGNED_BY_ID' in fields && fields['ASSIGNED_BY_ID'] !== current['ASSIGNED_BY_ID']) {
    risks.push('Смена ответственного: уведомление новому ответственному, права старого могут измениться');
  }
  if ('CATEGORY_ID' in fields && fields['CATEGORY_ID'] !== current['CATEGORY_ID']) {
    risks.push('Перенос в другую воронку сбрасывает стадию по правилам портала');
  }
  return risks;
}

export const crmUpdateRecordTool = defineTool({
  name: 'crm_update_record',
  module: 'crm',
  title: 'Изменить запись CRM',
  description:
    'Изменить поля записи CRM: сделка, лид, контакт, компания (crm.<entity>.update, поля ВЕРХНИЙ_РЕГИСТР), элемент смарт-процесса ' +
    '(entityType=smart + entityTypeId) или новый счёт (invoice) через crm.item.update (поля camelCase). ' +
    'Использовать, когда пользователь явно просит изменить конкретные поля существующей записи; передавайте только изменяемые поля. ' +
    'Рекомендуется expectedStateHash из crm_get_record: при изменении записи кем-то ещё будет CONFLICT, а не тихая перезапись. ' +
    'Стадия/статус проверяются по справочнику портала. Порядок: вызов без approvalId возвращает APPROVAL_REQUIRED с планом ' +
    '(diff «было → станет»); человек подтверждает; повторный вызов с теми же параметрами и approvalId применяет изменение один раз.',
  operation: 'update',
  annotations: UPDATE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      entityType: recordEntityTypeSchema,
      entityTypeId: entityTypeIdSchema.optional(),
      id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).describe('ID записи'),
      fields: crmFieldsSchema,
      ...updateArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({
    entityType: recordEntityTypeSchema,
    entityTypeId: z.number().optional(),
    id: z.number(),
    dryRun: z.boolean().optional(),
    plan: z.record(z.string(), z.unknown()).optional(),
    validationLevel: z.string().optional(),
    operationId: z.string().optional(),
    verified: z.boolean().optional(),
    replayed: z.boolean().optional(),
    changedFields: z.array(z.string()).optional(),
    stateHash: z.string().optional(),
  }),
  handler: async (args, ctx) => {
    const resolved = await resolveRecordTarget(ctx, args.entityType, args.entityTypeId);
    if (resolved.kind === 'item') {
      return itemUpdateEnvelope(ctx, resolved.target, {
        tool: 'crm_update_record',
        id: args.id,
        rawFields: args.fields,
        args,
        base: { entityType: args.entityType, entityTypeId: resolved.target.entityTypeId },
      });
    }
    const entity: ClassicEntity = resolved.entity;
    const meta = await getFieldsMeta(ctx, entity);
    const fields = validateFieldsForWrite(args.fields, meta, 'update');
    const current = await getRecord(ctx, entity, args.id);
    const currentHash = recordStateHash(current);
    // При вызове с approvalId сверку делает исполнитель (mismatch/replay) и precheck перед записью;
    // ранний отказ здесь сорвал бы replay уже выполненной операции (после записи хеш закономерно другой).
    if (!args.approvalId && args.expectedStateHash && args.expectedStateHash !== currentHash) {
      throw new AppError('CONFLICT', 'Запись изменилась после чтения: expectedStateHash не совпадает', {
        field: 'expectedStateHash',
        reason: 'STATE_CHANGED',
        nextAction: 'Прочитайте запись заново (crm_get_record) и повторите с новым stateHash',
      });
    }
    await assertStageValid(ctx, entity, fields, current);
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [k, v] of Object.entries(fields)) changes[k] = { from: current[k] ?? null, to: v };
    const method = `${entity.methodBase}.update`;
    const title = recordTitle(entity, current);

    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: {
        id: ctx.principal.id,
        portalKey: ctx.bitrix.auth.portalKey,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
      },
      tool: 'crm_update_record',
      operationKind: 'update',
      args: { ...args, fields },
      // Без expectedStateHash защиты от гонки нет (ТЗ §9.1: параметр необязателен) — план это указывает в рисках.
      expectedStateHash: args.expectedStateHash ?? null,
      summary: {
        action: `Изменить ${entity.labelAccusative} #${String(args.id)} «${title}»: ${Object.keys(fields).join(', ')}`,
        target: `${entity.methodBase}:${String(args.id)}`,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: { entityType: entity.type, method, id: args.id, changes },
        risks: updateRisks(entity, fields, current).concat(
          args.expectedStateHash
            ? []
            : [
                'expectedStateHash не передан: если запись изменят до выполнения, изменение всё равно применится',
              ],
        ),
      },
      validationLevel: 'local+metadata',
      // T14-класс: между подтверждением и записью объект мог измениться — сверяем состояние ещё раз.
      precheck: async () => {
        if (!args.expectedStateHash) return;
        const fresh = await getRecord(ctx, entity, args.id);
        if (recordStateHash(fresh) !== args.expectedStateHash) {
          throw new AppError('CONFLICT', 'Запись изменилась после подтверждения; изменение отменено', {
            reason: 'STATE_CHANGED',
            nextAction: 'Прочитайте запись заново и подготовьте новый план',
          });
        }
      },
      perform: async () => {
        await updateRecord(ctx, entity, args.id, fields);
        return { id: args.id, result: { id: args.id, changedFields: Object.keys(fields) } };
      },
      verify: async () => {
        const after = await getRecord(ctx, entity, args.id);
        const cmp = compareFields(entity, fields, after, Object.keys(fields));
        return { verified: cmp.warnings.length === 0, warnings: cmp.warnings };
      },
    });

    if (outcome.kind === 'dry-run') {
      return ok(
        {
          entityType: entity.type,
          id: args.id,
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
    let stateHash: string | undefined;
    if (!outcome.replayed) {
      try {
        stateHash = recordStateHash(await getRecord(ctx, entity, args.id));
      } catch {
        stateHash = undefined;
      }
    }
    return ok(
      {
        entityType: entity.type,
        id: args.id,
        operationId: outcome.operationId,
        verified: outcome.verified,
        replayed: outcome.replayed,
        changedFields: Object.keys(fields),
        ...(stateHash ? { stateHash } : {}),
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

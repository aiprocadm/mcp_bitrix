/**
 * crm_delete_record (ТЗ §9.4, §8.2, §11 п.8, этап 14): удаление одной записи CRM через MutationExecutor.
 * Инструмент виден только при ENABLE_DESTRUCTIVE_TOOLS=true и выполняется только ролью administrator
 * (register-tools). До плана запись читается (NOT_FOUND — без плана), план показывает, что именно удаляется
 * и последствия (impact); expectedStateHash → CONFLICT до плана и в precheck; после удаления — повторное чтение
 * должно дать NOT_FOUND (verified).
 */
import { z } from 'zod';
import type { JsonObject } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { requireIdempotencyUnlessDryRun, updateArgsShape } from '../../schemas/common.js';
import {
  asText,
  isObj,
  mutationOutputShape,
  mutationPrincipal,
  mutationResponse,
  outcomeUnknown,
} from '../shared.js';
import { defineTool, DESTRUCTIVE_ANNOTATIONS, type ToolContext } from '../types.js';
import { recordTitle, type ClassicEntity } from './entities.js';
import { getRecord, recordStateHash, type CrmRecord } from './crm-service.js';
import {
  entityTypeIdSchema,
  recordEntityTypeSchema,
  resolveRecordTarget,
  stateConflict,
  type RecordTarget,
} from './item-ops.js';
import { countOf, deleteItem, getItem, itemStateHash, itemTitle, type ItemTarget } from './item-service.js';

interface Snapshot {
  record: CrmRecord;
  hash: string;
  title: string;
  stage: string;
  amount: string;
  currency: string;
  assignedById: string;
}

async function readSnapshot(ctx: ToolContext, target: RecordTarget, id: number): Promise<Snapshot> {
  if (target.kind === 'classic') {
    const e = target.entity;
    const r = await getRecord(ctx, e, id);
    return {
      record: r,
      hash: recordStateHash(r),
      title: recordTitle(e, r),
      stage: e.stageField ? asText(r[e.stageField]) : '',
      amount: asText(r['OPPORTUNITY']),
      currency: asText(r['CURRENCY_ID']),
      assignedById: asText(r['ASSIGNED_BY_ID']),
    };
  }
  const r = await getItem(ctx, target.target, id);
  return {
    record: r,
    hash: itemStateHash(r),
    title: itemTitle(r),
    stage: asText(r['stageId']),
    amount: asText(r['opportunity']),
    currency: asText(r['currencyId']),
    assignedById: asText(r['assignedById']),
  };
}

const rowsOf = (result: unknown) => {
  const rows = isObj(result) ? result['productRows'] : undefined;
  return Array.isArray(rows) ? rows : undefined;
};

/**
 * Последствия удаления (только чтения, ошибки чтения не скрываются — «не удалось посчитать»).
 * Счётчики — total первой страницы соответствующего списка.
 */
async function impactOf(
  ctx: ToolContext,
  target: RecordTarget,
  id: number,
): Promise<{ impact: Record<string, unknown>; risks: string[] }> {
  const impact: Record<string, unknown> = {};
  const risks: string[] = [];
  const shown = (n: number | undefined) => n ?? 'не удалось посчитать';
  const ownerTypeId = target.kind === 'classic' ? target.entity.entityTypeId : target.target.entityTypeId;
  impact['activities'] = shown(
    await countOf(ctx, 'crm.activity.list', {
      filter: { OWNER_TYPE_ID: ownerTypeId, OWNER_ID: id },
      select: ['ID'],
    }),
  );
  if (target.kind === 'classic') {
    const e: ClassicEntity = target.entity;
    impact['timelineComments'] = shown(
      await countOf(ctx, 'crm.timeline.comment.list', {
        filter: { ENTITY_ID: id, ENTITY_TYPE: e.type },
        select: ['ID'],
      }),
    );
    if (e.type === 'deal' || e.type === 'lead') {
      impact['productRows'] = shown(
        await countOf(
          ctx,
          'crm.item.productrow.list',
          { filter: { '=ownerType': e.type === 'deal' ? 'D' : 'L', '=ownerId': id } },
          rowsOf,
        ),
      );
    }
    if (e.type === 'company' || e.type === 'contact') {
      const key = e.type === 'company' ? 'COMPANY_ID' : 'CONTACT_ID';
      const deals = await countOf(ctx, 'crm.deal.list', { filter: { [key]: id }, select: ['ID'] });
      impact['linkedDeals'] = shown(deals);
      if (deals === undefined || deals > 0) {
        risks.push(
          `Связанные сделки (${String(shown(deals))}) останутся без привязки к ${e.type === 'company' ? 'компании' : 'контакту'}`,
        );
      }
      if (e.type === 'company') {
        const contacts = await countOf(ctx, 'crm.contact.list', {
          filter: { COMPANY_ID: id },
          select: ['ID'],
        });
        impact['linkedContacts'] = shown(contacts);
        if (contacts === undefined || contacts > 0)
          risks.push(`Связанные контакты (${String(shown(contacts))}) потеряют привязку к компании`);
      }
    }
  } else {
    const t: ItemTarget = target.target;
    impact['productRows'] = shown(
      await countOf(
        ctx,
        'crm.item.productrow.list',
        { filter: { '=ownerType': t.ownerType, '=ownerId': id } },
        rowsOf,
      ),
    );
    if (t.smartType && !t.smartType.isRecyclebinEnabled)
      risks.push('У смарт-процесса выключена корзина: восстановить элемент после удаления будет нельзя');
  }
  impact['note'] =
    'Вместе с записью Bitrix24 удаляет её товарные позиции и записи таймлайна; дела, привязанные только к этой записи, ' +
    'удаляются, привязанные ещё к другим — остаются. При включённой корзине CRM запись может быть восстановлена из корзины';
  return { impact, risks };
}

async function performDelete(ctx: ToolContext, target: RecordTarget, id: number): Promise<void> {
  if (target.kind === 'item') {
    await deleteItem(ctx, target.target, id);
    return;
  }
  const method = `${target.entity.methodBase}.delete`;
  const r = await ctx.bitrix.call('legacy', method, { id }, { requestId: ctx.requestId, signal: ctx.signal });
  // Страницы crm.<entity>.delete: result=true при успехе; иное — исход неизвестен (удаление могло пройти).
  if (r.result !== true) throw outcomeUnknown(method, 'legacy', 'Проверьте запись в Bitrix24 и корзину CRM');
}

async function isGone(ctx: ToolContext, target: RecordTarget, id: number): Promise<boolean> {
  try {
    await readSnapshot(ctx, target, id);
    return false;
  } catch (e) {
    if (AppError.from(e).code === 'NOT_FOUND') return true;
    throw e;
  }
}

export const crmDeleteRecordTool = defineTool({
  name: 'crm_delete_record',
  module: 'crm',
  title: 'Удалить запись CRM',
  description:
    'Удалить одну запись CRM: сделку, лид, контакт, компанию (crm.<entity>.delete), элемент смарт-процесса (entityType=smart + entityTypeId) ' +
    'или новый счёт (invoice) через crm.item.delete. Использовать только по явной просьбе пользователя удалить конкретную запись. ' +
    'Доступно лишь при ENABLE_DESTRUCTIVE_TOOLS=true и роли administrator. Сначала запись читается: план показывает название, стадию, ' +
    'сумму, ответственного и последствия (дела, комментарии, товары; для компании/контакта — связанные сделки). ' +
    'Передавайте expectedStateHash из crm_get_record: при изменении записи будет CONFLICT. Вызов без approvalId возвращает ' +
    'APPROVAL_REQUIRED; человек подтверждает план; повтор с approvalId удаляет ровно эту запись один раз и проверяет, что её больше нет.',
  operation: 'delete',
  annotations: DESTRUCTIVE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      entityType: recordEntityTypeSchema,
      entityTypeId: entityTypeIdSchema.optional(),
      id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).describe('ID записи'),
      ...updateArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({
    entityType: recordEntityTypeSchema,
    entityTypeId: z.number().optional(),
    id: z.number(),
    deleted: z.boolean().optional(),
    ...mutationOutputShape,
  }),
  handler: async (args, ctx) => {
    const target = await resolveRecordTarget(ctx, args.entityType, args.entityTypeId);
    // NOT_FOUND без approvalId — отказ без плана и без подтверждения. С approvalId запись могла быть удалена
    // этой же операцией: решение (replay сохранённого результата или отказ) принимает исполнитель по ledger.
    let snap: Snapshot | undefined;
    try {
      snap = await readSnapshot(ctx, target, args.id);
    } catch (e) {
      if (!args.approvalId || AppError.from(e).code !== 'NOT_FOUND') throw e;
      snap = undefined;
    }
    if (snap && !args.approvalId && args.expectedStateHash && args.expectedStateHash !== snap.hash) {
      throw stateConflict(
        'Запись изменилась после чтения: expectedStateHash не совпадает; удаление не планируется',
      );
    }
    const { impact, risks } = snap ? await impactOf(ctx, target, args.id) : { impact: {}, risks: [] };
    const label = target.kind === 'classic' ? target.entity.labelAccusative : target.target.labelAccusative;
    const method = target.kind === 'classic' ? `${target.entity.methodBase}.delete` : 'crm.item.delete';
    const entityTypeId = target.kind === 'item' ? target.target.entityTypeId : undefined;
    const expected = args.expectedStateHash;
    const details: JsonObject = {
      entityType: args.entityType,
      id: args.id,
      method,
      title: snap?.title ?? '',
      stage: snap?.stage ?? '',
      amount: snap?.amount ?? '',
      currency: snap?.currency ?? '',
      assignedById: snap?.assignedById ?? '',
    };
    if (entityTypeId !== undefined) details['entityTypeId'] = entityTypeId;

    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: mutationPrincipal(ctx),
      tool: 'crm_delete_record',
      operationKind: 'delete',
      args,
      expectedStateHash: expected ?? null,
      summary: {
        action: `УДАЛИТЬ ${label} #${String(args.id)}${snap?.title ? ` «${snap.title}»` : ''}`,
        target: `${method}:${entityTypeId !== undefined ? `${String(entityTypeId)}:` : ''}${String(args.id)}`,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: { ...details, impact },
        risks: [
          'Необратимое действие через MCP: повторно создать запись с тем же ID нельзя',
          'Могут сработать роботы/бизнес-процессы и уведомления об удалении',
          ...risks,
          ...(expected
            ? []
            : [
                'expectedStateHash не передан: если запись изменят до выполнения, она всё равно будет удалена',
              ]),
        ],
      },
      validationLevel: 'local+metadata',
      precheck: async () => {
        const fresh = await readSnapshot(ctx, target, args.id);
        if (expected && fresh.hash !== expected) {
          throw new AppError('CONFLICT', 'Запись изменилась после подтверждения; удаление отменено', {
            reason: 'STATE_CHANGED',
            nextAction: 'Прочитайте запись заново и подготовьте новый план',
          });
        }
      },
      perform: async () => {
        await performDelete(ctx, target, args.id);
        return { id: args.id, result: { id: args.id, deleted: true } };
      },
      verify: async () => {
        const gone = await isGone(ctx, target, args.id);
        return {
          verified: gone,
          warnings: gone ? [] : ['После удаления запись по-прежнему читается: проверьте её в Bitrix24'],
        };
      },
    });
    return mutationResponse(ctx, outcome, {
      base: {
        entityType: args.entityType,
        ...(entityTypeId !== undefined ? { entityTypeId } : {}),
        id: args.id,
      },
      method,
      resultFields: ['deleted'],
    });
  },
});

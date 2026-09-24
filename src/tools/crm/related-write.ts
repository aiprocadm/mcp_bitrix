/**
 * Записи связанных данных CRM (ТЗ §9.4, §8.2, T32): crm_timeline_comment_add и crm_deal_products_replace.
 * Обе — через MutationExecutor: план → подтверждение человеком → одна запись → сверка.
 * Полная замена товаров показывает, что удалится и что добавится, денежный итог «было → станет»;
 * пустой список без allowEmpty=true отклоняется до плана (EMPTY_REPLACEMENT_BLOCKED).
 */
import { z } from 'zod';
import { AppError } from '../../errors/app-error.js';
import { ok } from '../../mcp/result.js';
import { requireIdempotencyUnlessDryRun, updateArgsShape, writeArgsShape } from '../../schemas/common.js';
import { CREATE_ANNOTATIONS, defineTool, DESTRUCTIVE_ANNOTATIONS } from '../types.js';
import { asText } from './deal-fields.js';
import { classicEntity, entityTypeSchema, recordTitle } from './entities.js';
import { getRecord } from './crm-service.js';
import {
  addComment,
  getComment,
  listAllDealRows,
  rowsStateHash,
  rowsTotal,
  rowToBitrix,
  setDealRows,
  type ProductRow,
  type RowInput,
} from './related-service.js';

const recordId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

// ---------- crm_timeline_comment_add ----------

export const crmTimelineCommentAddTool = defineTool({
  name: 'crm_timeline_comment_add',
  module: 'crm',
  title: 'Комментарий в таймлайн CRM',
  description:
    'Добавить текстовый комментарий в таймлайн записи CRM (сделка, лид, контакт, компания) через crm.timeline.comment.add. ' +
    'Использовать, когда пользователь явно просит оставить комментарий по сделке или клиенту. Вложения не поддерживаются. ' +
    'Порядок: вызов без approvalId возвращает APPROVAL_REQUIRED с планом и полным текстом; человек подтверждает; ' +
    'повторный вызов с теми же параметрами и approvalId добавляет комментарий ровно один раз.',
  operation: 'create',
  annotations: CREATE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      entityType: entityTypeSchema,
      recordId: recordId.describe('ID записи'),
      text: z.string().trim().min(1).max(10_000).describe('Текст комментария (до 10000 символов)'),
      ...writeArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({
    entityType: entityTypeSchema,
    recordId: z.number(),
    dryRun: z.boolean().optional(),
    plan: z.record(z.string(), z.unknown()).optional(),
    validationLevel: z.string().optional(),
    commentId: z.number().nullable().optional(),
    operationId: z.string().optional(),
    verified: z.boolean().optional(),
    replayed: z.boolean().optional(),
  }),
  handler: async (args, ctx) => {
    const entity = classicEntity(args.entityType);
    // Запись должна существовать и быть доступной до плана: иначе NOT_FOUND без подготовки операции.
    const record = await getRecord(ctx, entity, args.recordId);
    const title = recordTitle(entity, record);
    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: {
        id: ctx.principal.id,
        portalKey: ctx.bitrix.auth.portalKey,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
      },
      tool: 'crm_timeline_comment_add',
      operationKind: 'create',
      args,
      summary: {
        action: `Добавить комментарий в таймлайн: ${entity.label} #${String(args.recordId)} «${title}»`,
        target: `${entity.methodBase}:${String(args.recordId)}`,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: {
          entityType: entity.type,
          recordId: args.recordId,
          method: 'crm.timeline.comment.add',
          text: args.text,
        },
        risks: [
          'Комментарий увидят все, у кого есть доступ к записи',
          'Упоминания сотрудников в тексте могут отправить им уведомления',
        ],
      },
      validationLevel: 'local',
      perform: async () => {
        const id = await addComment(ctx, entity, args.recordId, args.text);
        return { id, result: { commentId: id } };
      },
      verify: async (performed) => {
        const saved = await getComment(ctx, Number(performed.id));
        const warnings: string[] = [];
        if (asText(saved['ENTITY_ID']) !== String(args.recordId))
          warnings.push('Комментарий привязан не к той записи');
        if (asText(saved['COMMENT']).trim() !== args.text)
          warnings.push('Текст в портале отличается от отправленного (возможна обработка BB-кодов)');
        return { verified: warnings.length === 0, warnings };
      },
    });
    if (outcome.kind === 'dry-run') {
      return ok(
        {
          entityType: entity.type,
          recordId: args.recordId,
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
    return ok(
      {
        entityType: entity.type,
        recordId: args.recordId,
        commentId: typeof outcome.id === 'number' ? outcome.id : null,
        operationId: outcome.operationId,
        verified: outcome.verified,
        replayed: outcome.replayed,
      },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: 'crm.timeline.comment.add',
        apiVersion: 'legacy',
        warnings: outcome.warnings,
        completeness: outcome.verified ? 'complete' : 'unknown',
      },
    );
  },
});

// ---------- crm_deal_products_replace ----------

const rowInput = z
  .object({
    productId: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .optional()
      .describe('ID товара каталога; 0 или нет — произвольная позиция'),
    productName: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .optional()
      .describe('Название позиции (обязательно без productId)'),
    price: z.number().min(0).max(1e12).describe('Цена за единицу'),
    quantity: z.number().gt(0).max(1e9).default(1).describe('Количество (> 0)'),
    discountTypeId: z
      .union([z.literal(1), z.literal(2)])
      .optional()
      .describe('1 — скидка суммой, 2 — процентом'),
    discountRate: z.number().min(0).max(100).optional().describe('Скидка, %'),
    discountSum: z.number().min(0).max(1e12).optional().describe('Скидка суммой на единицу'),
    taxRate: z.number().min(0).max(100).optional().describe('Ставка налога, %'),
    taxIncluded: z.boolean().optional().describe('Налог включён в цену'),
    measureCode: z.number().int().positive().max(10_000).optional().describe('Код единицы измерения'),
    sort: z.number().int().min(0).max(1_000_000).optional(),
  })
  .strict()
  .refine((r) => (r.productId !== undefined && r.productId > 0) || r.productName !== undefined, {
    message: 'нужен productId товара каталога или productName произвольной позиции',
  });

type RowSignature = string;
const sig = (r: {
  productId?: number | undefined;
  productName?: string | undefined;
  price: number;
  quantity: number;
}): RowSignature => JSON.stringify([r.productId ?? 0, r.productName ?? '', r.price, r.quantity]);

/** Разница составов как мультимножеств строк: что уйдёт и что появится. */
function diffRows(before: readonly ProductRow[], after: readonly RowInput[]) {
  const pool = new Map<RowSignature, number>();
  for (const r of before) pool.set(sig(r), (pool.get(sig(r)) ?? 0) + 1);
  const added: RowInput[] = [];
  for (const r of after) {
    const k = sig(r);
    const n = pool.get(k) ?? 0;
    if (n > 0) pool.set(k, n - 1);
    else added.push(r);
  }
  const removed: ProductRow[] = [];
  const left = new Map(pool);
  for (const r of before) {
    const k = sig(r);
    const n = left.get(k) ?? 0;
    if (n > 0) {
      removed.push(r);
      left.set(k, n - 1);
    }
  }
  return { added, removed, unchanged: after.length - added.length };
}

const briefRow = (r: {
  productId?: number | undefined;
  productName?: string | undefined;
  price: number;
  quantity: number;
  taxRate?: number | undefined;
  taxIncluded?: boolean | undefined;
  discountRate?: number | undefined;
  discountSum?: number | undefined;
}) => ({
  productId: r.productId ?? 0,
  productName: r.productName ?? '',
  price: r.price,
  quantity: r.quantity,
  ...(r.discountRate !== undefined ? { discountRate: r.discountRate } : {}),
  ...(r.discountSum !== undefined ? { discountSum: r.discountSum } : {}),
  ...(r.taxRate !== undefined ? { taxRate: r.taxRate } : {}),
  ...(r.taxIncluded !== undefined ? { taxIncluded: r.taxIncluded } : {}),
});

export const crmDealProductsReplaceTool = defineTool({
  name: 'crm_deal_products_replace',
  module: 'crm',
  title: 'Заменить товары сделки',
  description:
    'Заменить ВЕСЬ состав товаров сделки переданным списком (crm.item.productrow.set): строки, которых нет в списке, удаляются, ' +
    'сумма сделки пересчитывается порталом. Использовать, только когда пользователь явно просит изменить товары сделки; ' +
    'сначала прочитайте текущий состав через crm_deal_products_get. Пустой список удаляет все товары и допускается только с allowEmpty=true. ' +
    'План показывает удаляемые и добавляемые строки, НДС, скидки и итог «было → станет»; expectedStateHash из ответа плана ' +
    'защищает от одновременного изменения. Порядок: APPROVAL_REQUIRED → подтверждение человеком → повтор с approvalId.',
  operation: 'update',
  annotations: DESTRUCTIVE_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      dealId: recordId.describe('ID сделки'),
      productRows: z.array(rowInput).max(200).describe('Новый полный состав (до 200 строк)'),
      allowEmpty: z
        .boolean()
        .default(false)
        .describe('Явное намерение удалить все товары, если productRows пуст'),
      ...updateArgsShape,
    })
    .strict()
    .superRefine(requireIdempotencyUnlessDryRun),
  outputDataSchema: z.object({
    dealId: z.number(),
    dryRun: z.boolean().optional(),
    plan: z.record(z.string(), z.unknown()).optional(),
    validationLevel: z.string().optional(),
    operationId: z.string().optional(),
    verified: z.boolean().optional(),
    replayed: z.boolean().optional(),
    savedCount: z.number().optional(),
    stateHash: z.string().optional(),
  }),
  handler: async (args, ctx) => {
    if (args.productRows.length === 0 && !args.allowEmpty) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Пустой список удалит ВСЕ товары сделки; без allowEmpty=true замена запрещена',
        {
          field: 'productRows',
          reason: 'EMPTY_REPLACEMENT_BLOCKED',
          nextAction:
            'Если действительно нужно удалить все товары — повторите с allowEmpty=true и подтвердите новый план',
        },
      );
    }
    const deal = await getRecord(ctx, classicEntity('deal'), args.dealId);
    const before = await listAllDealRows(ctx, args.dealId);
    const currentHash = rowsStateHash(before);
    if (!args.approvalId && args.expectedStateHash && args.expectedStateHash !== currentHash) {
      throw new AppError(
        'CONFLICT',
        'Товары сделки изменились после чтения: expectedStateHash не совпадает',
        {
          field: 'expectedStateHash',
          reason: 'STATE_CHANGED',
          nextAction: 'Прочитайте состав заново (crm_deal_products_get) и подготовьте новый план',
        },
      );
    }
    const after: RowInput[] = args.productRows.map((r) => ({ ...r }));
    const diff = diffRows(before, after);
    const currency = asText(deal['CURRENCY_ID']);
    const totalBefore = rowsTotal(before);
    const totalAfter = rowsTotal(after);
    const risks = [
      'Все текущие строки заменяются: отсутствующие в списке удаляются вместе со связанными строками оплат',
      'Сумма сделки (OPPORTUNITY) будет пересчитана порталом; скидки и налоги рассчитает портал, итог в плане — ориентировочный',
    ];
    if (after.length === 0) risks.unshift('СДЕЛКА ОСТАНЕТСЯ БЕЗ ТОВАРОВ (allowEmpty=true)');
    if (!args.expectedStateHash)
      risks.push(
        'expectedStateHash не передан: если состав изменят до выполнения, замена всё равно применится',
      );
    if (after.some((r) => r.taxRate !== undefined && r.taxIncluded === undefined)) {
      risks.push(
        'Для строк с taxRate не указан taxIncluded: портал применит значение по умолчанию (налог сверху)',
      );
    }

    const outcome = await ctx.mutations.execute({
      requestId: ctx.requestId,
      principal: {
        id: ctx.principal.id,
        portalKey: ctx.bitrix.auth.portalKey,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
      },
      tool: 'crm_deal_products_replace',
      operationKind: 'update',
      args,
      expectedStateHash: args.expectedStateHash ?? null,
      summary: {
        action: `Заменить товары сделки #${String(args.dealId)} «${recordTitle(classicEntity('deal'), deal)}»: ${String(before.length)} → ${String(after.length)} строк`,
        target: `crm.deal:${String(args.dealId)}:productrows`,
        portalOrigin: ctx.bitrix.auth.portalOrigin,
        details: {
          dealId: args.dealId,
          method: 'crm.item.productrow.set',
          currency,
          stateHash: currentHash,
          total: { before: totalBefore, after: totalAfter },
          removed: diff.removed.map(briefRow),
          added: diff.added.map(briefRow),
          unchangedCount: diff.unchanged,
          productRows: after.map(briefRow),
        },
        risks,
      },
      validationLevel: 'local',
      precheck: async () => {
        if (!args.expectedStateHash) return;
        const fresh = await listAllDealRows(ctx, args.dealId);
        if (rowsStateHash(fresh) !== args.expectedStateHash) {
          throw new AppError('CONFLICT', 'Товары сделки изменились после подтверждения; замена отменена', {
            reason: 'STATE_CHANGED',
            nextAction: 'Прочитайте состав заново и подготовьте новый план',
          });
        }
      },
      perform: async () => {
        const savedCount = await setDealRows(ctx, args.dealId, after.map(rowToBitrix));
        return { id: args.dealId, result: { dealId: args.dealId, savedCount } };
      },
      verify: async () => {
        const saved = await listAllDealRows(ctx, args.dealId);
        const warnings: string[] = [];
        if (saved.length !== after.length) {
          warnings.push(`В портале ${String(saved.length)} строк вместо ${String(after.length)}`);
        } else {
          const want = after.map(sig).sort();
          const got = saved.map(sig).sort();
          if (want.join('|') !== got.join('|'))
            warnings.push(
              'Цена или количество строк в портале отличаются от плана (возможен пересчёт скидок/налогов)',
            );
        }
        return { verified: warnings.length === 0, warnings };
      },
    });

    if (outcome.kind === 'dry-run') {
      return ok(
        {
          dealId: args.dealId,
          dryRun: true,
          plan: outcome.plan,
          validationLevel: outcome.validationLevel,
          stateHash: currentHash,
        },
        {
          requestId: ctx.requestId,
          durationMs: Date.now() - ctx.startedAt,
          warnings: ['dryRun: запись не выполнялась, подтверждение не создано'],
        },
      );
    }
    const savedCount =
      typeof outcome.result['savedCount'] === 'number' ? outcome.result['savedCount'] : undefined;
    let stateHash: string | undefined;
    if (!outcome.replayed) {
      try {
        stateHash = rowsStateHash(await listAllDealRows(ctx, args.dealId));
      } catch {
        stateHash = undefined;
      }
    }
    return ok(
      {
        dealId: args.dealId,
        operationId: outcome.operationId,
        verified: outcome.verified,
        replayed: outcome.replayed,
        ...(savedCount !== undefined ? { savedCount } : {}),
        ...(stateHash ? { stateHash } : {}),
      },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method: 'crm.item.productrow.set',
        apiVersion: 'legacy',
        warnings: outcome.warnings,
        completeness: outcome.verified ? 'complete' : 'unknown',
      },
    );
  },
});

import { z } from 'zod';
import type { JsonValue } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { ok } from '../../mcp/result.js';
import { defineTool, READ_ANNOTATIONS, type ToolContext } from '../types.js';
import { validateSelect } from './deal-fields.js';
import { recordTitle } from './entities.js';
import { getFieldsMeta, getRecord, pickFields, recordStateHash } from './crm-service.js';
import {
  entityTypeIdSchema,
  itemGetData,
  recordEntityTypeSchema,
  resolveRecordTarget,
  type RecordTarget,
} from './item-ops.js';
import { activitiesFirstPage, itemRowsFirstPage } from './item-service.js';
import {
  activitiesPage,
  commentsPage,
  dealRowsPage,
  normalizeComment,
  normalizeRow,
} from './related-service.js';

/** Маленькие отдельные лимиты связанных блоков (§9.4: «через include с отдельными лимитами»). */
const INCLUDE_LIMIT = { activities: 10, comments: 10, products: 20 } as const;
type IncludeKind = keyof typeof INCLUDE_LIMIT;

const includeSchema = z
  .array(z.enum(['activities', 'comments', 'products']))
  .max(3)
  .optional()
  .describe(
    'Связанные блоки, каждый со своим лимитом и completeness: activities (до 10 дел), comments (до 10 комментариев таймлайна, ' +
      'только классические сущности), products (до 20 товарных позиций: сделка, лид, smart, invoice). Полные списки — отдельные инструменты',
  );

const blockSchema = z.object({
  items: z.array(z.unknown()),
  returnedCount: z.number(),
  completeness: z.enum(['complete', 'partial', 'unknown']),
  hasMore: z.boolean(),
  method: z.string(),
  note: z.string().optional(),
});

interface Block {
  items: unknown[];
  returnedCount: number;
  completeness: 'complete' | 'partial' | 'unknown';
  hasMore: boolean;
  method: string;
  note?: string;
}

const block = (items: unknown[], hasMore: boolean, method: string, note?: string): Block => ({
  items,
  returnedCount: items.length,
  completeness: hasMore ? 'partial' : 'complete',
  hasMore,
  method,
  ...(note ? { note } : {}),
});

function unsupported(kind: IncludeKind, what: string): never {
  throw new AppError('VALIDATION_ERROR', `include.${kind}: не поддерживается для ${what}`, {
    field: 'include',
    reason: 'UNSUPPORTED_INCLUDE',
  });
}

/** Проверка комбинаций include до чтений, чтобы не делать лишних запросов. */
function assertIncludeSupported(target: RecordTarget, include: readonly IncludeKind[]): void {
  for (const kind of include) {
    if (kind === 'comments' && target.kind === 'item')
      unsupported(kind, 'smart/invoice в этом срезе (ENTITY_TYPE комментариев для crm.item не сверен)');
    if (
      kind === 'products' &&
      target.kind === 'classic' &&
      target.entity.type !== 'deal' &&
      target.entity.type !== 'lead'
    )
      unsupported(kind, `${target.entity.type}: товарные позиции есть у сделки, лида, smart и invoice`);
  }
}

async function loadBlock(
  ctx: ToolContext,
  target: RecordTarget,
  id: number,
  kind: IncludeKind,
): Promise<Block> {
  const limit = INCLUDE_LIMIT[kind];
  const rest = (tool: string) => `Полный список — ${tool}`;
  if (kind === 'activities') {
    if (target.kind === 'classic') {
      const page = await activitiesPage(ctx, target.entity, {
        recordId: id,
        completed: undefined,
        includeDescription: false,
        pageSize: limit,
        cursor: undefined,
      });
      return block(page.items, page.hasMore, 'crm.activity.list', rest('crm_activities_list'));
    }
    const page = await activitiesFirstPage(ctx, target.target.entityTypeId, id, limit);
    return block(page.items, page.hasMore, 'crm.activity.list');
  }
  if (kind === 'comments') {
    if (target.kind !== 'classic') unsupported(kind, 'smart/invoice');
    const page = await commentsPage(ctx, target.entity, { recordId: id, pageSize: limit, cursor: undefined });
    const items = page.items.map((x: JsonValue) => normalizeComment(x)).filter((x) => x !== undefined);
    return block(items, page.hasMore, 'crm.timeline.comment.list', rest('crm_timeline_comments_list'));
  }
  if (target.kind === 'classic' && target.entity.type === 'deal') {
    const page = await dealRowsPage(ctx, { dealId: id, pageSize: limit, cursor: undefined });
    const rows = page.items.map((x: JsonValue) => normalizeRow(x)).filter((x) => x !== undefined);
    return block(rows, page.hasMore, 'crm.item.productrow.list', rest('crm_deal_products_get'));
  }
  const ownerType = target.kind === 'classic' ? 'L' : target.target.ownerType;
  const page = await itemRowsFirstPage(ctx, ownerType, id, limit);
  return block(page.rows, page.hasMore, 'crm.item.productrow.list');
}

export const crmGetRecordTool = defineTool({
  name: 'crm_get_record',
  module: 'crm',
  title: 'Карточка записи CRM',
  description:
    'Карточка записи CRM по ID в рамках доступных полей: сделка, лид, контакт, компания (crm.<entity>.get, поля ВЕРХНИЙ_РЕГИСТР), ' +
    'элемент смарт-процесса (entityType=smart + entityTypeId) или новый счёт (invoice) через crm.item.get (поля camelCase). ' +
    'Использовать, когда известен ID и нужны поля записи. Возвращает stateHash для expectedStateHash в crm_update_record/crm_delete_record. ' +
    'include добавляет небольшие связанные блоки (дела, комментарии, товары) с отдельными лимитами и полнотой; бинарные вложения не скачиваются.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      entityType: recordEntityTypeSchema,
      entityTypeId: entityTypeIdSchema.optional(),
      id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).describe('ID записи'),
      select: z
        .array(z.string().max(100))
        .max(100)
        .optional()
        .describe('Ограничить набор полей; по умолчанию все доступные'),
      include: includeSchema,
    })
    .strict(),
  outputDataSchema: z.object({
    entityType: recordEntityTypeSchema,
    entityTypeId: z.number().optional(),
    id: z.number(),
    title: z.string(),
    record: z.record(z.string(), z.unknown()),
    stateHash: z.string(),
    related: z.record(z.string(), blockSchema).optional(),
  }),
  handler: async (args, ctx) => {
    const target = await resolveRecordTarget(ctx, args.entityType, args.entityTypeId);
    const include = [...new Set(args.include ?? [])];
    assertIncludeSupported(target, include);
    let data: { id: number; title: string; record: Record<string, unknown>; stateHash: string };
    let method: string;
    if (target.kind === 'classic') {
      const entity = target.entity;
      if (args.select) validateSelect(args.select, await getFieldsMeta(ctx, entity));
      const record = await getRecord(ctx, entity, args.id);
      data = {
        id: args.id,
        title: recordTitle(entity, record),
        record: pickFields(record, args.select),
        stateHash: recordStateHash(record),
      };
      method = `${entity.methodBase}.get`;
    } else {
      data = await itemGetData(ctx, target.target, args.id, args.select);
      method = 'crm.item.get';
    }
    const warnings: string[] = [];
    let related: Record<string, Block> | undefined;
    if (include.length > 0) {
      related = {};
      for (const kind of include) {
        try {
          related[kind] = await loadBlock(ctx, target, args.id, kind);
        } catch (e) {
          // Сбой одного блока не скрывает карточку: блок помечается unknown с кодом ошибки.
          const err = AppError.from(e);
          related[kind] = {
            items: [],
            returnedCount: 0,
            completeness: 'unknown',
            hasMore: false,
            method: err.details.method ?? '',
            note: `Не получено: ${err.code}`,
          };
          warnings.push(`include.${kind}: не получено (${err.code})`);
        }
      }
    }
    const partial = related && Object.values(related).some((b) => b.completeness !== 'complete');
    return ok(
      {
        entityType: args.entityType,
        ...(target.kind === 'item' ? { entityTypeId: target.target.entityTypeId } : {}),
        ...data,
        ...(related ? { related } : {}),
      },
      {
        requestId: ctx.requestId,
        durationMs: Date.now() - ctx.startedAt,
        method,
        apiVersion: 'legacy',
        // Полнота карточки; блоки include — со своей completeness.
        completeness: 'complete',
        warnings: partial
          ? [...warnings, 'Связанные блоки ограничены лимитами include: смотрите related.*.completeness']
          : warnings,
      },
    );
  },
});

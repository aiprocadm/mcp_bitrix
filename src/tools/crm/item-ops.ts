/**
 * Общие операции универсального адаптера crm.item.* для инструментов crm_* (entityType smart|invoice),
 * smart_process_* и invoice_*: список, карточка, создание, изменение. Одна реализация — разные входы.
 * Записи только через ctx.mutations.execute: план → APPROVAL_REQUIRED → подтверждение → одна запись → сверка.
 */
import { z } from 'zod';
import type { JsonObject } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { ok, type Envelope } from '../../mcp/result.js';
import type { PerformResult } from '../../security/mutation-executor.js';
import { mutationPrincipal, mutationResponse, pageMeta, pageSizeOf } from '../shared.js';
import type { ToolContext } from '../types.js';
import { classicEntity, CLASSIC_ENTITY_TYPES, type ClassicEntity } from './entities.js';
import {
  validateItemFieldsForWrite,
  validateItemFilter,
  validateItemOrder,
  validateItemSelect,
} from './item-fields.js';
import {
  addItem,
  assertItemStageValid,
  compareItemFields,
  defaultItemSelect,
  getItem,
  getItemFieldsMeta,
  INVOICE_ENTITY_TYPE_ID,
  INVOICE_TARGET,
  QUOTE_ENTITY_TYPE_ID,
  QUOTE_TARGET,
  itemsPage,
  itemStateHash,
  itemTitle,
  smartTarget,
  updateItem,
  type CrmItem,
  type ItemTarget,
} from './item-service.js';

export const RECORD_ENTITY_TYPES = [...CLASSIC_ENTITY_TYPES, 'smart', 'invoice', 'quote'] as const;
export type RecordEntityType = (typeof RECORD_ENTITY_TYPES)[number];

export const recordEntityTypeSchema = z
  .enum(RECORD_ENTITY_TYPES)
  .describe(
    'Тип записи CRM: deal, lead, contact, company (классические, поля ВЕРХНИЙ_РЕГИСТР); ' +
      'smart — элемент смарт-процесса (нужен entityTypeId), invoice — новый счёт (entityTypeId=31), ' +
      'quote — коммерческое предложение (entityTypeId=7, без воронок); у smart/invoice/quote поля camelCase',
  );

export const entityTypeIdSchema = z
  .number()
  .int()
  .positive()
  .max(1_000_000)
  .describe(
    'Только для entityType=smart: entityTypeId смарт-процесса из smart_process_types_list (не id типа crm.type)',
  );

export type RecordTarget = { kind: 'classic'; entity: ClassicEntity } | { kind: 'item'; target: ItemTarget };

/** RecordRef (§9.1): entityTypeId обязателен для smart, запрещён для классических; для invoice — только 31. */
export async function resolveRecordTarget(
  ctx: ToolContext,
  entityType: RecordEntityType,
  entityTypeId: number | undefined,
): Promise<RecordTarget> {
  if (entityType === 'smart') {
    if (entityTypeId === undefined) {
      throw new AppError('VALIDATION_ERROR', 'entityTypeId: обязателен для entityType=smart', {
        field: 'entityTypeId',
        reason: 'ENTITY_TYPE_ID_REQUIRED',
        nextAction: 'Возьмите entityTypeId из smart_process_types_list',
      });
    }
    return { kind: 'item', target: await smartTarget(ctx, entityTypeId) };
  }
  if (entityType === 'invoice') {
    if (entityTypeId !== undefined && entityTypeId !== INVOICE_ENTITY_TYPE_ID) {
      throw new AppError('VALIDATION_ERROR', 'entityTypeId: для invoice не передаётся (всегда 31)', {
        field: 'entityTypeId',
        reason: 'UNEXPECTED_ENTITY_TYPE_ID',
      });
    }
    return { kind: 'item', target: INVOICE_TARGET };
  }
  if (entityType === 'quote') {
    if (entityTypeId !== undefined && entityTypeId !== QUOTE_ENTITY_TYPE_ID) {
      throw new AppError('VALIDATION_ERROR', 'entityTypeId: для quote не передаётся (всегда 7)', {
        field: 'entityTypeId',
        reason: 'UNEXPECTED_ENTITY_TYPE_ID',
      });
    }
    return { kind: 'item', target: QUOTE_TARGET };
  }
  if (entityTypeId !== undefined) {
    throw new AppError(
      'VALIDATION_ERROR',
      `entityTypeId: не передаётся для классической сущности ${entityType} (только для smart)`,
      { field: 'entityTypeId', reason: 'UNEXPECTED_ENTITY_TYPE_ID' },
    );
  }
  return { kind: 'classic', entity: classicEntity(entityType) };
}

function metaFor(ctx: ToolContext, method: string) {
  return {
    requestId: ctx.requestId,
    durationMs: Date.now() - ctx.startedAt,
    method,
    apiVersion: 'legacy' as const,
  };
}

// ---------- чтение ----------

export async function itemListEnvelope(
  ctx: ToolContext,
  target: ItemTarget,
  args: {
    tool: string;
    filter: Record<string, unknown>;
    order?: Record<string, unknown> | undefined;
    select?: string[] | undefined;
    pageSize?: number | undefined;
    cursor?: string | undefined;
  },
  base: Record<string, unknown>,
): Promise<Envelope> {
  const meta = await getItemFieldsMeta(ctx, target);
  const filter = validateItemFilter(args.filter, meta);
  const order = validateItemOrder(args.order ?? { id: 'DESC' }, meta);
  const select = validateItemSelect(args.select ?? defaultItemSelect(target, meta), meta);
  const page = await itemsPage(ctx, target, {
    tool: args.tool,
    filter,
    order,
    select,
    pageSize: pageSizeOf(ctx, args.pageSize),
    cursor: args.cursor,
  });
  return ok(
    {
      ...base,
      items: page.items as Record<string, unknown>[],
      returnedCount: page.items.length,
      ...(page.upstreamTotal !== undefined ? { upstreamTotal: page.upstreamTotal } : {}),
    },
    pageMeta(
      ctx,
      'crm.item.list',
      page,
      'legacy',
      page.upstreamCalls === 0 ? ['Страница отдана из буфера предыдущего запроса к порталу'] : [],
    ),
  );
}

function pickItemFields(item: CrmItem, select: string[] | undefined): CrmItem {
  if (!select || select.includes('*')) return item;
  const out: CrmItem = {};
  for (const s of select) if (item[s] !== undefined) out[s] = item[s];
  return out;
}

export async function itemGetData(
  ctx: ToolContext,
  target: ItemTarget,
  id: number,
  select: string[] | undefined,
): Promise<{ id: number; title: string; record: CrmItem; stateHash: string }> {
  if (select) validateItemSelect(select, await getItemFieldsMeta(ctx, target));
  const item = await getItem(ctx, target, id);
  return { id, title: itemTitle(item), record: pickItemFields(item, select), stateHash: itemStateHash(item) };
}

export async function itemGetEnvelope(
  ctx: ToolContext,
  target: ItemTarget,
  id: number,
  select: string[] | undefined,
  base: Record<string, unknown>,
): Promise<Envelope> {
  const data = await itemGetData(ctx, target, id, select);
  return ok({ ...base, ...data }, metaFor(ctx, 'crm.item.get'));
}

// ---------- запись ----------

export interface ItemWriteArgs {
  dryRun: boolean;
  idempotencyKey?: string | undefined;
  approvalId?: string | undefined;
  expectedStateHash?: string | undefined;
}

function createRisks(target: ItemTarget, fields: JsonObject): string[] {
  const risks = ['Могут сработать роботы/бизнес-процессы и уведомления'];
  if (!('stageId' in fields)) risks.push('stageId не указан: первая стадия воронки по умолчанию');
  if (!('assignedById' in fields))
    risks.push('assignedById не указан: ответственным станет пользователь вебхука');
  if (target.kind === 'invoice') {
    risks.push(
      'Создаётся только карточка счёта: PDF, отправка клиенту, ссылка на оплату и отметка оплаты НЕ выполняются',
    );
  }
  if (target.kind === 'quote') {
    risks.push('Создаётся только карточка КП: печатная форма и отправка клиенту НЕ выполняются');
  }
  return risks;
}

/**
 * Создание элемента: поля по crm.item.fields (кэш 5 мин), стадия по справочнику, план, подтверждение,
 * crm.item.add, сверка по crm.item.get. `extra` — дополнительный шаг внутри той же операции (товары счёта).
 */
export async function itemCreateEnvelope(
  ctx: ToolContext,
  target: ItemTarget,
  opts: {
    tool: string;
    rawFields: Record<string, unknown>;
    args: Record<string, unknown> & ItemWriteArgs;
    base: Record<string, unknown>;
    planDetails?: Record<string, unknown>;
    extraRisks?: string[];
    resultFields?: readonly string[];
    afterCreate?: (id: number) => Promise<Record<string, unknown>>;
    verifyExtra?: (performed: PerformResult) => Promise<{ verified: boolean; warnings: string[] }>;
  },
): Promise<{
  envelope: Envelope;
  result: Record<string, unknown> | undefined;
  operationId: string | undefined;
}> {
  const meta = await getItemFieldsMeta(ctx, target);
  const fields = validateItemFieldsForWrite(opts.rawFields, meta, 'create');
  await assertItemStageValid(ctx, target, fields, undefined);
  const title = itemTitle(fields);
  const outcome = await ctx.mutations.execute({
    requestId: ctx.requestId,
    principal: mutationPrincipal(ctx),
    tool: opts.tool,
    operationKind: 'create',
    args: { ...opts.args, fields },
    summary: {
      action: `Создать ${target.labelAccusative}${title ? ` «${title}»` : ''}`,
      target: `crm.item:${String(target.entityTypeId)}`,
      portalOrigin: ctx.bitrix.auth.portalOrigin,
      details: {
        entityType: target.kind,
        entityTypeId: target.entityTypeId,
        method: 'crm.item.add',
        fields,
        ...(opts.planDetails ?? {}),
      },
      risks: [...createRisks(target, fields), ...(opts.extraRisks ?? [])],
    },
    validationLevel: 'local+metadata',
    perform: async () => {
      const id = await addItem(ctx, target, fields);
      const extra = opts.afterCreate ? await opts.afterCreate(id) : {};
      return { id, result: { id, ...extra } };
    },
    verify: async (performed) => {
      const item = await getItem(ctx, target, Number(performed.id));
      const cmp = compareItemFields(fields, item);
      if (!opts.verifyExtra) return cmp;
      const more = await opts.verifyExtra(performed);
      return { verified: cmp.verified && more.verified, warnings: [...cmp.warnings, ...more.warnings] };
    },
  });
  const envelope = mutationResponse(ctx, outcome, {
    base: opts.base,
    method: 'crm.item.add',
    resultFields: ['id', ...(opts.resultFields ?? [])],
  });
  return outcome.kind === 'executed'
    ? { envelope, result: outcome.result, operationId: outcome.operationId }
    : { envelope, result: undefined, operationId: undefined };
}

function updateRisks(target: ItemTarget, fields: JsonObject, current: CrmItem): string[] {
  const risks = ['Могут сработать роботы/бизнес-процессы и уведомления об изменении'];
  if ('stageId' in fields && fields['stageId'] !== current['stageId'])
    risks.push('Смена stageId запускает автоматизацию стадии и меняет отчёты');
  if ('assignedById' in fields && fields['assignedById'] !== current['assignedById'])
    risks.push('Смена ответственного: уведомление новому ответственному, права старого могут измениться');
  if ('categoryId' in fields && fields['categoryId'] !== current['categoryId'])
    risks.push('Перенос в другую воронку меняет стадию по правилам портала');
  if (target.kind === 'invoice' && 'opportunity' in fields)
    risks.push('Сумма счёта при товарных позициях может пересчитываться порталом');
  return risks;
}

export function stateConflict(message: string): AppError {
  return new AppError('CONFLICT', message, {
    field: 'expectedStateHash',
    reason: 'STATE_CHANGED',
    nextAction: 'Прочитайте запись заново (crm_get_record / *_get) и повторите с новым stateHash',
  });
}

/** Изменение элемента: read-before, stateHash/CONFLICT, diff в плане, precheck, crm.item.update, сверка. */
export async function itemUpdateEnvelope(
  ctx: ToolContext,
  target: ItemTarget,
  opts: {
    tool: string;
    id: number;
    rawFields: Record<string, unknown>;
    args: Record<string, unknown> & ItemWriteArgs;
    base: Record<string, unknown>;
  },
): Promise<Envelope> {
  const meta = await getItemFieldsMeta(ctx, target);
  const fields = validateItemFieldsForWrite(opts.rawFields, meta, 'update');
  const current = await getItem(ctx, target, opts.id);
  const currentHash = itemStateHash(current);
  // С approvalId сверку делает исполнитель и precheck: ранний отказ сорвал бы replay выполненной операции.
  if (!opts.args.approvalId && opts.args.expectedStateHash && opts.args.expectedStateHash !== currentHash) {
    throw stateConflict('Запись изменилась после чтения: expectedStateHash не совпадает');
  }
  await assertItemStageValid(ctx, target, fields, current);
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [k, v] of Object.entries(fields)) changes[k] = { from: current[k] ?? null, to: v };
  const title = itemTitle(current);
  const expected = opts.args.expectedStateHash;

  const outcome = await ctx.mutations.execute({
    requestId: ctx.requestId,
    principal: mutationPrincipal(ctx),
    tool: opts.tool,
    operationKind: 'update',
    args: { ...opts.args, fields },
    expectedStateHash: expected ?? null,
    summary: {
      action: `Изменить ${target.labelAccusative} #${String(opts.id)}${title ? ` «${title}»` : ''}: ${Object.keys(fields).join(', ')}`,
      target: `crm.item:${String(target.entityTypeId)}:${String(opts.id)}`,
      portalOrigin: ctx.bitrix.auth.portalOrigin,
      details: {
        entityType: target.kind,
        entityTypeId: target.entityTypeId,
        method: 'crm.item.update',
        id: opts.id,
        changes,
      },
      risks: updateRisks(target, fields, current).concat(
        expected
          ? []
          : [
              'expectedStateHash не передан: если запись изменят до выполнения, изменение всё равно применится',
            ],
      ),
    },
    validationLevel: 'local+metadata',
    precheck: async () => {
      if (!expected) return;
      const fresh = await getItem(ctx, target, opts.id);
      if (itemStateHash(fresh) !== expected) {
        throw new AppError('CONFLICT', 'Запись изменилась после подтверждения; изменение отменено', {
          reason: 'STATE_CHANGED',
          nextAction: 'Прочитайте запись заново и подготовьте новый план',
        });
      }
    },
    perform: async () => {
      await updateItem(ctx, target, opts.id, fields);
      return { id: opts.id, result: { id: opts.id, changedFields: Object.keys(fields) } };
    },
    verify: async () => compareItemFields(fields, await getItem(ctx, target, opts.id)),
  });

  let stateHash: string | undefined;
  if (outcome.kind === 'executed' && !outcome.replayed) {
    try {
      stateHash = itemStateHash(await getItem(ctx, target, opts.id));
    } catch {
      stateHash = undefined;
    }
  }
  return mutationResponse(ctx, outcome, {
    base: { ...opts.base, id: opts.id, ...(stateHash ? { stateHash } : {}) },
    method: 'crm.item.update',
    resultFields: ['changedFields'],
  });
}

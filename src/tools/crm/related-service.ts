/**
 * Связанные данные записи CRM (ТЗ §9.4, §11 п.2): история стадий, дела, комментарии таймлайна,
 * пользовательские поля, товарные позиции сделки и ограниченный проход по сделкам для сводки воронки.
 * Только методы из реестра; формы ответов проверяются, чужие поля не пропускаются наружу «как есть».
 * Источники — страницы apidocs.bitrix24.ru, указанные в src/bitrix/method-registry.ts.
 */
import type { JsonObject, JsonValue } from '../../bitrix/legacy-adapter.js';
import { bindingHash, paginateLegacy, type PageResult } from '../../bitrix/pagination.js';
import { AppError } from '../../errors/app-error.js';
import { stateHash } from '../../security/idempotency.js';
import type { ToolContext } from '../types.js';
import { asText } from './deal-fields.js';
import type { ClassicEntity } from './entities.js';

function upstream(method: string, message: string): AppError {
  return new AppError('BITRIX_UPSTREAM_ERROR', message, { method, apiVersion: 'legacy' });
}

const isObj = (x: unknown): x is Record<string, JsonValue> =>
  !!x && typeof x === 'object' && !Array.isArray(x);
const num = (v: unknown): number | undefined => {
  const n = Number(asText(v));
  return asText(v) !== '' && Number.isFinite(n) ? n : undefined;
};
const yn = (v: unknown): boolean => v === true || asText(v).toUpperCase() === 'Y';

function binding(ctx: ToolContext, tool: string, parts: Record<string, unknown>) {
  return {
    principalId: ctx.principal.id,
    portalKey: ctx.bitrix.auth.portalKey,
    tool,
    bindingHash: bindingHash(parts),
  };
}

// ---------- пользовательские поля ----------

export interface UserField {
  fieldName: string;
  type: string;
  label: string;
  multiple: boolean;
  mandatory: boolean;
  sort: number;
  xmlId: string | undefined;
  items: { ID: string; VALUE: string }[] | undefined;
}

function labelOf(v: unknown): string {
  if (typeof v === 'string') return v;
  if (isObj(v))
    return (
      asText(v['ru']) ||
      asText(v['en']) ||
      (Object.values(v)
        .map(asText)
        .find((s) => s !== '') ??
        '')
    );
  return '';
}

/** crm.<entity>.userfield.list с LANG=ru: подписи строками, варианты списков — в LIST. */
export async function listUserFields(
  ctx: ToolContext,
  entity: ClassicEntity,
): Promise<{ fields: UserField[]; partial: boolean }> {
  const method = `${entity.methodBase}.userfield.list`;
  const r = await ctx.bitrix.call(
    'legacy',
    method,
    { order: { SORT: 'ASC', ID: 'ASC' }, filter: { LANG: 'ru' } },
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  if (!Array.isArray(r.result)) throw upstream(method, `${method} вернул не массив`);
  const fields = (r.result as unknown[]).filter(isObj).map((f): UserField => {
    const list = Array.isArray(f['LIST'])
      ? (f['LIST'] as unknown[])
          .filter(isObj)
          .map((i) => ({ ID: asText(i['ID']), VALUE: asText(i['VALUE']) }))
      : undefined;
    return {
      fieldName: asText(f['FIELD_NAME']),
      type: asText(f['USER_TYPE_ID']),
      label: labelOf(f['EDIT_FORM_LABEL']) || labelOf(f['LIST_COLUMN_LABEL']) || asText(f['FIELD_NAME']),
      multiple: yn(f['MULTIPLE']),
      mandatory: yn(f['MANDATORY']),
      sort: num(f['SORT']) ?? 0,
      xmlId: asText(f['XML_ID']) || undefined,
      items: list && list.length > 0 ? list : undefined,
    };
  });
  return { fields: fields.filter((f) => f.fieldName.startsWith('UF_')), partial: r.next !== undefined };
}

// ---------- история стадий ----------

export interface StageHistoryItem {
  id: number;
  kind: 'created' | 'intermediate' | 'final' | 'category_change' | 'other';
  createdTime: string;
  categoryId: number | undefined;
  stageId: string;
  semantic: 'P' | 'S' | 'F' | undefined;
}

const HISTORY_KIND: Record<number, StageHistoryItem['kind']> = {
  1: 'created',
  2: 'intermediate',
  3: 'final',
  5: 'category_change',
};

export function normalizeHistory(raw: JsonValue): StageHistoryItem | undefined {
  if (!isObj(raw)) return undefined;
  const id = num(raw['ID']);
  if (id === undefined) return undefined;
  // У лидов и старых счетов — STATUS_ID/STATUS_SEMANTIC_ID вместо STAGE_* (документация crm.stagehistory.list).
  const stageId = asText(raw['STAGE_ID']) || asText(raw['STATUS_ID']);
  const sem = asText(raw['STAGE_SEMANTIC_ID']) || asText(raw['STATUS_SEMANTIC_ID']);
  return {
    id,
    kind: HISTORY_KIND[num(raw['TYPE_ID']) ?? 0] ?? 'other',
    createdTime: asText(raw['CREATED_TIME']),
    categoryId: num(raw['CATEGORY_ID']),
    stageId,
    semantic: sem === 'P' || sem === 'S' || sem === 'F' ? sem : undefined,
  };
}

export async function stageHistoryPage(
  ctx: ToolContext,
  entity: ClassicEntity,
  args: {
    recordId: number;
    from: string | undefined;
    to: string | undefined;
    pageSize: number;
    cursor: string | undefined;
  },
): Promise<PageResult> {
  const filter: JsonObject = { OWNER_ID: args.recordId };
  if (args.from) filter['>=CREATED_TIME'] = args.from;
  if (args.to) filter['<=CREATED_TIME'] = args.to;
  return paginateLegacy({
    store: ctx.cursors,
    binding: binding(ctx, 'crm_stage_history', {
      entityTypeId: entity.entityTypeId,
      ...args,
      cursor: undefined,
    }),
    cursor: args.cursor,
    pageSize: args.pageSize,
    fetchPage: async (start) => {
      const r = await ctx.bitrix.call(
        'legacy',
        'crm.stagehistory.list',
        { entityTypeId: entity.entityTypeId, filter, order: { CREATED_TIME: 'ASC', ID: 'ASC' }, start },
        { requestId: ctx.requestId, signal: ctx.signal },
      );
      const items = isObj(r.result) ? r.result['items'] : undefined;
      if (!Array.isArray(items))
        throw upstream('crm.stagehistory.list', 'crm.stagehistory.list вернул неожиданную форму');
      return { items, next: r.next, total: r.total };
    },
  });
}

// ---------- дела ----------

export const ACTIVITY_FIELDS = [
  'ID',
  'OWNER_ID',
  'OWNER_TYPE_ID',
  'TYPE_ID',
  'PROVIDER_ID',
  'SUBJECT',
  'COMPLETED',
  'RESPONSIBLE_ID',
  'START_TIME',
  'END_TIME',
  'DEADLINE',
  'DIRECTION',
  'PRIORITY',
  'STATUS',
  'CREATED',
  'LAST_UPDATED',
] as const;

export async function activitiesPage(
  ctx: ToolContext,
  entity: ClassicEntity,
  args: {
    recordId: number;
    completed: boolean | undefined;
    typeId?: number | undefined;
    includeDescription: boolean;
    pageSize: number;
    cursor: string | undefined;
  },
): Promise<PageResult> {
  const filter: JsonObject = { OWNER_TYPE_ID: entity.entityTypeId, OWNER_ID: args.recordId };
  if (args.completed !== undefined) filter['COMPLETED'] = args.completed ? 'Y' : 'N';
  if (args.typeId !== undefined) filter['TYPE_ID'] = args.typeId;
  // COMMUNICATIONS (телефоны/email участников) и FILES намеренно не запрашиваются: минимум персональных данных (§8.4).
  const select: string[] = [...ACTIVITY_FIELDS];
  if (args.includeDescription) select.push('DESCRIPTION', 'DESCRIPTION_TYPE');
  return paginateLegacy({
    store: ctx.cursors,
    binding: binding(ctx, 'crm_activities_list', {
      entityTypeId: entity.entityTypeId,
      ...args,
      cursor: undefined,
    }),
    cursor: args.cursor,
    pageSize: args.pageSize,
    fetchPage: async (start) => {
      const r = await ctx.bitrix.call(
        'legacy',
        'crm.activity.list',
        { filter, select, order: { ID: 'desc' }, start },
        { requestId: ctx.requestId, signal: ctx.signal },
      );
      if (!Array.isArray(r.result)) throw upstream('crm.activity.list', 'crm.activity.list вернул не массив');
      return { items: r.result, next: r.next, total: r.total };
    },
  });
}

// ---------- комментарии таймлайна ----------

export interface TimelineComment {
  id: number;
  created: string;
  authorId: number | undefined;
  comment: string;
}

export function normalizeComment(raw: JsonValue): TimelineComment | undefined {
  if (!isObj(raw)) return undefined;
  const id = num(raw['ID']);
  if (id === undefined) return undefined;
  return {
    id,
    created: asText(raw['CREATED']),
    authorId: num(raw['AUTHOR_ID']),
    comment: asText(raw['COMMENT']),
  };
}

export async function commentsPage(
  ctx: ToolContext,
  entity: ClassicEntity,
  args: { recordId: number; pageSize: number; cursor: string | undefined },
): Promise<PageResult> {
  return paginateLegacy({
    store: ctx.cursors,
    binding: binding(ctx, 'crm_timeline_comments_list', {
      entityType: entity.type,
      ...args,
      cursor: undefined,
    }),
    cursor: args.cursor,
    pageSize: args.pageSize,
    fetchPage: async (start) => {
      // FILES не запрашиваются: в них ссылки на вложения; бинарные вложения автоматически не отдаются (§9.4).
      const r = await ctx.bitrix.call(
        'legacy',
        'crm.timeline.comment.list',
        {
          filter: { ENTITY_ID: args.recordId, ENTITY_TYPE: entity.type },
          select: ['ID', 'CREATED', 'ENTITY_ID', 'ENTITY_TYPE', 'AUTHOR_ID', 'COMMENT'],
          order: { ID: 'DESC' },
          start,
        },
        { requestId: ctx.requestId, signal: ctx.signal },
      );
      if (!Array.isArray(r.result))
        throw upstream('crm.timeline.comment.list', 'crm.timeline.comment.list вернул не массив');
      return { items: r.result, next: r.next, total: r.total };
    },
  });
}

export async function addComment(
  ctx: ToolContext,
  entity: ClassicEntity,
  recordId: number,
  text: string,
): Promise<number> {
  const r = await ctx.bitrix.call(
    'legacy',
    'crm.timeline.comment.add',
    { fields: { ENTITY_ID: recordId, ENTITY_TYPE: entity.type, COMMENT: text } },
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  const id = num(r.result);
  if (id === undefined || !Number.isInteger(id) || id <= 0) {
    throw new AppError(
      'OPERATION_OUTCOME_UNKNOWN',
      'crm.timeline.comment.add вернул ответ без ID; исход неизвестен',
      {
        method: 'crm.timeline.comment.add',
        apiVersion: 'legacy',
        reason: 'outcome-unknown',
        nextAction: 'Проверьте комментарии записи (crm_timeline_comments_list) перед повторной попыткой',
      },
    );
  }
  return id;
}

export async function getComment(ctx: ToolContext, id: number): Promise<Record<string, JsonValue>> {
  const r = await ctx.bitrix.call(
    'legacy',
    'crm.timeline.comment.get',
    { id },
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  if (!isObj(r.result)) {
    throw new AppError('NOT_FOUND', 'Комментарий не найден', {
      method: 'crm.timeline.comment.get',
      apiVersion: 'legacy',
    });
  }
  return r.result;
}

// ---------- товарные позиции сделки ----------

export interface ProductRow {
  id: number | undefined;
  productId: number;
  productName: string;
  /** Цена за единицу с учётом скидок и налогов (как её хранит Bitrix24). */
  price: number;
  quantity: number;
  discountTypeId: number | undefined;
  discountRate: number | undefined;
  discountSum: number | undefined;
  taxRate: number | undefined;
  taxIncluded: boolean;
  measureCode: number | undefined;
  measureName: string | undefined;
  sort: number | undefined;
}

export function normalizeRow(raw: JsonValue): ProductRow | undefined {
  if (!isObj(raw)) return undefined;
  return {
    id: num(raw['id']),
    productId: num(raw['productId']) ?? 0,
    productName: asText(raw['productName']),
    price: num(raw['price']) ?? 0,
    quantity: num(raw['quantity']) ?? 0,
    discountTypeId: num(raw['discountTypeId']),
    discountRate: num(raw['discountRate']),
    discountSum: num(raw['discountSum']),
    taxRate: num(raw['taxRate']),
    taxIncluded: yn(raw['taxIncluded']),
    measureCode: num(raw['measureCode']),
    measureName: asText(raw['measureName']) || undefined,
    sort: num(raw['sort']),
  };
}

/** Сумма в копейках, чтобы не накапливать ошибку плавающей точки. */
export function rowsTotal(rows: readonly { price: number; quantity: number }[]): number {
  const cents = rows.reduce((acc, r) => acc + Math.round(r.price * 100) * r.quantity, 0);
  return Math.round(cents) / 100;
}

/** Отпечаток состава для expectedStateHash: только смысловые поля строк, в порядке портала. */
export function rowsStateHash(rows: readonly ProductRow[]): string {
  return stateHash(
    rows.map((r) => [
      r.productId,
      r.productName,
      r.price,
      r.quantity,
      r.discountRate ?? null,
      r.taxRate ?? null,
      r.taxIncluded,
    ]),
  );
}

const MAX_ROW_PAGES = 10;

/** Все строки сделки (до 500): для плана замены и сверки нужен полный текущий состав. */
export async function listAllDealRows(ctx: ToolContext, dealId: number): Promise<ProductRow[]> {
  const rows: ProductRow[] = [];
  let start: number | undefined = 0;
  for (let i = 0; i < MAX_ROW_PAGES && start !== undefined; i += 1) {
    const page = await dealRowsUpstream(ctx, dealId, start);
    for (const raw of page.items) {
      const row = normalizeRow(raw);
      if (row) rows.push(row);
    }
    start = page.items.length === 0 ? undefined : page.next;
  }
  if (start !== undefined) {
    throw new AppError(
      'VALIDATION_ERROR',
      'У сделки больше 500 товарных позиций: замена целиком через MCP не поддерживается',
      {
        field: 'dealId',
        reason: 'TOO_MANY_ROWS',
      },
    );
  }
  return rows;
}

async function dealRowsUpstream(
  ctx: ToolContext,
  dealId: number,
  start: number,
): Promise<{ items: JsonValue[]; next: number | undefined; total: number | undefined }> {
  const r = await ctx.bitrix.call(
    'legacy',
    'crm.item.productrow.list',
    { filter: { '=ownerType': 'D', '=ownerId': dealId }, order: { sort: 'asc', id: 'asc' }, start },
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  const items = isObj(r.result) ? r.result['productRows'] : undefined;
  if (!Array.isArray(items))
    throw upstream('crm.item.productrow.list', 'crm.item.productrow.list вернул неожиданную форму');
  return { items, next: r.next, total: r.total };
}

export async function dealRowsPage(
  ctx: ToolContext,
  args: { dealId: number; pageSize: number; cursor: string | undefined },
): Promise<PageResult> {
  return paginateLegacy({
    store: ctx.cursors,
    binding: binding(ctx, 'crm_deal_products_get', { dealId: args.dealId, pageSize: args.pageSize }),
    cursor: args.cursor,
    pageSize: args.pageSize,
    fetchPage: (start) => dealRowsUpstream(ctx, args.dealId, start),
  });
}

export interface RowInput {
  productId?: number | undefined;
  productName?: string | undefined;
  price: number;
  quantity: number;
  discountTypeId?: 1 | 2 | undefined;
  discountRate?: number | undefined;
  discountSum?: number | undefined;
  taxRate?: number | undefined;
  taxIncluded?: boolean | undefined;
  measureCode?: number | undefined;
  sort?: number | undefined;
}

/** Строка для crm.item.productrow.set: только документированные поля, taxIncluded → Y/N. */
export function rowToBitrix(row: RowInput): JsonObject {
  const out: JsonObject = { price: row.price, quantity: row.quantity };
  if (row.productId !== undefined) out['productId'] = row.productId;
  if (row.productName !== undefined) out['productName'] = row.productName;
  if (row.discountTypeId !== undefined) out['discountTypeId'] = row.discountTypeId;
  if (row.discountRate !== undefined) out['discountRate'] = row.discountRate;
  if (row.discountSum !== undefined) out['discountSum'] = row.discountSum;
  if (row.taxRate !== undefined) out['taxRate'] = row.taxRate;
  if (row.taxIncluded !== undefined) out['taxIncluded'] = row.taxIncluded ? 'Y' : 'N';
  if (row.measureCode !== undefined) out['measureCode'] = row.measureCode;
  if (row.sort !== undefined) out['sort'] = row.sort;
  return out;
}

export async function setDealRows(ctx: ToolContext, dealId: number, rows: JsonObject[]): Promise<number> {
  const r = await ctx.bitrix.call(
    'legacy',
    'crm.item.productrow.set',
    { ownerType: 'D', ownerId: dealId, productRows: rows },
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  const saved = isObj(r.result) ? r.result['productRows'] : undefined;
  if (!Array.isArray(saved)) {
    throw new AppError(
      'OPERATION_OUTCOME_UNKNOWN',
      'crm.item.productrow.set не вернул сохранённый состав; исход неизвестен',
      {
        method: 'crm.item.productrow.set',
        apiVersion: 'legacy',
        reason: 'outcome-unknown',
        nextAction: 'Прочитайте товары сделки (crm_deal_products_get) и сверьте с планом',
      },
    );
  }
  return saved.length;
}

// ---------- сводка воронки ----------

export interface DealScanResult {
  deals: { stageId: string; opportunity: number; currency: string }[];
  scannedCount: number;
  hasMore: boolean;
  stoppedBy: 'complete' | 'maxRecords' | 'timeLimit';
  upstreamCalls: number;
}

/**
 * Ограниченный проход crm.deal.list по фильтру (ТЗ §9.4: универсального метода «сводка» нет).
 * Останавливается на maxRecords или по времени; отдаёт честный признак неполноты.
 */
export async function scanDeals(
  ctx: ToolContext,
  filter: JsonObject,
  maxRecords: number,
  maxSeconds: number,
  now: () => number = () => Date.now(),
): Promise<DealScanResult> {
  const deadline = now() + maxSeconds * 1000;
  const deals: DealScanResult['deals'] = [];
  let start: number | undefined = 0;
  let calls = 0;
  let stoppedBy: DealScanResult['stoppedBy'] = 'complete';
  while (start !== undefined) {
    if (deals.length >= maxRecords) {
      stoppedBy = 'maxRecords';
      break;
    }
    if (now() >= deadline) {
      stoppedBy = 'timeLimit';
      break;
    }
    const r = await ctx.bitrix.call(
      'legacy',
      'crm.deal.list',
      { filter, select: ['ID', 'STAGE_ID', 'OPPORTUNITY', 'CURRENCY_ID'], order: { ID: 'ASC' }, start },
      { requestId: ctx.requestId, signal: ctx.signal },
    );
    calls += 1;
    if (!Array.isArray(r.result)) throw upstream('crm.deal.list', 'crm.deal.list вернул не массив');
    const page = (r.result as unknown[]).filter(isObj);
    for (const d of page) {
      if (deals.length >= maxRecords) {
        stoppedBy = 'maxRecords';
        break;
      }
      deals.push({
        stageId: asText(d['STAGE_ID']),
        opportunity: num(d['OPPORTUNITY']) ?? 0,
        currency: asText(d['CURRENCY_ID']),
      });
    }
    if (stoppedBy === 'maxRecords') {
      // Остаток текущей страницы или следующая страница — признак неполноты.
      return { deals, scannedCount: deals.length, hasMore: true, stoppedBy, upstreamCalls: calls };
    }
    start = page.length === 0 ? undefined : r.next;
  }
  return { deals, scannedCount: deals.length, hasMore: start !== undefined, stoppedBy, upstreamCalls: calls };
}

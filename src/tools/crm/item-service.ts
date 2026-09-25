/**
 * Сервис универсального адаптера CRM crm.item.* (ТЗ §9.4, §9.5, §9.7): смарт-процессы и новые счета (entityTypeId=31).
 * Единственное место, где инструменты smart/invoice обращаются к ctx.bitrix; только методы из реестра.
 *
 * Факты из документации (apidocs.bitrix24.ru, crm/universal):
 *  - crm.item.list → result.items, total/next, фиксированная страница 50; crm.item.get/add/update → result.item;
 *    crm.item.delete → result: [] при успехе; crm.item.fields → result.fields (camelCase);
 *  - id типа crm.type ≠ entityTypeId: проверка entityTypeId — crm.type.getByEntityTypeId (право чтения смарт-процесса),
 *    а не произвольное число; для предопределённого счёта 31 crm.type.* НЕ вызывается (§9.5);
 *  - стадии смарт-процесса: crm.status.list ENTITY_ID=DYNAMIC_{entityTypeId}_STAGE_{categoryId};
 *    стадии счёта: SMART_INVOICE_STAGE_{categoryId}; воронки — crm.category.list(entityTypeId);
 *  - ownerType товарных строк: SI — счёт (новый), T{hex(entityTypeId)} — смарт-процесс.
 */
import type { JsonObject, JsonValue } from '../../bitrix/legacy-adapter.js';
import type { PageResult } from '../../bitrix/pagination.js';
import { AppError } from '../../errors/app-error.js';
import { stateHash } from '../../security/idempotency.js';
import {
  asText,
  idOf,
  isObj,
  legacyListPage,
  num,
  outcomeUnknown,
  own,
  upstreamShapeError,
  yn,
} from '../shared.js';
import type { ToolContext } from '../types.js';
import { listCategories, listStatuses, type StatusItem } from './crm-service.js';
import { parseItemFieldsResult, type ItemFieldsMeta } from './item-fields.js';
import { ACTIVITY_FIELDS, normalizeRow, type ProductRow } from './related-service.js';

export const INVOICE_ENTITY_TYPE_ID = 31;
/** Системные типы CRM из справочника типов объектов: не смарт-процессы (лид, сделка, контакт, компания, старый счёт, предложение, реквизит, заказ, новый счёт). */
const SYSTEM_ENTITY_TYPE_IDS: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 7, 8, 14, 31]);

const FIELDS_CACHE_KIND = 'item-fields';
const TYPE_CACHE_KIND = 'smart-type';

export type ItemKind = 'smart' | 'invoice';
export type CrmItem = Record<string, JsonValue>;

export interface SmartType {
  /** ID записи типа в crm.type — НЕ entityTypeId. */
  typeId: number;
  entityTypeId: number;
  title: string;
  code: string;
  isCategoriesEnabled: boolean;
  isStagesEnabled: boolean;
  isLinkWithProductsEnabled: boolean;
  isRecyclebinEnabled: boolean;
  isAutomationEnabled: boolean;
  isBizProcEnabled: boolean;
  isClientEnabled: boolean;
  isObserversEnabled: boolean;
  isBeginCloseDatesEnabled: boolean;
}

export interface ItemTarget {
  readonly kind: ItemKind;
  readonly entityTypeId: number;
  readonly label: string;
  readonly labelAccusative: string;
  /** Символьный ownerType товарных строк: SI или T{hex}. */
  readonly ownerType: string;
  readonly smartType: SmartType | undefined;
}

export function normalizeSmartType(raw: JsonValue): SmartType | undefined {
  if (!isObj(raw)) return undefined;
  const typeId = idOf(raw['id']);
  const entityTypeId = idOf(raw['entityTypeId']);
  if (typeId === undefined || entityTypeId === undefined) return undefined;
  return {
    typeId,
    entityTypeId,
    title: asText(raw['title']),
    code: asText(raw['code']),
    isCategoriesEnabled: yn(raw['isCategoriesEnabled']),
    isStagesEnabled: yn(raw['isStagesEnabled']),
    isLinkWithProductsEnabled: yn(raw['isLinkWithProductsEnabled']),
    isRecyclebinEnabled: yn(raw['isRecyclebinEnabled']),
    isAutomationEnabled: yn(raw['isAutomationEnabled']),
    isBizProcEnabled: yn(raw['isBizProcEnabled']),
    isClientEnabled: yn(raw['isClientEnabled']),
    isObserversEnabled: yn(raw['isObserversEnabled']),
    isBeginCloseDatesEnabled: yn(raw['isBeginCloseDatesEnabled']),
  };
}

function notSmart(entityTypeId: number, why: string): AppError {
  return new AppError(
    'VALIDATION_ERROR',
    `entityTypeId=${String(entityTypeId)}: ${why}. Не путайте id типа (crm.type) и entityTypeId`,
    {
      field: 'entityTypeId',
      reason: 'NOT_SMART_PROCESS',
      nextAction: 'Возьмите entityTypeId (не typeId) из smart_process_types_list',
    },
  );
}

/**
 * entityTypeId должен быть типом смарт-процесса портала: системные типы отклоняются локально,
 * остальное проверяется crm.type.getByEntityTypeId (кэш 5 минут).
 */
export async function resolveSmartType(ctx: ToolContext, entityTypeId: number): Promise<SmartType> {
  if (SYSTEM_ENTITY_TYPE_IDS.has(entityTypeId)) {
    throw notSmart(
      entityTypeId,
      entityTypeId === INVOICE_ENTITY_TYPE_ID
        ? 'это новый счёт, используйте entityType=invoice или invoice_*'
        : 'это системный тип CRM, а не смарт-процесс',
    );
  }
  const key = String(entityTypeId);
  const cached = ctx.capabilities.getCached<SmartType>(TYPE_CACHE_KIND, key);
  if (cached) return cached;
  let r;
  try {
    r = await ctx.bitrix.call(
      'legacy',
      'crm.type.getbyentitytypeid',
      { entityTypeId },
      { requestId: ctx.requestId, signal: ctx.signal },
    );
  } catch (e) {
    const err = AppError.from(e);
    // Страница метода: «Smart process not found» — код 0 (HTTP 400); встречается и NOT_FOUND.
    if (
      err.code === 'NOT_FOUND' ||
      (err.code === 'BITRIX_UPSTREAM_ERROR' && err.details.upstreamCode === '0') ||
      (err.code === 'VALIDATION_ERROR' && err.details.method === 'crm.type.getbyentitytypeid')
    ) {
      throw notSmart(entityTypeId, 'смарт-процесс с таким entityTypeId не найден или недоступен');
    }
    throw err;
  }
  const type = normalizeSmartType(isObj(r.result) ? (r.result['type'] ?? null) : null);
  if (!type) throw upstreamShapeError('crm.type.getbyentitytypeid', 'legacy');
  if (type.entityTypeId !== entityTypeId) {
    throw notSmart(entityTypeId, 'портал вернул другой тип');
  }
  ctx.capabilities.setCached(TYPE_CACHE_KIND, key, type);
  return type;
}

export function smartOwnerType(entityTypeId: number): string {
  return `T${entityTypeId.toString(16)}`;
}

export async function smartTarget(ctx: ToolContext, entityTypeId: number): Promise<ItemTarget> {
  const smartType = await resolveSmartType(ctx, entityTypeId);
  return {
    kind: 'smart',
    entityTypeId,
    label: `элемент смарт-процесса «${smartType.title}»`,
    labelAccusative: `элемент смарт-процесса «${smartType.title}»`,
    ownerType: smartOwnerType(entityTypeId),
    smartType,
  };
}

/** Предопределённый тип 31: crm.type.* не вызывается (§9.5). */
export const INVOICE_TARGET: ItemTarget = {
  kind: 'invoice',
  entityTypeId: INVOICE_ENTITY_TYPE_ID,
  label: 'счёт',
  labelAccusative: 'счёт',
  ownerType: 'SI',
  smartType: undefined,
};

// ---------- метаданные ----------

export async function getItemFieldsMeta(
  ctx: ToolContext,
  target: ItemTarget,
  refresh = false,
): Promise<ItemFieldsMeta> {
  const key = String(target.entityTypeId);
  if (!refresh) {
    const cached = ctx.capabilities.getCached<ItemFieldsMeta>(FIELDS_CACHE_KIND, key);
    if (cached) return cached;
  }
  const r = await ctx.bitrix.call(
    'legacy',
    'crm.item.fields',
    { entityTypeId: target.entityTypeId },
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  const meta = parseItemFieldsResult(r.result);
  ctx.capabilities.setCached(FIELDS_CACHE_KIND, key, meta);
  return meta;
}

/** Поля по умолчанию для списка/плана — только те, что есть в схеме портала. */
export function defaultItemSelect(target: ItemTarget, meta: ItemFieldsMeta): string[] {
  const base = [
    'id',
    'title',
    ...(target.kind === 'invoice' ? ['accountNumber'] : []),
    'categoryId',
    'stageId',
    'assignedById',
    'opportunity',
    'currencyId',
    'companyId',
    'contactId',
    'createdTime',
    'updatedTime',
  ];
  return base.filter((f) => own(meta, f) !== undefined);
}

// ---------- чтение ----------

export async function itemsPage(
  ctx: ToolContext,
  target: ItemTarget,
  opts: {
    tool: string;
    filter: JsonObject;
    order: Record<string, 'ASC' | 'DESC'>;
    select: string[];
    pageSize: number;
    cursor: string | undefined;
  },
): Promise<PageResult> {
  return legacyListPage(ctx, {
    tool: opts.tool,
    method: 'crm.item.list',
    params: {
      entityTypeId: target.entityTypeId,
      filter: opts.filter,
      order: opts.order,
      select: opts.select,
    },
    bindingParts: {
      entityTypeId: target.entityTypeId,
      filter: opts.filter,
      order: opts.order,
      select: opts.select,
    },
    pageSize: opts.pageSize,
    cursor: opts.cursor,
    extract: (result) => {
      const items = isObj(result) ? result['items'] : undefined;
      return Array.isArray(items) ? items : undefined;
    },
  });
}

export async function getItem(ctx: ToolContext, target: ItemTarget, id: number): Promise<CrmItem> {
  const r = await ctx.bitrix.call(
    'legacy',
    'crm.item.get',
    { entityTypeId: target.entityTypeId, id },
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  const item = isObj(r.result) ? r.result['item'] : undefined;
  if (!isObj(item)) {
    throw new AppError('NOT_FOUND', `Запись (${target.label}) не найдена или недоступна`, {
      method: 'crm.item.get',
      apiVersion: 'legacy',
    });
  }
  return item;
}

export function itemTitle(item: Record<string, unknown>): string {
  return asText(item['title']);
}

/** Хеш состояния для expectedStateHash: все поля элемента, кроме служебного времени изменения. */
export function itemStateHash(item: CrmItem): string {
  const { updatedTime: _u, ...rest } = item;
  return stateHash(rest);
}

// ---------- запись ----------

export async function addItem(ctx: ToolContext, target: ItemTarget, fields: JsonObject): Promise<number> {
  const r = await ctx.bitrix.call(
    'legacy',
    'crm.item.add',
    { entityTypeId: target.entityTypeId, fields },
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  const item = isObj(r.result) ? r.result['item'] : undefined;
  const id = isObj(item) ? idOf(item['id']) : undefined;
  if (id === undefined) {
    throw outcomeUnknown(
      'crm.item.add',
      'legacy',
      `Проверьте список (${target.label}) в Bitrix24 перед повторной попыткой`,
    );
  }
  return id;
}

/** crm.item.update возвращает result.item; иное — исход неизвестен. */
export async function updateItem(
  ctx: ToolContext,
  target: ItemTarget,
  id: number,
  fields: JsonObject,
): Promise<void> {
  const r = await ctx.bitrix.call(
    'legacy',
    'crm.item.update',
    { entityTypeId: target.entityTypeId, id, fields },
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  const item = isObj(r.result) ? r.result['item'] : undefined;
  if (!isObj(item)) {
    throw outcomeUnknown(
      'crm.item.update',
      'legacy',
      'Прочитайте запись заново и сверьте поля перед повторной попыткой',
    );
  }
}

/** crm.item.delete: при успехе result — пустой массив (страница метода). */
export async function deleteItem(ctx: ToolContext, target: ItemTarget, id: number): Promise<void> {
  const r = await ctx.bitrix.call(
    'legacy',
    'crm.item.delete',
    { entityTypeId: target.entityTypeId, id },
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  if (!Array.isArray(r.result)) {
    throw outcomeUnknown('crm.item.delete', 'legacy', 'Проверьте запись в Bitrix24 (и корзину CRM)');
  }
}

function sameValue(want: unknown, got: unknown): boolean {
  if (typeof want === 'number' || typeof got === 'number') {
    const w = num(want);
    const g = num(got);
    if (w !== undefined && g !== undefined) return w === g;
  }
  return asText(want) === asText(got);
}

/** Сверка после записи (§15.3): verified — все скалярные запрошенные поля совпали; расхождения — warnings. */
export function compareItemFields(
  requested: JsonObject,
  actual: CrmItem,
): { verified: boolean; warnings: string[] } {
  const warnings: string[] = [];
  for (const [key, want] of Object.entries(requested)) {
    if (want !== null && typeof want === 'object') continue; // множественные поля построчно не сверяем
    if (want === null) continue;
    if (!sameValue(want, actual[key])) {
      warnings.push(
        `Поле ${key}: запрошено «${asText(want)}», в портале «${asText(actual[key])}» (возможна автоматизация или значение по умолчанию)`,
      );
    }
  }
  return { verified: warnings.length === 0, warnings };
}

// ---------- стадии ----------

export function itemStageEntityId(target: ItemTarget, categoryId: number): string {
  return target.kind === 'invoice'
    ? `SMART_INVOICE_STAGE_${String(categoryId)}`
    : `DYNAMIC_${String(target.entityTypeId)}_STAGE_${String(categoryId)}`;
}

export async function defaultCategoryId(ctx: ToolContext, target: ItemTarget): Promise<number> {
  const cats = await listCategories(ctx, target.entityTypeId);
  const def = cats.find((c) => c.isDefault) ?? cats[0];
  if (!def) {
    throw new AppError('BITRIX_UPSTREAM_ERROR', 'crm.category.list не вернул ни одной воронки', {
      method: 'crm.category.list',
      apiVersion: 'legacy',
    });
  }
  return def.id;
}

export async function itemStages(
  ctx: ToolContext,
  target: ItemTarget,
  categoryId: number,
): Promise<{ entityId: string; stages: StatusItem[] }> {
  const entityId = itemStageEntityId(target, categoryId);
  return { entityId, stages: await listStatuses(ctx, entityId) };
}

/**
 * INVALID_STAGE: stageId должен принадлежать справочнику стадий воронки элемента (categoryId из fields,
 * иначе текущий элемент, иначе воронка по умолчанию). Проверяется до плана.
 */
export async function assertItemStageValid(
  ctx: ToolContext,
  target: ItemTarget,
  fields: JsonObject,
  current: CrmItem | undefined,
): Promise<void> {
  if (!('stageId' in fields)) return;
  if (target.smartType && !target.smartType.isStagesEnabled) {
    throw new AppError('VALIDATION_ERROR', 'stageId: у смарт-процесса выключены стадии', {
      field: 'stageId',
      reason: 'INVALID_STAGE',
    });
  }
  const wanted = asText(fields['stageId']);
  const fromFields = num(fields['categoryId']);
  const fromCurrent = current ? num(current['categoryId']) : undefined;
  const categoryId = fromFields ?? fromCurrent ?? (await defaultCategoryId(ctx, target));
  const { entityId, stages } = await itemStages(ctx, target, categoryId);
  if (!stages.some((s) => s.statusId === wanted)) {
    throw new AppError(
      'VALIDATION_ERROR',
      `stageId: стадия «${wanted}» отсутствует в справочнике ${entityId}; допустимо: ${stages.map((s) => s.statusId).join(', ') || 'нет данных'}`,
      {
        field: 'stageId',
        reason: 'INVALID_STAGE',
        nextAction:
          target.kind === 'invoice'
            ? 'Проверьте стадии: invoice_stages_list'
            : 'Проверьте стадии: crm_stages_and_statuses (statusEntityId) или crm_fields_get',
      },
    );
  }
}

// ---------- товарные строки (crm.item.productrow.*) ----------

export async function itemRowsFirstPage(
  ctx: ToolContext,
  ownerType: string,
  ownerId: number,
  limit: number,
): Promise<{ rows: ProductRow[]; hasMore: boolean; total: number | undefined }> {
  const r = await ctx.bitrix.call(
    'legacy',
    'crm.item.productrow.list',
    {
      filter: { '=ownerType': ownerType, '=ownerId': ownerId },
      order: { sort: 'asc', id: 'asc' },
      start: 0,
    },
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  const items = isObj(r.result) ? r.result['productRows'] : undefined;
  if (!Array.isArray(items)) throw upstreamShapeError('crm.item.productrow.list', 'legacy');
  const rows = items.map(normalizeRow).filter((x): x is ProductRow => x !== undefined);
  return {
    rows: rows.slice(0, limit),
    hasMore: rows.length > limit || r.next !== undefined,
    total: r.total,
  };
}

/** crm.item.productrow.set: result.productRows — сохранённый состав; иначе исход неизвестен. */
export async function setItemRows(
  ctx: ToolContext,
  ownerType: string,
  ownerId: number,
  rows: JsonObject[],
): Promise<number> {
  const r = await ctx.bitrix.call(
    'legacy',
    'crm.item.productrow.set',
    { ownerType, ownerId, productRows: rows },
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  const saved = isObj(r.result) ? r.result['productRows'] : undefined;
  if (!Array.isArray(saved)) {
    throw outcomeUnknown(
      'crm.item.productrow.set',
      'legacy',
      'Откройте карточку в Bitrix24 и сверьте товарные позиции',
    );
  }
  return saved.length;
}

// ---------- связанные данные для include / impact ----------

/** Первая страница дел по владельцу (OWNER_TYPE_ID — числовой тип CRM, для смарт-процесса — его entityTypeId). */
export async function activitiesFirstPage(
  ctx: ToolContext,
  ownerTypeId: number,
  ownerId: number,
  limit: number,
): Promise<{ items: JsonValue[]; hasMore: boolean; total: number | undefined }> {
  const r = await ctx.bitrix.call(
    'legacy',
    'crm.activity.list',
    {
      filter: { OWNER_TYPE_ID: ownerTypeId, OWNER_ID: ownerId },
      select: [...ACTIVITY_FIELDS],
      order: { ID: 'desc' },
      start: 0,
    },
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  if (!Array.isArray(r.result)) throw upstreamShapeError('crm.activity.list', 'legacy');
  return {
    items: r.result.slice(0, limit),
    hasMore: r.result.length > limit || r.next !== undefined,
    total: r.total,
  };
}

/** Количество записей списка (total первой страницы); undefined — не удалось узнать. */
export async function countOf(
  ctx: ToolContext,
  method: string,
  params: JsonObject,
  extract?: (result: JsonValue) => JsonValue[] | undefined,
): Promise<number | undefined> {
  try {
    const r = await ctx.bitrix.call(
      'legacy',
      method,
      { ...params, start: 0 },
      { requestId: ctx.requestId, signal: ctx.signal },
    );
    const items = extract ? extract(r.result) : Array.isArray(r.result) ? r.result : undefined;
    if (!Array.isArray(items)) return undefined;
    return r.total ?? (r.next === undefined ? items.length : undefined);
  } catch {
    return undefined;
  }
}

/**
 * Доступ к каталогу Bitrix24 (ТЗ §9.6) через ctx.bitrix: каталоги, товары трёх видов (простой товар,
 * услуга, вариация), метаданные полей, цены, типы цен, валюты. Формы ответов — по документации:
 * list → result.products|services|offers, get → result.product|service|offer,
 * add/update → result.element (товар) | result.service | result.offer, getFieldsByFilter → result.product|service|offer.
 */
import { z } from 'zod';
import type { JsonObject, JsonValue } from '../../bitrix/legacy-adapter.js';
import { AppError } from '../../errors/app-error.js';
import { stateHash } from '../../security/idempotency.js';
import { asText, idOf, isObj, num, upstreamShapeError } from '../shared.js';
import type { ToolContext } from '../types.js';
import { canonicalDecimal, decimalFromUpstream } from './decimal.js';

// ---------- виды товаров ----------

export const productKindSchema = z
  .enum(['product', 'service', 'offer'])
  .describe(
    'Вид позиции: product — простой товар, service — услуга, offer — вариация (торговое предложение)',
  );
export type ProductKind = z.infer<typeof productKindSchema>;

interface KindSpec {
  readonly base: string;
  readonly label: string;
  /** Ключ массива в ответе .list */
  readonly listKey: string;
  /** Ключ объекта в ответе .get и .getFieldsByFilter */
  readonly itemKey: string;
  /** Ключ объекта в ответе .add/.update */
  readonly writeKey: string;
  /** Допустимые значения поля type (catalog/data-types.md «Product and Variation Relationship»). */
  readonly types: readonly number[];
}

export const KINDS: Record<ProductKind, KindSpec> = {
  product: {
    base: 'catalog.product',
    label: 'товар',
    listKey: 'products',
    itemKey: 'product',
    writeKey: 'element',
    types: [1],
  },
  service: {
    base: 'catalog.product.service',
    label: 'услуга',
    listKey: 'services',
    itemKey: 'service',
    writeKey: 'service',
    types: [7],
  },
  offer: {
    base: 'catalog.product.offer',
    label: 'вариация',
    listKey: 'offers',
    itemKey: 'offer',
    writeKey: 'offer',
    types: [4, 5],
  },
};

const TYPE_NAMES: Record<number, string> = {
  1: 'простой товар',
  3: 'товар с вариациями',
  4: 'вариация',
  5: 'вариация без родителя',
  6: 'товар без вариаций',
  7: 'услуга',
};
export const productTypeName = (t: number | undefined): string =>
  t === undefined ? 'неизвестный тип' : (TYPE_NAMES[t] ?? `тип ${String(t)}`);

export function invalidProductType(message: string, details: Record<string, unknown> = {}): AppError {
  return new AppError('VALIDATION_ERROR', message, {
    field: 'productKind',
    reason: 'INVALID_PRODUCT_TYPE',
    nextAction:
      'Уточните вид позиции: product — простой товар, service — услуга, offer — вариация в каталоге вариаций',
    ...details,
  });
}

// ---------- каталоги ----------

export interface CatalogInfo {
  id: number;
  iblockId: number;
  name: string;
  iblockTypeId: string;
  /** Для каталога вариаций — инфоблок товаров-родителей. */
  productIblockId: number | undefined;
  skuPropertyId: number | undefined;
  vatId: number | undefined;
}

export function normalizeCatalog(raw: JsonValue): CatalogInfo | undefined {
  if (!isObj(raw)) return undefined;
  const id = idOf(raw['id']);
  const iblockId = idOf(raw['iblockId']) ?? id;
  if (id === undefined || iblockId === undefined) return undefined;
  return {
    id,
    iblockId,
    name: asText(raw['name']),
    iblockTypeId: asText(raw['iblockTypeId']),
    productIblockId: idOf(raw['productIblockId']),
    skuPropertyId: idOf(raw['skuPropertyId']),
    vatId: idOf(raw['vatId']),
  };
}

export const CATALOG_SELECT = [
  'id',
  'iblockId',
  'iblockTypeId',
  'name',
  'productIblockId',
  'skuPropertyId',
  'vatId',
];

const MAX_SCAN_PAGES = 20;

/** Все страницы legacy-списка (до MAX_SCAN_PAGES по 50) с извлечением массива по ключу. */
async function scanAll(
  ctx: ToolContext,
  method: string,
  params: JsonObject,
  key: string,
): Promise<{ items: JsonValue[]; complete: boolean }> {
  const items: JsonValue[] = [];
  let start: number | undefined = 0;
  for (let page = 0; page < MAX_SCAN_PAGES && start !== undefined; page++) {
    const r = await ctx.bitrix.call(
      'legacy',
      method,
      { ...params, start },
      { requestId: ctx.requestId, signal: ctx.signal },
    );
    const arr = isObj(r.result) ? r.result[key] : undefined;
    if (!Array.isArray(arr)) throw upstreamShapeError(method, 'legacy');
    items.push(...arr);
    start = r.next;
  }
  return { items, complete: start === undefined };
}

/** Каталог по ID инфоблока; отсутствует → VALIDATION_ERROR UNKNOWN_CATALOG. */
export async function findCatalog(ctx: ToolContext, iblockId: number): Promise<CatalogInfo> {
  const { items } = await scanAll(
    ctx,
    'catalog.catalog.list',
    { select: CATALOG_SELECT, filter: { iblockId }, order: { id: 'asc' } },
    'catalogs',
  );
  const found = items.map(normalizeCatalog).find((c) => c?.iblockId === iblockId);
  if (!found) {
    throw new AppError('VALIDATION_ERROR', `Инфоблок ${String(iblockId)} не является торговым каталогом`, {
      field: 'iblockId',
      reason: 'UNKNOWN_CATALOG',
      nextAction: 'Возьмите iblockId из catalog_list',
    });
  }
  return found;
}

/** Вид позиции должен соответствовать каталогу: вариации — только в каталоге вариаций. */
export function assertKindFitsCatalog(kind: ProductKind, catalog: CatalogInfo): void {
  const variations = catalog.productIblockId !== undefined;
  if (kind === 'offer' && !variations) {
    throw invalidProductType(
      `Каталог ${String(catalog.iblockId)} «${catalog.name}» — каталог товаров, а не вариаций: вариацию в нём создать нельзя`,
      { iblockId: catalog.iblockId },
    );
  }
  if (kind !== 'offer' && variations) {
    throw invalidProductType(
      `Каталог ${String(catalog.iblockId)} «${catalog.name}» — каталог вариаций: в нём создаются только вариации (productKind=offer)`,
      { iblockId: catalog.iblockId },
    );
  }
}

// ---------- поля карточки ----------

const yn = z.enum(['Y', 'N']);
const ynd = z.enum(['Y', 'N', 'D']);
const posId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const dimension = z.number().min(0).max(1e9);
const dateTime = z
  .string()
  .max(40)
  .refine((s) => !Number.isNaN(Date.parse(s)), 'ожидается дата ISO 8601, например 2026-10-01T00:00:00+03:00');

/**
 * Поля карточки, которые инструмент разрешает менять (подмножество документированных полей
 * catalog_product / catalog_product_service / catalog_product_offer). Сознательно исключены:
 * закупочная цена, количество и резерв (цены/остатки — отдельные сущности, ТЗ §9.6), картинки
 * (base64-файлы), свойства propertyN, служебные createdBy/modifiedBy/dateCreate, поля продажи контента.
 */
export const productFieldsSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional().describe('Название'),
    active: yn.optional().describe('Активность Y/N'),
    code: z.string().trim().min(1).max(255).optional().describe('Символьный код'),
    xmlId: z.string().trim().min(1).max(255).optional().describe('Внешний код'),
    iblockSectionId: posId.optional().describe('ID раздела каталога'),
    measure: posId.optional().describe('ID единицы измерения'),
    previewText: z.string().max(20_000).optional().describe('Описание для анонса'),
    previewTextType: z.enum(['text', 'html']).optional(),
    detailText: z.string().max(20_000).optional().describe('Детальное описание'),
    detailTextType: z.enum(['text', 'html']).optional(),
    sort: z.number().int().min(0).max(1_000_000_000).optional(),
    vatId: posId.optional().describe('ID ставки НДС'),
    vatIncluded: yn.optional().describe('НДС включён в цену Y/N'),
    dateActiveFrom: dateTime.optional(),
    dateActiveTo: dateTime.optional(),
    // только товар и вариация
    barcodeMulti: yn.optional().describe('Уникальный штрихкод на каждый экземпляр (товар/вариация)'),
    canBuyZero: yn.optional().describe('Разрешить покупку при отсутствии (товар/вариация)'),
    subscribe: ynd.optional().describe('Подписка на товар (товар/вариация)'),
    quantityTrace: ynd.optional().describe('Количественный учёт (товар/вариация)'),
    height: dimension.optional(),
    length: dimension.optional(),
    weight: dimension.optional(),
    width: dimension.optional(),
    // только вариация
    parentId: posId.optional().describe('ID родительского товара (только вариация)'),
  })
  .strict()
  .refine((f) => Object.keys(f).length > 0, { message: 'передайте хотя бы одно поле' });

export type ProductFields = z.infer<typeof productFieldsSchema>;

const COMMON_FIELDS = [
  'name',
  'active',
  'code',
  'xmlId',
  'iblockSectionId',
  'measure',
  'previewText',
  'previewTextType',
  'detailText',
  'detailTextType',
  'sort',
  'vatId',
  'vatIncluded',
  'dateActiveFrom',
  'dateActiveTo',
] as const;
const GOODS_FIELDS = [
  'barcodeMulti',
  'canBuyZero',
  'subscribe',
  'quantityTrace',
  'height',
  'length',
  'weight',
  'width',
] as const;

export const ALLOWED_FIELDS: Record<ProductKind, readonly string[]> = {
  product: [...COMMON_FIELDS, ...GOODS_FIELDS],
  service: [...COMMON_FIELDS],
  offer: [...COMMON_FIELDS, ...GOODS_FIELDS, 'parentId'],
};

export interface FieldMeta {
  name: string;
  type: string;
  isRequired: boolean;
  isReadOnly: boolean;
  isImmutable: boolean;
}

/** Метаданные полей для инфоблока: catalog.product[.service|.offer].getFieldsByFilter. */
export async function getFieldsMeta(
  ctx: ToolContext,
  kind: ProductKind,
  iblockId: number,
): Promise<Map<string, FieldMeta>> {
  const spec = KINDS[kind];
  const method = `${spec.base}.getfieldsbyfilter`;
  const r = await ctx.bitrix.call(
    'legacy',
    method,
    { filter: { iblockId } },
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  const obj = isObj(r.result) ? r.result[spec.itemKey] : undefined;
  if (!isObj(obj)) throw upstreamShapeError(method, 'legacy');
  const meta = new Map<string, FieldMeta>();
  for (const [k, v] of Object.entries(obj)) {
    if (!isObj(v)) continue;
    meta.set(k, {
      name: asText(v['name']) || k,
      type: asText(v['type']),
      isRequired: v['isRequired'] === true,
      isReadOnly: v['isReadOnly'] === true,
      isImmutable: v['isImmutable'] === true,
    });
  }
  return meta;
}

/**
 * Проверка полей по виду позиции и метаданным портала. Для create дополнительно — обязательные поля.
 * Ошибка до плана: VALIDATION_ERROR с конкретным полем и причиной.
 */
export function validateProductFields(
  kind: ProductKind,
  fields: Record<string, unknown>,
  meta: Map<string, FieldMeta>,
  mode: 'create' | 'update',
): void {
  const allowed = new Set(ALLOWED_FIELDS[kind]);
  for (const key of Object.keys(fields)) {
    if (!allowed.has(key)) {
      throw new AppError('VALIDATION_ERROR', `Поле ${key} не применяется к виду «${KINDS[kind].label}»`, {
        field: `fields.${key}`,
        reason: 'FIELD_NOT_ALLOWED_FOR_KIND',
      });
    }
    const m = meta.get(key);
    if (!m) {
      throw new AppError('VALIDATION_ERROR', `Поле ${key} отсутствует в схеме каталога портала`, {
        field: `fields.${key}`,
        reason: 'UNKNOWN_FIELD',
      });
    }
    if (m.isReadOnly || (mode === 'update' && m.isImmutable)) {
      throw new AppError('VALIDATION_ERROR', `Поле ${key} (${m.name}) только для чтения`, {
        field: `fields.${key}`,
        reason: 'READ_ONLY_FIELD',
      });
    }
  }
  if (mode === 'create') {
    for (const [key, m] of meta) {
      if (!m.isRequired || key === 'id' || key === 'iblockId' || key === 'type') continue;
      if (fields[key] !== undefined) continue;
      const supported = allowed.has(key);
      throw new AppError(
        'VALIDATION_ERROR',
        supported
          ? `Не заполнено обязательное поле ${key} (${m.name})`
          : `Портал требует поле ${key} (${m.name}), которое этот инструмент не заполняет`,
        {
          field: `fields.${key}`,
          reason: supported ? 'REQUIRED_FIELD_MISSING' : 'REQUIRED_FIELD_UNSUPPORTED',
          ...(supported
            ? {}
            : { nextAction: 'Создайте позицию в интерфейсе Bitrix24 или сделайте поле необязательным' }),
        },
      );
    }
  }
}

// ---------- позиции ----------

export type ProductRecord = Record<string, JsonValue>;

/** Позиция по ID через метод её вида; отсутствует → NOT_FOUND (ошибка Bitrix пробрасывается). */
export async function getProduct(ctx: ToolContext, kind: ProductKind, id: number): Promise<ProductRecord> {
  const spec = KINDS[kind];
  const method = `${spec.base}.get`;
  const r = await ctx.bitrix.call('legacy', method, { id }, { requestId: ctx.requestId, signal: ctx.signal });
  const obj = isObj(r.result) ? r.result[spec.itemKey] : undefined;
  if (obj === null || obj === undefined || (Array.isArray(obj) && obj.length === 0)) {
    throw new AppError('NOT_FOUND', `${spec.label} #${String(id)} не найдена или недоступна`, {
      method,
      apiVersion: 'legacy',
    });
  }
  if (!isObj(obj)) throw upstreamShapeError(method, 'legacy');
  return obj;
}

/** Тип позиции из портала обязан соответствовать заявленному виду (INVALID_PRODUCT_TYPE). */
export function assertRecordKind(kind: ProductKind, record: ProductRecord, id: number): void {
  const t = num(record['type']);
  if (t !== undefined && !KINDS[kind].types.includes(t)) {
    throw invalidProductType(`Позиция #${String(id)} — ${productTypeName(t)}, а не «${KINDS[kind].label}»`, {
      productId: id,
      actualType: t,
    });
  }
}

/** Снимок изменяемых полей для stateHash: только поля, которые инструмент может менять. */
export function productSnapshot(kind: ProductKind, record: ProductRecord): Record<string, JsonValue> {
  const snap: Record<string, JsonValue> = {
    id: record['id'] ?? null,
    iblockId: record['iblockId'] ?? null,
    type: record['type'] ?? null,
  };
  for (const f of ALLOWED_FIELDS[kind]) snap[f] = fieldValue(record, f);
  return snap;
}

export const productStateHash = (kind: ProductKind, record: ProductRecord): string =>
  stateHash(productSnapshot(kind, record));

/** Сравнение значения в портале с запрошенным (строки/числа/даты), без приведения регистра. */
export function sameFieldValue(requested: unknown, actual: unknown): boolean {
  if (typeof requested === 'number') return num(actual) === requested;
  if (typeof requested === 'string') {
    const a = asText(actual);
    if (a === requested) return true;
    const dr = Date.parse(requested);
    const da = Date.parse(a);
    return /^\d{4}-\d{2}-\d{2}/.test(requested) && !Number.isNaN(dr) && dr === da;
  }
  return false;
}

/** Значение поля карточки: свойства-ссылки (parentId вариации) приходят объектом {value, valueId}. */
export function fieldValue(record: ProductRecord, key: string): JsonValue {
  const v = record[key];
  if (v === undefined) return null;
  return isObj(v) && 'value' in v ? (v['value'] ?? null) : v;
}

export function compareProductFields(fields: Record<string, unknown>, record: ProductRecord): string[] {
  const warnings: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!sameFieldValue(v, fieldValue(record, k)))
      warnings.push(`Поле ${k} в портале отличается от запрошенного`);
  }
  return warnings;
}

/** Ответ add/update: объект позиции с ID; иначе — исход неизвестен. */
export function writtenProductId(kind: ProductKind, result: JsonValue): number | undefined {
  const obj = isObj(result) ? result[KINDS[kind].writeKey] : undefined;
  return isObj(obj) ? idOf(obj['id']) : undefined;
}

// ---------- цены, типы цен, валюты ----------

export interface PriceType {
  id: number;
  name: string;
  base: boolean;
}

export async function listPriceTypes(ctx: ToolContext): Promise<PriceType[]> {
  // Раздел «Returned Data» catalog.priceType.list: result.priceTypes.
  const { items } = await scanAll(
    ctx,
    'catalog.pricetype.list',
    { select: ['id', 'name', 'base', 'xmlId'], order: { id: 'asc' } },
    'priceTypes',
  );
  return items.flatMap((raw) => {
    if (!isObj(raw)) return [];
    const id = idOf(raw['id']);
    return id === undefined ? [] : [{ id, name: asText(raw['name']), base: asText(raw['base']) === 'Y' }];
  });
}

export interface Currency {
  code: string;
  decimals: number;
  base: boolean;
}

/** Валюты портала (crm.currency.list); строки разных языков схлопываются по коду. */
export async function listCurrencies(ctx: ToolContext): Promise<Map<string, Currency>> {
  const r = await ctx.bitrix.call(
    'legacy',
    'crm.currency.list',
    { order: { SORT: 'asc' } },
    { requestId: ctx.requestId, signal: ctx.signal },
  );
  if (!Array.isArray(r.result)) throw upstreamShapeError('crm.currency.list', 'legacy');
  const out = new Map<string, Currency>();
  for (const raw of r.result) {
    if (!isObj(raw)) continue;
    const code = asText(raw['CURRENCY']);
    if (!code || out.has(code)) continue;
    const d = num(raw['DECIMALS']);
    out.set(code, {
      code,
      decimals: d !== undefined && Number.isInteger(d) && d >= 0 && d <= 3 ? d : 2,
      base: asText(raw['BASE']) === 'Y',
    });
  }
  return out;
}

export interface PriceRow {
  id: number;
  productId: number;
  priceTypeId: number;
  /** Каноническая десятичная строка. */
  amount: string;
  currency: string;
}

function normalizePrice(raw: JsonValue): PriceRow | undefined {
  if (!isObj(raw)) return undefined;
  const id = idOf(raw['id']);
  const productId = idOf(raw['productId']);
  const priceTypeId = idOf(raw['catalogGroupId']);
  const amount = decimalFromUpstream(raw['price']);
  if (id === undefined || productId === undefined || priceTypeId === undefined || amount === undefined)
    return undefined;
  return { id, productId, priceTypeId, amount, currency: asText(raw['currency']) };
}

/** Цены товара заданного типа. Больше одной строки = диапазоны количества (устаревшая схема). */
export async function findPrices(
  ctx: ToolContext,
  productId: number,
  priceTypeId: number,
): Promise<PriceRow[]> {
  const { items } = await scanAll(
    ctx,
    'catalog.price.list',
    {
      select: ['id', 'productId', 'catalogGroupId', 'price', 'currency'],
      filter: { productId, catalogGroupId: priceTypeId },
      order: { id: 'asc' },
    },
    'prices',
  );
  return items.map((raw) => {
    const p = normalizePrice(raw);
    if (!p)
      throw upstreamShapeError(
        'catalog.price.list',
        'legacy',
        'catalog.price.list: цена в неожиданном формате',
      );
    return p;
  });
}

export const priceStateHash = (rows: readonly PriceRow[]): string =>
  stateHash(rows.map((r) => ({ id: r.id, amount: canonicalDecimal(r.amount), currency: r.currency })));

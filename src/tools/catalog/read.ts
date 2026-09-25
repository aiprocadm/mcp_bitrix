/**
 * Чтение каталога и склада (ТЗ §9.6): catalog_list, catalog_products_list, warehouse_list, warehouse_stock_list.
 * Всё страницами с непрозрачным курсором (start/next Bitrix, страница 50). Цены и остатки в список
 * товаров не подмешиваются: это разные сущности (цены — catalog_price_set, остатки — warehouse_stock_list).
 */
import { z } from 'zod';
import type { JsonObject, JsonValue } from '../../bitrix/legacy-adapter.js';
import { ok } from '../../mcp/result.js';
import { pageArgsShape } from '../../schemas/common.js';
import { asText, idOf, idSchema, isObj, legacyListPage, num, pageMeta, pageSizeOf } from '../shared.js';
import { defineTool, READ_ANNOTATIONS } from '../types.js';
import {
  CATALOG_SELECT,
  KINDS,
  normalizeCatalog,
  productKindSchema,
  productTypeName,
} from './catalog-service.js';

const itemsOf = (key: string) => (result: JsonValue) => {
  const arr = isObj(result) ? result[key] : undefined;
  return Array.isArray(arr) ? arr : undefined;
};

// ---------- catalog_list ----------

export const catalogListTool = defineTool({
  name: 'catalog_list',
  module: 'catalog',
  title: 'Торговые каталоги',
  description:
    'Список торговых каталогов портала (catalog.catalog.list): ID инфоблока, название, каталог товаров или вариаций. ' +
    'Использовать, чтобы узнать iblockId для catalog_products_list и catalog_product_create; вариации создаются только ' +
    'в каталоге вариаций (kind=variations, есть productIblockId). Метод доступен администратору портала.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z.object({ ...pageArgsShape }).strict(),
  outputDataSchema: z.object({
    items: z.array(
      z.object({
        iblockId: z.number(),
        name: z.string(),
        kind: z.enum(['products', 'variations']),
        productIblockId: z.number().optional(),
        iblockTypeId: z.string(),
        vatId: z.number().optional(),
      }),
    ),
    returnedCount: z.number(),
  }),
  handler: async (args, ctx) => {
    const pageSize = pageSizeOf(ctx, args.pageSize);
    const page = await legacyListPage(ctx, {
      tool: 'catalog_list',
      method: 'catalog.catalog.list',
      params: { select: CATALOG_SELECT, order: { id: 'asc' } },
      bindingParts: {},
      pageSize,
      cursor: args.cursor,
      extract: itemsOf('catalogs'),
    });
    const items = page.items.flatMap((raw) => {
      const c = normalizeCatalog(raw);
      if (!c) return [];
      return [
        {
          iblockId: c.iblockId,
          name: c.name,
          kind: c.productIblockId !== undefined ? ('variations' as const) : ('products' as const),
          ...(c.productIblockId !== undefined ? { productIblockId: c.productIblockId } : {}),
          iblockTypeId: c.iblockTypeId,
          ...(c.vatId !== undefined ? { vatId: c.vatId } : {}),
        },
      ];
    });
    return ok({ items, returnedCount: items.length }, pageMeta(ctx, 'catalog.catalog.list', page));
  },
});

// ---------- catalog_products_list ----------

/** Минимальный select: id и iblockId обязательны по документации, остальное — для идентификации позиции. */
const PRODUCT_SELECT = [
  'id',
  'iblockId',
  'name',
  'active',
  'type',
  'code',
  'xmlId',
  'iblockSectionId',
  'measure',
  'vatId',
  'vatIncluded',
  'timestampX',
];

export const catalogProductsListTool = defineTool({
  name: 'catalog_products_list',
  module: 'catalog',
  title: 'Товары каталога',
  description:
    'Товары, услуги или вариации одного торгового каталога (catalog.product.list / .service.list / .offer.list). ' +
    'Использовать, чтобы найти позицию по названию и узнать её productId для изменения карточки или цены. ' +
    'iblockId — из catalog_list; вариации лежат в каталоге вариаций. Цены и остатки здесь не выводятся: ' +
    'они в catalog_price_set (план показывает текущую цену) и warehouse_stock_list.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      iblockId: idSchema.describe('ID инфоблока каталога (catalog_list)'),
      productKind: productKindSchema.default('product'),
      nameContains: z.string().trim().min(1).max(100).optional().describe('Подстрока названия'),
      activeOnly: z.boolean().optional().describe('Только активные'),
      sectionId: idSchema.optional().describe('ID раздела каталога'),
      ...pageArgsShape,
    })
    .strict(),
  outputDataSchema: z.object({
    iblockId: z.number(),
    productKind: productKindSchema,
    items: z.array(
      z.object({
        id: z.number(),
        name: z.string(),
        active: z.boolean(),
        type: z.number().optional(),
        typeName: z.string(),
        parentId: z.number().optional(),
        code: z.string().optional(),
        xmlId: z.string().optional(),
        sectionId: z.number().optional(),
        measure: z.number().optional(),
        vatId: z.number().optional(),
        vatIncluded: z.boolean().optional(),
        updatedAt: z.string().optional(),
      }),
    ),
    returnedCount: z.number(),
  }),
  handler: async (args, ctx) => {
    const spec = KINDS[args.productKind];
    const method = `${spec.base}.list`;
    const filter: JsonObject = { iblockId: args.iblockId };
    if (args.nameContains) filter['%name'] = args.nameContains;
    if (args.activeOnly) filter['active'] = 'Y';
    if (args.sectionId) filter['iblockSectionId'] = args.sectionId;
    const select = args.productKind === 'offer' ? [...PRODUCT_SELECT, 'parentId'] : PRODUCT_SELECT;
    const pageSize = pageSizeOf(ctx, args.pageSize);
    const page = await legacyListPage(ctx, {
      tool: 'catalog_products_list',
      method,
      params: { select, filter, order: { id: 'asc' } },
      bindingParts: { kind: args.productKind, filter },
      pageSize,
      cursor: args.cursor,
      extract: itemsOf(spec.listKey),
    });
    const items = page.items.flatMap((raw) => {
      if (!isObj(raw)) return [];
      const id = idOf(raw['id']);
      if (id === undefined) return [];
      const type = num(raw['type']);
      const opt = (k: string, v: unknown) => (v === undefined || v === '' ? {} : { [k]: v });
      return [
        {
          id,
          name: asText(raw['name']),
          active: asText(raw['active']) === 'Y',
          ...opt('type', type),
          typeName: productTypeName(type),
          ...opt('parentId', idOf(isObj(raw['parentId']) ? raw['parentId']['value'] : raw['parentId'])),
          ...opt('code', asText(raw['code'])),
          ...opt('xmlId', asText(raw['xmlId'])),
          ...opt('sectionId', idOf(raw['iblockSectionId'])),
          ...opt('measure', idOf(raw['measure'])),
          ...opt('vatId', idOf(raw['vatId'])),
          ...(raw['vatIncluded'] !== undefined && raw['vatIncluded'] !== null
            ? { vatIncluded: asText(raw['vatIncluded']) === 'Y' }
            : {}),
          ...opt('updatedAt', asText(raw['timestampX'])),
        },
      ];
    });
    return ok(
      { iblockId: args.iblockId, productKind: args.productKind, items, returnedCount: items.length },
      pageMeta(ctx, method, page),
    );
  },
});

// ---------- warehouse_list ----------

export const warehouseListTool = defineTool({
  name: 'warehouse_list',
  module: 'catalog',
  title: 'Склады',
  description:
    'Список складов (catalog.store.list): ID, название, адрес, активность, пункт выдачи. ' +
    'Использовать, чтобы узнать storeId для warehouse_stock_list. Телефоны и email складов не выводятся.',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      activeOnly: z.boolean().default(false).describe('Только активные склады'),
      ...pageArgsShape,
    })
    .strict(),
  outputDataSchema: z.object({
    items: z.array(
      z.object({
        id: z.number(),
        title: z.string(),
        active: z.boolean(),
        address: z.string().optional(),
        code: z.string().optional(),
        issuingCenter: z.boolean(),
        sort: z.number().optional(),
      }),
    ),
    returnedCount: z.number(),
  }),
  handler: async (args, ctx) => {
    const filter: JsonObject = args.activeOnly ? { active: 'Y' } : {};
    const page = await legacyListPage(ctx, {
      tool: 'warehouse_list',
      method: 'catalog.store.list',
      params: {
        select: ['id', 'title', 'active', 'address', 'code', 'issuingCenter', 'sort'],
        filter,
        order: { sort: 'asc', id: 'asc' },
      },
      bindingParts: { filter },
      pageSize: pageSizeOf(ctx, args.pageSize),
      cursor: args.cursor,
      extract: itemsOf('stores'),
    });
    const items = page.items.flatMap((raw) => {
      if (!isObj(raw)) return [];
      const id = idOf(raw['id']);
      if (id === undefined) return [];
      const address = asText(raw['address']);
      const code = asText(raw['code']);
      const sort = num(raw['sort']);
      return [
        {
          id,
          title: asText(raw['title']),
          active: asText(raw['active']) === 'Y',
          ...(address ? { address } : {}),
          ...(code ? { code } : {}),
          issuingCenter: asText(raw['issuingCenter']) === 'Y',
          ...(sort !== undefined ? { sort } : {}),
        },
      ];
    });
    return ok({ items, returnedCount: items.length }, pageMeta(ctx, 'catalog.store.list', page));
  },
});

// ---------- warehouse_stock_list ----------

const idList = z.array(idSchema).min(1).max(50);

export const warehouseStockListTool = defineTool({
  name: 'warehouse_stock_list',
  module: 'catalog',
  title: 'Остатки и резервы на складах',
  description:
    'Остатки товаров по складам (catalog.storeproduct.list): товар, склад, количество на складе (amount) и резерв ' +
    '(quantityReserved) — как их хранит портал. Использовать, когда спрашивают «сколько товара на складе». ' +
    'Инструмент НЕ делает вывода о доступности к продаже: резервы, документы в работе и настройки учёта ' +
    'он не пересчитывает. Фильтры: storeIds и/или productIds (до 50 каждого).',
  operation: 'read',
  annotations: READ_ANNOTATIONS,
  requiresBitrix: true,
  inputSchema: z
    .object({
      storeIds: idList.optional().describe('ID складов (warehouse_list)'),
      productIds: idList.optional().describe('ID товаров/вариаций (catalog_products_list)'),
      ...pageArgsShape,
    })
    .strict(),
  outputDataSchema: z.object({
    items: z.array(
      z.object({
        id: z.number(),
        productId: z.number(),
        storeId: z.number(),
        amount: z.number().nullable(),
        quantityReserved: z.number().nullable(),
      }),
    ),
    returnedCount: z.number(),
  }),
  handler: async (args, ctx) => {
    const filter: JsonObject = {};
    if (args.storeIds) filter['@storeId'] = [...args.storeIds].sort((a, b) => a - b);
    if (args.productIds) filter['@productId'] = [...args.productIds].sort((a, b) => a - b);
    const page = await legacyListPage(ctx, {
      tool: 'warehouse_stock_list',
      method: 'catalog.storeproduct.list',
      params: {
        select: ['id', 'productId', 'storeId', 'amount', 'quantityReserved'],
        filter,
        order: { id: 'asc' },
      },
      bindingParts: { filter },
      pageSize: pageSizeOf(ctx, args.pageSize),
      cursor: args.cursor,
      extract: itemsOf('storeProducts'),
    });
    const items = page.items.flatMap((raw) => {
      if (!isObj(raw)) return [];
      const id = idOf(raw['id']);
      const productId = idOf(raw['productId']);
      const storeId = idOf(raw['storeId']);
      if (id === undefined || productId === undefined || storeId === undefined) return [];
      return [
        {
          id,
          productId,
          storeId,
          amount: num(raw['amount']) ?? null,
          quantityReserved: num(raw['quantityReserved']) ?? null,
        },
      ];
    });
    return ok(
      { items, returnedCount: items.length },
      pageMeta(ctx, 'catalog.storeproduct.list', page, 'legacy', [
        'amount и quantityReserved — данные портала; доступность к продаже не рассчитывалась',
      ]),
    );
  },
});

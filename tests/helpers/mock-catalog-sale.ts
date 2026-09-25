/**
 * Мок каталога и магазина Bitrix24 для тестов группы catalog-sale.
 * Формы ответов — по документации apidocs: catalog.catalog.list → result.catalogs, *.list → result.products|services|offers,
 * *.get → result.product|service|offer, add/update → result.element|service|offer, catalog.price.* → result.price(s),
 * catalog.priceType.list → result.priceTypes, crm.currency.list → массив, sale.order.get → result.order.
 */
import type { MockBitrix, RecordedCall } from './mock-bitrix.js';
import { legacyError, legacyListPage, legacyOk } from './mock-bitrix.js';

export const CATALOGS = [
  { id: 23, iblockId: 23, iblockTypeId: 'CRM_PRODUCT_CATALOG', name: 'Товарный каталог CRM', vatId: 1 },
  {
    id: 24,
    iblockId: 24,
    iblockTypeId: 'CRM_PRODUCT_CATALOG',
    name: 'Товарный каталог CRM (предложения)',
    productIblockId: 23,
    skuPropertyId: 97,
    vatId: 1,
  },
];

const meta = (name: string, type: string, extra: Record<string, boolean> = {}) => ({
  isImmutable: false,
  isReadOnly: false,
  isRequired: false,
  name,
  type,
  ...extra,
});

const COMMON_META = {
  id: meta('ID', 'integer', { isReadOnly: true }),
  iblockId: meta('Инфоблок', 'integer', { isRequired: true, isImmutable: true }),
  name: meta('Название', 'string', { isRequired: true }),
  active: meta('Активность', 'char'),
  code: meta('Символьный код', 'string'),
  xmlId: meta('Внешний код', 'string'),
  iblockSectionId: meta('Раздел', 'integer'),
  measure: meta('Единица измерения', 'integer'),
  previewText: meta('Анонс', 'string'),
  detailText: meta('Описание', 'string'),
  sort: meta('Сортировка', 'integer'),
  vatId: meta('НДС', 'integer'),
  vatIncluded: meta('НДС включён', 'char'),
  type: meta('Тип', 'integer', { isReadOnly: true }),
  available: meta('Доступность', 'char', { isReadOnly: true }),
};
const GOODS_META = {
  canBuyZero: meta('Покупка при отсутствии', 'char'),
  weight: meta('Вес', 'double'),
  quantity: meta('Количество', 'double'),
  purchasingPrice: meta('Закупочная цена', 'double'),
};
export const FIELDS_META = {
  product: { ...COMMON_META, ...GOODS_META },
  service: { ...COMMON_META },
  offer: { ...COMMON_META, ...GOODS_META, parentId: meta('Родитель', 'integer') },
};

export interface CatalogState {
  products: Map<number, Record<string, unknown>>;
  prices: Record<string, unknown>[];
  nextProductId: number;
  nextPriceId: number;
}

export function product(
  id: number,
  type: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    iblockId: type === 4 || type === 5 ? 24 : 23,
    name: `Позиция ${String(id)}`,
    active: 'Y',
    type,
    code: `p${String(id)}`,
    xmlId: String(id),
    iblockSectionId: 47,
    measure: 5,
    vatId: 1,
    vatIncluded: 'Y',
    canBuyZero: 'N',
    weight: 100,
    quantity: 10,
    purchasingPrice: 500,
    timestampX: '2026-09-01T10:00:00+03:00',
    ...extra,
  };
}

export const PRICE_TYPES = [
  { id: 1, name: 'BASE', base: 'Y', xmlId: 'BASE' },
  { id: 2, name: 'Оптовая', base: 'N', xmlId: 'wholesale' },
];

/** Две строки USD (как в документации — по языкам), RUB, JPY без копеек. */
export const CURRENCIES = [
  { CURRENCY: 'RUB', BASE: 'Y', DECIMALS: '2', SORT: '100' },
  { CURRENCY: 'USD', BASE: 'N', DECIMALS: '2', SORT: '200' },
  { CURRENCY: 'USD', BASE: 'N', DECIMALS: '2', SORT: '200' },
  { CURRENCY: 'JPY', BASE: 'N', DECIMALS: '0', SORT: '300' },
];

const KIND_BY_BASE: Record<string, { item: string; list: string; write: string; types: number[] }> = {
  'catalog.product': { item: 'product', list: 'products', write: 'element', types: [1] },
  'catalog.product.service': { item: 'service', list: 'services', write: 'service', types: [7] },
  'catalog.product.offer': { item: 'offer', list: 'offers', write: 'offer', types: [4, 5] },
};

const filterOf = (c: RecordedCall) => (c.body['filter'] ?? {}) as Record<string, unknown>;

export function installCatalogMock(bitrix: MockBitrix, state: CatalogState): void {
  bitrix
    .on('catalog.catalog.list', (c) => {
      const f = filterOf(c);
      const rows = CATALOGS.filter((x) => f['iblockId'] === undefined || x.iblockId === f['iblockId']);
      return legacyOk({ catalogs: rows }, { total: rows.length });
    })
    .on('catalog.pricetype.list', legacyOk({ priceTypes: PRICE_TYPES }, { total: PRICE_TYPES.length }))
    .on('crm.currency.list', legacyOk(CURRENCIES))
    .on('catalog.price.list', (c) => {
      const f = filterOf(c);
      const rows = state.prices.filter(
        (p) => p['productId'] === f['productId'] && p['catalogGroupId'] === f['catalogGroupId'],
      );
      return legacyOk({ prices: rows }, { total: rows.length });
    })
    .on('catalog.price.add', (c) => {
      const fields = c.body['fields'] as Record<string, unknown>;
      const row = {
        id: state.nextPriceId++,
        ...fields,
        extraId: null,
        timestampX: '2026-09-25T10:00:00+03:00',
      };
      state.prices.push(row);
      return legacyOk({ price: row });
    })
    .on('catalog.price.update', (c) => {
      const row = state.prices.find((p) => p['id'] === c.body['id']);
      if (!row) return legacyError('NOT_FOUND', 400, 'Price not found');
      Object.assign(row, c.body['fields'] as Record<string, unknown>);
      return legacyOk({ price: row });
    });

  for (const [base, k] of Object.entries(KIND_BY_BASE)) {
    const kind = k.item as keyof typeof FIELDS_META;
    bitrix
      .on(`${base}.getfieldsbyfilter`, legacyOk({ [k.item]: FIELDS_META[kind] }))
      .on(`${base}.get`, (c) => {
        const p = state.products.get(Number(c.body['id']));
        return p ? legacyOk({ [k.item]: p }) : legacyError('NOT_FOUND', 400, 'Product not found');
      })
      .on(`${base}.list`, (c) => {
        const f = filterOf(c);
        const all = [...state.products.values()].filter(
          (p) => p['iblockId'] === f['iblockId'] && k.types.includes(Number(p['type'])),
        );
        const page = legacyListPage(all, Number(c.body['start'] ?? 0), 50);
        const body = page.body as Record<string, unknown>;
        return { ...page, body: { ...body, result: { [k.list]: body['result'] } } };
      })
      .on(`${base}.add`, (c) => {
        const fields = c.body['fields'] as Record<string, unknown>;
        const id = state.nextProductId++;
        const row = product(id, k.types[0] ?? 1, { ...fields, quantity: 0, purchasingPrice: null });
        state.products.set(id, row);
        return legacyOk({ [k.write]: row });
      })
      .on(`${base}.update`, (c) => {
        const row = state.products.get(Number(c.body['id']));
        if (!row) return legacyError('NOT_FOUND', 400, 'Product not found');
        Object.assign(row, c.body['fields'] as Record<string, unknown>);
        return legacyOk({ [k.write]: row });
      });
  }
}
